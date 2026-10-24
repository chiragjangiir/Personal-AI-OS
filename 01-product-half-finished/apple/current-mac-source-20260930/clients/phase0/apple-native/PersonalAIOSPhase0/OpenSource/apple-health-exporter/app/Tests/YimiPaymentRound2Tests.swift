import XCTest
import Foundation
@testable import HealthKitExporter

actor RecordingAssistantNotificationScheduling: AssistantNotificationScheduling {
    private var ids: Set<String>
    private(set) var revoked: Set<String> = []
    var onRevoke: (@Sendable (String) -> Void)?
    init(ids: Set<String> = [], onRevoke: (@Sendable (String) -> Void)? = nil) { self.ids = ids; self.onRevoke = onRevoke }
    func authorizationStatus() async -> AssistantNotificationAuthorizationStatus { .authorized }
    func requestAuthorization(userInitiated: Bool) async throws -> AssistantNotificationAuthorizationStatus { .authorized }
    func deliver(_ message: AssistantNotificationMessage) async -> AssistantNotificationDelivery { ids.insert(message.identifier); return .delivered }
    func paymentNotificationIDs() async -> Set<String> { ids }
    func revoke(identifier: String) async { ids.remove(identifier); revoked.insert(identifier); onRevoke?(identifier) }
    func revokeAll() async { ids.removeAll() }
}

extension YimiPaymentFlowTests {
    func testI5OldUnlockReplyCannotRemoveNewLockAndFreshUnlockSucceeds() async throws {
        let (model, transport, _) = try await fixture(locked: true)
        let entered = expectation(description: "unlock dispatched")
        transport.holdUnlock = true; transport.unlockEntered = { entered.fulfill() }
        let unlock = Task { await model.unlock() }
        await fulfillment(of: [entered], timeout: 1)
        let oldGeneration = model.appLock.generation, start = Date()
        model.appLock.scene(.background, now: start)
        model.appLock.scene(.active, now: start.addingTimeInterval(61))
        try project("payment_settings", into: model) { output in
            output["keys"] = ["device": true, "user": true]
            var locks = output["locks"] as! [String: Any]
            locks["phone"] = ["enabled": true, "unlocked": false, "relock_s": 60, "relock_choices_s": [0, 60]]
            output["locks"] = locks
        }
        XCTAssertGreaterThan(model.appLock.generation, oldGeneration)
        transport.unlockReply?.resume(); transport.unlockReply = nil
        await unlock.value
        XCTAssertTrue(model.appLock.covered)
        transport.holdUnlock = false
        await model.unlock()
        XCTAssertFalse(model.appLock.covered)
    }

    func testI5FirstPhoneLockEnableIgnoresUnlockReplyAfterNewRelock() async throws {
        let (model, transport, _) = try await fixture()
        try project("payment_settings", into: model) { $0["keys"] = ["device": true, "user": false] }
        let setLocked = {
            try self.project("payment_settings", into: model) { output in
                output["keys"] = ["device": true, "user": true]
                var locks = output["locks"] as! [String: Any]
                locks["phone"] = ["enabled": true, "unlocked": false, "relock_s": 60, "relock_choices_s": [0, 60]]
                output["locks"] = locks
            }
        }
        transport.onSettingsSet = setLocked
        let entered = expectation(description: "first lock subsequent unlock dispatched")
        transport.holdUnlock = true; transport.unlockEntered = { entered.fulfill() }
        let enabling = Task { await model.change(["kind": "phone_lock", "enabled": true, "relock_s": 60]) }
        await fulfillment(of: [entered], timeout: 1)
        XCTAssertTrue(model.appLock.enabled); XCTAssertTrue(model.appLock.covered)
        let generation = model.appLock.generation, start = Date()
        model.appLock.scene(.background, now: start)
        model.appLock.scene(.active, now: start.addingTimeInterval(61))
        try setLocked()
        XCTAssertGreaterThan(model.appLock.generation, generation)
        transport.unlockReply?.resume(); transport.unlockReply = nil
        await enabling.value
        XCTAssertTrue(model.appLock.covered)
        transport.holdUnlock = false
        await model.unlock()
        XCTAssertFalse(model.appLock.covered)
    }

    func testI5ProtectedDataLockDuringAuthenticationIgnoresLateSuccessUntilFreshUnlock() async throws {
        let center = NotificationCenter()
        let (model, transport, keys) = try await fixture(locked: true, notificationCenter: center)
        let entered = expectation(description: "authentication awaiting completion")
        transport.holdAuthentication = true; transport.authenticationEntered = { entered.fulfill() }
        let unlock = Task { await model.unlock() }
        await fulfillment(of: [entered], timeout: 1)
        let generation = model.appLock.generation
        center.post(name: YimiAppLock.protectedDataWillLock, object: nil)
        XCTAssertTrue(model.appLock.covered)
        XCTAssertFalse(model.appLock.protectedDataAvailable)
        XCTAssertGreaterThan(model.appLock.generation, generation)
        transport.authenticationReply?.resume(); transport.authenticationReply = nil
        await unlock.value
        XCTAssertTrue(keys.purposes.isEmpty)
        XCTAssertFalse(transport.requests.contains { $0["operation"] as? String == "phone_unlock" })
        center.post(name: YimiAppLock.protectedDataDidUnlock, object: nil)
        XCTAssertTrue(model.appLock.protectedDataAvailable); XCTAssertTrue(model.appLock.covered)
        transport.holdAuthentication = false
        await model.unlock()
        XCTAssertFalse(model.appLock.covered)
        XCTAssertEqual(keys.purposes, ["phone_unlock"])
        XCTAssertEqual(transport.authenticated.count, 2)
    }

