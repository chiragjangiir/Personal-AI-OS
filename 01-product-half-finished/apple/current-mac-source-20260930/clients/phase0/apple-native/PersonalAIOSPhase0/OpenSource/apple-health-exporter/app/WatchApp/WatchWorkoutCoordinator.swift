import Combine
import Foundation
import HealthKit

/// Primitive values extracted from the HealthKit live workout statistics.
/// Keeping this seam free of HealthKit objects makes the unit conversion and
/// missing-value behavior testable without fabricating HealthKit samples.
struct WatchCyclingStatisticsValues: Equatable, Sendable {
    let heartRateBPM: Double?
    let activeEnergyKcal: Double?
    let distanceM: Double?
    let elapsedS: Double
    let cadenceSPM: Double?
    let cyclingSpeedMPS: Double?
    let heartRateSampleAt: Date?
    let cadenceSampleAt: Date?
    let cyclingSpeedSampleAt: Date?

    init(
        heartRateBPM: Double?,
        activeEnergyKcal: Double?,
        distanceM: Double?,
        elapsedS: Double,
        cadenceSPM: Double?,
        cyclingSpeedMPS: Double?,
        heartRateSampleAt: Date? = nil,
        cadenceSampleAt: Date? = nil,
        cyclingSpeedSampleAt: Date? = nil
    ) {
        self.heartRateBPM = heartRateBPM
        self.activeEnergyKcal = activeEnergyKcal
        self.distanceM = distanceM
        self.elapsedS = elapsedS
        self.cadenceSPM = cadenceSPM
        self.cyclingSpeedMPS = cyclingSpeedMPS
        self.heartRateSampleAt = heartRateSampleAt
        self.cadenceSampleAt = cadenceSampleAt
        self.cyclingSpeedSampleAt = cyclingSpeedSampleAt
    }

    var distanceMeters: Double? { distanceM }
    var elapsedSeconds: Double { elapsedS }
    var cyclingSpeedMetersPerSecond: Double? { cyclingSpeedMPS }
}

/// App-local live cycling values. This is deliberately not a canonical
/// contract or a delivery receipt; the WatchConnectivity adapter wraps it in
/// a separate closed local envelope before sending it to the paired iPhone.
struct WatchCyclingMetricSnapshot: Equatable, Sendable {
    let workoutID: String
    let observedAt: Date
    let heartRateBPM: Double?
    let activeEnergyKcal: Double?
    let distanceM: Double?
    let elapsedS: Double
    let cadenceSPM: Double?
    let cyclingSpeedMPS: Double?
    let heartRateSampleAt: Date?
    let cadenceSampleAt: Date?
    let cyclingSpeedSampleAt: Date?
    var workoutOrigin: WatchCyclingWorkoutOrigin? = nil

    init(
        workoutID: String,
        observedAt: Date,
        heartRateBPM: Double?,
        activeEnergyKcal: Double?,
        distanceM: Double?,
        elapsedS: Double,
        cadenceSPM: Double?,
        cyclingSpeedMPS: Double?,
        heartRateSampleAt: Date? = nil,
        cadenceSampleAt: Date? = nil,
        cyclingSpeedSampleAt: Date? = nil
    ) {
        self.workoutID = workoutID
        self.observedAt = observedAt
        self.heartRateBPM = heartRateBPM
        self.activeEnergyKcal = activeEnergyKcal
        self.distanceM = distanceM
        self.elapsedS = elapsedS
        self.cadenceSPM = cadenceSPM
        self.cyclingSpeedMPS = cyclingSpeedMPS
        self.heartRateSampleAt = heartRateSampleAt
        self.cadenceSampleAt = cadenceSampleAt
        self.cyclingSpeedSampleAt = cyclingSpeedSampleAt
    }

    var distanceMeters: Double? { distanceM }
    var elapsedSeconds: Double { elapsedS }
    var cyclingSpeedMetersPerSecond: Double? { cyclingSpeedMPS }
}

