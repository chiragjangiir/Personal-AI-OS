import Foundation
import XCTest
@testable import HealthKitExporter

final class AssistantActivityTests: XCTestCase {
    func testCapabilityUnknownAndWaitingDecodeAndDisplay() throws {
        for state in ["unknown", "waiting"] {
            var value = try XCTUnwrap(fixtures()["single_running"])
            var card = try XCTUnwrap(value["card"] as? [String: Any])
            card["state"] = state
            var items = try XCTUnwrap(card["items"] as? [[String: Any]])
            items[0]["state"] = state
            if state == "unknown" {
                card["completed_at"] = card["observed_at"]
                items[0]["completed_at"] = card["observed_at"]
            }
            var counts = try XCTUnwrap(card["counts"] as? [String: Any])
            counts["running"] = 0
            counts[state] = 1
            card["counts"] = counts
            card["items"] = items
            value["card"] = card
            let decoded = try JSONDecoder().decode(CentralActivityUpdate.self, from: packet(value).bytes)
            let presentation = ActivityPresentation(update: decoded, arrivedAt: Date(timeIntervalSince1970: 0))
            XCTAssertEqual(decoded.card.state.rawValue, state)
            XCTAssertEqual(decoded.card.items[0].state.rawValue, state)
            XCTAssertEqual(presentation.heading, state == "unknown" ? "结果待核对" : "正在等待")
            let roundTrip = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? NSDictionary
            XCTAssertEqual(roundTrip, value as NSDictionary)
        }
    }
    private func fixtures() throws -> [String: [String: Any]] {
        #if SWIFT_PACKAGE
        let url = Bundle.module.url(forResource: "activity-update.fixtures", withExtension: "json", subdirectory: "Fixtures")
        #else
        let url = Bundle(for: Self.self).url(forResource: "activity-update.fixtures", withExtension: "json")
        #endif
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(url))) as? [String: Any])
        return try XCTUnwrap(root["fixtures"] as? [String: [String: Any]])
    }

    private func packet(_ value: [String: Any]) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value))
    }

    private func update(_ name: String) throws -> CentralActivityUpdate {
        try JSONDecoder().decode(CentralActivityUpdate.self, from: packet(XCTUnwrap(fixtures()[name])).bytes)
    }

    private func binding(_ session: String = "session-fixture-1") throws -> CentralTransportBinding {
        let source = try CentralTextTestFixture().binding
        return CentralTransportBinding(sessionID: session, deviceID: source.deviceID, connectionEpoch: source.connectionEpoch,
            expectedGatewayIdentity: source.expectedGatewayIdentity, maxPacketBytes: source.maxPacketBytes,
            callRejoinWindowS: source.callRejoinWindowS)
    }

    func testServerHistoryMergeKeepsKnownRequestIdentityAfterDelivery() {
        let sent = YimiItem(id: "me-input", kind: .me, text: "打开云手机", date: Date(),
            submissionEventID: "input", submissionProcessedID: "processed-input")
        var timeline = YimiConversationTimeline(items: [sent])
        timeline.upsert(YimiItem(id: "me-input", kind: .me, text: "打开云手机", date: Date(), seq: 2), preserveDelivery: true)
        XCTAssertEqual(timeline.items.first?.activityProcessedEventID(consumer: nil), "processed-input")
        XCTAssertEqual(timeline.items.first?.submissionEventID, "input")
        XCTAssertNil(timeline.items.first?.delivery)
    }

    func testAllSharedFixturesDecodeThroughCanonicalWireWithoutLosingFields() throws {
        let values = try fixtures()
        XCTAssertEqual(Set(values.keys), ["single_running", "single_slow", "parallel_six", "failed_timeout", "partial_done", "succeeded", "partial_child"])
        for (name, value) in values {
            let decoded = try JSONDecoder().decode(CentralActivityUpdate.self, from: packet(value).bytes)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? NSDictionary
            XCTAssertEqual(encoded, value as NSDictionary, name)
            var consumer = AssistantCentralTextConsumer()
            try consumer.reset(binding: binding(decoded.session_id), generation: 1, ownerPairingIdentity: "owner")
            try consumer.accept(packet(value))
            XCTAssertEqual(consumer.activities.cards.map(\.update), [decoded], name)
        }
    }

    func testExplicitProgressSurvivesWireAndConsumerWithoutUsingTaskCounts() throws {
        var value = try XCTUnwrap(fixtures()["parallel_six"])
        var card = try XCTUnwrap(value["card"] as? [String: Any])
        var items = try XCTUnwrap(card["items"] as? [[String: Any]])
        card["progress"] = ["version": 1, "value": 3, "total": 10]
        items[0]["progress"] = ["version": 1, "value": 125, "total": 500]
        card["items"] = items
        value["card"] = card
        let wire = try packet(value)
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: binding(try XCTUnwrap(value["session_id"] as? String)), generation: 1, ownerPairingIdentity: "owner")
        try consumer.accept(wire)
        let presentation = try XCTUnwrap(consumer.activities.cards.first)
        XCTAssertEqual(presentation.card.progress, CentralActivityProgress(version: 1, value: 3, total: 10))
        XCTAssertEqual(presentation.card.items[0].progress?.accessibilityLabel, "进度 25%")
        XCTAssertTrue(presentation.accessibilityLabel(at: presentation.arrivedAt).contains("进度 30%"))
        XCTAssertFalse(presentation.accessibilityLabel(at: presentation.arrivedAt).contains("件在办"))
        XCTAssertEqual(presentation.pill, presentation.card.step_summary ?? presentation.card.summary)
        let roundTrip = try JSONSerialization.jsonObject(with: JSONEncoder().encode(presentation.update)) as? NSDictionary
        XCTAssertEqual(roundTrip, value as NSDictionary)
    }

    func testMissingProgressNeverDerivesProgressFromCountsOrElapsed() throws {
        let arrival = Date(timeIntervalSince1970: 100)
        for name in ["single_running", "parallel_six", "partial_done", "succeeded"] {
            let presentation = ActivityPresentation(update: try update(name), arrivedAt: arrival)
            XCTAssertNil(presentation.card.progress, name)
            XCTAssertTrue(presentation.card.items.allSatisfy { $0.progress == nil }, name)
            let label = presentation.accessibilityLabel(at: arrival)
            XCTAssertFalse(label.contains("进度 "), name)
            XCTAssertFalse(label.contains("件在办"), name)
            XCTAssertFalse(label.contains("件完成"), name)
            XCTAssertTrue(label.contains("用时"), name)
        }
    }

    func testNewRevisionReplacesWholeSnapshotAndStaleOrDuplicateDoesNotResetArrival() throws {
        let arrival = Date(timeIntervalSince1970: 100)
        let running = try update("single_running"), slow = try update("single_slow"), success = try update("succeeded")
        var store = CentralActivityStore()
        store.accept(running, at: arrival)
        store.accept(slow, at: arrival.addingTimeInterval(10))
        XCTAssertEqual(store.cards.count, 1)
        XCTAssertEqual(store.cards[0].update, slow)
        XCTAssertEqual(store.cards[0].arrivedAt, arrival.addingTimeInterval(10))
        var duplicateWire = try XCTUnwrap(fixtures()["single_slow"])
        var duplicateCard = try XCTUnwrap(duplicateWire["card"] as? [String: Any])
        duplicateCard["summary"] = "同版本不应覆盖"
        duplicateWire["card"] = duplicateCard
        let duplicate = try JSONDecoder().decode(CentralActivityUpdate.self, from: packet(duplicateWire).bytes)
        store.accept(duplicate, at: arrival.addingTimeInterval(20))
        store.accept(running, at: arrival.addingTimeInterval(30))
        XCTAssertEqual(store.cards[0].update, slow)
        XCTAssertEqual(store.cards[0].arrivedAt, arrival.addingTimeInterval(10))
        store.accept(success, at: arrival.addingTimeInterval(40))
        XCTAssertEqual(store.cards[0].update, success)
        XCTAssertNil(store.cards[0].card.step_summary, "An absent field clears the old revision's value")
        XCTAssertNil(store.cards[0].card.items[0].step_summary)
        XCTAssertEqual(store.cards[0].card.items[0].state, .succeeded)
        store.accept(try update("failed_timeout"), at: arrival)
        XCTAssertEqual(store.cards.count, 2, "Distinct requests retain separate cards")
    }

    func testOnlySucceededCardWithExactMatchingReplyCollapses() throws {
        let arrival = Date(timeIntervalSince1970: 100)
        for name in try fixtures().keys {
            let presentation = ActivityPresentation(update: try update(name), arrivedAt: arrival)
            XCTAssertFalse(presentation.collapsed(replyProcessedIDs: []), name)
            XCTAssertFalse(presentation.collapsed(replyProcessedIDs: [presentation.processedEventID + "-other"]), name)
            XCTAssertEqual(presentation.collapsed(replyProcessedIDs: [presentation.processedEventID]),
                presentation.card.state == .succeeded, name)
        }
    }

    func testElapsedUsesArrivalTimeAndTerminalElapsedFreezes() throws {
        let arrival = Date(timeIntervalSince1970: 100)
        let running = ActivityPresentation(update: try update("single_running"), arrivedAt: arrival)
        XCTAssertEqual(running.elapsed(at: arrival), 18_000)
        XCTAssertEqual(running.elapsed(at: arrival.addingTimeInterval(5)), 23_000)
        XCTAssertEqual(running.elapsed(at: arrival.addingTimeInterval(-5)), 18_000)
        for name in ["succeeded", "failed_timeout", "partial_done"] {
            let terminal = ActivityPresentation(update: try update(name), arrivedAt: arrival)
            XCTAssertEqual(terminal.elapsed(at: arrival.addingTimeInterval(3_600)), terminal.card.elapsed_ms, name)
            XCTAssertNil(terminal.slowSeconds(at: arrival.addingTimeInterval(3_600)), name)
        }
        XCTAssertEqual(ActivityPresentation.duration(100_000), "1分40秒")
    }

    func testDurationHasExplicitUnitsAtMinuteAndHourBoundaries() {
        let cases: [(Int, String)] = [
            (0, "0秒"), (59_999, "59秒"), (60_000, "1分00秒"), (61_000, "1分01秒"),
            (742_000, "12分22秒"), (3_599_999, "59分59秒"),
            (3_600_000, "1小时00分00秒"), (3_661_000, "1小时01分01秒")
        ]
        for (milliseconds, expected) in cases {
            XCTAssertEqual(ActivityPresentation.duration(milliseconds), expected)
        }
    }

    func testPartialItemAndOptionalPartialCountDecodeWithoutChangingOldSnapshots() throws {
        var value = try XCTUnwrap(fixtures()["partial_done"])
        var card = try XCTUnwrap(value["card"] as? [String: Any])
        var items = try XCTUnwrap(card["items"] as? [[String: Any]])
        items[0]["state"] = "partial"
        items[0]["failure_reason"] = "一项已完成，另一项已停止"
        card["items"] = items
        var counts = try XCTUnwrap(card["counts"] as? [String: Any])
        counts["partial"] = 1
        card["counts"] = counts
        value["card"] = card
        let decoded = try JSONDecoder().decode(CentralActivityUpdate.self, from: packet(value).bytes)
        XCTAssertEqual(decoded.card.items[0].state, .partial)
        XCTAssertEqual(decoded.card.items[0].statusLabel, "部分完成")
        XCTAssertEqual(decoded.card.counts.partial, 1)
        XCTAssertEqual(decoded.card.items[0].failure_reason, "一项已完成，另一项已停止")
        XCTAssertNil(try update("single_running").card.counts.partial)
    }

    func testSlowUsesServerProgressDeltaPlusTimeSinceArrivalDespiteClockSkew() throws {
        let arrival = Date(timeIntervalSince1970: 100)
        let running = ActivityPresentation(update: try update("single_running"), arrivedAt: arrival)
        XCTAssertNil(running.slowSeconds(at: arrival.addingTimeInterval(26)))
        XCTAssertEqual(running.slowSeconds(at: arrival.addingTimeInterval(27)), 30)
        let slow = ActivityPresentation(update: try update("single_slow"), arrivedAt: arrival)
        XCTAssertEqual(slow.slowSeconds(at: arrival), 40)
        XCTAssertEqual(slow.slowSeconds(at: arrival.addingTimeInterval(7)), 47)
        XCTAssertEqual(slow.slowSeconds(at: arrival.addingTimeInterval(-5)), 40)
        XCTAssertTrue(slow.accessibilityLabel(at: arrival).contains("40 秒没有新进度"))
    }

    func testConsumerRejectsForeignSessionAndResetsOwnerOrSessionScope() throws {
        let value = try XCTUnwrap(fixtures()["single_running"])
        let current = try binding()
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: current, generation: 1, ownerPairingIdentity: "owner")
        try consumer.accept(packet(value))
        let original = consumer.activities
        var foreign = value
        foreign["session_id"] = "other-session"
        XCTAssertThrowsError(try consumer.accept(packet(foreign)))
        XCTAssertEqual(consumer.activities, original)
        try consumer.reset(binding: current, generation: 2, ownerPairingIdentity: "owner")
        XCTAssertEqual(consumer.activities, original)
        try consumer.reset(binding: current, generation: 3, ownerPairingIdentity: "replacement-owner")
        XCTAssertTrue(consumer.activities.cards.isEmpty)
        try consumer.accept(packet(value))
        try consumer.reset(binding: binding("new-session"), generation: 4, ownerPairingIdentity: "replacement-owner")
        XCTAssertTrue(consumer.activities.cards.isEmpty)
        XCTAssertThrowsError(try consumer.accept(packet(value)))
        try consumer.reset(binding: current, generation: 5, ownerPairingIdentity: "owner")
        try consumer.accept(packet(value))
        try consumer.reset(binding: nil, generation: 6)
        XCTAssertTrue(consumer.activities.cards.isEmpty)
        XCTAssertThrowsError(try consumer.accept(packet(value)))
    }

    func testTimelineUsesDocumentedProcessedIDsAndExplicitMetadata() throws {
        let date = Date(timeIntervalSince1970: 100)
        let rows: [(YimiItem, String?)] = [
            (YimiItem(id: "her-d-one", kind: .her, text: "回复", date: date), "d-one"),
            (YimiItem(id: "me-ambient-d-one", kind: .me, text: "语音", date: date), "d-one"),
            (YimiItem(id: "call-d-one", kind: .her, text: "回复", date: date), "d-one"),
            (YimiItem(id: "task-d-one", kind: .me, text: "任务", date: date), "d-one"),
            (YimiItem(id: "me-input-event", kind: .me, text: "输入", date: date), nil),
            (YimiItem(id: "call-call-id", kind: .call, text: "通话", date: date), nil),
            (YimiItem(id: "call-one/0-assistant", kind: .her, text: "通话回复", date: date, callID: "one"), nil),
            (YimiItem(id: "me-input-event", kind: .me, text: "输入", date: date, submissionProcessedID: "explicit-d"), "explicit-d")
        ]
        for (row, expected) in rows {
            XCTAssertEqual(row.processedEventID, expected, row.id)
            XCTAssertEqual(row.activityProcessedEventID(consumer: nil), expected, row.id)
        }
        let fixture = try CentralTextTestFixture(), consumer = try fixture.consumer()
        let event = try XCTUnwrap(consumer.eventID)
        let processed = try XCTUnwrap(consumer.submissionProcessedID(eventID: event))
        let typed = YimiItem(id: "me-" + event, kind: .me, text: "输入", date: date)
        XCTAssertEqual(typed.activityProcessedEventID(consumer: consumer), processed)
        let voice = YimiItem(id: "voice-local-id", kind: .me, text: "语音", date: date, submissionEventID: event)
        XCTAssertEqual(voice.activityProcessedEventID(consumer: consumer), processed)
        let unknown = YimiItem(id: "me-unrelated-event", kind: .me, text: "另一句", date: date)
        XCTAssertNil(unknown.activityProcessedEventID(consumer: consumer))
    }

    func testCanonicalWireRejectsInvalidActivityBoundaries() throws {
        let original = try XCTUnwrap(fixtures()["single_running"])
        let originalCard = try XCTUnwrap(original["card"] as? [String: Any])
        let mutations: [(String, Any)] = [
            ("revision", -1), ("revision", true), ("state", "slow"),
            ("elapsed_ms", -1), ("summary", String(repeating: "字", count: 49)),
            ("progress", ["version": 1, "value": 0, "total": 0]),
            ("progress", ["version": 2, "value": 1, "total": 2]),
            ("progress", ["version": 1, "value": -1, "total": 2]),
            ("summary", "第一行\n第二行"), ("observed_at", "2026-10-19T16:28:18+08:00"),
            ("tool_args", ["secret": "synthetic"])
        ]
        for (field, invalid) in mutations {
            var value = original, card = originalCard
            card[field] = invalid
            value["card"] = card
            XCTAssertThrowsError(try packet(value), field)
        }
        for (fixtureName, required) in [("succeeded", "completed_at"), ("failed_timeout", "failure_reason"), ("partial_done", "failure_reason")] {
            var value = try XCTUnwrap(fixtures()[fixtureName])
            var card = try XCTUnwrap(value["card"] as? [String: Any])
            card.removeValue(forKey: required)
            value["card"] = card
            XCTAssertThrowsError(try packet(value), fixtureName + ":" + required)
        }
        var tooMany = original, card = originalCard
        card["items"] = Array(repeating: try XCTUnwrap((card["items"] as? [[String: Any]])?.first), count: 9)
        tooMany["card"] = card
        XCTAssertThrowsError(try packet(tooMany))
    }

}


