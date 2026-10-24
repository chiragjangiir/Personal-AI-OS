import Foundation
import XCTest
@testable import HealthKitExporter

final class PersistenceSyncTests: XCTestCase {
    func testAnchorCommitsOnlyAfterDurableOutboxEnqueue() async throws {
        let recorder = EventRecorder()
        let query = FakeHealthQueryService(recorder: recorder)
        let anchors = FakeAnchorStore(recorder: recorder)
        let outbox = FakeOutboxStore(recorder: recorder)
        await query.setBootstrap(
            metric: .restingHeartRate,
            result: .success(makePage(anchor: "next", rawCount: 0))
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        try await coordinator.queueIncremental(metric: .restingHeartRate)

        let events = await recorder.values()
        XCTAssertEqual(events, ["query", "outbox", "anchor"])
        let saved = await anchors.value(for: HealthMetric.restingHeartRate.rawValue)
        XCTAssertEqual(saved, Data("next".utf8))
    }

    func testAnchorDoesNotCommitWhenOutboxEnqueueFails() async throws {
        let recorder = EventRecorder()
        let query = FakeHealthQueryService(recorder: recorder)
        let anchors = FakeAnchorStore(recorder: recorder)
        let outbox = FakeOutboxStore(recorder: recorder)
        await outbox.setEnqueueError(TestFailure.expected)
        await query.setBootstrap(
            metric: .restingHeartRate,
            result: .success(makePage(anchor: "next", rawCount: 0))
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        do {
            try await coordinator.queueIncremental(metric: .restingHeartRate)
            XCTFail("Expected enqueue failure")
        } catch TestFailure.expected {
        }

        let events = await recorder.values()
        XCTAssertEqual(events, ["query", "outbox"])
        let saved = await anchors.value(for: HealthMetric.restingHeartRate.rawValue)
        XCTAssertNil(saved)
    }

    func testDeletedHealthKitObjectsArePersistedInPayload() async throws {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        let deletion = DeletedRecord(
            sampleType: "HKQuantityTypeIdentifierRestingHeartRate",
            sampleId: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        )
        await query.setBootstrap(
            metric: .restingHeartRate,
            result: .success(
                HealthQueryPage(
                    records: [],
                    deletedRecords: [deletion],
                    newAnchor: Data("delete-anchor".utf8),
                    rawChangeCount: 1
                )
            )
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        try await coordinator.queueIncremental(metric: .restingHeartRate)

        let items = await outbox.allItems()
        let item = try XCTUnwrap(items.first)
        let batch = try JSONPayloadEncoder().decode(item.payload)
        XCTAssertEqual(batch.records, [])
        XCTAssertEqual(batch.deletedRecords, [deletion])
    }

    func testFailureForOneTypeDoesNotBlockOtherTypes() async {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        await query.setBootstrap(
            metric: .heartRateVariabilitySDNN,
            result: .failure(TestFailure.expected)
        )
        await query.setBootstrap(
            metric: .restingHeartRate,
            result: .success(makePage(anchor: "resting", rawCount: 0))
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        let result = await coordinator.queueIncremental(
            metrics: [.heartRateVariabilitySDNN, .restingHeartRate]
        )

        XCTAssertNotNil(result.failures[HealthMetric.heartRateVariabilitySDNN.rawValue])
        XCTAssertEqual(result.completedMetricKeys, [HealthMetric.restingHeartRate.rawValue])
        let restingAnchor = await anchors.value(for: HealthMetric.restingHeartRate.rawValue)
        XCTAssertEqual(restingAnchor, Data("resting".utf8))
    }

    func testDuplicateRetryUsesSameBatchAndRemovesOnlyAfterAcceptance() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = TestClock(now)
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader(
            dispositions: [
                .retryable(message: "HTTP 503", retryAfter: nil),
                .accepted
            ]
        )
        let batchID = UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!
        await outbox.seed(
            OutboxItem(
                batchId: batchID,
                payload: Data("payload".utf8),
                requiredMetricKeys: [HealthMetric.restingHeartRate.rawValue],
                createdAt: now,
                attemptCount: 0,
                nextAttemptAt: .distantPast,
                permanentFailure: false,
                lastError: nil
            )
        )
        let coordinator = makeCoordinator(
            outbox: outbox,
            uploader: uploader,
            now: { clock.value() },
            jitter: { 0 }
        )

        try await coordinator.uploadPending(includePermanent: false)
        let countAfterFailure = await outbox.itemCount()
        XCTAssertEqual(countAfterFailure, 1)

        clock.advance(by: 60)
        try await coordinator.uploadPending(includePermanent: false)

        let uploadedIDs = await uploader.uploadedBatchIDs()
        XCTAssertEqual(uploadedIDs, [batchID, batchID])
        let countAfterAcceptance = await outbox.itemCount()
        XCTAssertEqual(countAfterAcceptance, 0)
    }

    func testUnavailableBackendDefersUploadsWithoutMutatingQueueItems() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader()
        let availability = FakeBackendAvailabilityChecker(available: false)
        let statusStore = FakeStatusStore()
        let item = OutboxItem(
            batchId: UUID(),
            payload: Data("payload".utf8),
            requiredMetricKeys: [HealthMetric.restingHeartRate.rawValue],
            createdAt: now,
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            permanentFailure: false,
            lastError: nil
        )
        await outbox.seed(item)
        let coordinator = makeCoordinator(
            outbox: outbox,
            backendAvailabilityChecker: availability,
            uploader: uploader,
            statusStore: statusStore,
            now: { now }
        )

        try await coordinator.uploadPending(includePermanent: false)

        let uploadedBatchIDs = await uploader.uploadedBatchIDs()
        let remainingItems = await outbox.allItems()
        let checkedEndpoints = await availability.checkedEndpoints()
        XCTAssertEqual(uploadedBatchIDs, [])
        XCTAssertEqual(remainingItems, [item])
        XCTAssertEqual(
            checkedEndpoints,
            [URL(string: "https://example.test/v1/healthkit/ingest")!]
        )
        let status = await statusStore.current()
        XCTAssertEqual(status.lastBackendReachabilityCheck, now)
        XCTAssertEqual(status.backendReachable, false)
        XCTAssertEqual(status.pendingOutboxBatches, 1)
    }

    func testQueuedOptionalMetricIsBlockedWithoutMatchingConsentScope() async throws {
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader()
        let batchID = UUID()
        await outbox.seed(
            OutboxItem(
                batchId: batchID,
                payload: Data("sensitive-payload".utf8),
                requiredMetricKeys: [HealthMetric.oxygenSaturation.rawValue],
                createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                attemptCount: 0,
                nextAttemptAt: .distantPast,
                permanentFailure: false,
                lastError: nil
            )
        )
        let coordinator = makeCoordinator(outbox: outbox, uploader: uploader)

        try await coordinator.uploadPending(includePermanent: false)

        let uploadedIDs = await uploader.uploadedBatchIDs()
        XCTAssertEqual(uploadedIDs, [])
        let remainingItems = await outbox.allItems()
        let item = try XCTUnwrap(remainingItems.first)
        XCTAssertTrue(item.permanentFailure)
    }

    func testWorkoutQueuesBoundedMeasurementsBeforeCommittingWorkoutAnchor() async throws {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        await anchors.seed(
            Data("existing-workout-anchor".utf8),
            for: HealthMetric.workout.rawValue
        )
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let source = SourceInfo(
            name: "Health",
            bundleIdentifier: "com.apple.health",
            version: nil,
            productType: nil
        )
        let workout = HealthRecord(
            sampleType: "HKWorkoutTypeIdentifier",
            sampleId: UUID(),
            start: start,
            end: start.addingTimeInterval(3_600),
            value: .workout(
                WorkoutValue(
                    activityType: 37,
                    durationSeconds: 3_600,
                    totalEnergyKilocalories: 500,
                    totalDistanceMeters: 10_000
                )
            ),
            unit: "workout",
            source: source,
            device: nil,
            metadata: [:]
        )
        let heartRate = HealthRecord(
            sampleType: "HKQuantityTypeIdentifierHeartRate",
            sampleId: UUID(),
            start: start.addingTimeInterval(60),
            end: start.addingTimeInterval(60),
            value: .numeric(140),
            unit: "count/min",
            source: source,
            device: nil,
            metadata: [:]
        )
        await query.setIncremental(
            metric: .workout,
            results: [
                .success(
                    HealthQueryPage(
                        records: [workout],
                        deletedRecords: [],
                        newAnchor: Data("workout-anchor".utf8),
                        rawChangeCount: 1
                    )
                )
            ]
        )
        await query.setBackfill(
            metric: .heartRate,
            results: [
                .success(
                    HealthQueryPage(
                        records: [heartRate],
                        deletedRecords: [],
                        newAnchor: Data("heart-rate-page".utf8),
                        rawChangeCount: 1
                    )
                )
            ]
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        try await coordinator.queueIncremental(metric: .workout)

        let items = await outbox.allItems()
        XCTAssertEqual(items.count, 2)
        let metricScopes = items.map(\.requiredMetricKeys)
        XCTAssertTrue(metricScopes.contains([HealthMetric.workout.rawValue]))
        XCTAssertTrue(metricScopes.contains([HealthMetric.heartRate.rawValue]))
        let savedAnchor = await anchors.value(for: HealthMetric.workout.rawValue)
        XCTAssertEqual(savedAnchor, Data("workout-anchor".utf8))
    }

    func testIncrementalCatchupStopsAfterConfiguredPageLimit() async throws {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        await anchors.seed(
            Data("existing-step-anchor".utf8),
            for: HealthMetric.stepCount.rawValue
        )
        await query.setIncremental(
            metric: .stepCount,
            results: [
                .success(makePage(anchor: "first-page", rawCount: 100)),
                .success(makePage(anchor: "second-page", rawCount: 100))
            ]
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox,
            maximumIncrementalPagesPerMetric: 1
        )

        let hasMoreChanges = try await coordinator.queueIncremental(
            metric: .stepCount
        )

        XCTAssertTrue(hasMoreChanges)
        let queryCount = await query.incrementalQueryCount(for: .stepCount)
        XCTAssertEqual(queryCount, 1)
        let savedAnchor = await anchors.value(for: HealthMetric.stepCount.rawValue)
        XCTAssertEqual(savedAnchor, Data("first-page".utf8))
    }

    func testInitialIncrementalSyncBootstrapsWithoutReadingHistory() async throws {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        await query.setBootstrap(
            metric: .stepCount,
            result: .success(
                makePage(anchor: "current-state-anchor", rawCount: 0)
            )
        )
        await query.setIncremental(
            metric: .stepCount,
            results: [.success(makePage(anchor: "historical-page", rawCount: 100))]
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox
        )

        let hasMoreChanges = try await coordinator.queueIncremental(
            metric: .stepCount
        )

        XCTAssertFalse(hasMoreChanges)
        let historicalQueryCount = await query.incrementalQueryCount(for: .stepCount)
        XCTAssertEqual(historicalQueryCount, 0)
        let savedAnchor = await anchors.value(for: HealthMetric.stepCount.rawValue)
        XCTAssertEqual(savedAnchor, Data("current-state-anchor".utf8))
        let items = await outbox.allItems()
        XCTAssertEqual(items.count, 1)
    }

    func testBootstrapAndIncrementalQueriesReuseExactNormalizedPredicate() async throws {
        let query = FakeHealthQueryService()
        let anchors = FakeAnchorStore()
        let fractionalNow = Date(timeIntervalSince1970: 1_700_000_000.987_654)
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            now: { fractionalNow }
        )

        _ = try await coordinator.queueIncremental(metric: .stepCount)
        _ = try await coordinator.queueIncremental(metric: .stepCount)

        let bootstrapDate = await query.bootstrapDate(for: .stepCount)
        let incrementalDate = await query.incrementalStartDate(for: .stepCount)
        let expected = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(bootstrapDate, expected)
        XCTAssertEqual(incrementalDate, expected)
    }

    func testPendingUploadAttemptsAreBoundedPerRun() async throws {
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader(
            dispositions: Array(repeating: .accepted, count: 3)
        )
        for index in 0..<3 {
            await outbox.seed(
                OutboxItem(
                    batchId: UUID(),
                    payload: Data("payload-\(index)".utf8),
                    requiredMetricKeys: [],
                    createdAt: Date(timeIntervalSince1970: Double(index)),
                    attemptCount: 0,
                    nextAttemptAt: .distantPast,
                    permanentFailure: false,
                    lastError: nil
                )
            )
        }
        let coordinator = makeCoordinator(
            outbox: outbox,
            uploader: uploader,
            maximumUploadsPerRun: 2
        )

        try await coordinator.uploadPending(includePermanent: false)

        let uploaded = await uploader.uploadedBatchIDs()
        XCTAssertEqual(uploaded.count, 2)
        let remaining = await outbox.itemCount()
        XCTAssertEqual(remaining, 1)
    }

    func testConcurrentUploadRequestsDoNotUploadTheSameBatchTwice() async throws {
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader(
            dispositions: Array(repeating: .accepted, count: 4),
            delayNanoseconds: 100_000_000
        )
        for index in 0..<2 {
            await outbox.seed(
                OutboxItem(
                    batchId: UUID(),
                    payload: Data("payload-\(index)".utf8),
                    requiredMetricKeys: [],
                    createdAt: Date(timeIntervalSince1970: Double(index)),
                    attemptCount: 0,
                    nextAttemptAt: .distantPast,
                    permanentFailure: false,
                    lastError: nil
                )
            )
        }
        let coordinator = makeCoordinator(
            outbox: outbox,
            uploader: uploader,
            maximumUploadsPerRun: 2
        )

        async let first: Void = coordinator.uploadPending(includePermanent: false)
        async let second: Void = coordinator.uploadPending(includePermanent: false)
        _ = try await (first, second)

        let uploaded = await uploader.uploadedBatchIDs()
        XCTAssertEqual(uploaded.count, 2)
        XCTAssertEqual(Set(uploaded).count, 2)
        let maximumConcurrentUploads = await uploader.maximumConcurrentUploads()
        XCTAssertEqual(maximumConcurrentUploads, 1)
    }

    func testFileOutboxKeepsFirstExactPayloadForDeterministicBatch() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let outbox = FileOutboxStore(root: root)
        let id = UUID()
        let first = Data("first".utf8)

        let firstInsert = try await outbox.enqueue(
            batchId: id,
            payload: first,
            requiredMetricKeys: [HealthMetric.restingHeartRate.rawValue],
            createdAt: Date()
        )
        let duplicateInsert = try await outbox.enqueue(
            batchId: id,
            payload: Data("second".utf8),
            requiredMetricKeys: [HealthMetric.restingHeartRate.rawValue],
            createdAt: Date().addingTimeInterval(1)
        )
        XCTAssertTrue(firstInsert)
        XCTAssertFalse(duplicateInsert)
        let items = try await outbox.pending(
            now: Date(),
            includePermanent: true,
            limit: 1
        )
        XCTAssertEqual(items.first?.payload, first)
    }

    func testFileOutboxLoadsOnlyTheRequestedOldestPayloads() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let outbox = FileOutboxStore(root: root)
        var expected: [UUID] = []
        for index in 0..<5 {
            let id = UUID()
            if index < 2 {
                expected.append(id)
            }
            _ = try await outbox.enqueue(
                batchId: id,
                payload: Data(repeating: UInt8(index), count: 128_000),
                requiredMetricKeys: [],
                createdAt: Date(timeIntervalSince1970: Double(index))
            )
        }

        let items = try await outbox.pending(
            now: Date(),
            includePermanent: false,
            limit: 2
        )

        XCTAssertEqual(items.map(\.batchId), expected)
        XCTAssertEqual(items.reduce(0) { $0 + $1.payload.count }, 256_000)
    }