enum WatchCyclingMetricMapper {
    static func snapshot(
        from values: WatchCyclingStatisticsValues,
        workoutID: String,
        observedAt: Date
    ) -> WatchCyclingMetricSnapshot? {
        guard !workoutID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              observedAt.timeIntervalSince1970.isFinite,
              values.elapsedS.isFinite,
              values.elapsedS >= 0 else {
            return nil
        }

        let heart = values.heartRateSampleAt.map { $0 <= observedAt } == true ? finiteNonNegative(values.heartRateBPM) : nil
        let cadence = fresh(values.cadenceSPM, at: values.cadenceSampleAt, observedAt: observedAt)
        let speed = fresh(values.cyclingSpeedMPS, at: values.cyclingSpeedSampleAt, observedAt: observedAt)
        return WatchCyclingMetricSnapshot(
            workoutID: workoutID,
            observedAt: observedAt,
            heartRateBPM: heart,
            activeEnergyKcal: finiteNonNegative(values.activeEnergyKcal),
            distanceM: finiteNonNegative(values.distanceM),
            elapsedS: values.elapsedS,
            cadenceSPM: cadence,
            cyclingSpeedMPS: speed,
            heartRateSampleAt: heart == nil ? nil : values.heartRateSampleAt,
            cadenceSampleAt: cadence == nil ? nil : values.cadenceSampleAt,
            cyclingSpeedSampleAt: speed == nil ? nil : values.cyclingSpeedSampleAt
        )
    }

    static func map(
        _ values: WatchCyclingStatisticsValues,
        workoutID: String,
        observedAt: Date
    ) -> WatchCyclingMetricSnapshot? {
        snapshot(from: values, workoutID: workoutID, observedAt: observedAt)
    }

    static func fresh(_ value: Double?, at sampleAt: Date?, observedAt: Date) -> Double? {
        guard let sampleAt, WatchCyclingMetricEnvelope.isFresh(sampleAt, at: observedAt) else { return nil }
        return finiteNonNegative(value)
    }

    private static func finiteNonNegative(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }
}

/// Reads only statistics whose HealthKit sample identifiers were reported by
/// the live builder. A missing statistic remains nil and is never synthesized.
private enum WatchCyclingHealthKitStatisticsReader {
    static func values(
        from builder: HKLiveWorkoutBuilder,
        collectedTypeIdentifiers: Set<String>
    ) -> WatchCyclingStatisticsValues {
        let heartRate = mostRecentValue(
            identifier: .heartRate,
            unit: HKUnit.count().unitDivided(by: .minute()),
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )
        let activeEnergy = cumulativeValue(
            identifier: .activeEnergyBurned,
            unit: .kilocalorie(),
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )
        let distance = cumulativeValue(
            identifier: .distanceCycling,
            unit: .meter(),
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )
        let cadence = mostRecentValue(
            identifier: .cyclingCadence,
            unit: HKUnit.count().unitDivided(by: .minute()),
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )
        let speed = mostRecentValue(
            identifier: .cyclingSpeed,
            unit: HKUnit.meter().unitDivided(by: .second()),
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )

        return WatchCyclingStatisticsValues(
            heartRateBPM: heartRate?.value,
            activeEnergyKcal: activeEnergy,
            distanceM: distance,
            elapsedS: builder.elapsedTime,
            cadenceSPM: cadence?.value,
            cyclingSpeedMPS: speed?.value,
            heartRateSampleAt: heartRate?.at,
            cadenceSampleAt: cadence?.at,
            cyclingSpeedSampleAt: speed?.at
        )
    }

    private static func statistics(
        identifier: HKQuantityTypeIdentifier,
        from builder: HKLiveWorkoutBuilder,
        collectedTypeIdentifiers: Set<String>
    ) -> HKStatistics? {
        guard let quantityType = HKObjectType.quantityType(
            forIdentifier: identifier
        ), collectedTypeIdentifiers.contains(quantityType.identifier) else {
            return nil
        }
        return builder.statistics(for: quantityType)
    }

    private static func mostRecentValue(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        from builder: HKLiveWorkoutBuilder,
        collectedTypeIdentifiers: Set<String>
    ) -> (value: Double, at: Date)? {
        guard let statistics = statistics(
            identifier: identifier,
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        ), let quantity = statistics.mostRecentQuantity(),
           let interval = statistics.mostRecentQuantityDateInterval() else { return nil }
        return (quantity.doubleValue(for: unit), interval.end)
    }