extension AssistantActivityTests {
    func testExt13PendingPromotionPreservesAllLiveActivityRevisions() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        let firstChunk = try XCTUnwrap(fixture.chunks().first)
        try consumer.accept(firstChunk)
        _ = try consumer.beginSubmit(eventID: "next", capturedAt: "2026-10-17T00:00:00.000Z", text: "next")
        for name in ["parallel_six", "succeeded", "failed_timeout"] {
            var activity = try XCTUnwrap(fixtures()[name]); activity["session_id"] = fixture.binding.sessionID
            try consumer.accept(packet(activity))
        }
        let expected = consumer.activities
        XCTAssertGreaterThan(expected.cards.count, 1)
        var accepted = try XCTUnwrap(fixture.values["accepted"] as? [String: Any])
        accepted["event_id"] = "next"; accepted["processed_event_id"] = "d-next"
        accepted["admission"] = ["state": "accepted", "run_id": "run-next", "idempotency_key": "next", "run_order": 2]
        try consumer.accept(packet(accepted))
        var header = try XCTUnwrap(fixture.values["result_header"] as? [String: Any])
        header["event_id"] = "next"; header["processed_event_id"] = "d-next"; header["run_id"] = "run-next"; header["text_replay"] = "pending"
        try consumer.accept(packet(header))
        for chunk in try fixture.chunks().dropFirst() { try consumer.accept(chunk) }
        _ = try consumer.consumedByUI(XCTUnwrap(consumer.presentation), observedAt: "2026-10-17T00:00:01.000Z")
        try consumer.accept(packet(accepted))
        XCTAssertEqual(consumer.eventID, "next")
        XCTAssertEqual(consumer.activities, expected)
        var duplicate = try XCTUnwrap(fixtures()["succeeded"]); duplicate["session_id"] = fixture.binding.sessionID
        try consumer.accept(packet(duplicate))
        XCTAssertEqual(consumer.activities, expected, "Duplicate terminal revisions must keep their original arrival and the other cards")
    }
}