    func testI5ProtectedDataNotificationImmediatelyLocksInvalidatesAndRefusesSignatures() async throws {
        let center = NotificationCenter()
        let (model, transport, keys) = try await fixture(notificationCenter: center)
        let reported = expectation(description: "OS lock presence")
        transport.onPresence = { if $0 == "locked" { reported.fulfill() } }
        let generation = model.appLock.generation
        center.post(name: YimiAppLock.protectedDataWillLock, object: nil)
        XCTAssertTrue(model.appLock.covered)
        XCTAssertFalse(model.appLock.protectedDataAvailable)
        XCTAssertGreaterThan(model.appLock.generation, generation)
        await model.decide(try XCTUnwrap(model.cards.first), decision: "pay")
        await model.unlock()
        await model.change(["kind": "voice", "enabled": true])
        await model.approve(try XCTUnwrap(model.approvals.first), allow: true)
        await model.forgetGlassesVoice()
        XCTAssertTrue(keys.purposes.isEmpty)
        XCTAssertTrue(transport.authenticated.isEmpty)
        XCTAssertFalse(model.appLock.didUnlock(generation: model.appLock.generation))
        await fulfillment(of: [reported], timeout: 1)
        center.post(name: YimiAppLock.protectedDataDidUnlock, object: nil)
        XCTAssertTrue(model.appLock.protectedDataAvailable)
        XCTAssertFalse(model.appLock.covered, "Authentication is disabled in this fixture")
    }

    func testI5BackgroundGraceAndAppSwitcherPrivacyAreIndependentOfAuthenticationSetting() async throws {
        let (enabled, _, _) = try await fixture(locked: true)
        let lock = enabled.appLock, start = Date()
        lock.configure(CentralPaymentPhone(enabled: true, relock_s: 60, relock_choices_s: [60], unlocked: false))
        XCTAssertTrue(lock.didUnlock(generation: lock.generation))
        lock.scene(.background, now: start)
        XCTAssertFalse(lock.covered); XCTAssertTrue(lock.obscured); XCTAssertEqual(lock.presence, "background")
        lock.scene(.active, now: start.addingTimeInterval(30)); XCTAssertFalse(lock.covered)
        let (disabled, _, _) = try await fixture()
        disabled.appLock.scene(.inactive)
        XCTAssertFalse(disabled.appLock.covered); XCTAssertTrue(disabled.appLock.obscured)
        disabled.appLock.scene(.background); XCTAssertTrue(disabled.appLock.obscured)
        disabled.appLock.scene(.active); XCTAssertFalse(disabled.appLock.obscured)
    }

    func testI3LocalLockedMissingKeyAndDisconnectedPayFailuresAllowRetry() async throws {
        for failure in ["locked", "key", "disconnected"] {
            let (model, transport, keys) = try await fixture(locked: failure == "locked")
            let card = try XCTUnwrap(model.cards.first)
            if failure == "key" { keys.missing = true }
            if failure == "disconnected" { model.receive(.failed) }
            await model.decide(card, decision: "pay")
            XCTAssertFalse(model.submitted.contains(card.id), failure)
            XCTAssertFalse(transport.requests.contains { $0["decision"] as? String == "pay" }, failure)
            keys.missing = false
            if failure == "locked" { await model.unlock() }
            if failure == "disconnected" {
                model.receive(.attached(CentralTransportBinding(sessionID: "session-1", deviceID: "phone-fixture", connectionEpoch: "epoch-2", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)))
                try project("payment_settings", into: model) { $0 = transport.settingsReply! }
            }
            await model.decide(card, decision: "pay")
            XCTAssertEqual(transport.requests.filter { $0["decision"] as? String == "pay" }.count, 1, failure)
        }
    }