    private static func cumulativeValue(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        from builder: HKLiveWorkoutBuilder,
        collectedTypeIdentifiers: Set<String>
    ) -> Double? {
        statistics(
            identifier: identifier,
            from: builder,
            collectedTypeIdentifiers: collectedTypeIdentifiers
        )?.sumQuantity()?.doubleValue(for: unit)
    }
}

enum WatchWorkoutState: String, Equatable, Sendable {
    case idle
    case authorizing
    case starting
    case running
    case paused
    case discarded
    case stopping
    case saving
    case finished
    case unknownSave
    case failed

    var displayName: String {
        switch self {
        case .idle: return "未开始"
        case .authorizing: return "正在请求健康权限"
        case .starting: return "正在开始"
        case .running: return "骑行中"
        case .paused: return "已暂停"
        case .discarded: return "未保存"
        case .stopping: return "正在停止"
        case .saving: return "正在保存"
        case .finished: return "已保存到本机"
        case .unknownSave: return "保存状态未知"
        case .failed: return "训练失败"
        }
    }
}

enum WatchWorkoutStopPhase: String, Equatable, Sendable {
    case idle
    case sessionEndRequested
    case sessionEnded
    case collectionEnded
    case finishRequested
    case saved
    case unknownSave
}

/// A small synchronous state machine that makes the required HealthKit stop
/// ordering explicit and independently testable:
/// `session.end` -> `endCollection` -> `finishWorkout`.
final class WatchWorkoutStopStateMachine {
    private(set) var phase: WatchWorkoutStopPhase = .idle

    @discardableResult
    func beginStop() -> Bool {
        guard phase == .idle else { return false }
        phase = .sessionEndRequested
        return true
    }

    @discardableResult
    func markSessionEnded() -> Bool {
        guard phase == .sessionEndRequested else { return false }
        phase = .sessionEnded
        return true
    }

    @discardableResult
    func markCollectionEnded() -> Bool {
        guard phase == .sessionEnded else { return false }
        phase = .collectionEnded
        return true
    }

    @discardableResult
    func markFinishRequested() -> Bool {
        guard phase == .collectionEnded else { return false }
        phase = .finishRequested
        return true
    }

    @discardableResult
    func markSaved() -> Bool {
        guard phase == .finishRequested else { return false }
        phase = .saved
        return true
    }

    @discardableResult
    func markUnknownSave() -> Bool {
        guard phase == .finishRequested || phase == .collectionEnded else {
            return false
        }
        phase = .unknownSave
        return true
    }
}

struct WatchWorkoutSnapshot: Equatable, Sendable {
    let state: WatchWorkoutState
    let stopPhase: WatchWorkoutStopPhase
    let workoutID: String?
    let errorCode: String?

    static let initial = WatchWorkoutSnapshot(
        state: .idle,
        stopPhase: .idle,
        workoutID: nil,
        errorCode: nil
    )
}

enum WatchWorkoutCoordinatorError: LocalizedError, Equatable, Sendable {
    case unavailable
    case alreadyRunning
    case notRunning
    case authorizationDenied
    case sessionFailed

    var errorDescription: String? {
        switch self {
        case .unavailable: return "这块手表暂时不能记录骑行。"
        case .alreadyRunning: return "已有一次骑行正在进行。"
        case .notRunning: return "当前没有正在进行的骑行。"
        case .authorizationDenied: return "请允许依米把骑行存进「健康」。"
        case .sessionFailed: return "骑行没能开始，请再试一次。"
        }
    }
}