    func testBackendDataStatusCachePersistsOriginAndRetrievalTime() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FileBackendDataStatusStore(root: root)
        let generatedAt = Date(timeIntervalSince1970: 1_721_565_900)
        let cache = BackendDataStatusCache(
            destinationOrigin: "https://private.example",
            retrievedAt: generatedAt.addingTimeInterval(1),
            status: BackendDataStatusSnapshot(
                schemaVersion: 1,
                generatedAt: generatedAt,
                state: .empty,
                latestAcceptedBatchAt: nil,
                latestRecordAt: nil,
                activeRecordCount: 0,
                domains: BackendDataDomains(
                    recovery: BackendDataDomainStatus(
                        state: .empty,
                        recordCount: 0,
                        latestRecordAt: nil
                    ),
                    sleep: BackendDataDomainStatus(
                        state: .empty,
                        recordCount: 0,
                        latestRecordAt: nil
                    ),
                    activity: BackendDataDomainStatus(
                        state: .empty,
                        recordCount: 0,
                        latestRecordAt: nil
                    ),
                    workouts: BackendDataDomainStatus(
                        state: .empty,
                        recordCount: 0,
                        latestRecordAt: nil
                    )
                ),
                databaseSchemaVersion: 2,
                warnings: []
            )
        )

        try await store.save(cache)
        let loaded = try await store.load()

