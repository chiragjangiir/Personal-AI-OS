import Foundation
import XCTest
@testable import HealthKitExporter

final class CentralVoiceTurnTests: XCTestCase {
    private let digest = String(repeating: "a", count: 64)

    // The accepted envelope central publishes for the confirmed window's D (same shape as a text submit).
    private let accepted: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "accepted",
        "event_id": "voice-source-event", "session_id": "continuity",
        "processed_event_id": "d:5ed299c64d2fea735e22c6da8e9250529a90a5eab1e1ae6b0cfd78d1ce66c3ee",
        "admission": ["state": "pending", "run_id": NSNull(),
                      "idempotency_key": "paios:7ffd89b1d082a1dbdd36d3d728e64d387304232b3c13c5789e71daf8b67c8211"]]
    func packet(_ value: Any) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value, options: .sortedKeys))
    }
    func body(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func consumer() throws -> AssistantCentralTextConsumer {
        var value = AssistantCentralTextConsumer()
        try value.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "phone-voice", connectionEpoch: "1",
            expectedGatewayIdentity: "controlled-source-gateway", maxPacketBytes: 12288, voiceTransport: "wav_byte_stream_v1"))
        return value
    }
    func status(_ operationID: String, _ sourceStatus: String, extra: [String: Any] = [:]) throws -> CentralTextPacket {
        var value: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "voice_status",
            "session_id": "continuity", "operation_id": operationID, "source_status": sourceStatus]
        value.merge(extra) { $1 }
        return try packet(value)
    }
    func transcript(_ text: String) -> [String: Any] {
        ["candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
         "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
         "transcript": text, "transcript_sha256": digest]
    }

    func testConfirmedVoiceTurnBecomesTheFollowedSubmission() throws {
        var value = try consumer()
        let open = try body(value.beginVoice(operationID: "voice-1"))
        XCTAssertEqual(open as NSDictionary, ["operation": "voice_open", "operation_id": "voice-1"])
        XCTAssertThrowsError(try value.commitVoice(), "commit must wait for the recording receipt")
        try value.accept(status("voice-1", "recording"))
        XCTAssertEqual(try body(value.commitVoice())["operation"] as? String, "voice_commit")
        try value.accept(status("voice-1", "pending", extra: ["event_id": "voice-source-event"]))
        XCTAssertEqual(value.voiceTurn.phase, .transcribing)
        XCTAssertEqual(try body(value.voiceCandidatesRequest())["operation"] as? String, "voice_candidates")
        try value.accept(status("voice-1", "candidates", extra: ["candidates": [
            ["candidate_ref": "voice-candidate:p", "candidate_revision": digest, "window_ref": "voice-window:one",
             "selected_input_sha256": digest, "authorization": "unknown", "kind": "partial", "preview": "帮我"],
            transcript("帮我记下明天早上八点骑行。")]]))
        XCTAssertEqual(value.voiceTurn.phase, .ready)
        XCTAssertFalse(value.isLocallySubmitted, "Transcription alone has not submitted a local request")
        let candidate = try XCTUnwrap(value.voiceTurn.candidates.first)
        let send = try body(value.sendVoice(candidate))
        XCTAssertEqual(send["operation"] as? String, "voice_send")
        XCTAssertEqual(send["transcript_sha256"] as? String, digest)
        XCTAssertEqual(value.eventID, "voice-source-event")
        XCTAssertTrue(value.isLocallySubmitted, "The confirmed local voice source follows its existing event identity")
        try value.accept(status("voice-1", "confirmation_recorded"))
        XCTAssertEqual(value.voiceTurn.phase, .sending, "confirmation records selection, not admission")
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .pending)
        try value.accept(packet(accepted))
        XCTAssertEqual(value.voiceTurn.phase, .sent)
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued)
        XCTAssertEqual(try value.accepted?.fields.value("event_id", as: String.self), "voice-source-event")
        XCTAssertEqual(value.status, "原文已接纳；服务端排队中")
        XCTAssertTrue(value.isLocallySubmitted)
    }

    func testUncertainPTTPromptStaysVisibleAfterAdmissionAndConfirmsItsOwnEvent() throws {
        var value = try consumer()
        let text = "帮我记下明天早上八点骑行。", id = String(repeating: "c", count: 64)
        _ = try value.beginVoice(operationID: "voice-1")
        try value.accept(status("voice-1", "recording")); _ = try value.commitVoice()
        try value.accept(status("voice-1", "pending", extra: ["event_id": "voice-source-event"]))
        try value.accept(status("voice-1", "candidates", extra: ["candidates": [transcript(text)]]))
        _ = try value.sendVoice(XCTUnwrap(value.voiceTurn.candidates.first))
        let receivedAfter = Date()
        let snapshot: [String: Any] = ["schema_version": AssistantCentralTextWire.schema,
            "operation": "voice_confirmations", "session_id": "continuity", "confirmations": [
                ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 118_000, "text": text]]]
        try value.accept(packet(snapshot))
        let prompt = try XCTUnwrap(value.ownerVoice.confirmations.first)
        XCTAssertEqual(prompt.id, id)
        XCTAssertEqual(prompt.text, text, "the pending card shows the selected PTT words")
        XCTAssertFalse(prompt.isNativeApproval, "speaker identity uses the 确认是我 card")
        XCTAssertGreaterThanOrEqual(prompt.deadline, receivedAfter.addingTimeInterval(118))
        XCTAssertLessThanOrEqual(prompt.deadline, Date().addingTimeInterval(118))
        XCTAssertNil(value.ownerVoice.confirmable(id, now: prompt.deadline), "the expired card cannot be tapped")
        try value.accept(status("voice-1", "confirmation_recorded"))
        try value.accept(packet(accepted))
        XCTAssertEqual(value.voiceTurn.phase, .sent)
        XCTAssertEqual(value.ownerVoice.confirmations, [prompt], "native admission does not decide speaker identity")
        XCTAssertEqual(try body(value.confirmVoice(id, auth: "face_id")) as NSDictionary,
                       ["operation": "voice_confirm", "confirmation_id": id, "auth": "face_id"])
        XCTAssertEqual(value.ownerVoice.confirming, [id: "voice-confirm:" + id])
        var cleared = snapshot
        cleared["confirmations"] = [] as [[String: Any]]
        try value.accept(packet(cleared))
        XCTAssertTrue(value.ownerVoice.confirmations.isEmpty)
        XCTAssertEqual(value.ownerVoice.confirming, [id: "voice-confirm:" + id], "an expired snapshot cannot acknowledge confirmation")
        try value.accept(packet(["schema_version": AssistantCentralTextWire.schema, "operation": "voice_confirmation_decided",
                                 "session_id": "continuity", "confirmation_id": id, "choice": "approve"]))
        XCTAssertTrue(value.ownerVoice.confirming.isEmpty)
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-confirm:" + id), .pending, "a decision ACK does not admit the confirmation event")
        var confirmed = accepted
        confirmed["event_id"] = "voice-confirm:" + id
        confirmed["processed_event_id"] = "d:" + String(repeating: "b", count: 64)
        try value.accept(packet(confirmed))
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-confirm:" + id), .queued,
                       "accepted with pending admission and no result header stays queued")
        XCTAssertEqual(try value.accepted?.fields.value("event_id", as: String.self), "voice-source-event",
                       "the original result remains active while the confirmation observation waits for its result")
    }

    /// One rule for every app: a window whose transcripts are all empty heard nothing. It never becomes sendable,
    /// ends as 没听清 and names the close central needs; a spoken one stays sendable.
    func testOnlyASpokenTranscriptIsSendableAndSilenceEndsAsNoSpeech() throws {
        var value = try consumer()
        _ = try value.beginVoice(operationID: "voice-1")
        try value.accept(status("voice-1", "recording")); _ = try value.commitVoice()
        try value.accept(status("voice-1", "pending", extra: ["event_id": "voice-source-event"]))
        XCTAssertNil(try value.voiceTurn.closeRequest(), "a window still transcribing is not closed")
        var silent = value
        try silent.accept(status("voice-1", "candidates", extra: ["candidates": [transcript(" \n")]]))
        XCTAssertEqual(silent.voiceTurn.phase, .failed)
        XCTAssertFalse(silent.voiceTurn.isActive, "the next press works")
        XCTAssertEqual(silent.voiceTurn.unsentOutcome, "没听清，请按住再说一次")
        XCTAssertEqual(try body(XCTUnwrap(silent.voiceTurn.closeRequest())) as NSDictionary, ["operation": "voice_close", "operation_id": "voice-1"])
        try value.accept(status("voice-1", "candidates", extra: ["candidates": [transcript("一百二十三加四百五十六等于多少")]]))
        XCTAssertEqual(value.voiceTurn.phase, .ready)
        XCTAssertNil(value.voiceTurn.unsentOutcome)
        _ = try value.expireVoice("VOICE_TRANSCRIBE_TIMEOUT")
        XCTAssertEqual(value.voiceTurn.unsentOutcome, "这句语音没发出去，请按住再说一次")
    }

    func testAnUnansweredOpenExpiresVisiblyAndFreesTheButton() throws {
        var value = try consumer()
        _ = try value.beginVoice(operationID: "voice-1")
        let close = try body(XCTUnwrap(value.expireVoice("VOICE_OPEN_TIMEOUT")))
        XCTAssertEqual(close as NSDictionary, ["operation": "voice_close", "operation_id": "voice-1"])
        XCTAssertEqual(value.voiceTurn.phase, .failed)
        XCTAssertFalse(value.voiceTurn.isActive, "a new press must be possible")
        XCTAssertEqual(value.voiceTurn.status, "语音未完成：VOICE_OPEN_TIMEOUT")
        try value.accept(status("voice-1", "recording"))
        XCTAssertEqual(value.voiceTurn.phase, .failed, "a late receipt for the expired turn is ignored")
        XCTAssertNil(try value.expireVoice("VOICE_OPEN_TIMEOUT"), "only a waiting turn expires")
        _ = try value.beginVoice(operationID: "voice-2")
        XCTAssertEqual(value.voiceTurn.phase, .opening)
    }

    func testFailuresStaleReceiptsAndCloseNeverSendAVoiceRequest() throws {
        var value = try consumer()
        _ = try value.beginVoice(operationID: "voice-1")
        XCTAssertThrowsError(try value.beginVoice(operationID: "voice-2"), "one active turn at a time")
        try value.accept(status("other-operation", "recording"))
        XCTAssertEqual(value.voiceTurn.phase, .opening)
        try value.accept(status("voice-1", "unknown", extra: ["error_code": "FORMAL_PCM_VOICE_SOURCE_REQUIRED"]))
        XCTAssertEqual(value.voiceTurn.phase, .failed)
        XCTAssertEqual(value.voiceTurn.errorCode, "FORMAL_PCM_VOICE_SOURCE_REQUIRED")

        _ = try value.beginVoice(operationID: "voice-3")
        try value.accept(status("voice-3", "recording"))
        _ = try value.commitVoice()
        XCTAssertThrowsError(try value.accept(status("voice-3", "pending")), "pending must name the window event")
        XCTAssertEqual(value.voiceTurn.phase, .committing)
        let close = try XCTUnwrap(value.closeVoice())
        XCTAssertEqual(try body(close)["operation"] as? String, "voice_close")
        XCTAssertEqual(value.voiceTurn.phase, .idle)
        try value.accept(status("voice-3", "cancel_requested"))
        XCTAssertEqual(value.voiceTurn.phase, .idle)
        XCTAssertNil(value.eventID)
        XCTAssertThrowsError(try value.accept(packet(["schema_version": "paios.central.text-envelope.v1",
            "operation": "voice_status", "session_id": "another-session", "operation_id": "voice-3", "source_status": "recording"])))
    }

    private func sendingVoice() throws -> (AssistantCentralTextConsumer, Data) {
        var value = try consumer()
        _ = try value.beginVoice(operationID: "voice-1")
        try value.accept(status("voice-1", "recording"))
        _ = try value.commitVoice()
        try value.accept(status("voice-1", "pending", extra: ["event_id": "voice-source-event"]))
        try value.accept(status("voice-1", "candidates", extra: ["candidates": [transcript("记下这句话")]]))
        let bytes = try value.sendVoice(XCTUnwrap(value.voiceTurn.candidates.first))
        return (value, bytes)
    }

    private func rejection(_ request: String, code: String, eventID: String? = nil) throws -> CentralTextPacket {
        try packet(["schema_version": AssistantCentralTextWire.schema, "operation": "rejected",
            "session_id": "continuity", "request_operation": request, "control_id": NSNull(),
            "event_id": eventID as Any? ?? NSNull(), "processed_event_id": NSNull(), "error_code": code])
    }
    // Voice requests are answered on their own operation (voice_status), never by an uncorrelated `rejected`.
    private func failure(_ code: String) throws -> CentralTextPacket { try status("voice-1", "unknown", extra: ["error_code": code]) }

    func testAdmissionBeforeConfirmationAndLateErrorsRemainAccepted() throws {
        var (value, _) = try sendingVoice()
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .pending)
        try value.accept(packet(accepted))
        try value.accept(status("voice-1", "confirmation_recorded"))
        try value.accept(failure("VOICE_WINDOW_CLOSED"))
        XCTAssertEqual(value.voiceTurn.phase, .sent)
        XCTAssertNil(value.voiceTurn.errorCode)
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued)
    }

    func testUnknownVoiceOutcomesAreTerminalAndReleaseTypingAndVoice() throws {
        let endings: [(String, (inout AssistantCentralTextConsumer) throws -> Void)] = [
            ("retries exhausted", { $0.voiceSendUnconfirmed() }),
            ("VOICE_SEND_OUTCOME_UNKNOWN", { try $0.accept(self.failure("VOICE_SEND_OUTCOME_UNKNOWN")) }),
            ("VOICE_PROCESS_FAILED", { try $0.accept(self.failure("VOICE_PROCESS_FAILED")) }),
            ("replay without result", { try $0.accept(self.status("voice-1", "confirmation_recorded")); $0.voiceSendUnconfirmed() }),
        ]
        for (name, end) in endings {
            var (value, original) = try sendingVoice()
            try end(&value)
            XCTAssertEqual(value.voiceTurn.phase, .unconfirmed, name)
            XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .unconfirmed, name)
            XCTAssertTrue(try value.canBeginSubmit, name)
            XCTAssertTrue(value.canResendVoice(eventID: "voice-source-event"), name)
            var resent = value
            XCTAssertEqual(try resent.resendVoice(), original, name)
            XCTAssertEqual(resent.submissionDelivery(eventID: "voice-source-event"), .pending, name)
            var late = value
            try late.accept(packet(accepted))
            XCTAssertEqual(late.voiceTurn.phase, .sent, "a late admission still applies: " + name)
            XCTAssertEqual(late.submissionDelivery(eventID: "voice-source-event"), .queued, name)
            var typed = value
            _ = try typed.beginSubmit(eventID: "next-typed", capturedAt: "2026-10-01T00:00:00.000Z", text: "重发这段文字")
            XCTAssertEqual(typed.submissionDelivery(eventID: "next-typed"), .pending, name)
            _ = try value.beginVoice(operationID: "voice-2")
            try value.accept(status("voice-2", "recording"))
            _ = try value.commitVoice()
            try value.accept(status("voice-2", "pending", extra: ["event_id": "voice-next-event"]))
            try value.accept(status("voice-2", "candidates", extra: ["candidates": [transcript("再说一句")]]))
            XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .unconfirmed, "a new window keeps the old row's outcome")
            _ = try value.sendVoice(XCTUnwrap(value.voiceTurn.candidates.first))
            XCTAssertEqual(value.submissionDelivery(eventID: "voice-next-event"), .pending, name)
        }
    }

    func testDefiniteVoiceRejectionReleasesTurnAndAdmissionStillWins() throws {
        var (value, _) = try sendingVoice()
        try value.accept(status("voice-1", "confirmation_recorded"))
        try value.accept(failure("VOICE_EXACT_CONFIRMATION_REQUIRED"))
        XCTAssertEqual(value.voiceTurn.phase, .failed)
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .rejected)
        XCTAssertTrue(try value.canBeginSubmit)
        XCTAssertThrowsError(try value.resendVoice(), "a rejected source needs a fresh request")
        _ = try value.beginVoice(operationID: "voice-2")
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .rejected, "a new window keeps the old row's outcome")
        try value.accept(packet(accepted))
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued, "admission wins even after a rejection")
    }

    func testOldVoiceFailureCannotFailTheNextTypedSubmission() throws {
        var (value, _) = try sendingVoice()
        value.voiceSendUnconfirmed()
        let original = try value.beginSubmit(eventID: "next-typed", capturedAt: "2026-10-01T00:00:00.000Z", text: "retry as text")
        try value.accept(failure("VOICE_EXACT_CONFIRMATION_REQUIRED"))
        try value.accept(rejection("voice_send", code: "VOICE_EXACT_CONFIRMATION_REQUIRED"))
        XCTAssertEqual(value.submissionDelivery(eventID: "next-typed"), .pending)
        XCTAssertEqual(try value.retryTypedSubmission(), original)
    }

    func testSessionResetEndsSentVoiceUnconfirmedAndReleasesTypingAndVoice() throws {
        for unconfirmedFirst in [false, true] {
            var (value, _) = try sendingVoice()
            if unconfirmedFirst { value.voiceSendUnconfirmed() }
            let binding = try XCTUnwrap(value.binding)
            try value.reset(binding: nil, generation: 2)
            try value.reset(binding: CentralTransportBinding(sessionID: "next-session", deviceID: binding.deviceID, connectionEpoch: "2",
                expectedGatewayIdentity: binding.expectedGatewayIdentity, maxPacketBytes: binding.maxPacketBytes), generation: 3)
            XCTAssertEqual(value.voiceTurn.phase, .unconfirmed, "its own line keeps saying the outcome is unknown")
            XCTAssertNil(value.submissionDelivery(eventID: "voice-source-event"), "the new session never claims the old request")
            XCTAssertThrowsError(try value.resendVoice(), "voice_send cannot move to another session")
            XCTAssertTrue(try value.canBeginSubmit)
            var typed = value
            _ = try typed.beginSubmit(eventID: "typed-after-reset", capturedAt: "2026-10-01T00:00:00.000Z", text: "重发这段文字")
            XCTAssertEqual(typed.submissionDelivery(eventID: "typed-after-reset"), .pending)
            _ = try value.beginVoice(operationID: "voice-2")
            XCTAssertEqual(value.voiceTurn.phase, .opening)
        }
    }

    func testTypedAndPendingDeliveryUseAdmissionRatherThanStatusText() throws {
        var value = try consumer()
        let original = try value.beginSubmit(eventID: "typed-event", capturedAt: "2026-10-01T00:00:00.000Z", text: "hello")
        XCTAssertEqual(value.submissionDelivery(eventID: "typed-event"), .pending)
        try value.accept(rejection("submit", code: "FORMAL_TEXT_REQUEST_FAILED", eventID: "typed-event"))
        XCTAssertEqual(value.submissionDelivery(eventID: "typed-event"), .pending, "Core keeps recovering an unknown submit")
        XCTAssertEqual(try value.retryTypedSubmission(), original)
        try value.beginObservation(eventID: "voice-source-event")
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .pending)
        try value.accept(packet(accepted))
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued)
        try value.accept(rejection("submit", code: "ADMISSION_CAPACITY_EXCEEDED", eventID: "typed-event"))
        XCTAssertEqual(value.submissionDelivery(eventID: "typed-event"), .rejected)
        XCTAssertFalse(value.canRetryTypedSubmission)
        var admitted = accepted
        admitted["event_id"] = "typed-event"
        admitted["processed_event_id"] = "d:" + String(repeating: "b", count: 64)
        admitted["admission"] = ["state": "pending", "run_id": NSNull(), "idempotency_key": "paios:" + String(repeating: "c", count: 64)]
        try value.accept(packet(admitted))
        try value.accept(rejection("result", code: "RESULT_NOT_READY", eventID: "typed-event"))
        XCTAssertEqual(value.submissionDelivery(eventID: "typed-event"), .queued)
        XCTAssertNil(value.submissionDelivery(eventID: "unknown-event"))
    }
}