    func testI3TypedNotDispatchedAndAuthoritativeFailedReceiptRestorePayButLostReplyDoesNot() async throws {
        let (model, transport, _) = try await fixture()
        let card = try XCTUnwrap(model.cards.first)
        transport.notDispatchedPay = true
        await model.decide(card, decision: "pay"); XCTAssertFalse(model.submitted.contains(card.id))
        transport.notDispatchedPay = false; transport.failedPayReceipt = true
        await model.decide(card, decision: "pay"); XCTAssertFalse(model.submitted.contains(card.id))
        transport.failedPayReceipt = false; transport.losePayReply = true
        await model.decide(card, decision: "pay"); XCTAssertTrue(model.submitted.contains(card.id))
        let count = transport.requests.count
        try project("payment_cards", into: model)
        await model.decide(card, decision: "pay"); XCTAssertEqual(transport.requests.count, count)
        await model.decide(card, decision: "cancel")
        XCTAssertEqual(transport.requests.last?["decision"] as? String, "cancel")
        try project("payment_cards", into: model) { output in
            var cards = output["cards"] as! [[String: Any]]; cards[0]["state"] = "paid"; output["cards"] = cards
        }
        XCTAssertFalse(model.submitted.contains(card.id))
    }

    func testRecordsUseExplicitContinuationForLargePackedPagesWithoutLosingRows() async throws {
        let (model, transport, _) = try await fixture()
        var page = try Self.example("payment_records")
        var row = try XCTUnwrap((page["items"] as? [[String: Any]])?.first)
        row["app"] = String(repeating: "\u{0001}", count: 20)
        row["payee"] = String(repeating: "\u{0001}", count: 200)
        row["summary"] = String(repeating: "\u{0001}", count: 400)
        let ids = (1...5).map { String(format: "pay-00000000-0000-4000-8000-%012d", $0) }
        func rows(_ indices: Range<Int>) -> [[String: Any]] { indices.map { var item = row; item["payment_id"] = ids[$0]; item["at"] = "2026-10-15T00:00:0\(5 - $0).000Z"; return item } }
        page["items"] = rows(0..<3)
        XCTAssertNotNil(page["next_before"], "Use the authority's opaque continuation")
        var last = page; last["items"] = rows(3..<5); last.removeValue(forKey: "next_before")
        for output in [page, last] { XCTAssertLessThanOrEqual(try JSONSerialization.data(withJSONObject: output).count, 12_288) }
        var oversized = page; oversized["items"] = rows(0..<4)
        XCTAssertGreaterThan(try JSONSerialization.data(withJSONObject: oversized).count, 12_288)
        transport.recordPages = [page, last]
        await model.loadRecords()
        XCTAssertEqual(model.records.count, 3)
        let before = try XCTUnwrap(model.nextBefore)
        await model.loadRecords(before: before)
        XCTAssertEqual(model.records.map(\.id), ids); XCTAssertNil(model.nextBefore)
        let requests = transport.requests.filter { $0["operation"] as? String == "payment_records_get" }
        XCTAssertNil(requests.first?["before"]); XCTAssertEqual(requests.last?["before"] as? String, before)
        XCTAssertEqual(model.records.last?.summary, row["summary"] as? String)
    }

    func testI8NotificationsReconcileColdStartTerminalAndDisappearedSnapshots() async throws {
        let removed = expectation(description: "cold and ended notifications withdrawn"); removed.expectedFulfillmentCount = 4
        let scheduler = RecordingAssistantNotificationScheduling(ids: ["payment-stale", "payment-approval-stale"], onRevoke: { _ in removed.fulfill() })
        let (model, _, _) = try await fixture(notifications: scheduler)
        let cardID = try XCTUnwrap(model.cards.first).id, approvalID = try XCTUnwrap(model.approvals.first).id
        _ = await scheduler.deliver(.payment(try XCTUnwrap(model.cards.first)))
        _ = await scheduler.deliver(.paymentApproval(try XCTUnwrap(model.approvals.first)))
        try project("payment_cards", into: model) { output in
            var cards = output["cards"] as! [[String: Any]]; cards[0]["state"] = "expired"; output["cards"] = cards
        }
        try project("payment_approvals", into: model) { $0["approvals"] = [] }
        await fulfillment(of: [removed], timeout: 1)
        let revoked = await scheduler.revoked
        XCTAssertTrue(revoked.isSuperset(of: ["payment-stale", "payment-approval-stale", "payment-" + cardID, "payment-approval-" + approvalID]))
    }

    func testI8ExpiredCardsAndApprovalsWithdrawWithoutAnotherSnapshot() async throws {
        let removed = expectation(description: "expiry withdrawal"); removed.expectedFulfillmentCount = 2
        let scheduler = RecordingAssistantNotificationScheduling(onRevoke: { _ in removed.fulfill() })
        let (model, _, _) = try await fixture(notifications: scheduler)
        _ = await scheduler.deliver(.payment(try XCTUnwrap(model.cards.first)))
        _ = await scheduler.deliver(.paymentApproval(try XCTUnwrap(model.approvals.first)))
        try project("payment_cards", into: model) { output in
            var cards = output["cards"] as! [[String: Any]]; cards[0]["expires_in_ms"] = 30; output["cards"] = cards
        }
        try project("payment_approvals", into: model) { output in
            var approvals = output["approvals"] as! [[String: Any]]; approvals[0]["expires_in_ms"] = 30; output["approvals"] = approvals
        }
        await fulfillment(of: [removed], timeout: 1)
        let ids = await scheduler.paymentNotificationIDs(); XCTAssertTrue(ids.isEmpty)
    }
}
