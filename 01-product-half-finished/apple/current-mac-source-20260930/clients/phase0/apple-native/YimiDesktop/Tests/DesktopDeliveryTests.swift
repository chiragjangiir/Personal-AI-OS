import Combine
import Foundation
import XCTest

@MainActor final class DesktopDeliveryTests: XCTestCase {
    private func model() throws -> (DesktopAppModel, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root), root)
    }
    private func consumer() throws -> AssistantCentralTextConsumer {
        var value = AssistantCentralTextConsumer()
        try value.reset(binding: CentralTransportBinding(sessionID: "delivery-test", deviceID: "mac-test", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288))
        return value
    }
    private func packet(_ fields: [String: Any]) throws -> CentralTextPacket {
        var fields = fields
        fields["schema_version"] = "paios.central.text-envelope.v1"; fields["session_id"] = "delivery-test"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields))
    }
    func testVoiceCardsRequirePairedOwnerUnlockAndClearWithTheirSession() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        let id = "01900000-0000-7000-8000-000000000001"
        let confirmationID = String(repeating: "b", count: 64)
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        var pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id,
            userID: "01900000-0000-7000-8000-000000000002", token: "test-pairing-token-00000000", governance: governance,
            media: ["data"], pairedAt: "2026-10-17T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools"])
        model.pairing = pairing
        var state = try consumer()
        try state.accept(packet(["operation": "voice_confirmations", "confirmations": [
            ["confirmation_id": confirmationID, "event_id": "d:" + String(repeating: "a", count: 64), "expires_in_ms": 60000, "text": "帮我整理文件"]]]))
        await model.accept(state)
        XCTAssertFalse(model.canConfirmVoice); XCTAssertTrue(model.voiceConfirmations.isEmpty)
        pairing.capabilities?.append("owner_unlock"); model.pairing = pairing
        await model.accept(state)
        XCTAssertTrue(model.canConfirmVoice); XCTAssertEqual(model.voiceConfirmations.map(\.id), [confirmationID])
        try state.accept(packet(["operation": "voice_confirmation_decided", "confirmation_id": confirmationID, "choice": "approve"]))
        await model.accept(state)
        XCTAssertTrue(model.voiceConfirmations.isEmpty)
        model.beginCentralSession()
        XCTAssertTrue(model.voiceConfirmations.isEmpty); XCTAssertTrue(model.confirmingVoice.isEmpty)
    }
    func testUnavailableTypedSendIsOnItsMessageAndKeepsLaterDraft() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        model.composer.text = "帮我整理发票"
        await model.send()
        let item = try XCTUnwrap(model.timeline.first)
        XCTAssertEqual(item.text, "帮我整理发票"); XCTAssertEqual(item.delivery, .failed)
        XCTAssertTrue(model.canRetry(item)); XCTAssertTrue(model.composer.text.isEmpty)
        model.composer.text = "下一句话"
        await model.retry(item)
        XCTAssertEqual(model.composer.text, "下一句话"); XCTAssertEqual(model.timeline.count, 1)
        XCTAssertEqual(model.error, "暂时无法发送，请连接后重试。")
    }
    func testAuthoritativeAcceptanceSettlesRowAndCannotBeReplacedByStaleFailure() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        model.composer.text = "记下明天的安排"; await model.send()
        let item = try XCTUnwrap(model.timeline.first), eventID = String(item.id.dropFirst(3))
        var state = try consumer()
        _ = try state.beginSubmit(eventID: eventID, capturedAt: "2026-10-16T17:00:00.000Z", text: item.text)
        await model.accept(state)
        XCTAssertEqual(model.timeline.first?.delivery, .sending, "in flight shows 发送中")
        XCTAssertFalse(model.canRetry(try XCTUnwrap(model.timeline.first)), "nothing to retry while Core is still sending")
        var rejected = state
        try rejected.accept(packet(["operation": "rejected", "request_operation": "submit", "event_id": eventID,
            "control_id": NSNull(), "processed_event_id": NSNull(),
            "error_code": "ADMISSION_CAPACITY_EXCEEDED"]))
        model.error = "连接已中断，请重新连接。"
        try state.accept(packet(["operation": "accepted", "event_id": eventID,
            "processed_event_id": "d:" + String(repeating: "a", count: 64),
            "admission": ["state": "accepted", "run_id": NSNull(), "idempotency_key": "paios:" + String(repeating: "b", count: 64)]]))
        await model.accept(state)
        XCTAssertNil(model.timeline.first?.delivery)
        XCTAssertEqual(model.error, "连接已中断，请重新连接。", "one row's acceptance does not clear an unrelated error")
        await model.accept(rejected)
        XCTAssertNil(model.timeline.first?.delivery)
        XCTAssertFalse(model.canRetry(item))
    }
    func testRecoveredConnectionCannotReceiveErrorFromSuspendedFailedSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let control = FakeDesktopControl(), model = try DesktopAppModel(desktop: control, storeURL: root)
        let stopping = expectation(description: "old snapshot awaits desktop stop"), recovered = expectation(description: "new active snapshot")
        let release = AsyncStream<Void>.makeStream()
        await control.setStopBarrier { stopping.fulfill(); for await _ in release.stream { break } }
        let stale = Task { await model.accept(AssistantSessionSnapshot(state: .failed(code: "network"), revision: 1,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false)) }
        await fulfillment(of: [stopping], timeout: 2)
        let subscription = model.$connected.filter { $0 }.sink { _ in recovered.fulfill() }
        let active = Task { await model.accept(AssistantSessionSnapshot(state: .active(encryptionActive: true), revision: 2,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false)) }
        await fulfillment(of: [recovered], timeout: 2)
        release.continuation.yield(()); await stale.value; await active.value; subscription.cancel()
        XCTAssertTrue(model.connected); XCTAssertNil(model.error)
    }
    func testVoiceSendFailureCreatesRetryableTranscriptOutsideComposer() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        let digest = String(repeating: "a", count: 64)
        let candidate = CentralVoiceCandidate(candidateRef: "candidate", candidateRevision: digest, windowRef: "window",
            selectedInputSHA256: digest, transcript: "帮我看看这个文件", transcriptSHA256: digest)
        await model.sendVoice(candidate, eventID: "voice-test")
        let item = try XCTUnwrap(model.timeline.first)
        XCTAssertEqual(item.text, candidate.transcript); XCTAssertEqual(item.via, "ptt")
        XCTAssertEqual(item.delivery, .failed); XCTAssertTrue(model.canRetry(item))
        XCTAssertTrue(model.composer.text.isEmpty); XCTAssertEqual(model.voiceFeedback, DesktopAppModel.voiceNotSent)
    }
    private func sentVoice(_ eventID: String, transcript: String) throws -> AssistantCentralTextConsumer {
        var value = try consumer()
        let digest = String(repeating: "a", count: 64)
        func status(_ source: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            try packet(["operation": "voice_status", "operation_id": "voice-1", "source_status": source].merging(extra) { $1 })
        }
        _ = try value.beginVoice(operationID: "voice-1")
        try value.accept(status("recording")); _ = try value.commitVoice()
        try value.accept(status("pending", ["event_id": eventID]))
        try value.accept(status("candidates", ["candidates": [["candidate_ref": "voice-candidate:one", "candidate_revision": digest,
            "window_ref": "voice-window:one", "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": transcript, "transcript_sha256": digest]]]))
        _ = try value.sendVoice(XCTUnwrap(value.voiceTurn.candidates.first))
        return value
    }
    func testInFlightVoiceShowsSendingAndUnknownOutcomeIsTerminalWithTextResend() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        let digest = String(repeating: "a", count: 64)
        await model.sendVoice(CentralVoiceCandidate(candidateRef: "voice-candidate:one", candidateRevision: digest, windowRef: "voice-window:one",
            selectedInputSHA256: digest, transcript: "帮我看看这个文件", transcriptSHA256: digest), eventID: "voice-event")
        var state = try sentVoice("voice-event", transcript: "帮我看看这个文件")
        await model.accept(state)
        let row = { try XCTUnwrap(model.timeline.first { $0.submissionEventID == "voice-event" }) }
        XCTAssertEqual(try row().delivery, .sending); XCTAssertFalse(model.canRetry(try row()))
        state.voiceSendUnconfirmed()
        await model.accept(state)
        XCTAssertEqual(try row().delivery, .unconfirmed); XCTAssertTrue(model.canRetry(try row()))
        XCTAssertEqual(model.voiceFeedback, DesktopAppModel.voiceUnconfirmed)
        XCTAssertTrue(try state.canBeginSubmit, "the unknown outcome never holds the next request")
    }
    private func activeSnapshot(_ revision: UInt64) -> AssistantSessionSnapshot {
        AssistantSessionSnapshot(state: .active(encryptionActive: true), revision: revision,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false)
    }
    /// Regression: a hold-to-talk failure was reported in `error`, and the next active snapshot (the
    /// microphone settling publishes one) cleared it before anyone saw it. Only a new connection clears the error.
    func testALaterActiveSnapshotKeepsAVoiceError() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        await model.accept(activeSnapshot(1))
        XCTAssertTrue(model.connected)
        model.error = "未能发送，请再试一次"
        await model.accept(activeSnapshot(2))
        XCTAssertEqual(model.error, "未能发送，请再试一次")
    }
    /// The released turn stays unsettled (HUD up) while central works, then shows Core's outcome: 没听清 only when
    /// nothing was heard, a plain failure otherwise.
    func testAReleasedTurnShowsItsOutcomeOnlyOnceItHasOne() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        let digest = String(repeating: "a", count: 64)
        func status(_ source: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            try packet(["operation": "voice_status", "operation_id": "voice-1", "source_status": source].merging(extra) { $1 })
        }
        var state = try consumer()
        _ = try state.beginVoice(operationID: "voice-1")
        try state.accept(status("recording")); _ = try state.commitVoice()
        try state.accept(status("pending", ["event_id": "voice-event"]))
        await model.accept(state)
        XCTAssertFalse(model.voiceSettled, "the HUD stays while central transcribes")
        var silent = state
        try silent.accept(status("candidates", ["candidates": [["candidate_ref": "voice-candidate:one", "candidate_revision": digest,
            "window_ref": "voice-window:one", "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": "", "transcript_sha256": digest]]]))
        await model.accept(silent)
        XCTAssertTrue(model.voiceSettled)
        XCTAssertEqual(model.voiceFeedback, "没听清，请按住再说一次"); XCTAssertEqual(model.voiceNote, "没听清，请按住再说一次")
        model.beginCentralSession()
        var expired = state
        _ = try expired.expireVoice("VOICE_TRANSCRIBE_TIMEOUT")
        await model.accept(expired)
        XCTAssertEqual(model.voiceFeedback, "这句语音没发出去，请按住再说一次", "a failure is not reported as 没听清")
    }
    func testNewSessionSettlesOldRowsAndFollowsTheFreshSessionState() async throws {
        let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
        model.composer.text = "旧会话里的话"; await model.send()
        let old = try XCTUnwrap(model.timeline.first)
        var previous = try consumer()
        _ = try previous.beginSubmit(eventID: String(old.id.dropFirst(3)), capturedAt: "2026-10-16T17:00:00.000Z", text: old.text)
        for _ in 0..<8 { previous.requireExplicitReread() }
        await model.accept(previous)
        XCTAssertEqual(model.timeline.first?.delivery, .sending)
        model.beginCentralSession()
        let settled = try XCTUnwrap(model.timeline.first { $0.id == old.id })
        XCTAssertEqual(settled.delivery, .unconfirmed); XCTAssertTrue(model.canRetry(settled))
        model.composer.text = "新会话里的话"; await model.send()
        let fresh = try XCTUnwrap(model.timeline.first { $0.text == "新会话里的话" })
        var next = try consumer()
        _ = try next.beginSubmit(eventID: String(fresh.id.dropFirst(3)), capturedAt: "2026-10-16T17:01:00.000Z", text: fresh.text)
        XCTAssertLessThan(next.revision, previous.revision)
        await model.accept(next)
        XCTAssertEqual(model.timeline.first { $0.id == fresh.id }?.delivery, .sending, "the new session's first updates are not dropped as stale")
        XCTAssertEqual(model.timeline.first { $0.id == old.id }?.delivery, .unconfirmed, "the new session never claims the old request")
    }
    func testTypedAndVoiceQueueAcknowledgementDoesNotOfferRetryAndSettlesOnDispatch() async throws {
        for voice in [false, true] {
            let (model, root) = try model(); defer { try? FileManager.default.removeItem(at: root) }
            if voice {
                let digest = String(repeating: "a", count: 64)
                await model.sendVoice(CentralVoiceCandidate(candidateRef: "voice-candidate:one", candidateRevision: digest,
                    windowRef: "voice-window:one", selectedInputSHA256: digest, transcript: "下一句", transcriptSHA256: digest), eventID: "voice-event")
            } else { model.composer.text = "下一句"; await model.send() }
            let item = try XCTUnwrap(model.timeline.first), event = item.submissionEventID ?? String(item.id.dropFirst(3))
            var state = voice ? try sentVoice(event, transcript: item.text) : try consumer()
            if !voice { _ = try state.beginSubmit(eventID: event, capturedAt: "2026-10-16T17:00:00.000Z", text: item.text) }
            func admission(_ status: String) throws -> CentralTextPacket {
                try packet(["operation": "accepted", "event_id": event, "processed_event_id": "d-queued",
                    "admission": ["state": status, "run_id": NSNull(), "idempotency_key": "queued-key"]])
            }
            try state.accept(admission("pending")); await model.accept(state)
            let queued = try XCTUnwrap(model.timeline.first)
            XCTAssertTrue(queued.isQueued)
            XCTAssertEqual(queued.deliveryStatus, "排队中 · 她处理完上一句就发")
            XCTAssertFalse(model.canRetry(queued))
            model.beginCentralSession()
            XCTAssertEqual(model.timeline.first?.deliveryStatus, "已接收 · 等待同步处理状态")
            XCTAssertFalse(model.canRetry(try XCTUnwrap(model.timeline.first)))
            try state.accept(admission("accepted")); await model.accept(state)
            XCTAssertNil(model.timeline.first?.deliveryStatus)
            XCTAssertFalse(model.canRetry(try XCTUnwrap(model.timeline.first)))
        }
    }

}
