import XCTest
@testable import HealthKitExporter

final class AssistantVoiceEnrollmentTests: XCTestCase {
    private let control = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private let draft = "ven-0f8fad5b-d9cb-469f-a165-70867728950e"
    private let call = "call-0f8fad5b-d9cb-469f-a165-70867728950e"

    private func consumer() throws -> AssistantCentralTextConsumer {
        var result = AssistantCentralTextConsumer()
        try result.reset(binding: CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        return result
    }
    private func packet(_ phase: String, ms: Int = 0, ack: String? = nil, session: String? = nil, preview: Data? = nil) throws -> CentralTextPacket {
        var fields: [String: Any] = ["schema_version": AssistantCentralTextWire.schema,
            "operation": "voice_enrollment_state", "session_id": "session",
            "enrollment": ["available": true, "session_id": session ?? draft, "call_id": call,
                "phase": phase, "recorded_ms": ms + 500, "clean_speech_ms": ms, "target_speech_ms": 30_000,
                "can_use": phase == "checked", "issue": NSNull(), "updated_at": NSNull(), "source_device": ["device_id": "phone", "device_type": "iphone"],
                "owner": ["enrolled": phase == "committed", "reenrollment_required": false, "samples": phase == "committed" ? 1 : 0]]]
        if let preview {
            var enrollment = fields["enrollment"] as! [String: Any]
            enrollment["preview_audio_base64"] = preview.base64EncodedString(); fields["enrollment"] = enrollment
        }
        if let ack { fields["control_id"] = ack }
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields))
    }

    func testDraftProgressAndPauseRequireAcknowledgmentAndStaySeparateFromPayment() throws {
        var c = try consumer()
        _ = try c.voiceEnrollmentControl("start", id: control, callID: call)
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .idle)
        try c.accept(packet("collecting", ms: 1500))
        XCTAssertEqual(c.ownerVoice.enrollment.cleanSpeechMS, 1500)
        XCTAssertEqual(c.ownerVoice.enrollment.recordedMS, 2000)
        XCTAssertEqual(c.ownerVoice.enrollment.pending, control, "progress is not the control receipt")
        try c.accept(packet("collecting", ms: 2000, ack: control))
        XCTAssertNil(c.ownerVoice.enrollment.pending)
        XCTAssertNil(c.ownerVoice.voiceprint.owner, "conversation enrollment cannot enable payment")
        _ = try c.voiceEnrollmentControl("pause", id: control, callID: nil)
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .collecting)
        try c.accept(packet("paused", ms: 2000, ack: control))
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .paused)
        XCTAssertEqual(c.ownerVoice.enrollment.cleanSpeechMS, 2000)
        _ = try c.voiceEnrollmentControl("resume", id: control, callID: call)
        let open = try c.openCall(enrollment: (draft, call))
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: open) as? [String: Any])
        XCTAssertEqual(wire["enrollment_session_id"] as? String, draft)
        XCTAssertEqual(wire["call_id"] as? String, call)
    }

    func testTimeoutDoesNotCommitAndStatusRetryReconcilesWithoutAcceptingLateAck() throws {
        var c = try consumer()
        _ = try c.voiceEnrollmentControl("start", id: control, callID: call)
        try c.accept(packet("checked", ms: 30_000, ack: control))
        _ = try c.voiceEnrollmentControl("commit", id: control, callID: nil)
        c.expireVoiceEnrollment(control, code: "VOICE_ENROLLMENT_ACK_TIMEOUT")
        try c.accept(packet("committed", ms: 30_000, ack: control))
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .checked)
        XCTAssertEqual(c.ownerVoice.enrollment.controlError, "VOICE_ENROLLMENT_ACK_TIMEOUT")
        let retry = "0f8fad5b-d9cb-469f-a165-70867728950f"
        _ = try c.voiceEnrollmentControl("status", id: retry, callID: nil)
        try c.accept(packet("committed", ms: 30_000, ack: retry))
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .committed)
        XCTAssertEqual(c.ownerVoice.enrollment.owner?.enrolled, true)
        XCTAssertNil(c.ownerVoice.voiceprint.owner)
    }

    func testOtherDraftProgressCannotOverwriteCurrentDraftAndPendingCannotOverlap() throws {
        var c = try consumer()
        _ = try c.voiceEnrollmentControl("start", id: control, callID: call)
        try c.accept(packet("collecting", ms: 2400, ack: control))
        try c.accept(packet("paused", ms: 9000, session: "ven-0f8fad5b-d9cb-469f-a165-70867728950f"))
        XCTAssertEqual(c.ownerVoice.enrollment.cleanSpeechMS, 2400)
        _ = try c.voiceEnrollmentControl("pause", id: control, callID: nil)
        XCTAssertThrowsError(try c.voiceEnrollmentControl("discard", id: control, callID: nil))
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .collecting)
    }
    func testExplicitPreviewDecodesOnlyServerPayload() throws {
        var c = try consumer()
        _ = try c.voiceEnrollmentControl("start", id: control, callID: call)
        try c.accept(packet("checked", ms: 30_000, ack: control))
        XCTAssertNil(c.ownerVoice.enrollment.previewAudio)
        _ = try c.voiceEnrollmentControl("preview", id: control, callID: nil)
        let payload = Data([1, 2, 3, 4])
        try c.accept(packet("checked", ms: 30_000, ack: control, preview: payload))
        XCTAssertEqual(c.ownerVoice.enrollment.previewAudio, payload)
        XCTAssertEqual(c.ownerVoice.enrollment.recordedMS, 30_500)
        XCTAssertEqual(c.ownerVoice.enrollment.phase, .checked)
        XCTAssertNil(c.ownerVoice.voiceprint.owner)
    }

}
