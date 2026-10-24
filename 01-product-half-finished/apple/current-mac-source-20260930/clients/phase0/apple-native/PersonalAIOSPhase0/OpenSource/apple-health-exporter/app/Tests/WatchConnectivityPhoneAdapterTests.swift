import CryptoKit
import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif
import XCTest
@testable import HealthKitExporter

private actor MetricRecorder {
    private(set) var sequences: [UInt64] = []

    func append(_ metric: WatchCyclingMetricEnvelope) {
        sequences.append(metric.sequence)
    }
}

private actor RequestRecorder {
    private(set) var count = 0

    func record() {
        count += 1
    }
}

private actor WatchVoiceStartGate {
    private var continuation: CheckedContinuation<Void, Never>?

    func suspend(entered: XCTestExpectation) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            entered.fulfill()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

#if canImport(WatchConnectivity) && os(iOS)
private final class TestPhoneContextDiagnosticRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [WatchInstallationIdentityContextDiagnostic] = []

    func append(_ value: WatchInstallationIdentityContextDiagnostic) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }

    var values: [WatchInstallationIdentityContextDiagnostic] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}


#endif
private struct PhoneCyclingControlSendError: Error {}

#if canImport(WatchConnectivity) && os(iOS)
private struct TestPreworkoutKeychainError: Error {}

private final class TestPreworkoutCredentialStore:
    CredentialStoring,
    @unchecked Sendable {
    let id = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb")!
    let token: String?
    let failDeviceID: Bool
    let failAPIToken: Bool

    init(
        token: String? = nil,
        failDeviceID: Bool = false,
        failAPIToken: Bool = false
    ) {
        self.token = token
        self.failDeviceID = failDeviceID
        self.failAPIToken = failAPIToken
    }

    func apiToken() throws -> String? {
        if failAPIToken { throw TestPreworkoutKeychainError() }
        return token
    }

    func apiToken(for origin: String) throws -> String? {
        try apiToken()
    }

    func setAPIToken(_ token: String) throws {}

    func deviceID() throws -> UUID {
        if failDeviceID { throw TestPreworkoutKeychainError() }
        return id
    }
}

#endif
final class TestPhoneControlSender: WatchPhoneConnectivitySending {
    var queuedUserInfo: [[String: Any]] = []
    func enqueueUserInfo(_ userInfo: [String: Any]) { queuedUserInfo.append(userInfo) }
    var isActivated = true
    func activate() {}
    var isReachable = true
    var receivedApplicationContext: [String: Any] = [:]
    var applicationContext: [String: Any] = [:]
    var contextFailure = false
    func updateApplicationContext(_ context: [String: Any]) throws {
        if !isActivated || contextFailure { throw PhoneCyclingControlSendError() }
        applicationContext = context
    }
    var replyStatus: WatchCyclingControlAckStatus = .accepted
    var failSend = false
    var installationIdentity = "dddddddd-dddd-4ddd-bddd-dddddddddddd"
    var deferIdentityReplies = false
    var onIdentityRequest: (() -> Void)?
    private(set) var identityReplies: [() -> Void] = []
    private(set) var sentMessages: [[String: Any]] = []

    func sendMessage(
        _ message: [String: Any],
        replyHandler: (([String: Any]) -> Void)?,
        errorHandler: ((Error) -> Void)?
    ) {
        sentMessages.append(message)
        if failSend {
            errorHandler?(PhoneCyclingControlSendError())
            return
        }
        if let data = message["payload"] as? Data,
           let request = try?
            WatchInstallationIdentityRequest.decodeStrict(data),
           let reply = try? WatchInstallationIdentityReply(
            kind: WatchInstallationIdentityReply.currentKind,
            nonce: request.nonce,
            localClientInstanceID: installationIdentity,
            localClientSource: "existing_watch_install_identity"
           ).encodedStrict() {
            let deliver: () -> Void = { replyHandler?(["payload": reply]) }
            identityReplies.append(deliver)
            onIdentityRequest?()
            if !deferIdentityReplies { deliver() }
            return
        }
        guard let data = message["payload"] as? Data,
              let command = try?
                AssistantCyclingControlCommand.decodeStrict(data),
              let acknowledgement = try?
                WatchCyclingControlAcknowledgement(
                    command: command,
                    status: replyStatus
                ).encodedStrict()
        else {
            replyHandler?([:])
            return
        }
        replyHandler?(["payload": acknowledgement])
    }
}
final class WatchConnectivityPhoneAdapterTests: XCTestCase {
    #if canImport(WatchConnectivity) && os(iOS)
    func testInstallationIdentityRequestIsNonceScopedAndClosed() throws {
        let nonce = "11111111-1111-4111-8111-111111111111"
        let encoded = try WatchInstallationIdentityRequest(
            nonce: nonce
        ).encodedStrict()
        XCTAssertEqual(
            try WatchInstallationIdentityRequest.decodeStrict(encoded).nonce,
            nonce
        )
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        object["extra"] = true
        let widened = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(
            try WatchInstallationIdentityRequest.decodeStrict(widened)
        )
    }

