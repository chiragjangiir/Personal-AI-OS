import HealthKit
import XCTest
@testable import HealthKitExporter

final class ContractTests: XCTestCase {
#if os(macOS)
    func testPlaceEventBatchesAndResponsesValidateSharedSchemas() throws {
        let arrival = Date(timeIntervalSince1970: 1_700_000_000), departure = arrival.addingTimeInterval(3_600)
        let fix = { (at: Date) in AssistantLocationObservation(localCaptureID: "capture", latitude: 3, longitude: 4,
            horizontalAccuracy: 10, observedAt: at) }
        let events = [PlaceEvent(kind: .visitArrival, location: fix(arrival), arrivalAt: arrival),
            PlaceEvent(kind: .visitDeparture, location: fix(departure), arrivalAt: arrival, departureAt: departure),
            PlaceEvent(kind: .regionEnter, location: fix(arrival), regionID: "home"),
            PlaceEvent(kind: .regionExit, location: fix(departure), regionID: "home")]
        let batches = try events.map { try String(decoding: PlaceUploadBatch.encode(deviceID: "01A11111-0000-7000-8000-000000000002",
            events: [$0], regionVersion: nil), as: UTF8.self) }
        let regions = [PlaceRegion(id: "home", label: "家", latitude: 3, longitude: 4, radius_m: 100)]
        let responses = try [PlaceRegionSet(version: 1, items: regions), PlaceRegionSet(version: 1, items: nil)].map {
            try String(decoding: JSONEncoder().encode(PlaceUploadResponse(schema: "paios.place-upload-response.v1",
                stored_ids: events.map(\.id), duplicate_ids: [], expired_ids: [], regions: $0)), as: UTF8.self)
        }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let root = String(#filePath.prefix(upTo: #filePath.range(of: "/01-product-half-finished/")!.lowerBound))
        process.currentDirectoryURL = URL(fileURLWithPath: root + "/01-product-half-finished/backend/services/personal-aios-integration")
        process.arguments = ["node", "--input-type=module", "-e", """
            import {readFileSync} from 'node:fs';
            import Ajv2020 from 'ajv/dist/2020.js';
            import {checkPlaceUpload} from './src/location.ts';
            const input=JSON.parse(readFileSync(0,'utf8'));
            for(const batch of input.batches)checkPlaceUpload(JSON.parse(batch));
            const ajv=new Ajv2020({strict:false});
            const validate=ajv.compile(JSON.parse(readFileSync('../../contracts/json-schema/realtime/realtime-place-upload-response.v1.schema.json','utf8')));
            for(const response of input.responses)if(!validate(JSON.parse(response)))throw Error(JSON.stringify(validate.errors));
            """]
        process.standardInput = input; process.standardOutput = output; process.standardError = output
        try process.run()
        try input.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: ["batches": batches, "responses": responses]))
        try input.fileHandleForWriting.close()
        let diagnostics = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, diagnostics)
    }
