import UserNotifications
import XCTest
@testable import HealthKitExporter

final class AssistantNotificationTests: XCTestCase {
    private func makeReminder(_ row: [String: String]) throws -> AssistantReminder {
        let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": "paios.central.text-envelope.v1", "operation": "reminders_sync", "session_id": "session",
            "sync_id": "sync", "part": 0, "final": true, "reminders": [row]]))
        let rows = try XCTUnwrap(packet.fields.value("reminders", as: [CentralBody].self))
        return try AssistantReminder(XCTUnwrap(rows.first))
    }

    func testDeduperRejectsDuplicateAndHonorsRevoke() async {
        let deduper = AssistantNotificationDeduper()
        let first = await deduper.reserve("result-1")
        let duplicate = await deduper.reserve("result-1")
        await deduper.revoke("result-1")
        let revoked = await deduper.reserve("result-1")
        XCTAssertEqual(first, .delivered)
        XCTAssertEqual(duplicate, .duplicate)
        XCTAssertEqual(revoked, .revoked)
    }

    func testDeduperCanResetForNextSession() async {
        let deduper = AssistantNotificationDeduper()
        _ = await deduper.reserve("result-1")
        await deduper.clear()
        let result = await deduper.reserve("result-1")
        XCTAssertEqual(result, .delivered)
    }

    func testPermissionTransitionMapsToRevokedAndAuthorized() {
        XCTAssertEqual(
            AssistantNotificationCenter.map(.denied),
            .denied
        )
        XCTAssertEqual(
            AssistantNotificationCenter.map(.authorized),
            .authorized
        )
    }

    func testMalformedMessageIsRejected() {
        let message = AssistantNotificationMessage(
            identifier: "",
            title: "title",
            body: "body"
        )
        XCTAssertFalse(message.isWellFormed)
    }
    func testPaymentNotificationContainsOnlyGenericCopyAndOpensPayment() {
        func card(payee: String, amount: Int) -> CentralPaymentCard {
            CentralPaymentCard(payment_id: "private-card", intent_id: "intent", version: 1, state: .awaiting_owner,
                amount_fen: amount, payee: payee, app: "private-app", items: ["private-item"], delivery: nil,
                expires_in_ms: 1000, auto_in_ms: nil, decision_nonce: "private-nonce", payee_key: "private-key",
                methods: CentralPaymentMethods(voice: CentralPaymentVoiceMethod(available: false, reason: nil, tries_left: 0),
                    auto: CentralPaymentAutoMethod(available: false, reason: nil)), notice: nil, result: nil,
                today_auto_used_fen: nil)
        }
        let message = AssistantNotificationMessage.payment(card(payee: "private-payee", amount: 12345))
        XCTAssertEqual(message, .payment(card(payee: "another-payee", amount: 99999)))
        XCTAssertEqual(message.identifier, "payment-private-card")
        XCTAssertEqual(message.title, "依米：有一笔付款等你确认")
        XCTAssertEqual(message.body, "解锁依米查看金额和收款方。\n请在 iPhone 上确认。手表不能付款。")
        let content = AssistantNotificationCenter.content(for: message)
        XCTAssertEqual(content.title, message.title)
        XCTAssertEqual(content.body, message.body)
        XCTAssertEqual(content.categoryIdentifier, AssistantNotificationCenter.paymentCategoryIdentifier)
        XCTAssertEqual(content.userInfo as NSDictionary, ["paios_payment": true] as NSDictionary)
    }

    func testQuestionAndCareNotificationsOpenExactIDsWithoutActions() throws {
        let rawExpiry = "2030-01-01T00:00:00.120Z"
        let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": AssistantCentralTextWire.schema, "operation": "gesture_card", "session_id": "session",
            "card_id": "card-1", "question": "选哪一个？", "expires_at": rawExpiry,
            "options": [["id": "first", "label": "甲", "lines": []], ["id": "second", "label": "乙", "lines": []]]]))
        let card = try CentralQuestion(packet.fields)
        XCTAssertEqual(card.expiresAt, rawExpiry)
        let selection = AssistantQuestionSelection(identity: "owner", cardID: card.id, optionID: "second")
        XCTAssertEqual(try selection.text(for: card, now: .distantPast), "就选第2项：乙（仅选择，不授权付款、身份或记忆写入）")
        XCTAssertThrowsError(try selection.text(for: card, now: card.deadline))
        XCTAssertThrowsError(try AssistantQuestionSelection(identity: "owner", cardID: "stale", optionID: "second").text(for: card, now: .distantPast))
        XCTAssertThrowsError(try AssistantQuestionSelection(identity: "owner", cardID: card.id, optionID: "missing").text(for: card, now: .distantPast))
        let question = AssistantNotificationCenter.content(for: .question(card))
        XCTAssertEqual(question.categoryIdentifier, AssistantNotificationCenter.questionCategoryIdentifier)
        let questionURL = try XCTUnwrap(URL(string: XCTUnwrap(question.userInfo["yimi_deep_link"] as? String)))
        XCTAssertEqual(URLComponents(url: questionURL, resolvingAgainstBaseURL: false)?.percentEncodedPath.removingPercentEncoding?.dropFirst().description, card.id)
        XCTAssertEqual(questionURL.host, "card")
        XCTAssertEqual(AssistantNotificationDestination.card("卡/1?#").url.absoluteString, "yimi://card/%E5%8D%A1%2F1%3F%23")
        let care = AssistantNotificationCenter.content(for: AssistantNotificationMessage(identifier: "care", title: "依米",
            body: "你还好吗", careIdentity: "captured-owner", deepLink: .care("care/一")))
        let careURL = try XCTUnwrap(URL(string: XCTUnwrap(care.userInfo["yimi_deep_link"] as? String)))
        XCTAssertEqual(URLComponents(url: careURL, resolvingAgainstBaseURL: false)?.percentEncodedPath.removingPercentEncoding?.dropFirst().description, "care/一")
        XCTAssertEqual(careURL.host, "care")
        XCTAssertTrue(AssistantNotificationCenter.questionCategory().actions.isEmpty)
        XCTAssertTrue(AssistantNotificationCenter.careCategory().actions.isEmpty)
    }

    func testApprovalNotificationsAndHiddenPreviewsUseGenericCategoryWithoutActions() {
        for (kind, title) in [("glasses_unlock", "依米：眼镜请求解锁"),
                              ("voiceprint_enrol", "依米：眼镜请求录入你的声音")] {
            let approval = CentralPaymentApproval(approval_id: "approval", kind: kind, target_device_id: "private-device",
                device_label: "private-label", expires_in_ms: 1000, nonce: "private-nonce")
            let message = AssistantNotificationMessage.paymentApproval(approval)
            XCTAssertEqual(message.identifier, "payment-approval-approval")
            XCTAssertEqual(message.title, title)
            XCTAssertEqual(message.body, "解锁依米查看金额和收款方。")
            let content = AssistantNotificationCenter.content(for: message)
            XCTAssertEqual(content.title, title)
            XCTAssertEqual(content.body, message.body)
            XCTAssertEqual(content.categoryIdentifier, AssistantNotificationCenter.paymentCategoryIdentifier)
            XCTAssertEqual(content.userInfo as NSDictionary, ["paios_payment": true] as NSDictionary)
        }
        let category = AssistantNotificationCenter.paymentCategory()
        XCTAssertEqual(category.identifier, AssistantNotificationCenter.paymentCategoryIdentifier)
        XCTAssertEqual(category.hiddenPreviewsBodyPlaceholder, "解锁依米查看金额和收款方。")
        XCTAssertTrue(category.actions.isEmpty)
        XCTAssertEqual(category.options, [])
    }

    func testPrivateResultContentBoundaryMasksRawTitleAndBody() {
        let message = AssistantNotificationMessage(identifier: "private-result", title: "一点点 ¥16.60",
            body: "【已付款】 一点点 ¥16.60", privacy: .payment)
        let content = AssistantNotificationCenter.content(for: message)
        XCTAssertEqual(content.title, "依米")
        XCTAssertEqual(content.body, "依米：付款结果已更新，解锁依米查看。")
        XCTAssertEqual(content.categoryIdentifier, AssistantNotificationCenter.paymentResultCategoryIdentifier)
        let initiallyVisible = AssistantNotificationMessage.assistantReply(identifier: "changed-state", text: message.body,
            privacy: .payment, locked: false, active: true)
        XCTAssertEqual(AssistantNotificationCenter.content(for: initiallyVisible).body, message.body)
        XCTAssertEqual(AssistantNotificationCenter.content(for: initiallyVisible, redactsPrivateContent: true).body,
            "依米：付款结果已更新，解锁依米查看。")
    }

    func testReminderSchedulingReplacementCancellationAndDenial() async throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let reminder = try makeReminder(["id": "native-job", "text": "喝水",
            "fire_at": "2027-01-20T10:30:00+08:00"])
        var pending: [UNNotificationRequest] = []
        var removed: [String] = []
        try await AssistantNotificationCenter.syncReminders([reminder], pending: pending, status: .authorized, now: now,
            add: { pending.append($0) }, remove: { removed += $0 })
        XCTAssertEqual(pending.first?.identifier, "native-job")
        XCTAssertEqual(pending.first?.content.body, "喝水")
        let trigger = try XCTUnwrap(pending.first?.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        XCTAssertEqual(trigger.dateComponents.hour, 2, "the +08:00 instant is scheduled in UTC")
        try await AssistantNotificationCenter.syncReminders([reminder], pending: pending, status: .authorized, now: now,
            add: { _ in XCTFail("identical snapshot must not add again") }, remove: { removed += $0 })
        let changed = try makeReminder(["id": "native-job", "text": "喝茶",
            "fire_at": "2027-01-20T11:30:00+08:00"])
        try await AssistantNotificationCenter.syncReminders([changed], pending: pending, status: .authorized, now: now,
            add: { XCTAssertEqual($0.identifier, "native-job"); XCTAssertEqual($0.content.body, "喝茶") }, remove: { removed += $0 })
        try await AssistantNotificationCenter.syncReminders([], pending: pending, status: .denied, now: now,
            add: { _ in XCTFail() }, remove: { removed += $0 })
        XCTAssertEqual(removed, ["native-job"])
        try await AssistantNotificationCenter.syncReminders([], pending: pending, status: .authorized,
            now: reminder.fireAt.addingTimeInterval(1), add: { _ in XCTFail() },
            remove: { XCTAssertTrue($0.isEmpty, "a due alert must remain with the OS until presentation") })
        do {
            try await AssistantNotificationCenter.syncReminders([reminder], pending: [], status: .denied, now: now,
                add: { _ in XCTFail() }, remove: { _ in })
            XCTFail("denied permission must surface failure")
        } catch { XCTAssertEqual(error as? AssistantNotificationError, .remindersPermissionDenied) }
        // The same desired snapshot must still schedule after notification consent changes.
        var retried: [UNNotificationRequest] = []
        try await AssistantNotificationCenter.syncReminders([reminder], pending: [], status: .authorized, now: now,
            add: { retried.append($0) }, remove: { _ in })
        XCTAssertEqual(retried.map(\.identifier), [reminder.id])
    }

    func testFailedReminderAddRollsBackAndLeavesPreviousSnapshot() async throws {
        enum Failure: Error { case add }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let first = try makeReminder(["id": "first", "text": "喝水", "fire_at": "2027-01-20T10:30:00Z"])
        let second = try makeReminder(["id": "second", "text": "喝茶", "fire_at": "2027-01-20T11:30:00Z"])
        let old = UNMutableNotificationContent()
        old.userInfo = ["paios_reminder": true]; old.body = "previous"
        let previous = UNNotificationRequest(identifier: "previous", content: old,
            trigger: UNCalendarNotificationTrigger(dateMatching: Calendar(identifier: .gregorian)
                .dateComponents(in: TimeZone(secondsFromGMT: 0)!, from: first.fireAt), repeats: false))
        var pending = [previous]
        do {
            try await AssistantNotificationCenter.syncReminders([first, second], pending: pending, status: .authorized, now: now,
                add: { request in
                    if request.identifier == "second" { throw Failure.add }
                    pending.removeAll { $0.identifier == request.identifier }
                    pending.append(request)
                }, remove: { ids in pending.removeAll { ids.contains($0.identifier) } })
            XCTFail("add failure must propagate")
        } catch { XCTAssertTrue(error is Failure) }
        XCTAssertEqual(pending.map(\.identifier), ["previous"])
        try await AssistantNotificationCenter.syncReminders([first, second], pending: pending, status: .authorized, now: now,
            add: { request in
                pending.removeAll { $0.identifier == request.identifier }
                pending.append(request)
            }, remove: { ids in pending.removeAll { ids.contains($0.identifier) } })
        XCTAssertEqual(Set(pending.map(\.identifier)), Set([first.id, second.id]))
        do {
            try await AssistantNotificationCenter.syncReminders(Array(repeating: first, count: 65), pending: pending,
                status: .authorized, now: now, add: { _ in XCTFail() }, remove: { _ in XCTFail() })
            XCTFail("OS capacity must surface")
        } catch { XCTAssertEqual(error as? AssistantNotificationError, .tooManyReminders) }
    }

    func testReminderPagesBecomeAuthoritativeOnlyAtFinalAndValidateSession() throws {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288))
        func packet(_ part: Int, final: Bool, session: String = "session", rows: [[String: String]]) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
                "schema_version": "paios.central.text-envelope.v1", "operation": "reminders_sync", "session_id": session,
                "sync_id": "sync", "part": part, "final": final, "reminders": rows]))
        }
        let row = ["id": "native-job", "text": "喝水", "fire_at": "2027-01-20T10:30:00+08:00"]
        XCTAssertThrowsError(try consumer.accept(packet(0, final: true, session: "other", rows: [row])))
        try consumer.accept(packet(0, final: false, rows: [row]))
        XCTAssertNil(consumer.ownerVoice.reminders)
        XCTAssertThrowsError(try consumer.accept(packet(2, final: true, rows: [])))
        try consumer.accept(packet(1, final: true, rows: []))
        XCTAssertEqual(consumer.ownerVoice.reminders?.map(\.id), ["native-job"])
        try consumer.accept(packet(0, final: true, rows: []))
        XCTAssertEqual(consumer.ownerVoice.reminders, [])
        try consumer.accept(packet(0, final: false, rows: [row]))
        try consumer.reset(binding: nil)
        try consumer.reset(binding: CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "2",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288))
        XCTAssertThrowsError(try consumer.accept(packet(1, final: true, rows: [])))
        XCTAssertNil(consumer.ownerVoice.reminders)
        XCTAssertThrowsError(try makeReminder(["id": "bad", "text": "bad", "fire_at": "2027-01-20T10:30:00"]))
    }

}
