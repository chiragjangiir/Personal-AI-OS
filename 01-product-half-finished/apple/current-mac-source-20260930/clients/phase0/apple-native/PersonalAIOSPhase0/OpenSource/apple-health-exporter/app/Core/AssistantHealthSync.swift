import Foundation
import HealthKit

/// One HEALTH source. HK anchors belong to a pairing; only a durable Mac receipt commits a page.
/// A cancelled/failed page is queried again. Mac UUID upserts make partial-page replay safe.
actor AssistantHealthSync {
    static let metrics: [HealthMetric] = [.sleepAnalysis, .heartRate, .restingHeartRate,
        .heartRateVariabilitySDNN, .respiratoryRate, .oxygenSaturation, .stepCount,
        .activeEnergyBurned, .appleExerciseTime, .workout, .highHeartRateEvent, .lowHeartRateEvent, .irregularHeartRhythmEvent, .numberOfTimesFallen, .appleWalkingSteadiness,
        .appleSleepingWristTemperature, .bodyTemperature]
    typealias Sender = @Sendable (AssistantHealthWire.Chunk) async throws -> Void
    private let query: any HealthQuerying
    private let defaults: UserDefaults
    private let selectedMetrics: [HealthMetric]
    private var running = false
    private var urgentRunning = false
    private var generation: UInt64 = 0
    private var enabledIdentity: String?

    init(query: any HealthQuerying, defaults: UserDefaults = .standard, metrics: [HealthMetric] = AssistantHealthSync.metrics) {
        self.query = query; self.defaults = defaults; selectedMetrics = metrics
    }
    func isEnabled(identity: String) -> Bool { defaults.bool(forKey: "health.enabled." + identity) }
    func setEnabled(_ enabled: Bool, identity: String) {
        defaults.set(enabled, forKey: "health.enabled." + identity)
        generation &+= 1
        running = false; urgentRunning = false
        enabledIdentity = enabled ? identity : nil
    }
    func interruptForFall() {
        generation &+= 1
        running = false; urgentRunning = false
    }
    func markObserverDirty(identity: String) { defaults.set(true, forKey: "health.dirty." + identity) }

    /// Round-robin bounded page groups per metric, one packet in flight. A wake has a finite page budget.
    /// Returns true when another bounded run is needed. The session schedules it while still connected.
    func sync(identity: String, maximumBytes: Int, urgentOnly: Bool = false,
              allowBulk: @escaping @Sendable () async -> Bool = { true }, send: @escaping Sender) async throws -> Bool {
        guard isEnabled(identity: identity) else { return false }
        if urgentOnly {
            if urgentRunning { return true }; urgentRunning = true
        } else {
            if running { return true }; running = true
        }
        enabledIdentity = identity
        let version = generation
        defer { if generation == version { if urgentOnly { urgentRunning = false } else { running = false } } }
        let available = selectedMetrics.filter { $0.sampleType != nil && (!urgentOnly || $0 == .numberOfTimesFallen) }
        var more = available
        var pages = 0
        var failedMetrics: [String] = []
        while !more.isEmpty, pages < 128 {
            var next: [HealthMetric] = []
            for metric in more {
                if pages >= 128 { next.append(metric); continue }
                do {
                    try check(identity, version)
                    if !urgentOnly, !(await allowBulk()) { return true }
                    let key = "health.anchor.\(identity).\(metric.rawValue)"
                    var anchor = defaults.data(forKey: key)
                    var records: [HealthRecord] = []
                    var deleted: [DeletedRecord] = []
                    var hasMore = false
                    var batchPages = 0
                    repeat {
                        if !urgentOnly, !(await allowBulk()) { return true }
                        // Temporary anchors coalesce filtered/sparse HK pages without advancing durable state.
                        let page = try await query.incrementalPage(for: metric, anchor: anchor,
                            startDate: Date(timeIntervalSince1970: 0), limit: 64)
                        try check(identity, version)
                        records += page.records; deleted += page.deletedRecords; anchor = page.newAnchor
                        pages += 1; batchPages += 1; hasMore = page.rawChangeCount >= 64
                    } while hasMore && records.count < 64 && deleted.count < 128 && pages < 128 && batchPages < 8
                    let combined = HealthQueryPage(records: records, deletedRecords: deleted,
                        newAnchor: anchor!, rawChangeCount: records.count + deleted.count)
                    for chunk in try AssistantHealthWire.chunks(page: combined, metric: metric, maximumBytes: maximumBytes) {
                        try check(identity, version)
                        if !urgentOnly, !(await allowBulk()) { return true }
                        try await send(chunk)
                        try check(identity, version)
                    }
                    // Commit only after every packet from the coalesced pages has a durable receipt.
                    defaults.set(anchor, forKey: key)
                    if hasMore { next.append(metric) }
                } catch is CancellationError { throw CancellationError() }
                catch {
                    try check(identity, version)
                    failedMetrics.append(metric.rawValue)
                    pages += 1
                }
            }
            more = next
        }
        if !failedMetrics.isEmpty { throw AssistantHealthFailure(code: "HEALTH_PARTIAL") }
        if more.isEmpty && !urgentOnly { defaults.set(false, forKey: "health.dirty." + identity) }
        return !more.isEmpty
    }
    private func check(_ identity: String, _ version: UInt64) throws {
        try Task.checkCancellation()
        guard generation == version, enabledIdentity == identity, isEnabled(identity: identity) else {
            throw CancellationError()
        }
    }
}

/// Reuses HealthKit's observer/background-delivery path. Completion does not claim a network upload.
/// If iOS suspends the connection, the uncommitted anchor is replayed on foreground/reconnect.
final class AssistantHealthObservers: @unchecked Sendable {
    private let store: HKHealthStore
    private let lock = NSLock()
    private var queries: [HKObserverQuery] = []
    init(store: HKHealthStore) { self.store = store }
    func start(changed: @escaping @Sendable (HealthMetric) async -> Void) async {
        stop()
        for metric in AssistantHealthSync.metrics {
            guard let type = metric.sampleType else { continue }
            let observer = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                guard error == nil else { completion(); return }
                Task { await changed(metric); completion() }
            }
            append(observer)
            store.execute(observer)
            _ = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                store.enableBackgroundDelivery(for: type, frequency: metric == .numberOfTimesFallen ? .immediate : .hourly) { success, _ in continuation.resume(returning: success) }
            }
        }
    }
    func stop() {
        lock.lock(); let old = queries; queries.removeAll(); lock.unlock()
        for query in old { store.stop(query) }
    }
    private func append(_ query: HKObserverQuery) { lock.lock(); queries.append(query); lock.unlock() }
}