    func testUppercaseUUIDsNormalizeAndCollisionRejects() {
        XCTAssertTrue(
            PhysicalCanaryPreworkoutObservationExporter.areDistinctRFCUUIDs([
                "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
                "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb",
                "cccccccc-cccc-4ccc-accc-cccccccccccc",
                "dddddddd-dddd-4ddd-bddd-dddddddddddd"
            ])
        )
        XCTAssertFalse(
            PhysicalCanaryPreworkoutObservationExporter.areDistinctRFCUUIDs([
                "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "cccccccc-cccc-4ccc-accc-cccccccccccc",
                "dddddddd-dddd-4ddd-bddd-dddddddddddd"
            ])
        )
    }

    func testProtectedStatusMapsEveryClosedFailureCode() {
        let cases: [(PhysicalCanaryPreworkoutExportError,
                     PhysicalCanaryPreworkoutStatusCode)] = [
            (.missingInput, .missingInput),
            (.malformedInput, .malformedInput),
            (.invalidInput, .invalidInput),
            (.watchUnavailable, .watchUnavailable),
            (.keychainUnavailable, .keychainUnavailable),
            (.persistenceFailed, .persistenceFailed)
        ]
        for (error, expected) in cases {
            XCTAssertEqual(
                PhysicalCanaryPreworkoutObservationExporter.statusCode(
                    for: error
                ),
                expected
            )
        }
    }

