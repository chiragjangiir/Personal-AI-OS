import XCTest
import HealthKit
@testable import HealthKitExporter

final class AssistantHealthSyncTests: XCTestCase {
    func testSparsePagesShareOneReceiptAndCommitOnlyTheirFinalAnchor() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sync = AssistantHealthSync(query: SparseHealthQuery(), defaults: defaults, metrics: [.heartRate])
        await sync.setEnabled(true, identity: "owner")
        do {
            _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { chunk in
                XCTAssertEqual(chunk.stored, 3)
                XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
                throw AssistantHealthFailure(code: "rejected")
            }
            XCTFail("A rejected coalesced receipt must retain the original anchor")
        } catch let failure as AssistantHealthFailure { XCTAssertEqual(failure.code, "HEALTH_PARTIAL") }
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
        let recorder = HealthChunkRecorder()
        _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { await recorder.append($0) }
        let chunks = await recorder.chunks
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(chunks.first?.stored, 3)
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([3]))
    }

    func testCallYieldDoesNotQueryOrAdvanceBulkAnchors() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let query = HealthSyncQuery()
        let sync = AssistantHealthSync(query: query, defaults: defaults, metrics: [.heartRate])
        await sync.setEnabled(true, identity: "owner")
        let more = try await sync.sync(identity: "owner", maximumBytes: 15_000, allowBulk: { false }) { _ in
            XCTFail("Bulk packets must yield during a call")
        }
        XCTAssertTrue(more)
        let anchors = await query.anchors
        XCTAssertTrue(anchors.isEmpty)
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
        _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in }
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([1]))
    }

    func testCallBeginningDuringQueryDefersThePageUntilCallEnds() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let query = SuspendedHealthQuery(), admission = HealthBulkAdmission()
        let sync = AssistantHealthSync(query: query, defaults: defaults, metrics: [.heartRate])
        let recorder = HealthChunkRecorder()
        await sync.setEnabled(true, identity: "owner")
        let bulk = Task {
            try await sync.sync(identity: "owner", maximumBytes: 15_000,
                allowBulk: { await admission.allowed }) { await recorder.append($0) }
        }
        await query.waitUntilSuspended()
        await admission.setAllowed(false)
        await query.resume()
        let more = try await bulk.value
        let deferred = await recorder.chunks
        XCTAssertTrue(more); XCTAssertTrue(deferred.isEmpty)
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
        await admission.setAllowed(true)
        _ = try await sync.sync(identity: "owner", maximumBytes: 15_000,
            allowBulk: { await admission.allowed }) { await recorder.append($0) }
        let resumed = await recorder.chunks
        XCTAssertEqual(resumed.count, 1)
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([2]))
    }

    func testFallInterruptFencesAnOrdinaryReceiptBeforeAnchorCommit() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sync = AssistantHealthSync(query: HealthSyncQuery(), defaults: defaults, metrics: [.heartRate, .numberOfTimesFallen])
        await sync.setEnabled(true, identity: "owner")
        do {
            _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in
                await sync.interruptForFall()
                _ = try await sync.sync(identity: "owner", maximumBytes: 15_000, urgentOnly: true,
                    allowBulk: { false }) { _ in }
            }
            XCTFail("The retired receipt must not advance the ordinary anchor")
        } catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.numberOfTimesFallen"), Data([1]))
    }

    func testFallPreemptsSuspendedQueryAndFencesItsAnchor() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let query = SuspendedHealthQuery()
        let sync = AssistantHealthSync(query: query, defaults: defaults, metrics: [.numberOfTimesFallen, .heartRate])
        await sync.setEnabled(true, identity: "owner")
        let bulk = Task { try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in } }
        await query.waitUntilSuspended()
        bulk.cancel()
        await sync.interruptForFall()
        let recorder = HealthChunkRecorder()
        _ = try await sync.sync(identity: "owner", maximumBytes: 15_000, urgentOnly: true,
            allowBulk: { false }) { await recorder.append($0) }
        let chunks = await recorder.chunks
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.numberOfTimesFallen"), Data([2]))
        await query.resume()
        do { _ = try await bulk.value; XCTFail("Interrupted query must be fenced") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.numberOfTimesFallen"), Data([2]))
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
    }

    func testCardiacEventCategoriesUseTheExistingAnchoredWire() throws {
        for metric in [HealthMetric.highHeartRateEvent, .lowHeartRateEvent, .irregularHeartRhythmEvent] {
            XCTAssertTrue(AssistantHealthSync.metrics.contains(metric))
            XCTAssertTrue(metric.sampleType is HKCategoryType)
            let record = HealthRecord(sampleType: metric.rawValue, sampleId: UUID(), start: Date(timeIntervalSince1970: 1000),
                end: Date(timeIntervalSince1970: 1001), value: .category(HKCategoryValue.notApplicable.rawValue), unit: "category-code",
                source: SourceInfo(name: "watch", bundleIdentifier: "watch", version: nil, productType: nil), device: nil, metadata: [:])
            let page = HealthQueryPage(records: [record], deletedRecords: [], newAnchor: Data([1]), rawChangeCount: 1)
            let chunk = try XCTUnwrap(AssistantHealthWire.chunks(page: page, metric: metric, maximumBytes: 12288).first)
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: chunk.bytes) as? [String: Any])
            XCTAssertEqual(fields["metric"] as? String, metric.rawValue)
            XCTAssertEqual(fields["unit"] as? String, "category-code")
            let samples = try XCTUnwrap(fields["samples"] as? [[String: Any]])
            XCTAssertEqual(samples.first?["c"] as? Int, 0); XCTAssertNil(samples.first?["v"])
        }
    }

    func testSourceAndDeletionPartitionNeverDropsSamples() throws {
        let records = (0..<70).map { healthRecord(source: "source.\($0)") }
        let deleted = (0..<140).map { _ in DeletedRecord(sampleType: "heart", sampleId: UUID()) }
        let page = HealthQueryPage(records: records, deletedRecords: deleted, newAnchor: Data([1]), rawChangeCount: 210)
        let chunks = try AssistantHealthWire.chunks(page: page, metric: .heartRate, maximumBytes: 2500)
        var ids: [String] = [], removed: [String] = []
        for chunk in chunks {
            XCTAssertLessThanOrEqual(chunk.bytes.count, 2500)
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: chunk.bytes) as? [String: Any])
            let sources = try XCTUnwrap(fields["sources"] as? [String])
            let samples = try XCTUnwrap(fields["samples"] as? [[String: Any]])
            XCTAssertLessThanOrEqual(sources.count, 16); XCTAssertLessThanOrEqual(samples.count, 64)
            ids += samples.compactMap { $0["id"] as? String }
            removed += fields["deleted"] as? [String] ?? []
            XCTAssertTrue(samples.allSatisfy { ($0["src"] as? Int).map { sources.indices.contains($0) } == true })
        }
        XCTAssertEqual(ids, records.map { $0.sampleId.uuidString.lowercased() })
        XCTAssertEqual(removed, deleted.map { $0.sampleId.uuidString.lowercased() })
    }

    func testActualGatewayReceiptAndReplayZeroCounts() throws {
        let chunk = AssistantHealthWire.Chunk(bytes: Data(), controlID: "health-test", stored: 2, deleted: 1)
        func packet(session: String = "session-test", stored: Int = 0, deleted: Int = 0) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
                "operation": "health_ack", "control_id": "health-test", "session_id": session,
                "schema_version": "paios.central.text-envelope.v1", "stored": stored, "deleted": deleted
            ]))
        }
        XCTAssertTrue(try chunk.matchesReceipt(packet().fields, sessionID: "session-test"))
        XCTAssertTrue(try chunk.matchesReceipt(packet(stored: 2, deleted: 1).fields, sessionID: "session-test"))
        XCTAssertFalse(try chunk.matchesReceipt(packet(session: "other").fields, sessionID: "session-test"))
        XCTAssertFalse(try chunk.matchesReceipt(packet(stored: 3).fields, sessionID: "session-test"))
    }

    func testFailedReceiptKeepsAnchorThenDurableReceiptAdvancesIt() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let query = HealthSyncQuery()
        let sync = AssistantHealthSync(query: query, defaults: defaults, metrics: [.heartRate])
        await sync.setEnabled(true, identity: "owner-a")
        do {
            _ = try await sync.sync(identity: "owner-a", maximumBytes: 15_000) { _ in throw AssistantHealthFailure(code: "rejected") }
            XCTFail("A rejected receipt must fail the page")
        } catch {}
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner-a.heartRate"))
        _ = try await sync.sync(identity: "owner-a", maximumBytes: 15_000) { _ in }
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner-a.heartRate"), Data([1]))
        _ = try await sync.sync(identity: "owner-a", maximumBytes: 15_000) { _ in }
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner-a.heartRate"), Data([2]))
        await sync.setEnabled(true, identity: "owner-b")
        _ = try await sync.sync(identity: "owner-b", maximumBytes: 15_000) { _ in }
        let seen = await query.anchors
        XCTAssertEqual(seen.count, 4)
        XCTAssertNil(seen[0]); XCTAssertNil(seen[1]); XCTAssertEqual(seen[2], Data([1])); XCTAssertNil(seen[3])
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner-a.heartRate"), Data([2]))
    }

    func testRevocationWhileWaitingForACKDoesNotAdvanceAnchor() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sync = AssistantHealthSync(query: HealthSyncQuery(), defaults: defaults, metrics: [.heartRate])
        await sync.setEnabled(true, identity: "owner")
        do {
            _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in
                await sync.setEnabled(false, identity: "owner")
            }
            XCTFail("Revoked sync must stop")
        } catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
        await sync.setEnabled(true, identity: "owner")
        let more = try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in }
        XCTAssertFalse(more)
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([1]))
    }

    func testOneFailedMetricDoesNotBlockLaterMetric() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sync = AssistantHealthSync(query: HealthSyncQuery(failSleep: true), defaults: defaults, metrics: [.sleepAnalysis, .heartRate])
        await sync.setEnabled(true, identity: "owner")
        do {
            _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { _ in }
            XCTFail("Partial sync must report the failed metric")
        } catch let failure as AssistantHealthFailure { XCTAssertEqual(failure.code, "HEALTH_PARTIAL") }
        XCTAssertNil(defaults.data(forKey: "health.anchor.owner.sleepAnalysis"))
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([1]))
    }

    func testEmptyQueryRequiresReceiptBeforeAnchorCommit() async throws {
        let suite = "HealthSyncTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sync = AssistantHealthSync(query: HealthSyncQuery(empty: true), defaults: defaults, metrics: [.heartRate])
        await sync.setEnabled(true, identity: "owner")
        let recorder = HealthChunkRecorder()
        _ = try await sync.sync(identity: "owner", maximumBytes: 15_000) { chunk in
            XCTAssertNil(defaults.data(forKey: "health.anchor.owner.heartRate"))
            await recorder.append(chunk)
        }
        let chunks = await recorder.chunks
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(chunks.first?.stored, 0)
        XCTAssertEqual(defaults.data(forKey: "health.anchor.owner.heartRate"), Data([2]))
    }
}

