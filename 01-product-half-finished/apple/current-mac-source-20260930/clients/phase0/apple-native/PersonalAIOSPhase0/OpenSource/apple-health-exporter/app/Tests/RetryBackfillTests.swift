import Foundation
import XCTest
@testable import HealthKitExporter

final class RetryBackfillTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testRetryAfterSecondsAndHTTPDate() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(RetryAfterParser.interval(from: "120", now: now), 120)

        let date = now.addingTimeInterval(300)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        XCTAssertEqual(
            try XCTUnwrap(
                RetryAfterParser.interval(from: formatter.string(from: date), now: now)
            ),
            300,
            accuracy: 0.5
        )
    }

    func testBoundedExponentialBackoffRespectsRetryAfter() {
        let policy = RetryPolicy(
            baseDelay: 2,
            maximumBackoff: 60
        )
        XCTAssertEqual(
            policy.delay(afterAttempt: 0, retryAfter: nil, jitterUnit: 0.5),
            2
        )
        XCTAssertEqual(
            policy.delay(afterAttempt: 20, retryAfter: nil, jitterUnit: 0.5),
            60
        )
        XCTAssertEqual(
            policy.delay(afterAttempt: 2, retryAfter: 120, jitterUnit: 0),
            120
        )
    }

    func testHTTPRetryAndPermanentClassification() async throws {
        let item = makeNetworkItem()
        let cases: [(Int, [String: String]?, Bool, TimeInterval?)] = [
            (401, nil, false, nil),
            (403, nil, false, nil),
            (408, nil, true, nil),
            (429, ["Retry-After": "90"], true, 90),
            (500, nil, true, nil),
            (503, ["Retry-After": "30"], true, 30)
        ]

        for testCase in cases {
            let status = testCase.0
            let headers = testCase.1
            StubURLProtocol.handler = { request in
                (
                    try XCTUnwrap(
                        HTTPURLResponse(
                            url: request.url!,
                            statusCode: status,
                            httpVersion: "HTTP/1.1",
                            headerFields: headers
                        )
                    ),
                    Data()
                )
            }
            let result = await makeUploadClient().upload(
                item,
                endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
                token: "token",
                now: Date(timeIntervalSince1970: 1_700_000_000)
            )
            switch (result, testCase.2) {
            case (.retryable(_, let retryAfter), true):
                XCTAssertEqual(retryAfter, testCase.3)
            case (.permanent, false):
                break
            default:
                XCTFail("Unexpected classification for HTTP \(status): \(result)")
            }
        }
    }

    func testSuccessRequiresMatchingAcceptedBatchID() async throws {
        let item = makeNetworkItem()
        StubURLProtocol.handler = { request in
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                )
            )
            return (response, Data(#"{"batchId":"00000000-0000-0000-0000-000000000000"}"#.utf8))
        }
        let mismatch = await makeUploadClient().upload(
            item,
            endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
            token: "token",
            now: Date()
        )
        if case .permanent = mismatch {
        } else {
            XCTFail("A mismatched acceptance ID must be permanent")
        }

        StubURLProtocol.handler = { request in
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 202,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                )
            )
            return (response, Data(#"{"batchId":"DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD"}"#.utf8))
        }
        let accepted = await makeUploadClient().upload(
            item,
            endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
            token: "token",
            now: Date()
        )
        XCTAssertEqual(accepted, .accepted)
    }

    func testConnectionLossAndTimeoutAreRetryable() async {
        let item = makeNetworkItem()
        for code in [URLError.networkConnectionLost, URLError.timedOut] {
            StubURLProtocol.handler = { _ in throw URLError(code) }
            let result = await makeUploadClient().upload(
                item,
                endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
                token: "token",
                now: Date()
            )
            if case .retryable = result {
            } else {
                XCTFail("\(code) should be retryable")
            }
        }
    }

    func testBackendAvailabilityChecksReadyEndpointWithoutSendingCredentials() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/readyz")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                )!,
                Data(#"{"status":"ready"}"#.utf8)
            )
        }

        let available = try await makeBackendAvailabilityClient().isBackendAvailable(
            at: URL(string: "https://example.test/v1/healthkit/ingest")!
        )

        XCTAssertTrue(available)
    }

    func testBackendAvailabilityTreatsFailureAsUnavailable() async throws {
        let client = makeBackendAvailabilityClient()
        StubURLProtocol.handler = { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 503,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                )!,
                Data()
            )
        }
        let unavailableResponse = try await client.isBackendAvailable(
            at: URL(string: "https://example.test/v1/healthkit/ingest")!
        )
        XCTAssertFalse(unavailableResponse)

        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }
        let unavailableNetwork = try await client.isBackendAvailable(
            at: URL(string: "https://example.test/v1/healthkit/ingest")!
        )
        XCTAssertFalse(unavailableNetwork)
    }

    func testBackendDataStatusClientAuthenticatesAndDecodesBoundedResponse() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/healthkit/status")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer test-token"
            )
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(
                    """
                    {
                      "schemaVersion": 1,
                      "generatedAt": "2026-07-21T12:45:00.000Z",
                      "state": "current",
                      "latestAcceptedBatchAt": "2026-07-21T12:40:00.000Z",
                      "latestRecordAt": "2026-07-21T11:30:00.000Z",
                      "activeRecordCount": 42,
                      "domains": {
                        "recovery": {"state":"current","recordCount":10,"latestRecordAt":"2026-07-21T11:30:00.000Z"},
                        "sleep": {"state":"current","recordCount":8,"latestRecordAt":"2026-07-21T06:00:00.000Z"},
                        "activity": {"state":"current","recordCount":20,"latestRecordAt":"2026-07-21T10:00:00.000Z"},
                        "workouts": {"state":"current","recordCount":4,"latestRecordAt":"2026-07-21T09:00:00.000Z"}
                      },
                      "databaseSchemaVersion": 2,
                      "warnings": []
                    }
                    """.utf8
                )
            )
        }

        let status = try await makeBackendDataStatusClient().fetchStatus(
            at: URL(string: "https://example.test/v1/healthkit/ingest")!,
            token: "test-token"
        )

        XCTAssertEqual(status.state, .current)
        XCTAssertEqual(status.activeRecordCount, 42)
        XCTAssertEqual(status.domains.workouts.recordCount, 4)
    }

    func testDuplicateRequestsRetainIdempotencyKey() async {
        let item = makeNetworkItem()
        var keys: [String] = []
        StubURLProtocol.handler = { request in
            keys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer token"
            )
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            )!
            return (
                response,
                Data(#"{"batchId":"DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD"}"#.utf8)
            )
        }
        let client = makeUploadClient()

        _ = await client.upload(
            item,
            endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
            token: "token",
            now: Date()
        )
        _ = await client.upload(
            item,
            endpoint: URL(string: "https://example.test/v1/healthkit/ingest")!,
            token: "token",
            now: Date()
        )

        XCTAssertEqual(
            keys,
            [
                "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
                "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD"
            ]
        )
    }

    func testBackfillChunksAreBoundedByCalendarMonth() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = calendar.date(from: DateComponents(year: 2024, month: 1, day: 31))!
        let end = calendar.date(from: DateComponents(year: 2024, month: 5, day: 2))!
        let chunks = BackfillChunker.chunks(start: start, end: end, calendar: calendar)

        XCTAssertEqual(chunks.first?.lowerBound, start)
        XCTAssertEqual(chunks.last?.upperBound, end)
        XCTAssertTrue(chunks.allSatisfy { $0.lowerBound < $0.upperBound })
        XCTAssertGreaterThan(chunks.count, 2)
    }

    func testBackfillCancellationPreservesCheckpointAndResumeCompletes() async throws {
        let query = FakeHealthQueryService()
        let backfill = FakeBackfillStore()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox,
            backfill: backfill
        )
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let end = start.addingTimeInterval(10 * 24 * 60 * 60)
        try await coordinator.startBackfill(
            start: start,
            end: end,
            metrics: [.restingHeartRate]
        )
        let queryStarted = expectation(description: "Backfill query started")
        await query.delayNextBackfill(
            nanoseconds: 5_000_000_000,
            expectation: queryStarted
        )

        let task = Task {
            try await coordinator.resumeBackfill()
        }
        await fulfillment(of: [queryStarted], timeout: 2)
        task.cancel()
        do {
            try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
        }

        let savedAfterCancellation = await backfill.load()
        XCTAssertNotNil(savedAfterCancellation)
        try await coordinator.resumeBackfill()
        let savedAfterResume = await backfill.load()
        XCTAssertNil(savedAfterResume)
        let anchorKeys = await anchors.storedMetricKeys()
        XCTAssertEqual(anchorKeys, [])
    }

    func testHistoricalPageIsQueuedWithoutAdvancingIncrementalAnchor() async throws {
        let query = FakeHealthQueryService()
        let backfill = FakeBackfillStore()
        let anchors = FakeAnchorStore()
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader(
            dispositions: [.retryable(message: "offline", retryAfter: nil)]
        )
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let record = HealthRecord(
            sampleType: "HKQuantityTypeIdentifierRestingHeartRate",
            sampleId: UUID(),
            start: start,
            end: start,
            value: .numeric(50),
            unit: "count/min",
            source: SourceInfo(
                name: "Health",
                bundleIdentifier: "com.apple.health",
                version: nil,
                productType: nil
            ),
            device: nil,
            metadata: [:]
        )
        await query.setBackfill(
            metric: .restingHeartRate,
            results: [
                .success(
                    HealthQueryPage(
                        records: [record],
                        deletedRecords: [],
                        newAnchor: Data("backfill-page".utf8),
                        rawChangeCount: 1
                    )
                )
            ]
        )
        let coordinator = makeCoordinator(
            query: query,
            anchors: anchors,
            outbox: outbox,
            uploader: uploader,
            backfill: backfill
        )
        try await coordinator.startBackfill(
            start: start,
            end: start.addingTimeInterval(24 * 60 * 60),
            metrics: [.restingHeartRate]
        )

        try await coordinator.resumeBackfill()

        let items = await outbox.allItems()
        let item = try XCTUnwrap(items.first)
        let batch = try JSONPayloadEncoder().decode(item.payload)
        XCTAssertEqual(batch.mode, .backfill)
        XCTAssertEqual(batch.records, [record])
        XCTAssertEqual(
            item.requiredMetricKeys,
            [HealthMetric.restingHeartRate.rawValue]
        )
        let anchorKeys = await anchors.storedMetricKeys()
        XCTAssertEqual(anchorKeys, [])
        let checkpoint = await backfill.load()
        XCTAssertNil(checkpoint)
    }

    func testBackfillUploadsEachDurablyQueuedPageInsteadOfAccumulatingIt() async throws {
        let query = FakeHealthQueryService()
        let backfill = FakeBackfillStore()
        let outbox = FakeOutboxStore()
        let uploader = FakeUploader(dispositions: [.accepted])
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let record = HealthRecord(
            sampleType: "HKQuantityTypeIdentifierRestingHeartRate",
            sampleId: UUID(),
            start: start,
            end: start,
            value: .numeric(50),
            unit: "count/min",
            source: SourceInfo(
                name: "Health",
                bundleIdentifier: "com.apple.health",
                version: nil,
                productType: nil
            ),
            device: nil,
            metadata: [:]
        )
        await query.setBackfill(
            metric: .restingHeartRate,
            results: [
                .success(
                    HealthQueryPage(
                        records: [record],
                        deletedRecords: [],
                        newAnchor: Data("backfill-page".utf8),
                        rawChangeCount: 1
                    )
                )
            ]
        )
        let coordinator = makeCoordinator(
            query: query,
            outbox: outbox,
            uploader: uploader,
            backfill: backfill
        )
        try await coordinator.startBackfill(
            start: start,
            end: start.addingTimeInterval(24 * 60 * 60),
            metrics: [.restingHeartRate]
        )

        try await coordinator.resumeBackfill()

        let uploaded = await uploader.uploadedBatchIDs()
        XCTAssertEqual(uploaded.count, 1)
        let pending = await outbox.itemCount()
        XCTAssertEqual(pending, 0)
    }

    private func makeNetworkItem() -> OutboxItem {
        OutboxItem(
            batchId: UUID(uuidString: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD")!,
            payload: Data(#"{"schemaVersion":1}"#.utf8),
            requiredMetricKeys: [],
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            permanentFailure: false,
            lastError: nil
        )
    }

    private func makeUploadClient() -> UploadClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return UploadClient(session: URLSession(configuration: configuration))
    }

    private func makeBackendAvailabilityClient() -> BackendAvailabilityClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return BackendAvailabilityClient(
            session: URLSession(configuration: configuration)
        )
    }

    private func makeBackendDataStatusClient() -> BackendDataStatusClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return BackendDataStatusClient(
            session: URLSession(configuration: configuration)
        )
    }
}

final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