        XCTAssertEqual(loaded, cache)
    }
}

enum TestFailure: Error {
    case expected
}

actor EventRecorder {
    private var events: [String] = []

    func append(_ event: String) {
        events.append(event)
    }

    func values() -> [String] {
        events
    }
}

actor FakeHealthQueryService: HealthQuerying {
    private var bootstrap: [HealthMetric: Result<HealthQueryPage, Error>] = [:]
    private var incremental: [HealthMetric: [Result<HealthQueryPage, Error>]] = [:]
    private var backfill: [HealthMetric: [Result<HealthQueryPage, Error>]] = [:]
    private var backfillDelayNanoseconds: UInt64 = 0
    private var backfillExpectation: XCTestExpectation?
    private var incrementalQueryCounts: [HealthMetric: Int] = [:]
    private var bootstrapDates: [HealthMetric: Date] = [:]
    private var incrementalStartDates: [HealthMetric: Date] = [:]
    private let recorder: EventRecorder?

    init(recorder: EventRecorder? = nil) {
        self.recorder = recorder
    }

    func setBootstrap(
        metric: HealthMetric,
        result: Result<HealthQueryPage, Error>
    ) {
        bootstrap[metric] = result
    }

    func setIncremental(
        metric: HealthMetric,
        results: [Result<HealthQueryPage, Error>]
    ) {
        incremental[metric] = results
    }

    func setBackfill(
        metric: HealthMetric,
        results: [Result<HealthQueryPage, Error>]
    ) {
        backfill[metric] = results
    }

    func delayNextBackfill(
        nanoseconds: UInt64,
        expectation: XCTestExpectation
    ) {
        backfillDelayNanoseconds = nanoseconds
        backfillExpectation = expectation
    }

    func incrementalPage(
        for metric: HealthMetric,
        anchor: Data?,
        startDate: Date,
        limit: Int
    ) async throws -> HealthQueryPage {
        incrementalQueryCounts[metric, default: 0] += 1
        incrementalStartDates[metric] = startDate
        await recorder?.append("query")
        guard var results = incremental[metric], !results.isEmpty else {
            return makePage(anchor: "empty-\(metric.rawValue)", rawCount: 0)
        }
        let result = results.removeFirst()
        incremental[metric] = results
        return try result.get()
    }

    func bootstrapPage(
        for metric: HealthMetric,
        after date: Date
    ) async throws -> HealthQueryPage {
        bootstrapDates[metric] = date
        await recorder?.append("query")
        return try bootstrap[
            metric,
            default: .success(
                makePage(anchor: "bootstrap-\(metric.rawValue)", rawCount: 0)
            )
        ].get()
    }

    func incrementalQueryCount(for metric: HealthMetric) -> Int {
        incrementalQueryCounts[metric, default: 0]
    }

    func bootstrapDate(for metric: HealthMetric) -> Date? {
        bootstrapDates[metric]
    }

    func incrementalStartDate(for metric: HealthMetric) -> Date? {
        incrementalStartDates[metric]
    }

    func backfillPage(
        for metric: HealthMetric,
        start: Date,
        end: Date,
        cursor: Data?,
        limit: Int
    ) async throws -> HealthQueryPage {
        if let expectation = backfillExpectation {
            expectation.fulfill()
            backfillExpectation = nil
        }
        let delay = backfillDelayNanoseconds
        backfillDelayNanoseconds = 0
        if delay > 0 {
            try await Task.sleep(nanoseconds: delay)
        }
        guard var results = backfill[metric], !results.isEmpty else {
            return makePage(anchor: "backfill-empty", rawCount: 0)
        }
        let result = results.removeFirst()
        backfill[metric] = results
        return try result.get()
    }
}