private actor HealthChunkRecorder {
    var chunks: [AssistantHealthWire.Chunk] = []
    func append(_ chunk: AssistantHealthWire.Chunk) { chunks.append(chunk) }
}
private actor HealthSyncQuery: HealthQuerying {
    var anchors: [Data?] = []
    let empty: Bool
    let failSleep: Bool
    init(empty: Bool = false, failSleep: Bool = false) { self.empty = empty; self.failSleep = failSleep }
    func incrementalPage(for metric: HealthMetric, anchor: Data?, startDate: Date, limit: Int) async throws -> HealthQueryPage {
        if failSleep && metric == .sleepAnalysis { throw AssistantHealthFailure(code: "HK_UNAVAILABLE") }
        anchors.append(anchor)
        XCTAssertEqual(startDate, Date(timeIntervalSince1970: 0)); XCTAssertEqual(limit, 64)
        if empty || anchor != nil { return HealthQueryPage(records: [], deletedRecords: [], newAnchor: Data([2]), rawChangeCount: 0) }
        return HealthQueryPage(records: [healthRecord(source: "watch")], deletedRecords: [], newAnchor: Data([1]), rawChangeCount: 1)
    }
    func bootstrapPage(for metric: HealthMetric, after date: Date) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
    func backfillPage(for metric: HealthMetric, start: Date, end: Date, cursor: Data?, limit: Int) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
}
private func healthRecord(source: String) -> HealthRecord {
    HealthRecord(sampleType: "heart", sampleId: UUID(), start: Date(timeIntervalSince1970: 1000),
        end: Date(timeIntervalSince1970: 1001), value: .numeric(70), unit: "count/min",
        source: SourceInfo(name: source, bundleIdentifier: source, version: nil, productType: nil), device: nil, metadata: [:])
}