#endif

    func testSchemaVersionOneEncodingIsStable() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let batch = ExportBatch(
            batchId: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
            deviceId: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
            createdAt: start,
            timezone: "Europe/Berlin",
            mode: .incremental,
            records: [
                HealthRecord(
                    sampleType: "HKQuantityTypeIdentifierStepCount",
                    sampleId: UUID(uuidString: "33333333-3333-3333-3333-333333333333")!,
                    start: start,
                    end: start.addingTimeInterval(3_600),
                    value: .numeric(1_234),
                    unit: "count",
                    source: SourceInfo(
                        name: "Health",
                        bundleIdentifier: "com.apple.health",
                        version: "17.0",
                        productType: "Watch6,4"
                    ),
                    device: nil,
                    metadata: ["HKWasUserEntered": "1"]
                )
            ],
            deletedRecords: [
                DeletedRecord(
                    sampleType: "HKQuantityTypeIdentifierStepCount",
                    sampleId: UUID(uuidString: "44444444-4444-4444-4444-444444444444")!
                )
            ]
        )

        let data = try JSONPayloadEncoder().encode(batch)
        let encoded = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertEqual(
            encoded,
            #"{"batchId":"11111111-1111-1111-1111-111111111111","createdAt":"2023-11-14T22:13:20.000Z","deletedRecords":[{"sampleId":"44444444-4444-4444-4444-444444444444","sampleType":"HKQuantityTypeIdentifierStepCount"}],"deviceId":"22222222-2222-2222-2222-222222222222","mode":"incremental","records":[{"end":"2023-11-14T23:13:20.000Z","metadata":{"HKWasUserEntered":"1"},"operation":"upsert","sampleId":"33333333-3333-3333-3333-333333333333","sampleType":"HKQuantityTypeIdentifierStepCount","source":{"bundleIdentifier":"com.apple.health","name":"Health","productType":"Watch6,4","version":"17.0"},"start":"2023-11-14T22:13:20.000Z","unit":"count","value":{"kind":"numeric","numericValue":1234}}],"schemaVersion":1,"timezone":"Europe/Berlin"}"#
        )
        XCTAssertEqual(try JSONPayloadEncoder().decode(data), batch)
    }

    func testCanonicalUnitConversions() throws {
        let percent = HKQuantity(unit: .percent(), doubleValue: 0.42)
        XCTAssertEqual(
            try HealthMetric.bodyFatPercentage.canonicalUnit.value(from: percent),
            42,
            accuracy: 0.000_001
        )

        let perSecond = HKQuantity(
            unit: .count().unitDivided(by: .second()),
            doubleValue: 1
        )
        XCTAssertEqual(
            try HealthMetric.restingHeartRate.canonicalUnit.value(from: perSecond),
            60,
            accuracy: 0.000_001
        )

        let seconds = HKQuantity(unit: .second(), doubleValue: 0.125)
        XCTAssertEqual(
            try HealthMetric.heartRateVariabilitySDNN.canonicalUnit.value(from: seconds),
            125,
            accuracy: 0.000_001
        )

        let metUnit = HKUnit.kilocalorie()
            .unitDivided(by: .gramUnit(with: .kilo))
            .unitDivided(by: .hour())
        let mets = HKQuantity(unit: metUnit, doubleValue: 6.5)
        XCTAssertEqual(
            try HealthMetric.physicalEffort.canonicalUnit.value(from: mets),
            6.5,
            accuracy: 0.000_001
        )
    }

    func testUnavailableTypesArePartitionedWithoutBlockingSupportedTypes() {
        let metrics: [HealthMetric] = [
            .restingHeartRate,
            .appleSleepingWristTemperature,
            .physicalEffort
        ]
        let availability = HealthTypeRegistry.availability(for: metrics) {
            $0 != .appleSleepingWristTemperature
        }
        XCTAssertEqual(
            availability.available,
            [.restingHeartRate, .physicalEffort]
        )
        XCTAssertEqual(
            availability.unavailable,
            [.appleSleepingWristTemperature]
        )
    }

    func testAuthorizationOutcomeDoesNotClaimReadPermissionWasGranted() {
        let outcome = AuthorizationOutcome(
            requestedMetricKeys: [HealthMetric.restingHeartRate.rawValue],
            unavailableMetricKeys: [],
            interpretation: .requestCompletedReadAvailabilityUnknown
        )
        XCTAssertEqual(
            outcome.interpretation,
            .requestCompletedReadAvailabilityUnknown
        )
    }

    func testUserFacingHealthLabelsAndErrorsAreChinese() {
        XCTAssertEqual(HealthMetric.sleepAnalysis.displayName, "睡眠分析")
        XCTAssertEqual(HealthMetric.sleepAnalysis.purpose, "恢复状态与健身建议")
        XCTAssertEqual(OperationalStatus().backgroundRegistration, "未注册")
        XCTAssertEqual(
            ExporterError.missingToken.localizedDescription,
            "请输入 API 令牌。"
        )
        XCTAssertEqual(
            UserFacingError.message(for: URLError(.timedOut)),
            "连接服务器超时，请稍后重试。"
        )
        XCTAssertEqual(
            UserFacingError.message(
                for: NSError(domain: "BGTaskSchedulerErrorDomain", code: 1)
            ),
            "操作失败（错误代码 1）。"
        )
    }

    func testLockedDeviceIsRetryableInsteadOfAnAuthoritativeEmptyPage() async {
        let service = HealthQueryService(
            healthStore: HKHealthStore(),
            protectedDataChecker: FixedProtectedDataChecker(
                isProtectedDataAvailable: false
            )
        )
        do {
            _ = try await service.incrementalPage(
                for: .restingHeartRate,
                anchor: nil,
                startDate: Date(),
                limit: 100
            )
            XCTFail("Expected protected-data failure")
        } catch {
            XCTAssertEqual(error as? ExporterError, .protectedDataUnavailable)
        }
    }

    func testTokenAndEndpointAreRedacted() {
        let endpoint = URL(string: "https://private.example/v1/healthkit/ingest")!
        let result = Redactor.redact(
            "Bearer secret-token failed at https://private.example/v1/healthkit/ingest",
            token: "secret-token",
            endpoint: endpoint
        )
        XCTAssertFalse(result.contains("secret-token"))
        XCTAssertFalse(result.contains("/v1/healthkit/ingest"))
        XCTAssertTrue(result.contains("private.example"))
    }

    func testEndpointRequiresExactHTTPSIngestLocation() throws {
        XCTAssertEqual(
            try EndpointResolver.ingestURL(from: "https://private.example"),
            URL(string: "https://private.example/v1/healthkit/ingest")
        )
        XCTAssertEqual(
            try EndpointResolver.ingestURL(
                from: "https://private.example/v1/healthkit/ingest"
            ),
            URL(string: "https://private.example/v1/healthkit/ingest")
        )
        for invalid in [
            "http://private.example",
            "https://user:password@private.example",
            "https://private.example/other",
            "https://private.example?token=secret",
            "https://private.example/#fragment"
        ] {
            XCTAssertThrowsError(try EndpointResolver.ingestURL(from: invalid))
        }
#if DEBUG
        XCTAssertEqual(
            try EndpointResolver.ingestURL(from: "http://192.168.50.42:8787"),
            URL(string: "http://192.168.50.42:8787/v1/healthkit/ingest")
        )
        XCTAssertEqual(
            try EndpointResolver.ingestURL(
                from: "http://example-client.local:8787"
            ),
            URL(
                string: "http://example-client.local:8787/v1/healthkit/ingest"
            )
        )
        XCTAssertEqual(
            try EndpointResolver.ingestURL(
                from: "http://[fdf8:dd52:5b03::2]:8080"
            ),
            URL(
                string: "http://[fdf8:dd52:5b03::2]:8080/v1/healthkit/ingest"
            )
        )
        XCTAssertEqual(
            try EndpointResolver.destinationOrigin(
                from: "http://[fdf8:dd52:5b03::2]:8080"
            ),
            "http://[fdf8:dd52:5b03::2]:8080"
        )
#endif
    }

    func testStatusEndpointAndResponseContract() throws {
        let ingestURL = try EndpointResolver.ingestURL(from: "https://private.example")

        XCTAssertEqual(
            try EndpointResolver.statusURL(from: ingestURL),
            URL(string: "https://private.example/v1/healthkit/status")
        )

        let data = Data(
            """
            {
              "schemaVersion": 1,
              "generatedAt": "2026-07-21T12:45:00.000Z",
              "state": "current",
              "latestAcceptedBatchAt": "2026-07-21T12:40:00.000Z",
              "latestRecordAt": "2026-07-21T11:30:00.000Z",
              "activeRecordCount": 42,
              "domains": {
                "recovery": {
                  "state": "current",
                  "recordCount": 10,
                  "latestRecordAt": "2026-07-21T11:30:00.000Z"
                },
                "sleep": {
                  "state": "stale",
                  "recordCount": 8,
                  "latestRecordAt": "2026-07-17T06:00:00.000Z"
                },
                "activity": {
                  "state": "current",
                  "recordCount": 20,
                  "latestRecordAt": "2026-07-21T10:00:00.000Z"
                },
                "workouts": {
                  "state": "empty",
                  "recordCount": 0,
                  "latestRecordAt": null
                }
              },
              "databaseSchemaVersion": 2,
              "warnings": ["sleep data is stale", "workouts data is absent"]
            }
            """.utf8
        )

        let status = try JSONDecoder.exporter.decode(
            BackendDataStatusSnapshot.self,
            from: data
        )

        XCTAssertEqual(status.state, .current)
        XCTAssertEqual(status.activeRecordCount, 42)
        XCTAssertEqual(status.domains.sleep.state, .stale)
        XCTAssertEqual(status.domains.workouts.state, .empty)
        XCTAssertEqual(status.warnings.count, 2)
    }

    func testLegacySettingsDecodeAsNotYetAuthorized() throws {
        let legacy = Data(
            """
            {
              "endpoint": "https://private.example",
              "metrics": {
                "oxygenSaturation": false,
                "bodyMass": false,
                "bodyFatPercentage": false,
                "leanBodyMass": false
              }
            }
            """.utf8
        )

        let settings = try JSONDecoder.exporter.decode(AppSettings.self, from: legacy)

        XCTAssertFalse(settings.authorizationRequested)
        XCTAssertEqual(settings.endpoint, "https://private.example")
    }

    func testLegacyStatusDecodesWithoutBackendReachabilityFields() throws {
        let legacy = Data(
            """
            {
              "pendingOutboxBatches": 2,
              "backgroundRegistration": "Enabled hourly"
            }
            """.utf8
        )

        let status = try JSONDecoder.exporter.decode(OperationalStatus.self, from: legacy)

        XCTAssertNil(status.lastBackendReachabilityCheck)
        XCTAssertNil(status.backendReachable)
        XCTAssertEqual(status.pendingOutboxBatches, 2)
    }

    func testConsentIsBoundToSchemeHostAndPort() {
        let receipt = ConsentReceipt(
            destinationOrigin: "https://private.example:8787",
            selectedMetricKeys: [HealthMetric.stepCount.rawValue],
            consentedAt: Date()
        )

        XCTAssertTrue(
            receipt.matches(
                origin: "https://private.example:8787",
                metricKeys: [HealthMetric.stepCount.rawValue]
            )
        )
        XCTAssertFalse(
            receipt.matches(
                origin: "http://private.example:8787",
                metricKeys: [HealthMetric.stepCount.rawValue]
            )
        )
    }

    private struct FixedProtectedDataChecker: ProtectedDataChecking {
        let isProtectedDataAvailable: Bool
    }
}