actor FakeAnchorStore: AnchorStoring {
    private var anchors: [String: QueryAnchorState] = [:]
    private let recorder: EventRecorder?

    init(recorder: EventRecorder? = nil) {
        self.recorder = recorder
    }

    func state(for metricKey: String) -> QueryAnchorState? {
        anchors[metricKey]
    }

    func save(_ state: QueryAnchorState, for metricKey: String) async {
        await recorder?.append("anchor")
        anchors[metricKey] = state
    }

    func resetAll() {
        anchors.removeAll()
    }

    func storedMetricKeys() -> [String] {
        anchors.keys.sorted()
    }

    func value(for metricKey: String) -> Data? {
        anchors[metricKey]?.anchor
    }

    func seed(
        _ anchor: Data,
        for metricKey: String,
        predicateStart: Date = Date(timeIntervalSince1970: 1_600_000_000)
    ) {
        anchors[metricKey] = QueryAnchorState(
            anchor: anchor,
            predicateStart: predicateStart
        )
    }
}

actor FakeOutboxStore: OutboxStoring {
    private var items: [UUID: OutboxItem] = [:]
    private var enqueueError: Error?
    private let recorder: EventRecorder?

    init(recorder: EventRecorder? = nil) {
        self.recorder = recorder
    }

    func setEnqueueError(_ error: Error) {
        enqueueError = error
    }

    func seed(_ item: OutboxItem) {
        items[item.batchId] = item
    }

    func enqueue(
        batchId: UUID,
        payload: Data,
        requiredMetricKeys: [String],
        createdAt: Date
    ) async throws -> Bool {
        await recorder?.append("outbox")
        if let enqueueError {
            throw enqueueError
        }
        guard items[batchId] == nil else { return false }
        items[batchId] = OutboxItem(
            batchId: batchId,
            payload: payload,
            requiredMetricKeys: requiredMetricKeys,
            createdAt: createdAt,
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            permanentFailure: false,
            lastError: nil
        )
        return true
    }

    func pending(
        now: Date,
        includePermanent: Bool,
        limit: Int
    ) -> [OutboxItem] {
        Array(
            items.values
            .filter {
                includePermanent
                    ? true
                    : !$0.permanentFailure && $0.nextAttemptAt <= now
            }
            .sorted { $0.createdAt < $1.createdAt }
            .prefix(limit)
        )
    }

    func remove(batchId: UUID) {
        items[batchId] = nil
    }

    func markRetry(batchId: UUID, nextAttemptAt: Date, error: String) {
        guard var item = items[batchId] else { return }
        item.attemptCount += 1
        item.nextAttemptAt = nextAttemptAt
        item.permanentFailure = false
        item.lastError = error
        items[batchId] = item
    }

    func markPermanent(batchId: UUID, error: String) {
        guard var item = items[batchId] else { return }
        item.attemptCount += 1
        item.permanentFailure = true
        item.nextAttemptAt = .distantFuture
        item.lastError = error
        items[batchId] = item
    }

    func clear() {
        items.removeAll()
    }

    func count() -> Int {
        items.count
    }

    func allItems() -> [OutboxItem] {
        Array(items.values)
    }

    func itemCount() -> Int {
        items.count
    }
}