private actor SparseHealthQuery: HealthQuerying {
    func incrementalPage(for metric: HealthMetric, anchor: Data?, startDate: Date, limit: Int) async throws -> HealthQueryPage {
        let page = Int(anchor?.first ?? 0) + 1
        return HealthQueryPage(records: [healthRecord(source: "watch")], deletedRecords: [],
            newAnchor: Data([UInt8(page)]), rawChangeCount: page < 3 ? 64 : 1)
    }
    func bootstrapPage(for metric: HealthMetric, after date: Date) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
    func backfillPage(for metric: HealthMetric, start: Date, end: Date, cursor: Data?, limit: Int) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
}

private actor SuspendedHealthQuery: HealthQuerying {
    private var first = true
    private var pending: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    func waitUntilSuspended() async {
        if pending == nil { await withCheckedContinuation { started = $0 } }
    }
    func resume() { pending?.resume(); pending = nil }
    func incrementalPage(for metric: HealthMetric, anchor: Data?, startDate: Date, limit: Int) async throws -> HealthQueryPage {
        let index: UInt8 = first ? 1 : 2
        if first {
            first = false
            await withCheckedContinuation { pending = $0; started?.resume(); started = nil }
        }
        return HealthQueryPage(records: [healthRecord(source: "watch")], deletedRecords: [], newAnchor: Data([index]), rawChangeCount: 1)
    }
    func bootstrapPage(for metric: HealthMetric, after date: Date) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
    func backfillPage(for metric: HealthMetric, start: Date, end: Date, cursor: Data?, limit: Int) async throws -> HealthQueryPage { throw CentralTextError.unavailable }
}

private actor HealthBulkAdmission {
    var allowed = true
    func setAllowed(_ value: Bool) { allowed = value }
}