    func testMissingInputWritesClosedProtectedStatusOnly() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "preworkout-status-" + UUID().uuidString,
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let exporter = PhysicalCanaryPreworkoutObservationExporter(
            credentialStore: TestPreworkoutCredentialStore(),
            rootURL: root
        )
        await exporter.runWithProtectedStatus(
            using: WatchConnectivityPhoneAdapter(
                sender: TestPhoneControlSender()
            )
        )
        let url = root.appendingPathComponent(
            "preworkout-export.status.v1.json"
        )
        let data = try Data(contentsOf: url)
        XCTAssertEqual(data.last, 0x0A)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), Set(["schema", "status"]))
        XCTAssertEqual(
            object["schema"] as? String,
            PhysicalCanaryPreworkoutObservationExporter.statusSchema
        )
        XCTAssertEqual(object["status"] as? String, "missing_input")
        XCTAssertNil(object["core_device_id"])
        XCTAssertNil(object["token"])
        let attributes = try FileManager.default.attributesOfItem(
            atPath: url.path
        )
        XCTAssertEqual(attributes[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(
            try url.resourceValues(
                forKeys: [.isExcludedFromBackupKey]
            ).isExcludedFromBackup,
            true
        )
    }

    func testAdapterRequestsWatchIdentityExactlyOnce() async {
        let sender = TestPhoneControlSender()
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let reply = await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111"
        )
        XCTAssertEqual(
            reply?.localClientInstanceID,
            sender.installationIdentity
        )
        XCTAssertEqual(sender.sentMessages.count, 1)
    }


    func testCurrentIdentityContextWinsUnreachableAndIsClosed() async throws {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let observation = try WatchInstallationIdentityObservation(
            version: 1,
            kind: WatchInstallationIdentityObservation.currentKind,
            localClientInstanceID: sender.installationIdentity,
            localClientSource: "existing_watch_install_identity"
        ).encodedStrict()
        sender.receivedApplicationContext = ["payload": observation]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let reply = await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111"
        )
        XCTAssertEqual(reply?.localClientInstanceID, sender.installationIdentity)
        XCTAssertTrue(sender.sentMessages.isEmpty)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: observation) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), Set([
            "version", "kind", "local_client_instance_id",
            "local_client_source"
        ]))
        XCTAssertNil(object["canonical"])
    }

    func testDelayedIdentityApplicationContextWakesWithoutMessageFallback()
        async throws {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let recorder = TestPhoneContextDiagnosticRecorder()
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000_000)
        adapter.setInstallationIdentityContextDiagnosticHandlerForTests {
            recorder.append($0)
        }
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        let task = Task {
            await adapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        }
        try? await Task.sleep(nanoseconds: 10_000_000)
        let observation = try WatchInstallationIdentityObservation(
            version: 1,
            kind: WatchInstallationIdentityObservation.currentKind,
            localClientInstanceID: sender.installationIdentity,
            localClientSource: "existing_watch_install_identity"
        ).encodedStrict()
        sender.receivedApplicationContext = ["payload": observation]
        adapter.receiveApplicationContext(["payload": observation]
        )
        let reply = await task.value
        XCTAssertEqual(reply?.localClientInstanceID, sender.installationIdentity)
        XCTAssertTrue(sender.sentMessages.isEmpty)
        XCTAssertEqual(recorder.values.last?.presence, "present")
        XCTAssertEqual(recorder.values.last?.version, "current")
        XCTAssertEqual(recorder.values.last?.kind, "installation_identity")
        XCTAssertEqual(recorder.values.last?.decision, "accepted")
    }

    func testDelayedInvalidIdentityContextFailsClosedWithoutFallback()
        async {
        let sender = TestPhoneControlSender()
        sender.isReachable = true
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000_000)
        let task = Task {
            await adapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        }
        try? await Task.sleep(nanoseconds: 10_000_000)
        let malformed = Data(
            #"{"version":0,"kind":"preworkout_installation_identity_observation","local_client_instance_id":"dddddddd-dddd-4ddd-bddd-dddddddddddd","local_client_source":"existing_watch_install_identity"}"#.utf8
        )
        adapter.receiveApplicationContext(["payload": malformed]
        )
        let reply = await task.value
        XCTAssertNil(reply)
        XCTAssertTrue(sender.sentMessages.isEmpty)
    }

    func testSameInstallationSurvivesWatchRestartProvenance() async throws {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        for source in ["app_installation_uuid_v1", "existing_watch_install_identity"] {
            sender.receivedApplicationContext = ["payload": try WatchInstallationIdentityObservation(version: 1,
                kind: WatchInstallationIdentityObservation.currentKind,
                localClientInstanceID: sender.installationIdentity, localClientSource: source).encodedStrict()]
            let reply = await adapter.requestInstallationIdentity(nonce: "11111111-1111-4111-8111-111111111111")
            XCTAssertEqual(reply?.localClientInstanceID, sender.installationIdentity)
            XCTAssertEqual(reply?.localClientSource, source)
        }
        XCTAssertTrue(sender.sentMessages.isEmpty)
    }

    func testMalformedStaleOrReplacementIdentityContextFailsClosed()
        async throws {
        let malformed = Data(
            #"{"version":0,"kind":"preworkout_installation_identity_observation","local_client_instance_id":"dddddddd-dddd-4ddd-bddd-dddddddddddd","local_client_source":"existing_watch_install_identity","extra":true}"#.utf8
        )
        let malformedSender = TestPhoneControlSender()
        malformedSender.receivedApplicationContext = ["payload": malformed]
        let malformedAdapter = WatchConnectivityPhoneAdapter(
            sender: malformedSender
        )
        let malformedReply =
            await malformedAdapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        XCTAssertNil(malformedReply)
        XCTAssertTrue(malformedSender.sentMessages.isEmpty)

        let sender = TestPhoneControlSender()
        sender.isReachable = false
        sender.receivedApplicationContext = ["payload":
            try WatchInstallationIdentityObservation(
                version: 1,
                kind: WatchInstallationIdentityObservation.currentKind,
                localClientInstanceID:
                    "dddddddd-dddd-4ddd-bddd-dddddddddddd",
                localClientSource: "existing_watch_install_identity"
            ).encodedStrict()
        ]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let firstReply = await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111"
        )
        XCTAssertNotNil(firstReply)
        sender.receivedApplicationContext = ["payload":
            try WatchInstallationIdentityObservation(
                version: 1,
                kind: WatchInstallationIdentityObservation.currentKind,
                localClientInstanceID:
                    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                localClientSource: "existing_watch_install_identity"
            ).encodedStrict()
        ]
        let replacementReply = await adapter.requestInstallationIdentity(
            nonce: "22222222-2222-4222-8222-222222222222"
        )
        XCTAssertNil(replacementReply)
        XCTAssertTrue(sender.sentMessages.isEmpty)
        sender.isReachable = true
        sender.installationIdentity = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        let verified = await adapter.requestInstallationIdentity(
            nonce: "33333333-3333-4333-8333-333333333333", rebind: true)
        XCTAssertEqual(verified?.localClientInstanceID, sender.installationIdentity)
        XCTAssertEqual(sender.sentMessages.count, 1, "replacement needs a fresh nonce reply")
    }

    func testWatchSwitchFencesQueuedIdentityReply() async throws {
        let sender = TestPhoneControlSender()
        sender.deferIdentityReplies = true
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let firstSent = expectation(description: "old Watch challenge sent")
        sender.onIdentityRequest = { firstSent.fulfill() }
        let first = Task { await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111", rebind: true) }
        await fulfillment(of: [firstSent], timeout: 1)
        adapter.pairingChanged()
        let old = await first.value
        XCTAssertNil(old)

        sender.installationIdentity = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        let secondSent = expectation(description: "new Watch challenge sent")
        sender.onIdentityRequest = { secondSent.fulfill() }
        let second = Task { await adapter.requestInstallationIdentity(
            nonce: "22222222-2222-4222-8222-222222222222") }
        await fulfillment(of: [secondSent], timeout: 1)
        sender.identityReplies[0]()
        sender.identityReplies[1]()
        let current = await second.value
        XCTAssertEqual(current?.localClientInstanceID, sender.installationIdentity)
    }

    func testClosingChannelFinishesPendingRebindWithoutAcceptingItsReply() async {
        let sender = TestPhoneControlSender()
        sender.deferIdentityReplies = true
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let sent = expectation(description: "challenge sent")
        sender.onIdentityRequest = { sent.fulfill() }
        let pending = Task { await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111", rebind: true) }
        await fulfillment(of: [sent], timeout: 1)
        adapter.closeInstallationIdentityChannel()
        let reply = await pending.value
        XCTAssertNil(reply)
        sender.identityReplies[0]()
        let replay = await adapter.requestInstallationIdentity(
            nonce: "22222222-2222-4222-8222-222222222222", rebind: true)
        XCTAssertNil(replay)
    }

    func testClosedIdentityContextCannotReplay() async throws {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        sender.receivedApplicationContext = ["payload":
            try WatchInstallationIdentityObservation(
                version: 1,
                kind: WatchInstallationIdentityObservation.currentKind,
                localClientInstanceID: sender.installationIdentity,
                localClientSource: "existing_watch_install_identity"
            ).encodedStrict()
        ]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.closeInstallationIdentityChannel()
        let closedReply = await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111"
        )
        XCTAssertNil(closedReply)
        XCTAssertTrue(sender.sentMessages.isEmpty)
    }

    func testAdapterWaitsForDelayedReachabilityAndSendsOnce() async {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000_000)
        let task = Task {
            await adapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        }
        try? await Task.sleep(nanoseconds: 10_000_000)
        sender.isReachable = true
        adapter.reachabilityChanged()
        let value = await task.value
        XCTAssertNotNil(value)
        XCTAssertEqual(sender.sentMessages.count, 1)
    }

    func testAdapterReachabilityTimeoutDoesNotSend() async {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000)
        let reply = await adapter.requestInstallationIdentity(
            nonce: "11111111-1111-4111-8111-111111111111"
        )
        XCTAssertNil(reply)
        XCTAssertEqual(sender.sentMessages.count, 0)
    }

    func testAdapterIgnoresUnreachableFlapUntilReachable() async {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000_000)
        let task = Task {
            await adapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        }
        adapter.reachabilityChanged()
        XCTAssertEqual(sender.sentMessages.count, 0)
        sender.isReachable = true
        adapter.reachabilityChanged()
        let value = await task.value
        XCTAssertNotNil(value)
        XCTAssertEqual(sender.sentMessages.count, 1)
    }

    func testAdapterCancellationClosesWaitWithoutSend() async {
        let sender = TestPhoneControlSender()
        sender.isReachable = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setPhysicalReachabilityTimeoutForTests(1_000_000_000)
        let task = Task {
            await adapter.requestInstallationIdentity(
                nonce: "11111111-1111-4111-8111-111111111111"
            )
        }
        task.cancel()
        let value = await task.value
        XCTAssertNil(value)
        XCTAssertEqual(sender.sentMessages.count, 0)
        sender.isReachable = true
        adapter.reachabilityChanged()
        XCTAssertEqual(sender.sentMessages.count, 0)
    }

    func testExporterWritesCanonicalProtectedObservation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "preworkout-exporter-" + UUID().uuidString,
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let request: [String: Any] = [
            "schema": "paios.apple-physical-preworkout-request.v1",
            "manifest_sha256": String(repeating: "a", count: 64),
            "iphone": [
                "core_device_id": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
                "launch_receipt_sha256": String(repeating: "b", count: 64)
            ],
            "watch": [
                "core_device_id": "CCCCCCCC-CCCC-4CCC-ACCC-CCCCCCCCCCCC",
                "launch_receipt_sha256": String(repeating: "d", count: 64)
            ]
        ]
        let requestData = try JSONSerialization.data(
            withJSONObject: request,
            options: [.sortedKeys]
        )
        try requestData.write(
            to: root.appendingPathComponent("preworkout-request.v1.json")
        )
        let sender = TestPhoneControlSender()
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let exporter = PhysicalCanaryPreworkoutObservationExporter(
            credentialStore: TestPreworkoutCredentialStore(),
            rootURL: root,
            now: { Date(timeIntervalSince1970: 1_700_000_000) }
        )
        await exporter.runWithProtectedStatus(using: adapter)

        let outputURL = root.appendingPathComponent(
            "preworkout-observation.v1.json"
        )
        let output = try Data(contentsOf: outputURL)
        XCTAssertEqual(output.last, 0x0A)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: output) as? [String: Any]
        )
        let iphone = try XCTUnwrap(object["iphone"] as? [String: Any])
        let watch = try XCTUnwrap(object["watch"] as? [String: Any])
        XCTAssertEqual(
            iphone["core_device_id"] as? String,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
        XCTAssertEqual(
            watch["core_device_id"] as? String,
            "cccccccc-cccc-4ccc-accc-cccccccccccc"
        )
        let attributes = try FileManager.default.attributesOfItem(
            atPath: outputURL.path
        )
        XCTAssertEqual(attributes[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(
            try outputURL.resourceValues(
                forKeys: [.isExcludedFromBackupKey]
            ).isExcludedFromBackup,
            true
        )
        let statusURL = root.appendingPathComponent(
            "preworkout-export.status.v1.json"
        )
        let status = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(contentsOf: statusURL)
            ) as? [String: Any]
        )
        XCTAssertEqual(Set(status.keys), Set(["schema", "status"]))
        XCTAssertEqual(status["status"] as? String, "success")
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent(
                    "secure-registration-response.v1.json"
                ).path
            )
        )
    }

    func testSecureRegistrationWritesProtectedResponseForPresentToken()
        async throws {
        let root = try makePreworkoutRoot("secure-registration-present")
        defer { try? FileManager.default.removeItem(at: root) }
        let nonce = "11111111-1111-4111-8111-111111111111"
        let token = "raw-token-ä-🔐"
        try writeSecureRegistrationRequest(nonce: nonce, to: root)

        let exporter = PhysicalCanaryPreworkoutObservationExporter(
            credentialStore: TestPreworkoutCredentialStore(token: token),
            rootURL: root,
            now: { Date(timeIntervalSince1970: 1_700_000_000) }
        )
        await exporter.runWithProtectedStatus(
            using: WatchConnectivityPhoneAdapter(
                sender: TestPhoneControlSender()
            )
        )

        let responseURL = root.appendingPathComponent(
            "secure-registration-response.v1.json"
        )
        let responseData = try Data(contentsOf: responseURL)
        XCTAssertEqual(responseData.last, 0x0A)
        let response = try XCTUnwrap(
            JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        )
        XCTAssertEqual(
            Set(response.keys),
            Set([
                "schema", "request_nonce", "request_sha256", "observed_at",
                "local_client_instance_id", "local_client_source",
                "api_token_present", "api_token_sha256", "credential_service",
                "credential_account"
            ])
        )
        XCTAssertEqual(
            response["schema"] as? String,
            PhysicalCanaryPreworkoutObservationExporter
                .secureRegistrationResponseSchema
        )
        XCTAssertEqual(response["request_nonce"] as? String, nonce)
        XCTAssertEqual(
            response["request_sha256"] as? String,
            secureRegistrationRequestSHA256(nonce: nonce)
        )
        XCTAssertEqual(
            response["observed_at"] as? String,
            "2023-11-14T22:13:20Z"
        )
        XCTAssertEqual(
            response["local_client_instance_id"] as? String,
            TestPreworkoutCredentialStore().id.uuidString.lowercased()
        )
        XCTAssertEqual(
            response["local_client_source"] as? String,
            "existing_keychain_device_id"
        )
        XCTAssertEqual(response["api_token_present"] as? Bool, true)
        XCTAssertEqual(
            response["api_token_sha256"] as? String,
            sha256Hex(Data(token.utf8))
        )
        XCTAssertEqual(
            response["credential_service"] as? String,
            "ai.paios.personal.phase0"
        )
        XCTAssertEqual(response["credential_account"] as? String, "api-token")
        let attributes = try FileManager.default.attributesOfItem(
            atPath: responseURL.path
        )
        XCTAssertEqual(attributes[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(
            try responseURL.resourceValues(
                forKeys: [.isExcludedFromBackupKey]
            ).isExcludedFromBackup,
            true
        )
    }

    func testSecureRegistrationWritesNullDigestWhenTokenIsAbsent()
        async throws {
        let root = try makePreworkoutRoot("secure-registration-absent")
        defer { try? FileManager.default.removeItem(at: root) }
        let nonce = "22222222-2222-4222-8222-222222222222"
        try writeSecureRegistrationRequest(nonce: nonce, to: root)

        let exporter = PhysicalCanaryPreworkoutObservationExporter(
            credentialStore: TestPreworkoutCredentialStore(),
            rootURL: root,
            now: { Date(timeIntervalSince1970: 1_700_000_001) }
        )
        await exporter.runWithProtectedStatus(
            using: WatchConnectivityPhoneAdapter(
                sender: TestPhoneControlSender()
            )
        )

        let response = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(contentsOf: root.appendingPathComponent(
                    "secure-registration-response.v1.json"
                ))
            ) as? [String: Any]
        )
        XCTAssertEqual(response["api_token_present"] as? Bool, false)
        XCTAssertTrue(response.keys.contains("api_token_sha256"))
        XCTAssertTrue(response["api_token_sha256"] is NSNull)
    }

    func testSecureRegistrationRejectsMalformedClosedAndMismatchedRequests()
        async throws {
        let cases: [Data] = [
            Data("not-json".utf8),
            Data(
                "{\"schema\":\"paios.apple-secure-registration-request.v1\",\"request_nonce\":\"33333333-3333-4333-8333-333333333333\",\"request_sha256\":\"".utf8
            ),
            try JSONSerialization.data(
                withJSONObject: [
                    "schema": "paios.apple-secure-registration-request.v1",
                    "request_nonce": "33333333-3333-4333-8333-333333333333",
                    "request_sha256": String(repeating: "0", count: 64),
                    "extra": true
                ],
                options: [.sortedKeys]
            ),
            try JSONSerialization.data(
                withJSONObject: [
                    "schema": "paios.apple-secure-registration-request.v1",
                    "request_nonce": "33333333-3333-4333-8333-333333333333",
                    "request_sha256": String(repeating: "0", count: 64)
                ],
                options: [.sortedKeys]
            )
        ]

        for (index, data) in cases.enumerated() {
            let root = try makePreworkoutRoot(
                "secure-registration-invalid-\(index)"
            )
            defer { try? FileManager.default.removeItem(at: root) }
            try data.write(
                to: root.appendingPathComponent(
                    "secure-registration-request.v1.json"
                )
            )
            let responseURL = root.appendingPathComponent(
                "secure-registration-response.v1.json"
            )
            try Data("stale-response".utf8).write(to: responseURL)

            let exporter = PhysicalCanaryPreworkoutObservationExporter(
                credentialStore: TestPreworkoutCredentialStore(
                    token: "do-not-output"
                ),
                rootURL: root
            )
            await exporter.runWithProtectedStatus(
                using: WatchConnectivityPhoneAdapter(
                    sender: TestPhoneControlSender()
                )
            )

            XCTAssertFalse(FileManager.default.fileExists(atPath: responseURL.path))
            XCTAssertFalse(
                FileManager.default.fileExists(
                    atPath: root.appendingPathComponent(
                        "preworkout-export.status.v1.json"
                    ).path
                )
            )
        }
    }

    func testSecureRegistrationKeychainErrorRemovesResponseWithoutDiagnostics()
        async throws {
        let root = try makePreworkoutRoot("secure-registration-keychain-error")
        defer { try? FileManager.default.removeItem(at: root) }
        let nonce = "44444444-4444-4444-8444-444444444444"
        try writeSecureRegistrationRequest(nonce: nonce, to: root)
        let responseURL = root.appendingPathComponent(
            "secure-registration-response.v1.json"
        )
        try Data("stale-response".utf8).write(to: responseURL)

        let exporter = PhysicalCanaryPreworkoutObservationExporter(
            credentialStore: TestPreworkoutCredentialStore(
                failAPIToken: true
            ),
            rootURL: root
        )
        await exporter.runWithProtectedStatus(
            using: WatchConnectivityPhoneAdapter(
                sender: TestPhoneControlSender()
            )
        )

        XCTAssertFalse(FileManager.default.fileExists(atPath: responseURL.path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent(
                    "preworkout-export.status.v1.json"
                ).path
            )
        )
    }

    private func makePreworkoutRoot(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            name + "-" + UUID().uuidString,
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        return root
    }

    private func writeSecureRegistrationRequest(
        nonce: String,
        to root: URL
    ) throws {
        let request: [String: Any] = [
            "schema": PhysicalCanaryPreworkoutObservationExporter
                .secureRegistrationRequestSchema,
            "request_nonce": nonce,
            "request_sha256": secureRegistrationRequestSHA256(nonce: nonce)
        ]
        let data = try JSONSerialization.data(
            withJSONObject: request,
            options: [.sortedKeys]
        )
        try data.write(
            to: root.appendingPathComponent(
                "secure-registration-request.v1.json"
            )
        )
    }

    private func secureRegistrationRequestSHA256(nonce: String) -> String {
        sha256Hex(
            Data(
                "{\"request_nonce\":\"\(nonce)\",\"schema\":\"paios.apple-secure-registration-request.v1\"}".utf8
            )
        )
    }

    private func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    #endif
    private func makeMetric(sequence: UInt64, state: WatchCyclingWorkoutState? = nil) -> WatchCyclingMetricEnvelope {
        WatchCyclingMetricEnvelope(
            sequence: sequence,
            observedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(sequence)),
            workoutID: "cycling-workout",
            heartRateBPM: 140 + Double(sequence),
            activeEnergyKcal: Double(sequence),
            distanceM: 100 * Double(sequence),
            elapsedS: 10 * Double(sequence),
            cadenceSPM: nil,
            cyclingSpeedMPS: nil, workoutState: state
        )
    }

    func testLegacyWatchCallsNeverReachActionOwner() async throws {
        let calls = RequestRecorder()
        let adapter = WatchConnectivityPhoneAdapter(sender: TestPhoneControlSender(), actionHandler: { _ in
            await calls.record(); return true
        })
        for (index, action) in [WatchAssistantAction.requestVoiceSession, .stopCurrentSession].enumerated() {
            let packet = WatchAssistantPacket(action: action, requestID: "legacy-\(index)", sequence: UInt64(index + 1))
            let replied = expectation(description: "legacy request rejected")
            adapter.receiveMessage(["payload": try WatchLocalEnvelope(request: packet).encodedStrict()]) { message in
                let ack = (message["payload"] as? Data).flatMap { try? WatchLocalEnvelope.decodeStrict($0) }
                XCTAssertEqual(ack?.status, .rejected)
                replied.fulfill()
            }
            await fulfillment(of: [replied], timeout: 2)
        }
        let count = await calls.count
        XCTAssertEqual(count, 0)
    }

    func testTypedActionCorrelationAndArgumentConflict() async throws {
        let calls = RequestRecorder()
        let adapter = WatchConnectivityPhoneAdapter(sender: TestPhoneControlSender(), actionHandler: { _ in await calls.record(); return true })
        for (sequence, option, expected) in [(UInt64(1), "yes", WatchLocalAckStatus.accepted), (2, "yes", .duplicate), (3, "no", .conflict)] {
            let request = WatchLocalEnvelope(kind: .request, action: .cardAnswer, requestID: "answer", sequence: sequence,
                                             version: 1, args: .init(card_id: "card", option_id: option))
            let replied = expectation(description: "typed action receipt")
            adapter.receiveMessage(["payload": try request.encodedStrict()]) { message in
                let ack = (message["payload"] as? Data).flatMap { try? WatchLocalEnvelope.decodeStrict($0) }
                XCTAssertEqual(ack?.status, expected)
                XCTAssertEqual(ack?.version, 1)
                XCTAssertEqual(ack?.action, .cardAnswer)
                XCTAssertEqual(ack?.requestID, "answer")
                XCTAssertEqual(ack?.sequence, sequence)
                replied.fulfill()
            }
            await fulfillment(of: [replied], timeout: 2)
        }
        let count = await calls.count
        XCTAssertEqual(count, 1)
    }

    func testSuccessfulActivationInvokesCurrentProjectionRefresh() async {
        let calls = RequestRecorder()
        let adapter = WatchConnectivityPhoneAdapter(sender: TestPhoneControlSender())
        adapter.setActivationHandler { await calls.record() }
        adapter.activationChanged(isActivated: false, error: nil)
        await adapter.waitForPendingDeliveries()
        let before = await calls.count
        XCTAssertEqual(before, 0)
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let after = await calls.count
        XCTAssertEqual(after, 1)
    }

    func testActivationRefreshPublishesAfterNotActivatedFailure() async throws {
        let sender = TestPhoneControlSender()
        sender.isActivated = false
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let state = Data("current-owner-state".utf8)
        XCTAssertThrowsError(try adapter.publishYimiState(state, credential: nil))
        adapter.setActivationHandler {
            do { try adapter.publishYimiState(state, credential: nil) }
            catch { XCTFail("activation refresh failed: \(error)") }
        }
        sender.isActivated = true
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        XCTAssertEqual(sender.applicationContext["yimi_state"] as? Data, state)
        adapter.setActivationHandler {}
    }

    func testContextPublicationMergesAndRemovesOwnedValues() throws {
        let sender = TestPhoneControlSender()
        let identity = Data("identity".utf8)
        sender.applicationContext = ["payload": identity]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        let state = Data("state".utf8), credential = Data("credential".utf8)
        try adapter.publishYimiState(state, credential: nil)
        try adapter.publishYimiState(state, credential: credential)
        XCTAssertEqual(sender.applicationContext["payload"] as? Data, identity)
        XCTAssertEqual(sender.applicationContext["yimi_state"] as? Data, state)
        XCTAssertEqual(sender.applicationContext["watch_credential"] as? Data, credential)
        try adapter.publishYimiState(state, credential: nil)
        XCTAssertNil(sender.applicationContext["watch_credential"])
        XCTAssertEqual(sender.applicationContext["yimi_state"] as? Data, state)
        sender.contextFailure = true
        XCTAssertThrowsError(try adapter.publishYimiState(nil, credential: nil))
        XCTAssertEqual(sender.applicationContext["yimi_state"] as? Data, state)
    }

    func testRequestLedgerDeduplicatesSameRequest() async {
        let ledger = WatchLocalRequestLedger(capacity: 4)
        let packet = WatchAssistantPacket(
            action: .requestVoiceSession,
            requestID: "voice-1",
            sequence: 1
        )

        let first = await ledger.classify(packet)
        XCTAssertEqual(first, .new)
        let second = await ledger.classify(packet)
        XCTAssertEqual(second, .duplicate)
    }

    func testRequestLedgerRejectsActionConflict() async {
        let ledger = WatchLocalRequestLedger(capacity: 4)
        let voice = WatchAssistantPacket(
            action: .requestVoiceSession,
            requestID: "same-id",
            sequence: 1
        )
        let stop = WatchAssistantPacket(
            action: .stopCurrentSession,
            requestID: "same-id",
            sequence: 2
        )

        let first = await ledger.classify(voice)
        XCTAssertEqual(first, .new)
        let second = await ledger.classify(stop)
        XCTAssertEqual(second, .conflict)
    }

    func testTransferHintsDoNotBecomeRequestProcessing() throws {
        let packet = WatchAssistantPacket(
            action: .stopCurrentSession,
            requestID: "hint-1",
            sequence: 7
        )
        let hint = WatchLocalTransferHint(packet: packet)
        let decoded = try WatchLocalTransferHint.decodeStrict(
            try hint.encodedStrict()
        )
        XCTAssertEqual(decoded, hint)
    }

    func testMetricHandlerIsSeparateAndMonotonicAcrossDeliveryPaths() async
        throws {
        let metrics = MetricRecorder()
        let requests = RequestRecorder()
        let adapter = WatchConnectivityPhoneAdapter(
            sender: TestPhoneControlSender(), actionHandler: { _ in
                await requests.record()
                return true
            },
            metricHandler: { metric in
                await metrics.append(metric)
            }
        )
        let first = try makeMetric(sequence: 1).encodedStrict()
        let second = try makeMetric(sequence: 2).encodedStrict()

        adapter.receiveMessage(["payload": first]
        )
        adapter.receiveApplicationContext(["payload": second]
        )
        adapter.receiveMessage(["payload": first]
        )
        adapter.receiveApplicationContext(["payload": second]
        )
        adapter.receiveMessage(["payload": Data("not-json".utf8)]
        )

        await adapter.waitForPendingDeliveries()

        let receivedSequences = await metrics.sequences
        let requestCount = await requests.count
        XCTAssertEqual(receivedSequences, [1, 2])
        XCTAssertEqual(requestCount, 0)
    }

    func testMetricDeliveryTwoThenOneKeepsTwoAndRejectsOne() async throws {
        let metrics = MetricRecorder()
        let adapter = WatchConnectivityPhoneAdapter(
            sender: TestPhoneControlSender(), metricHandler: { metric in
                await metrics.append(metric)
            }
        )
        let first = try makeMetric(sequence: 1).encodedStrict()
        let second = try makeMetric(sequence: 2).encodedStrict()

        adapter.receiveMessage(["payload": second]
        )
        adapter.receiveApplicationContext(["payload": first]
        )
        await adapter.waitForPendingDeliveries()

        let receivedSequences = await metrics.sequences
        XCTAssertEqual(receivedSequences, [2])
    }

    func testMalformedMetricEnvelopeDoesNotInvokeEitherHandler() async {
        let metrics = MetricRecorder()
        let requests = RequestRecorder()
        let adapter = WatchConnectivityPhoneAdapter(
            sender: TestPhoneControlSender(), actionHandler: { _ in
                await requests.record()
                return true
            },
            metricHandler: { metric in
                await metrics.append(metric)
            }
        )

        let malformed = Data(
            #"{"version":1,"kind":"watch_cycling_metric","sequence":0,"observedAt":"2023-11-14T22:13:20Z","workoutID":"w","elapsed_s":1}"#.utf8
        )
        adapter.receiveApplicationContext(["payload": malformed]
        )
        await adapter.waitForPendingDeliveries()

        let receivedSequences = await metrics.sequences
        let requestCount = await requests.count
        XCTAssertTrue(receivedSequences.isEmpty)
        XCTAssertEqual(requestCount, 0)
    }

    func testCyclingControlUsesOneRealtimeWatchSendAndMapsAck()
        async throws {
        let sender = TestPhoneControlSender()
        let adapter = WatchConnectivityPhoneAdapter(sender: sender, controlSequence: WatchSenderSequence(key: "test-control", defaults: nil, clock: nil))
        let start = AssistantCyclingControlCommand(
            action: .start,
            requestID: "cycling-start-1",
            sequence: 1
        )

        let accepted = await adapter.sendCyclingControl(start)
        XCTAssertEqual(accepted, .accepted)
        XCTAssertEqual(sender.sentMessages.count, 1)
        let payload = try XCTUnwrap(
            sender.sentMessages.first?["payload"] as? Data
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload)
                as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            Set(["version", "kind", "action", "request_id", "sequence"])
        )
        XCTAssertEqual(
            try AssistantCyclingControlCommand.decodeStrict(payload),
            start
        )

        sender.replyStatus = .rejected
        let rejected = await adapter.sendCyclingControl(
            AssistantCyclingControlCommand(
                action: .stop,
                requestID: "cycling-stop-2",
                sequence: 2
            )
        )
        XCTAssertEqual(rejected, .rejected)
        XCTAssertEqual(sender.sentMessages.count, 2)

        sender.replyStatus = .duplicate
        let duplicate = await adapter.sendCyclingControl(
            AssistantCyclingControlCommand(
                action: .stop,
                requestID: "cycling-stop-duplicate",
                sequence: 3
            )
        )
        XCTAssertEqual(duplicate, .duplicate)
        XCTAssertEqual(sender.sentMessages.count, 3)

        sender.failSend = true
        let failed = await adapter.sendCyclingControl(
            AssistantCyclingControlCommand(
                action: .stop,
                requestID: "cycling-stop-failed",
                sequence: 4
            )
        )
        XCTAssertEqual(failed, .unreachable)
        XCTAssertEqual(sender.sentMessages.count, 4)

        sender.failSend = false
        sender.isReachable = false
        let unreachable = await adapter.sendCyclingControl(
            AssistantCyclingControlCommand(
                action: .stop,
                requestID: "cycling-stop-unreachable",
                sequence: 5
            )
        )
        XCTAssertEqual(unreachable, .unreachable)
        XCTAssertEqual(sender.sentMessages.count, 4)
    }
    func testLifecycleQueueSurvivesNewerMetricAndDeduplicatesEdges() async throws {
        let metrics = MetricRecorder(), adapter = WatchConnectivityPhoneAdapter(sender: TestPhoneControlSender(), metricHandler: { await metrics.append($0) })
        adapter.receiveMessage(["payload": try makeMetric(sequence: 2).encodedStrict()])
        let start = try makeMetric(sequence: 1, state: .started).encodedStrict()
        adapter.receiveUserInfo(["payload": start])
        adapter.receiveUserInfo(["payload": start])
        adapter.receiveUserInfo(["payload": try makeMetric(sequence: 3, state: .ended).encodedStrict()])
        await adapter.waitForPendingDeliveries()
        let received = await metrics.sequences
        XCTAssertEqual(received, [2, 1, 3])
    }
    func testUnreachableTargetedStopQueuesWithSameControlSequence() async throws {
        let sender = TestPhoneControlSender()
        let adapter = WatchConnectivityPhoneAdapter(sender: sender, controlSequence: WatchSenderSequence(key: "test-stop", defaults: nil, clock: nil))
        _ = await adapter.sendCyclingControl(.init(action: .start, requestID: "start", sequence: 100))
        sender.isReachable = false
        let result = await adapter.sendCyclingControl(.init(action: .stop, requestID: "stop", sequence: 1, workoutID: "workout-1"))
        XCTAssertEqual(result, .unreachable, "Queuing is not an execution receipt")
        let stop = try AssistantCyclingControlCommand.decodeStrict(XCTUnwrap(sender.queuedUserInfo.first?["payload"] as? Data))
        XCTAssertEqual(stop.workoutID, "workout-1")
        XCTAssertEqual(stop.sequence, 2)
        XCTAssertEqual(stop.action, .stop)
    }
}