actor FakeUploader: Uploading {
    private var dispositions: [UploadDisposition]
    private var uploaded: [UUID] = []
    private let delayNanoseconds: UInt64
    private var activeUploads = 0
    private var peakActiveUploads = 0

    init(
        dispositions: [UploadDisposition] = [.accepted],
        delayNanoseconds: UInt64 = 0
    ) {
        self.dispositions = dispositions
        self.delayNanoseconds = delayNanoseconds
    }

    func upload(
        _ item: OutboxItem,
        endpoint: URL,
        token: String,
        now: Date
    ) async -> UploadDisposition {
        activeUploads += 1
        peakActiveUploads = max(peakActiveUploads, activeUploads)
        uploaded.append(item.batchId)
        if delayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: delayNanoseconds)
        }
        activeUploads -= 1
        guard !dispositions.isEmpty else { return .accepted }
        return dispositions.removeFirst()
    }

    func uploadedBatchIDs() -> [UUID] {
        uploaded
    }

    func maximumConcurrentUploads() -> Int {
        peakActiveUploads
    }
}

actor FakeBackendAvailabilityChecker: BackendAvailabilityChecking {
    private let available: Bool
    private var endpoints: [URL] = []

    init(available: Bool = true) {
        self.available = available
    }

    func isBackendAvailable(at ingestEndpoint: URL) -> Bool {
        endpoints.append(ingestEndpoint)
        return available
    }

    func checkedEndpoints() -> [URL] {
        endpoints
    }
}

