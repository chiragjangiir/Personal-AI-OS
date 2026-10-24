import XCTest
import SwiftUI
import LocalAuthentication
import CryptoKit
@testable import HealthKitExporter

// Host and simulator fixtures exercise client orchestration only. No server eligibility, grants or hardware keys are simulated.
final class PaymentFlowKeys: AssistantPaymentSigning {
    let key = P256.Signing.PrivateKey()
    var contexts: [LAContext?] = []
    var purposes: [String] = []
    var registrations = 0
    var missing = false
    func publicKey(role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data { key.publicKey.x963Representation }
    func sign(_ bytes: Data, role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data {
        if missing { throw AssistantPaymentKeys.KeyError.missing }
        contexts.append(context)
        purposes.append((try JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["purpose"] as? String ?? "")
        return try key.signature(for: bytes).derRepresentation
    }
    func registration(controlID: String, deviceID: String, nonce: String, role: AssistantPaymentKeys.Role, context: LAContext?) throws -> Data {
        registrations += 1
        contexts.append(context); purposes.append("keys_register")
        let publicKey = key.publicKey.x963Representation
        let statement = try AssistantPayment.keyRegistrationStatement(deviceID: deviceID, nonce: nonce,
            role: role.rawValue, publicKey: publicKey)
        let signature = try key.signature(for: statement).derRepresentation
        var fields = AssistantPayment.signedFields(statement: statement, signature: signature)
        fields.merge(["control_id": controlID, "role": role.rawValue, "public_x963_b64": publicKey.base64EncodedString()]) { _, value in value }
        if role == .user { fields["device_signature_b64"] = signature.base64EncodedString() }
        return try AssistantCentralTextWire.encode("payment_keys_register", fields: fields)
    }
}

@MainActor
final class YimiPaymentFlowTests: XCTestCase {
    @MainActor final class Transport {
        var requests: [[String: Any]] = []
        var presence: [String] = []
        var onPresence: ((String) -> Void)?
        var authenticated: [LAContext] = []
        var settingsReply: [String: Any]?
        var onOutput: ((CentralTextPacket) -> Void)?
        var notDispatchedPay = false
        var failedPayReceipt = false
        var holdUnlock = false
        var unlockEntered: (() -> Void)?
        var unlockReply: CheckedContinuation<Void, Never>?
        var recordPages: [[String: Any]] = []
        var recordDetailPages: [[String: Any]] = []
        var onSettingsSet: (() throws -> Void)?
        var losePayReply = false
        var cancelAuthentication = false
        var holdAuthentication = false
        var authenticationEntered: (() -> Void)?
        var authenticationReply: CheckedContinuation<Void, Never>?
        func send(_ bytes: Data, _ id: String, _ timeout: TimeInterval) async throws -> CentralTextPacket {
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            requests.append(input)
            let operation = try XCTUnwrap(input["operation"] as? String)
            if operation == "phone_unlock", holdUnlock {
                await withCheckedContinuation { unlockReply = $0; unlockEntered?() }
            }
            if operation == "payment_settings_set" { try onSettingsSet?() }
            if notDispatchedPay, operation == "payment_decide", input["decision"] as? String == "pay" {
                throw AssistantPaymentChannelError.notDispatched(CentralTextError.unavailable)
            }
            if losePayReply, operation == "payment_decide", input["decision"] as? String == "pay" { throw CentralTextError.unavailable }
            var reply: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "session_id": "session-1"]
            if operation == "payment_challenge_get" {
                reply.merge(["operation": "payment_challenge", "request_id": id, "purpose": input["purpose"]!,
                             "nonce": String(repeating: "A", count: 43), "expires_in_ms": 120000]) { _, value in value }
            } else if operation == "payment_settings_get" {
                reply = try settingsReply ?? YimiPaymentFlowTests.example("payment_settings"); reply["request_id"] = id
            } else if operation == "payment_records_get" {
                reply = recordPages.removeFirst(); reply["request_id"] = id
            } else if operation == "payment_record_get" {
                reply = recordDetailPages.removeFirst(); reply["request_id"] = id
            } else {
                reply.merge(["operation": "payment_receipt", "control_id": id, "ok": true]) { _, value in value }
            }
            if failedPayReceipt, operation == "payment_decide", input["decision"] as? String == "pay" {
                reply["ok"] = false; reply["error_code"] = "PAYMENT_TERMINAL_LOCKED"; reply["state"] = "awaiting_owner"
            }
            let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: reply))
            onOutput?(packet)
            return packet
        }
    }
    static func example(_ operation: String) throws -> [String: Any] {
        #if SWIFT_PACKAGE
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Contracts/payment-message.v1.json")
        #else
        let url = try XCTUnwrap(Bundle.main.url(forResource: "payment-message.v1", withExtension: "json", subdirectory: "Contracts"))
        #endif
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap((contract["examples"] as? [String: [[String: Any]]])?[operation]?.first)
    }
    func project(_ operation: String, into model: YimiPaymentModel, modify: (inout [String: Any]) -> Void = { _ in }) throws {
        var output = try Self.example(operation); modify(&output)
        model.receive(.output(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: output))))
    }
    func fixture(locked: Bool = false, notifications: (any AssistantNotificationScheduling)? = nil, notificationCenter: NotificationCenter = .default) async throws -> (YimiPaymentModel, Transport, PaymentFlowKeys) {
        let suite = "YimiPaymentFlowTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let transport = Transport(), keys = PaymentFlowKeys()
        var initialSettings = try Self.example("payment_settings")
        initialSettings["keys"] = ["device": true, "user": true]
        var locks = initialSettings["locks"] as! [String: Any]
        var phone = locks["phone"] as! [String: Any]
        phone["enabled"] = locked; phone["unlocked"] = !locked
        locks["phone"] = phone; initialSettings["locks"] = locks
        transport.settingsReply = initialSettings
        let settingsReceived = expectation(description: "attached settings projected")
        var awaitingInitialSettings = true
        let model = YimiPaymentModel(appLock: YimiAppLock(defaults: defaults, notificationCenter: notificationCenter, protectedDataAvailable: true), notifications: notifications, timeout: 1,
            sender: { try await transport.send($0, $1, $2) }, presence: { transport.presence.append($0); transport.onPresence?($0) },
            makeKeys: { _ in keys }, authenticate: { context, _ in
                transport.authenticated.append(context)
                if transport.holdAuthentication {
                    await withCheckedContinuation { transport.authenticationReply = $0; transport.authenticationEntered?() }
                }
                if transport.cancelAuthentication { throw LAError(.userCancel) }
            })
        transport.onOutput = { [weak model] packet in
            model?.receive(.output(packet))
            if awaitingInitialSettings, (try? packet.fields.value("operation", as: String.self)) == "payment_settings" {
                awaitingInitialSettings = false
                settingsReceived.fulfill()
            }
        }
        model.receive(.attached(CentralTransportBinding(sessionID: "session-1", deviceID: "phone-fixture", connectionEpoch: "epoch-1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)))
        await fulfillment(of: [settingsReceived], timeout: 1)
        try project("payment_cards", into: model)
        try project("payment_approvals", into: model)
        return (model, transport, keys)
    }
    func testI6AuthenticatedContextIsReusedForUnlockSettingsAndApprovalSignatures() async throws {
        let (model, transport, keys) = try await fixture(locked: true)
        await model.unlock()
        XCTAssertFalse(model.appLock.covered)
        await model.change(["kind": "voice", "enabled": true])
        await model.approve(try XCTUnwrap(model.approvals.first), allow: true)
        XCTAssertEqual(keys.purposes, ["phone_unlock", "settings", "approval"])
        XCTAssertEqual(transport.authenticated.count, 3)
        for (signed, authenticated) in zip(keys.contexts, transport.authenticated) { XCTAssertTrue(signed === authenticated) }
        XCTAssertEqual(keys.registrations, 0)
    }
    func testI7CancelOffDisputeAndDenyNeverAuthenticateOrSign() async throws {
        let (model, transport, keys) = try await fixture(locked: true)
        await model.change(["kind": "voice", "enabled": false])
        await model.change(["kind": "auto", "enabled": false])
        await model.decide(try XCTUnwrap(model.cards.first), decision: "cancel")
        await model.dispute(try XCTUnwrap(model.cards.first).id)
        await model.approve(try XCTUnwrap(model.approvals.first), allow: false)
        XCTAssertTrue(transport.authenticated.isEmpty)
        XCTAssertTrue(keys.contexts.isEmpty)
        let actions = transport.requests.filter { $0["operation"] as? String != "payment_settings_get" }
        XCTAssertEqual(actions.count, 5)
        XCTAssertTrue(actions.allSatisfy { $0["statement_b64"] == nil && $0["signature_b64"] == nil })
    }
    func testI7CancelledAuthenticationDoesNotBlockUnsignedApprovalDenial() async throws {
        let (model, transport, keys) = try await fixture()
        let approval = try XCTUnwrap(model.approvals.first)
        transport.cancelAuthentication = true
        await model.approve(approval, allow: true)
        XCTAssertFalse(model.submitted.contains(approval.id), "Cancelling authentication before sending must permit another approval attempt")
        await model.approve(approval, allow: false)
        XCTAssertEqual(transport.authenticated.count, 1)
        XCTAssertTrue(keys.contexts.isEmpty)
        XCTAssertEqual(transport.requests.filter { $0["decision"] as? String == "deny" }.count, 1)
    }
    func testI3LostPayReplyDoesNotMintSecondClientAuthorizationAndI7CancelStillWorks() async throws {
        let (model, transport, keys) = try await fixture()
        let card = try XCTUnwrap(model.cards.first)
        transport.losePayReply = true
        await model.decide(card, decision: "pay")
        try project("payment_cards", into: model)
        await model.decide(card, decision: "pay")
        XCTAssertEqual(keys.purposes, ["payment_decide"])
        XCTAssertEqual(transport.requests.filter { $0["decision"] as? String == "pay" }.count, 1)
        await model.decide(card, decision: "cancel")
        XCTAssertEqual(transport.requests.filter { $0["decision"] as? String == "cancel" }.count, 1)
    }
    func testI5CoveredAppCannotSignPayAndI15MissingKeyRequiresRepairWithoutRegistration() async throws {
        let (model, transport, keys) = try await fixture(locked: true)
        let card = try XCTUnwrap(model.cards.first)
        await model.decide(card, decision: "pay")
        XCTAssertTrue(keys.contexts.isEmpty)
        XCTAssertFalse(transport.requests.contains { $0["operation"] as? String == "payment_decide" })
        let (unlocked, _, missingKeys) = try await fixture()
        missingKeys.missing = true
        await unlocked.decide(try XCTUnwrap(unlocked.cards.first), decision: "pay")
        XCTAssertEqual(unlocked.error, "请重新配对这台 iPhone")
        XCTAssertEqual(missingKeys.registrations, 0)
        await model.unlock()
        XCTAssertFalse(model.appLock.covered)
        model.receive(.detached)
        XCTAssertFalse(model.available)
        XCTAssertFalse(model.appLock.covered, "Network loss alone is not a relock event; the configured timer and authoritative lease control the cover")
    }
    func testI6FirstPhoneLockRegistersUserKeyThenSignsSettingsAndUnlockWithOneContext() async throws {
        let (model, transport, keys) = try await fixture()
        try project("payment_settings", into: model) { $0["keys"] = ["device": true, "user": false] }
        transport.onSettingsSet = {
            try self.project("payment_settings", into: model) { output in
                output["keys"] = ["device": true, "user": true]
                var locks = output["locks"] as! [String: Any]
                locks["phone"] = ["enabled": true, "unlocked": false, "relock_s": 60, "relock_choices_s": [0, 60]]
                output["locks"] = locks
            }
            XCTAssertTrue(model.appLock.covered)
        }
        await model.change(["kind": "phone_lock", "enabled": true, "relock_s": 60])
        XCTAssertTrue(model.appLock.enabled)
        XCTAssertFalse(model.appLock.covered)
        XCTAssertNil(model.error)
        XCTAssertEqual(keys.registrations, 1)
        XCTAssertEqual(transport.authenticated.count, 1)
        XCTAssertEqual(keys.purposes, ["keys_register", "settings", "phone_unlock"])
        let context = try XCTUnwrap(transport.authenticated.first)
        XCTAssertTrue(keys.contexts.allSatisfy { $0 === context })
        let operations = transport.requests.compactMap { $0["operation"] as? String }
        XCTAssertLessThan(try XCTUnwrap(operations.firstIndex(of: "payment_keys_register")),
                          try XCTUnwrap(operations.firstIndex(of: "payment_settings_set")))
    }

    func testI6UnregisteredUserKeyDirectsOwnerToPhoneLockWithoutPretendingItWasLost() async throws {
        let (model, transport, keys) = try await fixture()
        try project("payment_settings", into: model) { $0["keys"] = ["device": true, "user": false] }
        await model.change(["kind": "limits", "auto_order_fen": 1000])
        XCTAssertEqual(model.error, "请先开启 iPhone 上的依米锁，再确认这个操作")
        XCTAssertTrue(transport.authenticated.isEmpty)
        XCTAssertEqual(keys.registrations, 0)
    }

    func testUnsupportedVersionHidesExistingPaymentUIUntilReattach() async throws {
        let (model, _, _) = try await fixture()
        XCTAssertTrue(model.available)
        let future: [String: Any] = ["operation": "payment_settings", "session_id": "session-1",
            "schema_version": "paios.central.text-envelope.v1", "wire_version": 2]
        let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: future))
        model.receive(.output(packet))
        XCTAssertFalse(model.available)
        XCTAssertTrue(model.cards.isEmpty)
        XCTAssertTrue(model.approvals.isEmpty)
        XCTAssertNil(model.settings)
        try project("payment_settings", into: model)
        XCTAssertFalse(model.available, "A delayed old-version snapshot cannot reopen the UI")
    }

    func testI7PaymentNotificationsOpenAppWithoutPaymentActionAndFaceIDPurposeIsBundled() async throws {
        let (model, _, _) = try await fixture()
        let card = try XCTUnwrap(model.cards.first)
        let message = AssistantNotificationMessage.payment(card)
        let content = AssistantNotificationCenter.content(for: message)
        XCTAssertEqual(content.title, "依米：有一笔付款等你确认")
        XCTAssertEqual(content.body, "解锁依米查看金额和收款方。\n请在 iPhone 上确认。手表不能付款。")
        XCTAssertEqual(content.categoryIdentifier, AssistantNotificationCenter.paymentCategoryIdentifier)
        XCTAssertTrue(AssistantNotificationCenter.paymentCategory().actions.isEmpty)
        XCTAssertEqual(content.userInfo["paios_payment"] as? Bool, true)
        #if SWIFT_PACKAGE
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let plist = try XCTUnwrap(NSDictionary(contentsOf: app.appendingPathComponent("App/Info.plist")))
        XCTAssertEqual(plist["NSFaceIDUsageDescription"] as? String, "用 Face ID 解锁依米、确认付款设置，以及确认刚才这句话是你说的")
        #else
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "NSFaceIDUsageDescription") as? String,
                       "用 Face ID 解锁依米、确认付款设置，以及确认刚才这句话是你说的")
        #endif
    }

    func testI5RelockUsesConfiguredIntervalAndReportsForegroundBackgroundLockedPresence() async throws {
        let suite = "YimiPaymentRelockTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(true, forKey: "paios.payment.phoneLock")
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let lock = YimiAppLock(defaults: defaults)
        XCTAssertTrue(lock.covered, "Cold start keeps the local privacy cover")
        lock.configure(CentralPaymentPhone(enabled: true, relock_s: 60, relock_choices_s: [0, 60], unlocked: false))
        let changed = expectation(description: "three presence states"); changed.expectedFulfillmentCount = 3
        var seen = Set<String>()
        lock.onPresence = { state in if seen.insert(state).inserted { changed.fulfill() } }
        let start = Date()
        lock.didUnlock(generation: lock.generation)
        lock.scene(.inactive, now: start)
        XCTAssertTrue(lock.obscured)
        XCTAssertEqual(lock.presence, "foreground", "LocalAuthentication keeps the scene in the foreground")
        lock.scene(.active, now: start)
        lock.scene(.background, now: start)
        XCTAssertTrue(lock.obscured)
        lock.scene(.active, now: start.addingTimeInterval(30))
        XCTAssertFalse(lock.covered)
        lock.scene(.background, now: start.addingTimeInterval(31))
        lock.scene(.active, now: start.addingTimeInterval(92))
        XCTAssertTrue(lock.covered)
        lock.configure(CentralPaymentPhone(enabled: true, relock_s: 0, relock_choices_s: [0, 60], unlocked: false))
        lock.didUnlock(generation: lock.generation); lock.scene(.inactive)
        XCTAssertFalse(lock.covered, "An authentication overlay must not instantly relock the new lease")
        lock.scene(.active); lock.scene(.background)
        XCTAssertTrue(lock.covered)
        await fulfillment(of: [changed], timeout: 1)
        XCTAssertEqual(seen, ["foreground", "background", "locked"])
        XCTAssertTrue(YimiAppLock(defaults: defaults).covered, "Persisted enabled lock covers a new instance")
    }
}