extension CentralVoiceTurnTests {
    func testQueuedVoiceFreesNextWindowWithoutReplacingForeground() throws {
        let fixture = try CentralTextTestFixture()
        var value = try fixture.consumer()
        try value.accept(XCTUnwrap(fixture.chunks().first))
        let foreground = value.eventID, displayed = value.presentation
        let session = fixture.binding.sessionID
        func voice(_ source: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            var fields: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "voice_status",
                "session_id": session, "operation_id": "voice-queue", "source_status": source]
            fields.merge(extra) { $1 }
            return try packet(fields)
        }
        _ = try value.beginVoice(operationID: "voice-queue")
        try value.accept(voice("recording")); _ = try value.commitVoice()
        try value.accept(voice("pending", ["event_id": "voice-source-event"]))
        try value.accept(voice("candidates", ["candidates": [transcript("下一句")]]))
        let bytes = try value.sendVoice(XCTUnwrap(value.voiceTurn.candidates.first))
        XCTAssertEqual(try body(bytes)["operation"] as? String, "voice_send")
        XCTAssertEqual(value.eventID, foreground)
        XCTAssertEqual(value.presentation, displayed)
        value.voiceSendUnconfirmed()
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .unconfirmed)
        XCTAssertTrue(value.canResendVoice(eventID: "voice-source-event"))
        var admitted = accepted; admitted["session_id"] = session
        try value.accept(packet(admitted))
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued)
        XCTAssertEqual(value.voiceTurn.phase, .sent)
        _ = try value.beginVoice(operationID: "voice-next")
        XCTAssertEqual(value.voiceTurn.phase, .opening)
        try value.accept(voice("confirmation_recorded"))
        XCTAssertEqual(value.voiceTurn.phase, .opening, "Late old receipt cannot change the next window")
        XCTAssertEqual(value.submissionDelivery(eventID: "voice-source-event"), .queued)
        XCTAssertEqual(value.presentation, displayed)
    }
}