actor FakeSettingsStore: SettingsStoring {
    private var settings: AppSettings
    private var consent: ConsentReceipt?

    init(settings: AppSettings = AppSettings(), consent: ConsentReceipt? = nil) {
        self.settings = settings
        self.consent = consent
    }

    func loadSettings() -> AppSettings {
        settings
    }

    func saveSettings(_ settings: AppSettings) {
        self.settings = settings
    }

    func loadConsent() -> ConsentReceipt? {
        consent
    }

    func saveConsent(_ receipt: ConsentReceipt?) {
        consent = receipt
    }
}

final class FakeCredentialStore: CredentialStoring, @unchecked Sendable {
    private let id: UUID
    private var token: String?

    init(
        token: String? = "test-token",
        id: UUID = UUID(uuidString: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC")!
    ) {
        self.token = token
        self.id = id
    }

    func apiToken() -> String? {
        token
    }

    func apiToken(for origin: String) -> String? {
        apiToken()
    }

    func setAPIToken(_ token: String) {
        self.token = token
    }

    func deviceID() -> UUID {
        id
    }
}

actor FakeBackfillStore: BackfillStateStoring {
    private var checkpoint: BackfillCheckpoint?

    func load() -> BackfillCheckpoint? {
        checkpoint
    }

    func save(_ checkpoint: BackfillCheckpoint) {
        self.checkpoint = checkpoint
    }

    func clear() {
        checkpoint = nil
    }
}

actor FakeStatusStore: StatusStoring {
    private var status = OperationalStatus()

    func load() -> OperationalStatus {
        status
    }

    func save(_ status: OperationalStatus) {
        self.status = status
    }

    func current() -> OperationalStatus {
        status
    }
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var now: Date

    init(_ now: Date) {
        self.now = now
    }

    func value() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return now
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        now = now.addingTimeInterval(interval)
        lock.unlock()
    }
}

