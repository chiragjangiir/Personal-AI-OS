import Foundation
import XCTest

final class DesktopCallTests: XCTestCase {
    private func packet(_ fields: [String: Any]) throws -> CentralTextPacket {
        var body = fields
        body["schema_version"] = AssistantCentralTextWire.schema
        body["session_id"] = "desktop-continuity"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
    }

    private func openedCall() throws -> AssistantCentralTextConsumer {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "desktop-continuity", deviceID: "mac",
            connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, callRejoinWindowS: 120))
        _ = try consumer.openCall()
        return consumer
    }

    func testHangupFencesLateLiveStateOnSameCall() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        XCTAssertEqual(consumer.call.state, "opening")
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live"]))
        XCTAssertTrue(consumer.call.isActive)
        _ = try consumer.closeCall()
        XCTAssertEqual(consumer.call.state, "closing")
        XCTAssertFalse(consumer.call.isActive)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live"]))
        XCTAssertEqual(consumer.call.state, "closing", "late transport delivery cannot reopen a local hangup")
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "closed"]))
        XCTAssertEqual(consumer.call.state, "closed")
        XCTAssertEqual(consumer.call.id, id)
    }

    func testAvatarDowngradeKeepsSameLiveVoiceCallAndInterruptedTranscript() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        let credentials = ["provider": "artc", "app_id": "app", "channel_id": "avatar", "user_id": "mac",
                           "token": "test-credential", "token_expire_at": "1800003600", "audio_input": "gateway"]
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live", "video": true,
                                    "video_revision": 1, "media": credentials]))
        XCTAssertEqual(consumer.call.state, "connecting", "avatar is not live until its first rendered frame")
        consumer.renderedCallFrame(id)
        XCTAssertEqual(consumer.call.state, "live")
        try consumer.accept(packet(["operation": "call_transcript", "call_id": id, "role": "assistant",
                                    "turn": 1, "text": "到这里", "final": true, "interrupted": true]))
        consumer.stopCallVideo(id)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live",
                                    "video": false, "video_revision": 2]))
        XCTAssertEqual(consumer.call.id, id)
        XCTAssertTrue(consumer.call.isActive)
        XCTAssertEqual(consumer.call.state, "live")
        XCTAssertNil(consumer.call.media)
        XCTAssertEqual(consumer.call.video, false)
        XCTAssertEqual(consumer.call.lines.last?.text, "到这里")
        XCTAssertEqual(consumer.call.lines.last?.interrupted, true)
    }

    func testStaleAvatarRevisionCannotUndoVoiceDowngrade() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live",
                                    "video": false, "video_revision": 2]))
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "connecting",
                                    "video": true, "video_revision": 1]))
        XCTAssertEqual(consumer.call.videoRevision, 2)
        XCTAssertEqual(consumer.call.video, false)
        XCTAssertEqual(consumer.call.state, "live")
        XCTAssertEqual(consumer.call.id, id)
    }
}