@MainActor
final class WatchWorkoutCoordinator: NSObject, ObservableObject,
    HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    @Published private(set) var snapshot = WatchWorkoutSnapshot.initial
    @Published private(set) var metricSnapshot: WatchCyclingMetricSnapshot?
    @Published private(set) var summary: WatchRideSummary?
    @Published private(set) var awaitingSaveDecision = false
    private var asksToSave = false
    private var saveDecision: CheckedContinuation<Bool, Never>?

    var onCyclingMetric: ((WatchCyclingMetricSnapshot, WatchCyclingWorkoutState?) -> Void)?

    private var stopRequested = false
    private var collectionStarted = false
    private var pendingEndedAt: Date?
    private var lifecycleStarted = false
    private let healthStore: HKHealthStore
    private var workoutSession: HKWorkoutSession?
    private var workoutBuilder: HKLiveWorkoutBuilder?
    private var stopMachine = WatchWorkoutStopStateMachine()
    private var activeWorkoutID: String?
    private var activeWorkoutOrigin: WatchCyclingWorkoutOrigin?
    private var collectedMetricTypeIdentifiers: Set<String> = []
    /// Bumped whenever a workout's resources are created or released: HealthKit callbacks of an earlier workout
    /// carry their generation and are ignored once it is stale.
    private nonisolated let workoutGenerationLock = NSLock()
    private nonisolated(unsafe) var workoutGeneration: UInt64 = 0

    /// The live statistics this app reads (the builder collects them; reading needs its own authorization).
    static let readTypes: Set<HKObjectType> = Set([
        HKQuantityTypeIdentifier.heartRate, .activeEnergyBurned, .distanceCycling, .cyclingCadence, .cyclingSpeed
    ].compactMap { HKObjectType.quantityType(forIdentifier: $0) })

    init(healthStore: HKHealthStore = HKHealthStore()) {
        self.healthStore = healthStore
        super.init()
    }

    func startWorkout(
        activityType: HKWorkoutActivityType = .cycling,
        startDate: Date = Date(),
        fromPhone: Bool = false
    ) async throws {
        let attemptID = UUID().uuidString.lowercased()
        let attemptOrigin: WatchCyclingWorkoutOrigin = fromPhone ? .phone : .watch
        switch snapshot.state {
        case .finished, .unknownSave, .failed, .discarded:
            // A finished or failed workout never blocks the next one.
            releaseWorkout()
        default:
            break
        }
        guard workoutSession == nil,
              snapshot.state != .authorizing, snapshot.state != .starting else {
            emitAttemptFailure(workoutID: attemptID, origin: attemptOrigin)
            throw WatchWorkoutCoordinatorError.alreadyRunning
        }
        activeWorkoutID = attemptID
        activeWorkoutOrigin = attemptOrigin
        guard HKHealthStore.isHealthDataAvailable() else {
            emitAttemptFailure(workoutID: attemptID, origin: attemptOrigin)
            activeWorkoutID = nil
            activeWorkoutOrigin = nil
            transition(.failed, errorCode: "healthkit_unavailable")
            throw WatchWorkoutCoordinatorError.unavailable
        }

        stopRequested = false
        summary = nil
        asksToSave = false
        transition(.authorizing, errorCode: nil)
        do {
            try await requestAuthorization()
        } catch {
            emitAttemptFailure(workoutID: attemptID, origin: attemptOrigin)
            activeWorkoutID = nil
            activeWorkoutOrigin = nil
            transition(.failed, errorCode: "authorization_failed")
            throw WatchWorkoutCoordinatorError.authorizationDenied
        }
        guard workoutSession == nil, snapshot.state == .authorizing else {
            throw WatchWorkoutCoordinatorError.alreadyRunning
        }

        if stopRequested {
            emitAttemptFailure(workoutID: attemptID, origin: attemptOrigin)
            activeWorkoutID = nil
            activeWorkoutOrigin = nil
            transition(.idle, errorCode: nil)
            return
        }

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = activityType
        configuration.locationType = .outdoor

        let session: HKWorkoutSession
        do {
            session = try HKWorkoutSession(
                healthStore: healthStore,
                configuration: configuration
            )
        } catch {
            emitAttemptFailure(workoutID: attemptID, origin: attemptOrigin)
            activeWorkoutID = nil
            activeWorkoutOrigin = nil
            transition(.failed, errorCode: "session_create_failed")
            throw WatchWorkoutCoordinatorError.sessionFailed
        }

        let builder = session.associatedWorkoutBuilder()
        session.delegate = self
        builder.delegate = self
        builder.dataSource = HKLiveWorkoutDataSource(
            healthStore: healthStore,
            workoutConfiguration: configuration
        )
        let generation = workoutGenerationLock.withLock {
            workoutGeneration &+= 1
            return workoutGeneration
        }
        workoutSession = session
        workoutBuilder = builder
        stopMachine = WatchWorkoutStopStateMachine()
        collectedMetricTypeIdentifiers.removeAll(keepingCapacity: true)
        metricSnapshot = nil
        transition(.starting, errorCode: nil)

        session.startActivity(with: startDate)
        builder.beginCollection(withStart: startDate) { [weak self] success, error in
            Task { @MainActor [weak self] in
                guard let self, generation == self.workoutGeneration else { return }
                guard success, error == nil else {
                    self.failWorkout(errorCode: "collection_begin_failed")
                    return
                }
                self.collectionStarted = true
                if let endedAt = self.pendingEndedAt {
                    self.handleEndedSession(at: endedAt)
                    self.pendingEndedAt = nil
                } else if self.stopRequested { self.stopWorkout() }
            }
        }
    }

    func stopWorkout(endDate: Date = Date(), askToSave: Bool = false) {
        guard snapshot.state == .authorizing || snapshot.state == .starting || snapshot.state == .running || snapshot.state == .paused,
              stopMachine.phase == .idle else { return }
        asksToSave = askToSave
        stopRequested = true
        // Authorization can be cancelled without creating a session. Once created,
        // wait for collection to begin so ending still follows the saving contract.
        guard collectionStarted, let workoutSession, stopMachine.beginStop() else { return }
        transition(.stopping, errorCode: nil)
        workoutSession.end()
    }

    var elapsedTime: TimeInterval { workoutBuilder?.elapsedTime ?? metricSnapshot?.elapsedS ?? 0 }

    func togglePause() {
        if snapshot.state == .running { workoutSession?.pause() }
        else if snapshot.state == .paused { workoutSession?.resume() }
    }

    func decideSave(_ save: Bool) {
        awaitingSaveDecision = false
        saveDecision?.resume(returning: save)
        saveDecision = nil
    }

    /// A queued stop must not end a newer local workout.
    func stopWorkout(ifMatching workoutID: String?) -> Bool {
        guard workoutID == nil || workoutID == activeWorkoutID else { return false }
        stopWorkout()
        return true
    }

    func resetAfterTerminalState() {
        guard snapshot.state == .finished || snapshot.state == .unknownSave || snapshot.state == .failed || snapshot.state == .discarded
        else { return }
        releaseWorkout()
        snapshot = .initial
    }

    /// Drops the finished or failed workout's session and builder (the terminal snapshot stays on screen).
    private func releaseWorkout() {
        workoutSession?.delegate = nil
        workoutBuilder?.delegate = nil
        workoutSession = nil
        workoutBuilder = nil
        activeWorkoutID = nil
        activeWorkoutOrigin = nil
        stopRequested = false
        asksToSave = false
        decideSave(false)
        collectionStarted = false
        pendingEndedAt = nil
        lifecycleStarted = false
        collectedMetricTypeIdentifiers.removeAll(keepingCapacity: true)
        metricSnapshot = nil
        stopMachine = WatchWorkoutStopStateMachine()
        workoutGenerationLock.withLock { workoutGeneration &+= 1 }
    }

    /// A failed workout ends its system session and discards its builder, so nothing keeps running without a
    /// stop control, and becomes restartable.
    private func failWorkout(errorCode: String) {
        emitTerminalLifecycle(at: Date())
        if let session = workoutSession, session.state != .ended, session.state != .notStarted {
            session.end()
        }
        workoutBuilder?.discardWorkout()
        releaseWorkout()
        updateStopSnapshot(state: .failed, workoutID: nil, errorCode: errorCode)
    }

    private func requestAuthorization() async throws {
        let workoutType = HKObjectType.workoutType()
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            // Writing the workout and reading its live statistics are separate grants.
            healthStore.requestAuthorization(
                toShare: [workoutType],
                read: Self.readTypes
            ) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: WatchWorkoutCoordinatorError.authorizationDenied
                    )
                }
            }
        }
    }

    private func transition(_ state: WatchWorkoutState, errorCode: String?) {
        snapshot = WatchWorkoutSnapshot(
            state: state,
            stopPhase: stopMachine.phase,
            workoutID: snapshot.workoutID,
            errorCode: errorCode
        )
    }

    private func updateStopSnapshot(
        state: WatchWorkoutState,
        workoutID: String?,
        errorCode: String?
    ) {
        snapshot = WatchWorkoutSnapshot(
            state: state,
            stopPhase: stopMachine.phase,
            workoutID: workoutID,
            errorCode: errorCode
        )
    }

    private func handleEndedSession(at date: Date) {
        guard stopMachine.phase == .idle || stopMachine.phase == .sessionEndRequested else { return }
        emitTerminalLifecycle(at: date)
        transition(.stopping, errorCode: nil)
        guard collectionStarted else {
            pendingEndedAt = date
            return
        }
        if stopMachine.phase == .idle { _ = stopMachine.beginStop() }
        guard stopMachine.markSessionEnded(),
              let builder = workoutBuilder else {
            return
        }
        let generation = workoutGeneration

        builder.endCollection(withEnd: date) { [weak self] success, error in
            Task { @MainActor [weak self] in
                guard let self, generation == self.workoutGeneration else { return }
                guard success, error == nil,
                      self.stopMachine.markCollectionEnded() else {
                    _ = self.stopMachine.markUnknownSave()
                    self.updateStopSnapshot(
                        state: .unknownSave,
                        workoutID: nil,
                        errorCode: "collection_end_unknown"
                    )
                    self.activeWorkoutID = nil
                    self.activeWorkoutOrigin = nil
                    return
                }

                if self.asksToSave {
                    self.awaitingSaveDecision = true
                    let save = await withCheckedContinuation { self.saveDecision = $0 }
                    guard generation == self.workoutGeneration else { return }
                    if !save {
                        builder.discardWorkout()
                        self.releaseWorkout()
                        self.updateStopSnapshot(state: .discarded, workoutID: nil, errorCode: nil)
                        return
                    }
                }
                guard self.stopMachine.markFinishRequested() else { return }
                self.updateStopSnapshot(
                    state: .saving,
                    workoutID: nil,
                    errorCode: nil
                )
                builder.finishWorkout { [weak self] workout, error in
                    Task { @MainActor [weak self] in
                        guard let self, generation == self.workoutGeneration else { return }
                        if let workout {
                            self.summary = self.activeWorkoutID.map { WatchRideSummary(workoutID: $0, workout: workout) }
                            _ = self.stopMachine.markSaved()
                            self.updateStopSnapshot(
                                state: .finished,
                                workoutID: workout.uuid.uuidString,
                                errorCode: nil
                            )
                            self.activeWorkoutID = nil
                            self.activeWorkoutOrigin = nil
                        } else {
                            _ = self.stopMachine.markUnknownSave()
                            self.updateStopSnapshot(
                                state: .unknownSave,
                                workoutID: nil,
                                errorCode: error == nil
                                    ? "finish_without_workout"
                                    : "finish_unknown"
                            )
                            self.activeWorkoutID = nil
                            self.activeWorkoutOrigin = nil
                        }
                    }
                }
            }
        }
    }

    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        guard toState == .running || toState == .paused || toState == .ended else { return }
        let source = ObjectIdentifier(workoutSession)
        Task { @MainActor [weak self] in
            guard let self, let current = self.workoutSession, ObjectIdentifier(current) == source else { return }
            if toState == .paused {
                self.transition(.paused, errorCode: nil)
            } else if toState == .running {
                guard self.pendingEndedAt == nil,
                      self.stopMachine.phase == .idle || self.stopMachine.phase == .sessionEndRequested else { return }
                self.emitLifecycle(.started, at: date)
                if self.stopMachine.phase == .idle {
                    self.transition(.running, errorCode: nil)
                }
            } else {
                self.handleEndedSession(at: date)
            }
        }
    }

    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didFailWithError error: Error
    ) {
        let source = ObjectIdentifier(workoutSession)
        Task { @MainActor [weak self] in
            guard let self, let current = self.workoutSession, ObjectIdentifier(current) == source else { return }
            self.failWorkout(errorCode: "session_failed")
        }
    }

    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        recoveryStartDate: Date
    ) {
        // HealthKit may request recovery; no silent auto-resume is performed.
    }

    nonisolated func workoutBuilderDidCollectEvent(
        _ workoutBuilder: HKLiveWorkoutBuilder
    ) {
        let generation = workoutGenerationLock.withLock { workoutGeneration }
        Task { @MainActor [weak self] in
            guard let self, generation == self.workoutGeneration,
                  workoutBuilder === self.workoutBuilder else { return }
            self.publishMetricSnapshot(from: workoutBuilder)
        }
    }

    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder,
        didCollectDataOf types: Set<HKSampleType>
    ) {
        let generation = workoutGenerationLock.withLock { workoutGeneration }
        let collectedIdentifiers = Set(types.map(\.identifier))
        Task { @MainActor [weak self] in
            guard let self, generation == self.workoutGeneration,
                  workoutBuilder === self.workoutBuilder else { return }
            self.collectedMetricTypeIdentifiers.formUnion(collectedIdentifiers)
            self.publishMetricSnapshot(from: workoutBuilder)
        }
    }

    private func publishMetricSnapshot(from builder: HKLiveWorkoutBuilder) {
        guard snapshot.state == .running,
              let workoutID = activeWorkoutID else {
            return
        }

        let values = WatchCyclingHealthKitStatisticsReader.values(
            from: builder,
            collectedTypeIdentifiers: collectedMetricTypeIdentifiers
        )
        guard var metricSnapshot = WatchCyclingMetricMapper.snapshot(
            from: values,
            workoutID: workoutID,
            observedAt: Date()
        ) else {
            return
        }
        metricSnapshot.workoutOrigin = activeWorkoutOrigin
        self.metricSnapshot = metricSnapshot
        onCyclingMetric?(metricSnapshot, nil)
    }

    private func emitTerminalLifecycle(at date: Date) {
        guard pendingEndedAt == nil else { return }
        if !lifecycleStarted {
            if let startedAt = workoutSession?.startDate {
                emitLifecycle(.started, at: startedAt)
            } else if let workoutID = activeWorkoutID {
                emitAttemptFailure(workoutID: workoutID, origin: activeWorkoutOrigin, at: date)
                return
            }
        }
        emitLifecycle(.ended, at: date)
    }

    private func emitAttemptFailure(workoutID: String, origin: WatchCyclingWorkoutOrigin?, at date: Date = Date()) {
        var metric = WatchCyclingMetricSnapshot(
            workoutID: workoutID, observedAt: date, heartRateBPM: nil,
            activeEnergyKcal: nil, distanceM: nil, elapsedS: 0,
            cadenceSPM: nil, cyclingSpeedMPS: nil
        )
        metric.workoutOrigin = origin
        onCyclingMetric?(metric, .failed)
    }

    private func emitLifecycle(_ state: WatchCyclingWorkoutState, at date: Date) {
        guard let workoutID = activeWorkoutID, let builder = workoutBuilder else { return }
        if state == .started {
            guard !lifecycleStarted else { return }
            lifecycleStarted = true
            var metric = WatchCyclingMetricSnapshot(
                workoutID: workoutID, observedAt: date, heartRateBPM: nil,
                activeEnergyKcal: nil, distanceM: nil, elapsedS: 0,
                cadenceSPM: nil, cyclingSpeedMPS: nil
            )
            metric.workoutOrigin = activeWorkoutOrigin
            if metricSnapshot == nil { metricSnapshot = metric }
            onCyclingMetric?(metric, state)
            return
        } else {
            guard lifecycleStarted else { return }
            lifecycleStarted = false
        }
        let values = WatchCyclingHealthKitStatisticsReader.values(
            from: builder, collectedTypeIdentifiers: collectedMetricTypeIdentifiers
        )
        guard var metric = WatchCyclingMetricMapper.snapshot(
            from: values, workoutID: workoutID, observedAt: date
        ) else { return }
        metric.workoutOrigin = activeWorkoutOrigin
        metricSnapshot = metric
        onCyclingMetric?(metric, state)
    }
}
