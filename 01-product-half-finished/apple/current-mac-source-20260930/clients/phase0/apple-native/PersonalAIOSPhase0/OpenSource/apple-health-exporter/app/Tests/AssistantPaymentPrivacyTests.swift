import UserNotifications
import XCTest
@testable import HealthKitExporter

final class AssistantPaymentPrivacyTests: XCTestCase {
    private let fullText = "【已付款】 一点点 ¥16.60"
    private func packet(_ fields: [String: Any]) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields))
    }

    func testPrivateAmbientWireKeepsFullReplyAndTimelineButMasksLockedOrInactiveNotifications() throws {
        let binding = try CentralTextTestFixture().binding
        for marked in [false, true] {
            var fields: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "ambient_reply",
                "session_id": binding.sessionID, "processed_event_id": "payment-result", "heard": "买奶茶", "text": fullText]
            if marked { fields["private"] = "payment" }
            var consumer = AssistantCentralTextConsumer()
            try consumer.reset(binding: binding)
            try consumer.accept(packet(fields))
            let reply = try XCTUnwrap(consumer.ownerVoice.ambientReplies.first)
            XCTAssertEqual(reply.text, fullText, "Speech and unlocked app consumers retain the original reply")
            XCTAssertEqual(reply.privacy, marked ? .payment : nil)
            var timeline = YimiConversationTimeline()
            timeline.accept(reply)
            let item = try XCTUnwrap(timeline.items.last)
            XCTAssertEqual(item.text, fullText)
            XCTAssertEqual(item.privacy, reply.privacy)
            let saved = try JSONDecoder().decode(YimiItem.self, from: JSONEncoder().encode(item))
            XCTAssertEqual(saved.privacy, reply.privacy)
            for (locked, active) in [(true, true), (false, false), (true, false), (false, true)] {
                let message = AssistantNotificationMessage.assistantReply(identifier: "ambient-result", title: fullText,
                    text: reply.text, privacy: reply.privacy, locked: locked, active: active)
                let content = AssistantNotificationCenter.content(for: message)
                let mask = marked && (locked || !active)
                XCTAssertEqual(content.body, mask ? "依米：付款结果已更新，解锁依米查看。" : fullText)
                XCTAssertEqual(content.title, mask ? "依米" : fullText)
                XCTAssertEqual(content.categoryIdentifier, marked ? AssistantNotificationCenter.paymentResultCategoryIdentifier : "")
            }
        }
    }

    func testPrivateHeaderOrChunkSurvivesFormalConsumerPresentation() throws {
        let fixture = try CentralTextTestFixture()
        for markHeader in [false, true] {
            var header = try XCTUnwrap(fixture.values["result_header"] as? [String: Any])
            if markHeader { header["private"] = "payment" }
            var consumer = try fixture.consumer(header: packet(header))
            let chunks = try XCTUnwrap(fixture.values["text_chunks"] as? [[String: Any]])
            for var chunk in chunks {
                if !markHeader { chunk["private"] = "payment" }
                try consumer.accept(packet(chunk))
            }
            XCTAssertEqual(try consumer.header?.fields.value("private", as: String.self), markHeader ? "payment" : nil)
            let presentation = try XCTUnwrap(consumer.presentation)
            XCTAssertEqual(presentation.privacy, .payment)
            XCTAssertFalse(presentation.text.isEmpty)
        }
    }

    func testPrivateCallTranscriptKeepsFullSpeechAndPersistedTurn() throws {
        let binding = try CentralTextTestFixture().binding
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: binding)
        try consumer.accept(packet(["schema_version": "paios.central.text-envelope.v1", "operation": "call_state",
            "session_id": binding.sessionID, "call_id": "ambient-private", "state": "opening", "mode": "ambient"]))
        try consumer.accept(packet(["schema_version": "paios.central.text-envelope.v1", "operation": "call_transcript",
            "session_id": binding.sessionID, "call_id": "ambient-private", "turn": 0, "role": "main_agent",
            "text": fullText, "final": true, "private": "payment"]))
        // A later update of this same turn cannot downgrade its trusted source provenance.
        try consumer.accept(packet(["schema_version": "paios.central.text-envelope.v1", "operation": "call_transcript",
            "session_id": binding.sessionID, "call_id": "ambient-private", "turn": 0, "role": "main_agent",
            "text": fullText, "final": true]))
        let line = try XCTUnwrap(consumer.call.lines.first)
        XCTAssertEqual(line.text, fullText)
        XCTAssertEqual(line.privacy, .payment)
        var timeline = YimiConversationTimeline()
        timeline.accept(consumer.call)
        let item = try XCTUnwrap(timeline.items.last)
        XCTAssertEqual(item.text, fullText)
        XCTAssertEqual(item.privacy, .payment)
    }

    func testPrivateLegacyResultRetainsProvenanceThroughContextAndReducer() async throws {
        let original = AssistantResultEnvelope(streamID: "private-stream", sequence: 1, text: fullText,
            isFinal: true, privacy: .payment)
        let decoded = try XCTUnwrap(AssistantResultEnvelope.decode(original.encodedStrict()))
        let contextual = decoded.injectingLocalContext(sessionID: "session", epoch: 1)
        XCTAssertEqual(contextual.privacy, .payment)
        let reducer = AssistantResultStreamReducer()
        _ = await reducer.accept(contextual)
        let snapshot = await reducer.snapshot()
        XCTAssertEqual(snapshot.text, fullText)
        XCTAssertEqual(snapshot.privacy, .payment)
        let message = AssistantNotificationMessage.assistantReply(identifier: "result", text: snapshot.text,
            privacy: snapshot.privacy, locked: true, active: true)
        XCTAssertEqual(AssistantNotificationCenter.content(for: message).body, "依米：付款结果已更新，解锁依米查看。")
    }
}