func makeCoordinator(
    query: HealthQuerying = FakeHealthQueryService(),
    anchors: AnchorStoring = FakeAnchorStore(),
    outbox: OutboxStoring = FakeOutboxStore(),
    backendAvailabilityChecker: BackendAvailabilityChecking =
        FakeBackendAvailabilityChecker(),
    uploader: Uploading = FakeUploader(),
    backfill: BackfillStateStoring = FakeBackfillStore(),
    statusStore: StatusStoring = FakeStatusStore(),
    maximumIncrementalPagesPerMetric: Int = 1,
    maximumUploadsPerRun: Int = 10,
    now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_700_000_000) },
    jitter: @escaping @Sendable () -> Double = { 0.5 }
) -> SyncCoordinator {
    var settings = AppSettings()
    settings.endpoint = "https://example.test"
    let selectedKeys = HealthTypeRegistry.selectedMetrics(settings.metrics).map(\.rawValue)
    let consent = ConsentReceipt(
        destinationOrigin: "https://example.test",
        selectedMetricKeys: selectedKeys,
        consentedAt: now()
    )
    return SyncCoordinator(
        queryService: query,
        anchorStore: anchors,
        outboxStore: outbox,
        payloadEncoder: JSONPayloadEncoder(),
        backendAvailabilityChecker: backendAvailabilityChecker,
        uploader: uploader,
        settingsStore: FakeSettingsStore(settings: settings, consent: consent),
        credentialStore: FakeCredentialStore(),
        backfillStore: backfill,
        statusStore: statusStore,
        retryPolicy: RetryPolicy(),
        calendar: Calendar(identifier: .gregorian),
        queryLimit: 100,
        maximumIncrementalPagesPerMetric: maximumIncrementalPagesPerMetric,
        maximumUploadsPerRun: maximumUploadsPerRun,
        now: now,
        jitter: jitter
    )
}

func makePage(anchor: String, rawCount: Int) -> HealthQueryPage {
    HealthQueryPage(
        records: [],
        deletedRecords: [],
        newAnchor: Data(anchor.utf8),
        rawChangeCount: rawCount
    )
}
