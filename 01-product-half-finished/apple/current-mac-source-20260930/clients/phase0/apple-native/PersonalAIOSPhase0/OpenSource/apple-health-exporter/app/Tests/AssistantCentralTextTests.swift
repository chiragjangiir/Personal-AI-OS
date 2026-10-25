import Foundation
import CoreImage
import XCTest
@testable import HealthKitExporter

struct CentralTextTestFixture {
    let values: [String: Any]
    init(name: String = "formal-text-envelope.fixture") throws {
        #if SWIFT_PACKAGE
        let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/CentralText")
        #else
        let url = Bundle(for: AssistantCentralTextTests.self).url(forResource: name, withExtension: "json")
        #endif
        values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(url))) as? [String: Any])
    }
    var binding: CentralTransportBinding {
        let source = values["trusted_binding"] as! [String: Any]
        return CentralTransportBinding(sessionID: source["session_id"] as! String, deviceID: source["device_id"] as! String, connectionEpoch: source["connection_epoch"] as! String, expectedGatewayIdentity: source["expected_gateway_identity"] as! String, maxPacketBytes: 12_288, callRejoinWindowS: 120)
    }
    func bytes(_ key: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: XCTUnwrap(values[key]), options: .sortedKeys)
    }
    func packet(_ key: String) throws -> CentralTextPacket { try AssistantCentralTextWire.decode(bytes(key)) }
    func chunks() throws -> [CentralTextPacket] {
        try XCTUnwrap(values["text_chunks"] as? [[String: Any]]).map {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: $0, options: .sortedKeys))
        }
    }
    func completion(_ mode: String) throws -> AutomaticCentralCompletionFixture {
        let completions = try XCTUnwrap(values["automatic_completion"] as? [String: Any])
        let value = try XCTUnwrap(completions[mode] as? [String: Any])
        func decode(_ value: Any) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value, options: .sortedKeys))
        }
        return try AutomaticCentralCompletionFixture(submit: XCTUnwrap(value["input_submit"] as? [String: String]),
            accepted: decode(XCTUnwrap(value["accepted"])), header: decode(XCTUnwrap(value["header"])),
            chunks: XCTUnwrap(value["text_chunks"] as? [[String: Any]]).map(decode))
    }
    func cancelled(_ extent: String) throws -> CancelledCentralCompletionFixture {
        let completions = try XCTUnwrap(values["cancelled"] as? [String: Any])
        let value = try XCTUnwrap(completions[extent] as? [String: Any])
        func decode(_ value: Any) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value, options: .sortedKeys))
        }
        return try CancelledCentralCompletionFixture(submit: XCTUnwrap(value["input_submit"] as? [String: String]),
            accepted: decode(XCTUnwrap(value["accepted"])), sealedHeader: decode(XCTUnwrap(value["sealed_header"])),
            chunks: XCTUnwrap(value["original_text_chunks"] as? [[String: Any]]).map(decode),
            header: decode(XCTUnwrap(value["header"])), lateChunk: decode(XCTUnwrap(value["late_chunk"])),
            ack: XCTUnwrap(value["input_ack"] as? [String: Any]), receipt: XCTUnwrap(value["ack_receipt"] as? [String: Any]),
            evidence: XCTUnwrap(value["evidence"] as? [String: Any]))
    }
    func consumer(header: CentralTextPacket? = nil) throws -> AssistantCentralTextConsumer {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: binding)
        let submit = try XCTUnwrap(values["input_submit"] as? [String: String])
        _ = try consumer.beginSubmit(eventID: XCTUnwrap(submit["event_id"]),
            capturedAt: XCTUnwrap(submit["captured_at"]), text: XCTUnwrap(submit["text"]))
        try consumer.accept(packet("accepted"))
        let selectedHeader = try header ?? packet("result_header")
        _ = try consumer.requestResult(sealed: (try selectedHeader.fields.value("text_replay", as: String.self)) == "sealed")
        try consumer.accept(selectedHeader)
        return consumer
    }
}

struct AutomaticCentralCompletionFixture {
    let submit: [String: String]
    let accepted: CentralTextPacket
    let header: CentralTextPacket
    let chunks: [CentralTextPacket]
}

struct CancelledCentralCompletionFixture {
    let submit: [String: String]
    let accepted: CentralTextPacket
    let sealedHeader: CentralTextPacket
    let chunks: [CentralTextPacket]
    let header: CentralTextPacket
    let lateChunk: CentralTextPacket
    let ack: [String: Any]
    let receipt: [String: Any]
    let evidence: [String: Any]

    func receiptPacket() throws -> CentralTextPacket {
        // Test-only framing of the actual raw OUT receipt, not an observed SDK outer packet.
        let envelope: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "ack_receipt",
            "session_id": try XCTUnwrap((try accepted.fields.value("session_id", as: String.self))),
            "processed_event_id": try XCTUnwrap((try accepted.fields.value("processed_event_id", as: String.self))), "receipt": receipt]
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: envelope))
    }
}

final class AssistantCentralTextTests: XCTestCase {
    func testLocalTypedSubmissionSourceComesFromCurrentConsumer() throws {
        let fixture = try CentralTextTestFixture()
        var value = try fixture.consumer()
        XCTAssertTrue(value.isLocallySubmitted)
        try value.reset(binding: fixture.binding)
        XCTAssertFalse(value.isLocallySubmitted, "A reset cannot keep the previous local source")
    }

    func testQRURLSurvivesTextPersistenceAndRendersLocally() throws {
        let url = "https://example.invalid/scan?ticket=synthetic%2Bticket&sid=mijia"
        let text = "请保存图片，再用米家相册扫码\n![米家, 登录](qr:\(url))"
        let saved = YimiItem(id: "her-login", kind: .her, text: text, date: Date())
        let restored = try JSONDecoder().decode(YimiItem.self, from: JSONEncoder().encode(saved))
        XCTAssertEqual(restored.text, text)
        XCTAssertEqual(restored.replyContent.text, "请保存图片，再用米家相册扫码")
        let image = try XCTUnwrap(restored.replyContent.qr)
        let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: nil,
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        XCTAssertEqual(detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }, [url])
        let prefix = "https://example.invalid/"
        let maximum = YimiItem(id: "her-max", kind: .her,
            text: "![x](qr:\(prefix + String(repeating: "a", count: 2048 - prefix.utf8.count)))", date: Date())
        XCTAssertNotNil(maximum.replyContent.qr)
        let wechat = YimiItem(id: "her-wechat", kind: .her, text: "![微信登录二维码](qr:http://weixin.qq.com/x/SyntheticToken123)", date: Date())
        XCTAssertNotNil(wechat.replyContent.qr)
        for payload in ["qr:http://example.invalid", "qr:http://weixin.qq.com/other", "qr:http://weixin.qq.com.evil/x/a",
                        "qr:file:///session.json", "qr:https://",
                        "qr:" + prefix + String(repeating: "a", count: 2048),
                        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWsAAAAASUVORK5CYII="] {
            let invalid = YimiItem(id: "her-invalid", kind: .her, text: "![x](\(payload))", date: Date())
            XCTAssertEqual(invalid.replyContent.text, invalid.text)
            XCTAssertNil(invalid.replyContent.qr)
        }
    }

    /// Audit APP-07: only the callback of the hand-off this app started (its nonce, exact host, unexpired) becomes
    /// a turn; forged, other-nonce, late and look-alike callbacks are ignored, and the reply is size-bounded.
    func testLocationLossKeepsRequestCorrelationAndRejectsInvalidRequestID() throws {
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with:
            AssistantCentralTextWire.locationUpdate(nil, requestID: "care:one")) as? [String: Any])
        XCTAssertTrue(body["location"] is NSNull)
        XCTAssertEqual(body["request_id"] as? String, "care:one")
        XCTAssertThrowsError(try AssistantCentralTextWire.locationUpdate(nil, requestID: "bad id"))
    }

    func testLocationLossCarriesItsReasonOnlyWithoutAFix() throws {
        for reason in [AssistantLocationUnavailableReason.sharingOff, .permissionDenied, .permissionRestricted,
                       .permissionNotDetermined, .locationUnknown, .network, .timeout, .staleFix, .invalidFix, .backgroundWhenInUse, .reducedAccuracy, .failed] {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with:
                AssistantCentralTextWire.locationUpdate(nil, requestID: "navigation:fix", unavailable: reason, cachedFixAgeMs: 240_000)) as? [String: Any])
            XCTAssertEqual(body["unavailable_reason"] as? String, reason.rawValue)
            XCTAssertEqual(body["cached_fix_age_ms"] as? Int, 240_000)
        }
        XCTAssertThrowsError(try AssistantCentralTextWire.locationUpdate(nil, requestID: "navigation:fix", unavailable: .timeout, cachedFixAgeMs: -1))
        let silent = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.locationUpdate(nil)) as? [String: Any])
        XCTAssertNil(silent["unavailable_reason"])
        let fix = AssistantLocationObservation(localCaptureID: "a", latitude: 1, longitude: 2, horizontalAccuracy: 5, observedAt: Date())
        let located = try XCTUnwrap(JSONSerialization.jsonObject(with:
            AssistantCentralTextWire.locationUpdate(fix, unavailable: .network)) as? [String: Any])
        XCTAssertNil(located["unavailable_reason"])
    }

    func testQwenCallbackIsAcceptedOnlyForThePendingHandOff() throws {
        let nonce = "3f1c2a64-8b1d-4c55-9a0e-2f6f5b7c9d10"
        let pending = QwenHandoff.Pending(nonce: nonce, createdAt: Date(timeIntervalSince1970: 1_800_000_000))
        let now = pending.createdAt.addingTimeInterval(60)
        func reply(_ url: String, _ handoff: QwenHandoff.Pending? = nil, at time: Date? = nil) throws -> String? {
            QwenHandoff.reply(from: try XCTUnwrap(URL(string: url)), pending: handoff, now: time ?? now)
        }
        let good = "paios://qwen-result/" + nonce + "?result=%E5%A5%BD%E7%9A%84"
        XCTAssertEqual(try reply(good, pending), "【千问回复】好的")
        XCTAssertNil(try reply(good), "No hand-off was started")
        XCTAssertNil(try reply("paios://qwen-result?result=forged", pending), "The old nonce-less form is refused")
        XCTAssertNil(try reply("paios://qwen-result/other-nonce?result=x", pending))
        XCTAssertNil(try reply("paios://qwen-anything/" + nonce + "?result=x", pending), "Exact host only")
        XCTAssertNil(try reply("evil://qwen-result/" + nonce + "?result=x", pending))
        XCTAssertNil(try reply(good, pending, at: pending.createdAt.addingTimeInterval(QwenHandoff.validity + 1)))
        XCTAssertEqual(try reply("paios://qwen-error/" + nonce, pending), "【千问回复】（千问没有返回结果）")
        let long = String(repeating: "长", count: QwenHandoff.maximumReplyCharacters + 50)
        let encoded = try XCTUnwrap(long.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        XCTAssertEqual(try reply("paios://qwen-result/" + nonce + "?result=" + encoded, pending)?.count,
                       QwenHandoff.replyPrefix.count + QwenHandoff.maximumReplyCharacters)
        let run = try XCTUnwrap(QwenHandoff.runURL(task: "点一杯奶茶", nonce: nonce)).absoluteString
        XCTAssertTrue(run.contains("paios%3A%2F%2Fqwen%2Dresult%2F" + nonce.replacingOccurrences(of: "-", with: "%2D")))
    }

    func testCallVideoStateRequiresBoundedRevision() throws {
        let base: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "session_id": "session",
            "operation": "call_state", "call_id": "video", "state": "live"]
        let media: [String: String] = ["provider": "artc", "app_id": "app", "channel_id": "channel",
            "user_id": "owner", "token": "test-only-credential", "token_expire_at": "1800003600"]
        for (key, value) in [("video", true as Any), ("media", media as Any)] {
            var packet = base; packet[key] = value
            XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet)))
            packet["video_revision"] = 0
            XCTAssertNoThrow(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet)))
        }
        for revision in [-1 as Any, 9_007_199_254_740_992 as Any, 0.5 as Any] {
            var packet = base; packet["video"] = false; packet["video_revision"] = revision
            XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet)))
        }
        var open = base; open["operation"] = "call_open"; open["video"] = true
        open.removeValue(forKey: "state")
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: open)))
    }

    func testVideoCallWireKeepsVoiceCompatibilityAndDecodesMedia() throws {
        let voice = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.call("call_open", callID: "voice")) as! [String: Any]
        let video = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.call("call_open", callID: "video", video: true)) as! [String: Any]
        XCTAssertEqual(voice["video_revision"] as? Int, 0)
        let update = try JSONSerialization.jsonObject(with: AssistantCentralTextWire.call("call_video", callID: "video", video: false, videoRevision: 7)) as! [String: Any]
        XCTAssertEqual(update["video_revision"] as? Int, 7)
        XCTAssertThrowsError(try AssistantCentralTextWire.call("call_video", callID: "video", videoRevision: 9_007_199_254_740_992))
        XCTAssertNil(voice["video"]); XCTAssertEqual(video["video"] as? Bool, true)
        var call = CentralCall(id: "video", state: "opening")
        var wire: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "session_id": "session",
            "operation": "call_state", "call_id": "video", "state": "connecting"]
        try call.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)).fields)
        XCTAssertNil(call.media)
        wire["video_revision"] = 0
        wire["media"] = ["provider": "artc", "app_id": "app", "channel_id": "channel", "user_id": "owner",
            "token": "test-only-credential", "token_expire_at": "1800003600"]
        try call.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)).fields)
        XCTAssertEqual(call.media?.channel_id, "channel"); XCTAssertEqual(call.media?.user_id, "owner")
        wire["state"] = "live"; wire["video"] = true
        var component = wire["media"] as! [String: String]; component["audio_input"] = "gateway"; wire["media"] = component
        try call.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)).fields)
        XCTAssertEqual(call.state, "connecting", "Video presentation waits for a frame without losing server live")
        call.stopVideoPresentation()
        XCTAssertEqual(call.state, "live"); XCTAssertEqual(call.id, "video"); XCTAssertNil(call.media)
        wire["state"] = "closed"
        try call.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)).fields)
        wire["state"] = "live"
        try call.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)).fields)
        XCTAssertEqual(call.state, "closed", "A late acknowledgement cannot reopen a hung-up call")
        wire["media"] = ["provider": "artc", "token": "test-only-credential"]
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)))
    }

    func testWakeOpeningIsExplicitAndDoesNotChangeManualOpening() throws {
        func fields(_ wake: Bool) throws -> [String: Any] {
            let data = try AssistantCentralTextWire.call("call_open", callID: "wake-call", wakeWord: wake)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertNil(try fields(false)["wake_word"])
        XCTAssertEqual(try fields(true)["wake_word"] as? Bool, true)
    }

    /// Audit H-05: a typed request during a live call keeps the call (only a session reset ends it).
    func testANewSubmissionKeepsTheLiveCall() throws {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        _ = try consumer.openCall()
        let callID = try XCTUnwrap(consumer.call.id)
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": AssistantCentralTextWire.schema, "session_id": "session",
            "operation": "call_state", "call_id": callID, "state": "live"])))
        XCTAssertTrue(consumer.call.isActive)
        _ = try consumer.beginSubmit(eventID: "typed-during-call", capturedAt: "2026-10-08T10:00:00.000Z", text: "顺便记一下")
        XCTAssertTrue(consumer.call.isActive)
        XCTAssertEqual(consumer.call.id, callID)
        try consumer.reset(binding: nil)
        XCTAssertFalse(consumer.call.isActive, "A session reset still ends it")
    }

    func testASecondCallKeepsTheFirstCallsTranscriptInsteadOfOverwritingTurnZero() throws {
        func packet(_ fields: [String: Any]) throws -> CentralBody {
            var body = fields
            body["schema_version"] = "paios.central.text-envelope.v1"; body["session_id"] = "session"
            return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body)).fields
        }
        func transcript(_ call: String, _ text: String) throws -> CentralBody {
            try packet(["operation": "call_transcript", "call_id": call, "turn": 0, "role": "user", "text": text, "final": true])
        }
        var call = CentralCall(id: "call-1", state: "live", lines: [])
        try call.accept(transcript("call-1", "第一次通话"))
        try call.accept(packet(["operation": "call_state", "call_id": "call-1", "state": "closed"]))
        call = CentralCall(id: "call-2", state: "opening", lines: call.lines)
        try call.accept(transcript("call-2", "第二次通话"))
        XCTAssertEqual(call.lines.map(\.text), ["第一次通话", "第二次通话"])
    }

    private func ownerVoiceConsumer() throws -> AssistantCentralTextConsumer {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        return consumer
    }
    private func central(_ fields: [String: Any]) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject:
            fields.merging(["schema_version": AssistantCentralTextWire.schema, "session_id": "session"]) { $1 }))
    }

    /// 录入我的声音: a sentence window opens, records, commits and is measured; only ok samples carry an id; a refused
    /// commit names the samples to read again; everything is encoded per the pinned contract.
    func testVoiceprintSentenceWindowsAndCommitFollowTheContract() throws {
        var consumer = try ownerVoiceConsumer()
        let open = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.beginVoiceprint(operationID: "voiceprint-1")) as? [String: Any])
        XCTAssertEqual(open as NSDictionary, ["operation": "voiceprint_open", "operation_id": "voiceprint-1"])
        XCTAssertThrowsError(try consumer.commitVoiceprint(), "commit waits for the recording receipt")
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "voiceprint-1", "status": "recording"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.phase, .recording)
        _ = try consumer.commitVoiceprint()
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "other", "status": "measured",
                                     "sample_id": "vps-0f8fad5b-d9cb-469f-a165-70867728950e", "speech_ms": 2400, "quality": "ok"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.phase, .measuring, "another window's answer is ignored")
        let sampleID = "vps-0f8fad5b-d9cb-469f-a165-70867728950e"
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "voiceprint-1", "status": "measured",
                                     "sample_id": sampleID, "speech_ms": 2400, "quality": "ok"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.sample, CentralVoiceprintSample(sampleID: sampleID, speechMS: 2400, quality: .ok))
        XCTAssertThrowsError(try central(["operation": "voiceprint_sample", "operation_id": "x", "status": "measured", "sample_id": "../x"]))
        // A too-short sentence carries no id; a failed window says why.
        _ = try consumer.beginVoiceprint(operationID: "voiceprint-2")
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "voiceprint-2", "status": "recording"]))
        _ = try consumer.commitVoiceprint()
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "voiceprint-2", "status": "measured", "speech_ms": 600, "quality": "too_short"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.sample?.quality, .tooShort); XCTAssertNil(consumer.ownerVoice.voiceprint.sample?.sampleID)
        _ = try consumer.beginVoiceprint(operationID: "voiceprint-3")
        try consumer.accept(central(["operation": "voiceprint_sample", "operation_id": "voiceprint-3", "status": "failed", "error_code": "FORMAL_PCM_VOICE_SOURCE_REQUIRED"]))
        XCTAssertEqual([consumer.ownerVoice.voiceprint.phase == .failed, consumer.ownerVoice.voiceprint.errorCode == "FORMAL_PCM_VOICE_SOURCE_REQUIRED"], [true, true])
        // Commit: the registry refuses the set and names the odd sample; then it enrolls.
        let ids = (0..<5).map { "vps-0f8fad5b-d9cb-469f-a165-7086772895\($0)0" }
        let enroll = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.voiceprintControl("voiceprint_enroll", controlID: "c-1", sampleIDs: ids)) as? [String: Any])
        XCTAssertEqual(enroll["sample_ids"] as? [String], ids); XCTAssertEqual(enroll["operation"] as? String, "voiceprint_enroll")
        XCTAssertThrowsError(try AssistantCentralTextWire.voiceprintControl("voiceprint_enroll", controlID: "c", sampleIDs: ["bad"]))
        XCTAssertThrowsError(try AssistantCentralTextWire.voiceprintControl("voiceprint_read", controlID: "c", sampleIDs: ids))
        let notEnrolled: [String: Any] = ["enrolled": false, "reenrollment_required": false, "samples": 0]
        try consumer.accept(central(["operation": "voiceprint_owner", "control_id": "c-1", "owner": notEnrolled,
            "enrollment": ["status": "inconsistent", "samples": ids.enumerated().map { ["sample_id": $1, "consistency": $0 == 4 ? 0.3 : 0.8, "ok": $0 != 4] }]]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.enrollment, CentralVoiceprint.Enrollment(enrolled: false, rejected: [ids[4]]))
        XCTAssertNil(consumer.ownerVoice.voiceprint.pending)
        _ = try consumer.voiceprintControl("voiceprint_enroll", controlID: "c-2", sampleIDs: ids)
        try consumer.accept(central(["operation": "voiceprint_owner", "control_id": "c-2", "enrollment": ["status": "enrolled"],
            "owner": ["enrolled": true, "reenrollment_required": false, "samples": 5, "updated_at": "2026-10-09T08:00:00.000Z", "consistency_min": 0.81]]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.enrollment?.enrolled, true)
        XCTAssertEqual(consumer.ownerVoice.voiceprint.owner?.samples, 5)
        // A refused control is matched by its control id; a new request never clears this state.
        _ = try consumer.voiceprintControl("voiceprint_forget", controlID: "c-3")
        try consumer.accept(central(["operation": "rejected", "request_operation": "voiceprint_forget", "control_id": "c-3",
                                     "event_id": NSNull(), "processed_event_id": NSNull(), "error_code": "VOICEPRINT_DEVICE_REQUIRED"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.controlError, "VOICEPRINT_DEVICE_REQUIRED")
        _ = try consumer.beginSubmit(eventID: "typed", capturedAt: "2026-10-09T08:00:00.000Z", text: "你好")
        XCTAssertEqual(consumer.ownerVoice.voiceprint.owner?.enrolled, true)
    }

    /// "确认是我": prompts arrive as a snapshot with a deadline from arrival; a tap is encoded per contract and starts
    /// following the confirmed request; a refusal clears the tap; an expired prompt cannot be tapped.
    func testTrustWindowUsesDeviceAuthorityAndConfirmsWithoutObservation() throws {
        var consumer = try ownerVoiceConsumer()
        let owner: [String: Any] = ["enrolled": false, "reenrollment_required": false, "samples": 0]
        try consumer.accept(central(["operation": "voiceprint_owner", "control_id": "read-devices", "owner": owner,
            "voice_devices": [["device_id": "paired-glasses", "device_type": "glasses", "name": "我的眼镜"]],
            "active_voice_device_id": "paired-glasses"]))
        XCTAssertEqual(consumer.ownerVoice.voiceprint.voiceDevices.map(\.title), ["我的眼镜"])
        XCTAssertEqual(consumer.ownerVoice.voiceprint.activeVoiceDeviceID, "paired-glasses")
        let bytes = try consumer.voiceprintControl("voice_trust_window_open", controlID: "trust-1", sourceDeviceID: "paired-glasses")
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(request["source_device_id"] as? String, "paired-glasses")
        let id = String(repeating: "e", count: 64)
        try consumer.accept(central(["operation": "voice_trust_window_opened", "control_id": "trust-1", "confirmation_id": id]))
        XCTAssertNil(consumer.ownerVoice.voiceprint.pending)
        XCTAssertEqual(consumer.ownerVoice.voiceprint.trustConfirmationID, id)
        try consumer.accept(central(["operation": "voice_confirmations", "confirmations": [
            ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 60_000,
             "text": "接下来 1 分钟是我在说", "purpose": "trust_window"]]]))
        _ = try consumer.confirmVoice(id, auth: "face_id")
        XCTAssertNil(consumer.submissionDelivery(eventID: "voice-confirm:" + id), "trust changes identity scope without creating a user turn")
        try consumer.accept(central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": "approve"]))
        XCTAssertTrue(consumer.ownerVoice.confirming.isEmpty)
        _ = try consumer.voiceprintControl("voice_trust_window_open", controlID: "trust-denied", sourceDeviceID: "paired-glasses")
        try consumer.accept(central(["operation": "rejected", "request_operation": "voice_trust_window_open",
            "control_id": "trust-denied", "event_id": NSNull(), "processed_event_id": NSNull(), "error_code": "VOICE_TRUST_DEVICE_REQUIRED"]))
        XCTAssertNil(consumer.ownerVoice.voiceprint.pending)
        XCTAssertEqual(consumer.ownerVoice.voiceprint.controlError, "VOICE_TRUST_DEVICE_REQUIRED")
    }

    func testVoiceConfirmationsArePushedTappedAndExpire() throws {
        var consumer = try ownerVoiceConsumer()
        let id = String(repeating: "c", count: 64), late = String(repeating: "d", count: 64)
        try consumer.accept(central(["operation": "voice_confirmations", "confirmations": [
            ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 118_000, "text": "依米，帮我叫车回家"],
            ["confirmation_id": late, "event_id": "voice-confirm:" + late, "expires_in_ms": 0]]]))
        XCTAssertEqual(consumer.ownerVoice.confirmations.map(\.text), ["依米，帮我叫车回家", nil])
        XCTAssertThrowsError(try consumer.confirmVoice(late), "an expired prompt cannot be confirmed")
        XCTAssertThrowsError(try consumer.confirmVoice(id, choice: .deny), "identity confirmation does not accept an action decision")
        XCTAssertThrowsError(try consumer.confirmVoice(id), "identity confirmation requires biometrics")
        XCTAssertTrue(consumer.ownerVoice.confirming.isEmpty)
        let tap = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.confirmVoice(id, auth: "face_id")) as? [String: Any])
        XCTAssertEqual(tap as NSDictionary, ["operation": "voice_confirm", "confirmation_id": id, "auth": "face_id"])
        XCTAssertEqual(consumer.ownerVoice.confirming, [id: "voice-confirm:" + id])
        XCTAssertThrowsError(try consumer.confirmVoice(id), "one tap in flight")
        // The confirmed request is followed like an observation: its admission is accepted for that event.
        try consumer.accept(central(["operation": "accepted", "event_id": "voice-confirm:" + id, "processed_event_id": "D-confirm",
            "admission": ["state": "accepted", "run_id": "run", "idempotency_key": "key"]]))
        try consumer.accept(central(["operation": "rejected", "request_operation": "voice_confirm", "control_id": NSNull(),
                                     "event_id": NSNull(), "processed_event_id": NSNull(), "error_code": "VOICE_CONFIRMATION_EXPIRED"]))
        XCTAssertEqual(consumer.ownerVoice.confirmationError, "VOICE_CONFIRMATION_EXPIRED"); XCTAssertTrue(consumer.ownerVoice.confirming.isEmpty)
        try consumer.accept(central(["operation": "voice_confirmations", "confirmations": []]))
        XCTAssertTrue(consumer.ownerVoice.confirmations.isEmpty, "a decided or expired prompt leaves")
        XCTAssertThrowsError(try AssistantCentralTextWire.voiceConfirm(confirmationID: "not-hex"))
    }

    func testNativeApprovalUsesExplicitChoiceAndSettlesWithoutNewAdmission() throws {
        var consumer = try ownerVoiceConsumer()
        let id = String(repeating: "a", count: 64), question = "可以把这份报告发给小林吗？"
        XCTAssertThrowsError(try consumer.accept(central(["operation": "voice_confirmations", "confirmations": [
            ["confirmation_id": id, "event_id": "approval:" + id, "expires_in_ms": 60_000, "kind": "native_approval"]]])),
            "an action cannot be approved without its question")
        for choice in [CentralVoiceConfirmationChoice.approve, .deny] {
            try consumer.accept(central(["operation": "voice_confirmations", "confirmations": [
                ["confirmation_id": id, "event_id": "approval:" + id, "expires_in_ms": 60_000,
                 "kind": "native_approval", "text": question]]]))
            XCTAssertEqual(consumer.ownerVoice.confirmations.first?.text, question)
            XCTAssertTrue(try XCTUnwrap(consumer.ownerVoice.confirmations.first).isNativeApproval)
            XCTAssertThrowsError(try consumer.confirmVoice(id), "native approvals require an explicit choice")
            let tap = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.confirmVoice(id, choice: choice)) as? [String: Any])
            XCTAssertEqual(tap as NSDictionary, ["operation": "voice_confirm", "confirmation_id": id, "choice": choice.rawValue])
            XCTAssertThrowsError(try consumer.confirmVoice(id, choice: choice), "one decision in flight")
            try consumer.accept(central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": choice.rawValue]))
            XCTAssertTrue(consumer.ownerVoice.confirming.isEmpty)
            XCTAssertTrue(consumer.ownerVoice.confirmations.isEmpty)
            XCTAssertNil(consumer.accepted, "the original run resumes; no new admission is expected")
        }
        XCTAssertThrowsError(try central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": "always"]))
    }

    /// 随身模式: a wake turn's reply arrives once per processed event and survives a new request.
    func testAmbientRepliesAreKeptOncePerTurn() throws {
        var consumer = try ownerVoiceConsumer()
        let reply: [String: Any] = ["operation": "ambient_reply", "processed_event_id": "processed:turn-1", "heard": "明天早上八点提醒我开会", "text": "好的，明早八点提醒你。"]
        try consumer.accept(central(reply)); try consumer.accept(central(reply))
        XCTAssertEqual(consumer.ownerVoice.ambientReplies.map(\.heard), ["明天早上八点提醒我开会"])
        _ = try consumer.beginSubmit(eventID: "typed", capturedAt: "2026-10-09T08:00:00.000Z", text: "谢谢")
        XCTAssertEqual(consumer.ownerVoice.ambientReplies.count, 1)
        XCTAssertThrowsError(try central(reply.merging(["text": ""]) { $1 }), "an empty reply is not a reply")
    }

    func testCareSafeStagesBeforeBindingAndRequiresMatchingAcknowledgement() throws {
        var unbound = AssistantCentralTextConsumer()
        let queued = try XCTUnwrap(JSONSerialization.jsonObject(with: unbound.careSafe(controlID: "safe")) as? [String: Any])
        XCTAssertEqual(queued as NSDictionary, ["operation": "care_safe", "control_id": "safe"])
        XCTAssertThrowsError(try unbound.accept(central(["operation": "care_safe_ack", "control_id": "safe", "cancelled": 1])))
        var consumer = try ownerVoiceConsumer()
        let card: [String: Any] = ["operation": "care_checkin", "care_id": "care:fall:checkin", "text": "你还好吗？"]
        try consumer.accept(central(card)); try consumer.accept(central(card))
        XCTAssertEqual(consumer.ownerVoice.careCheckins.count, 1)
        let tap = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.careSafe(controlID: "safe")) as? [String: Any])
        XCTAssertEqual(tap as NSDictionary, ["operation": "care_safe", "control_id": "safe"])
        XCTAssertThrowsError(try consumer.careSafe(controlID: "duplicate"))
        try consumer.accept(central(["operation": "care_safe_ack", "control_id": "other", "cancelled": 1]))
        XCTAssertEqual(consumer.ownerVoice.careControl, "safe")
        try consumer.accept(central(["operation": "care_safe_ack", "control_id": "safe", "cancelled": 0]))
        XCTAssertEqual(consumer.ownerVoice.careOutcome, "已告诉依米你没事")
        XCTAssertTrue(consumer.ownerVoice.careCheckins.isEmpty)
        _ = try consumer.careSafe(controlID: "timed-out"); consumer.expireCare("timed-out")
        try consumer.accept(central(["operation": "care_safe_ack", "control_id": "timed-out", "cancelled": 1]))
        XCTAssertEqual(consumer.ownerVoice.careError, "CARE_ACK_TIMEOUT")
    }

    func testErrandFeedDecodesTheRunningSnapshotAndStopIsEncodedPerContract() throws {
        let errand: [String: Any] = ["job_id": "job-0123456789ab", "title": "点一杯香柠养乐多", "app": "千问", "state": "running",
                                     "started_at": "2026-10-08T10:00:00.000Z", "step": 3, "max_steps": 40]
        let body: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "errand_progress",
                                   "session_id": "session", "errands": [errand]]
        let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
        let decoded = try XCTUnwrap(packet.fields.value("errands", as: [CentralBody].self)).map(CentralErrand.init)
        XCTAssertEqual(decoded.map(\.title), ["点一杯香柠养乐多"])
        XCTAssertEqual(decoded.first?.step, 3)
        XCTAssertEqual(decoded.first?.startedAt, Date(timeIntervalSince1970: 1_791_453_600))
        var bad = body; bad["errands"] = [errand.merging(["job_id": "../x"]) { $1 }]
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: bad)))
        let stop = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.errandCancel(jobID: "job-0123456789ab")) as? [String: Any])
        XCTAssertEqual(stop["operation"] as? String, "errand_cancel")
        XCTAssertEqual(stop["job_id"] as? String, "job-0123456789ab")
        XCTAssertThrowsError(try AssistantCentralTextWire.errandCancel(jobID: "job-1"))
    }

    func testSubmitAndCallCarryThePhonesFixAsWGS84AndRejectImpossibleCoordinates() throws {
        var fix = AssistantLocationObservation(localCaptureID: "fix", latitude: 31.239700, longitude: 121.49980,
                                               horizontalAccuracy: 35, observedAt: Date(timeIntervalSince1970: 1_791_400_000))
        fix.place = "上海市陆家嘴（公开地标）"
        let submit = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.submit(
            eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z", text: "帮我点杯奶茶", location: fix)) as? [String: Any])
        let location = try XCTUnwrap(submit["location"] as? [String: Any])
        XCTAssertEqual(location["latitude"] as? Double, 31.239700)
        XCTAssertEqual(location["longitude"] as? Double, 121.49980)
        XCTAssertEqual(location["accuracy_m"] as? Double, 35)
        XCTAssertEqual(location["datum"] as? String, "wgs84")
        XCTAssertEqual(location["place"] as? String, "上海市陆家嘴（公开地标）")
        XCTAssertEqual(location["observed_at"] as? String, "2026-10-07T19:06:40.000Z")
        let call = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.call(
            "call_open", callID: "call-1", location: fix)) as? [String: Any])
        XCTAssertNotNil(call["location"])
        XCTAssertNil(try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.submit(
            eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z", text: "x")) as? [String: Any])["location"])
        let impossible = AssistantLocationObservation(localCaptureID: "bad", latitude: 91, longitude: 0,
                                                      horizontalAccuracy: 5, observedAt: Date())
        XCTAssertThrowsError(try AssistantCentralTextWire.submit(eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z",
                                                                 text: "x", location: impossible))
    }

    func testAmbientHeartbeatPreservesTheSensorFixThroughSignalLoss() throws {
        var fix = AssistantLocationObservation(localCaptureID: "fix", latitude: 31.239700, longitude: 121.49980,
                                               horizontalAccuracy: 65, observedAt: Date(timeIntervalSince1970: 1_791_400_000))
        fix.place = "上海市陆家嘴（公开地标）"
        let update = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.locationUpdate(fix)) as? [String: Any])
        XCTAssertEqual(update["operation"] as? String, "location_update")
        XCTAssertEqual(Set(update.keys), ["operation", "location"])
        let location = try XCTUnwrap(update["location"] as? [String: Any])
        XCTAssertEqual(location["latitude"] as? Double, 31.239700)
        XCTAssertEqual(location["observed_at"] as? String, "2026-10-07T19:06:40.000Z")
        // The feed can stay alive beyond the server TTL while the phone moves without a new fix.
        let now = fix.observedAt.addingTimeInterval(1_200)
        let still = AssistantAmbientLocationFeed.stillHere(fix, now: now)
        XCTAssertEqual([still.latitude, still.longitude], [fix.latitude, fix.longitude])
        XCTAssertEqual(still.horizontalAccuracy, fix.horizontalAccuracy)
        XCTAssertEqual(still.observedAt, fix.observedAt)
        let repeated = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantCentralTextWire.locationUpdate(still)) as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(repeated["location"] as? [String: Any])["observed_at"] as? String,
                       "2026-10-07T19:06:40.000Z")
        let impossible = AssistantLocationObservation(localCaptureID: "bad", latitude: 0, longitude: 181,
                                                      horizontalAccuracy: 5, observedAt: Date())
        XCTAssertThrowsError(try AssistantCentralTextWire.locationUpdate(impossible))
    }

    func testActualPostSealCancellationPreservesDisplayedTextAndRetiresChunkACKConsumption() throws {
        let fixture = try CentralTextTestFixture(name: "formal-text-cancelled-envelope.fixture")
        for extent in ["partial", "full"] {
            let packets = try fixture.cancelled(extent)
            var consumer = AssistantCentralTextConsumer()
            try consumer.reset(binding: fixture.binding)
            _ = try consumer.beginSubmit(eventID: XCTUnwrap(packets.submit["event_id"]),
                capturedAt: XCTUnwrap(packets.submit["captured_at"]), text: XCTUnwrap(packets.submit["text"]))
            try consumer.accept(packets.accepted)
            try consumer.accept(packets.sealedHeader)
            let displayedCount = try XCTUnwrap(packets.ack["highest_contiguous_seq"] as? Int)
            for packet in packets.chunks.prefix(displayedCount) { try consumer.accept(packet) }
            let displayed = try XCTUnwrap(consumer.presentation)
            let beforeFinal = displayed.isFinal
            XCTAssertEqual(beforeFinal, extent == "full")
            let observedAt = try XCTUnwrap(packets.ack["observed_at"] as? String)
            let ack = try XCTUnwrap(consumer.consumedByUI(displayed, observedAt: observedAt))
            let ackEnvelope = try XCTUnwrap(JSONSerialization.jsonObject(with: ack) as? [String: Any])
            XCTAssertEqual(ackEnvelope["ack"] as? NSDictionary, packets.ack as NSDictionary)
            if extent == "full" { try consumer.accept(packets.receiptPacket()) }
            let priorReceiptConfirmation = consumer.ackConfirmed
            try consumer.accept(packets.header)
            XCTAssertEqual(consumer.presentation, displayed)
            XCTAssertEqual(consumer.presentation?.isFinal, beforeFinal, "Cancellation must not invent final text completion")
            XCTAssertEqual((try consumer.header?.fields.value("text_chunk_count", as: Int.self)), 9)
            XCTAssertTrue(consumer.status.contains("中断"))
            XCTAssertTrue(try consumer.canBeginSubmit, "The source cancellation ends this reply without awaiting the remaining chunks")
            XCTAssertFalse(try consumer.canRequestSealedResult, "The UI capability comes from the same interrupted source header")
            XCTAssertNil(consumer.renderedACK)
            XCTAssertEqual(consumer.ackConfirmed, priorReceiptConfirmation, "Historical receipt fact is not cancellation completion")
            let interruptedStatus = consumer.status
            if displayedCount < packets.chunks.count {
                XCTAssertThrowsError(try consumer.accept(packets.chunks[displayedCount]), "Even the next contiguous queued chunk is retired")
            }
            XCTAssertThrowsError(try consumer.accept(packets.lateChunk))
            XCTAssertNil(try consumer.consumedByUI(displayed, observedAt: "2026-10-01T00:00:03.000Z"))
            XCTAssertThrowsError(try consumer.accept(packets.receiptPacket()))
            XCTAssertEqual(consumer.presentation, displayed)
            XCTAssertEqual(consumer.status, interruptedStatus)
            XCTAssertThrowsError(try consumer.requestResult(sealed: true), "No fallback on a cancelled epoch")
            XCTAssertEqual(consumer.status, interruptedStatus)
            XCTAssertEqual(packets.evidence["sealed_replay_error"] as? String, "SEALED_TEXT_OLD_EPOCH")
            XCTAssertEqual(packets.evidence["late_ack_error"] as? String, "OUTPUT_ACK_OLD_EPOCH")

            var stale = try XCTUnwrap(JSONSerialization.jsonObject(with: packets.sealedHeader.bytes) as? [String: Any])
            stale["rendered_text_through_seq"] = (try packets.header.fields.value("rendered_text_through_seq", as: Int.self))
            stale["pending_text_chunk_count"] = (try packets.header.fields.value("pending_text_chunk_count", as: Int.self))
            // Controlled stale projection with matching waterline: the retired phase still cannot become sealed.
            XCTAssertThrowsError(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: stale))))
            XCTAssertEqual(consumer.presentation, displayed)
            _ = try consumer.beginSubmit(eventID: "next-explicit-" + extent, capturedAt: XCTUnwrap(packets.submit["captured_at"]), text: "new explicit prompt")
            XCTAssertNil(consumer.accepted)
            XCTAssertNil(consumer.header)
            XCTAssertNil(consumer.presentation)
            XCTAssertNil(consumer.renderedACK)
            XCTAssertThrowsError(try consumer.accept(packets.header))
            XCTAssertThrowsError(try consumer.accept(packets.lateChunk))
        }
    }

    func testCancelledHeaderPreventsDelayedUIACKAboveSourceRenderedWaterline() throws {
        let fixture = try CentralTextTestFixture(name: "formal-text-cancelled-envelope.fixture")
        let packets = try fixture.cancelled("partial")
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding)
        _ = try consumer.beginSubmit(eventID: XCTUnwrap(packets.submit["event_id"]), capturedAt: XCTUnwrap(packets.submit["captured_at"]), text: XCTUnwrap(packets.submit["text"]))
        try consumer.accept(packets.accepted)
        try consumer.accept(packets.sealedHeader)
        for packet in packets.chunks.prefix(3) { try consumer.accept(packet) }
        let displayed = try XCTUnwrap(consumer.presentation)
        XCTAssertEqual((try displayed.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self)), 3)
        XCTAssertNil(consumer.renderedACK, "The controlled UI callback has not run yet")
        try consumer.accept(packets.header)
        XCTAssertEqual((try consumer.header?.fields.value("rendered_text_through_seq", as: Int.self)), 2)
        XCTAssertNil(try consumer.consumedByUI(displayed, observedAt: "2026-10-01T00:00:03.000Z"), "Cancellation overrides an otherwise advancing honest UI ACK")
        XCTAssertNil(consumer.renderedACK)
        XCTAssertEqual(consumer.presentation, displayed)
        XCTAssertFalse(displayed.isFinal)
        XCTAssertTrue(consumer.status.contains("中断"))
    }

    func testTurnLimitNoticeUsesExistingFailedResultDisplay() throws {
        let fixture = try CentralTextTestFixture(name: "automatic-text-envelope.fixture")
        let packets = try fixture.completion("failed")
        var header = try XCTUnwrap(JSONSerialization.jsonObject(with: packets.header.bytes) as? [String: Any])
        let notice = "依米这次用完了步骤，还没来得及给出完整回复。动作收据：1 项已完成。"
        header["failure_notice"] = notice
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding)
        _ = try consumer.beginSubmit(eventID: XCTUnwrap(packets.submit["event_id"]),
            capturedAt: XCTUnwrap(packets.submit["captured_at"]), text: XCTUnwrap(packets.submit["text"]))
        try consumer.accept(packets.accepted)
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header)))
        XCTAssertEqual(consumer.status, notice)
        XCTAssertNil(consumer.presentation)
        XCTAssertTrue(try consumer.canBeginSubmit)
    }

    func testActualAutomaticCompletionsNeedNoResultRequestAndKeepFailuresHonest() throws {
        let fixture = try CentralTextTestFixture(name: "automatic-text-envelope.fixture")
        for mode in ["text", "none", "failed", "receipt_failure", "instant"] {
            let packets = try fixture.completion(mode)
            var consumer = AssistantCentralTextConsumer()
            try consumer.reset(binding: fixture.binding)
            _ = try consumer.beginSubmit(eventID: XCTUnwrap(packets.submit["event_id"]),
                capturedAt: XCTUnwrap(packets.submit["captured_at"]), text: XCTUnwrap(packets.submit["text"]))
            XCTAssertThrowsError(try consumer.accept(packets.header), "Accepted source D must bind before an automatic result")
            try consumer.accept(packets.accepted)
            XCTAssertEqual(consumer.submissionDelivery(eventID: try XCTUnwrap(packets.submit["event_id"])), .queued)
            if mode == "instant" {
                _ = try consumer.requestResult(sealed: true)
                // A too-early pure read must not disable the original automatic pending completion.
            }
            try consumer.accept(packets.header)
            for packet in packets.chunks { try consumer.accept(packet) }
            XCTAssertEqual((try consumer.header?.fields.value("text_replay", as: String.self)), "pending")
            if packets.chunks.isEmpty {
                XCTAssertNil(consumer.presentation)
                XCTAssertNil(consumer.renderedACK)
                XCTAssertTrue(try consumer.canBeginSubmit)
                XCTAssertTrue(consumer.status.contains(mode == "none" ? "静默" : "失败"))
            } else {
                let displayed = try XCTUnwrap(consumer.presentation)
                XCTAssertEqual(displayed.text, "automatic 🔬文字")
                XCTAssertNil(consumer.renderedACK, "Source push is not UI consumption")
                let ack = try XCTUnwrap(consumer.consumedByUI(displayed, observedAt: "2026-10-01T00:00:02.000Z"))
                let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: ack) as? [String: Any])
                let receipt = try XCTUnwrap(envelope["ack"] as? [String: Any])
                let chunk = try XCTUnwrap((try displayed.packet.fields.value("chunk", as: CentralBody.self)))
                XCTAssertEqual(receipt["output_id"] as? String, (try chunk.value("output_id", as: String.self)))
                XCTAssertEqual(receipt["reply_id"] as? String, (try chunk.value("reply_id", as: String.self)))
                XCTAssertEqual(receipt["target_device_id"] as? String, (try chunk.value("target_device_id", as: String.self)))
                XCTAssertEqual(receipt["route_version"] as? String, (try chunk.value("route_version", as: String.self)))
                XCTAssertEqual(receipt["reply_epoch"] as? Int, (try chunk.value("reply_epoch", as: Int.self)))
                XCTAssertEqual(receipt["highest_contiguous_seq"] as? Int, (try chunk.value("seq", as: Int.self)))
                XCTAssertFalse(consumer.ackConfirmed)
                if mode == "receipt_failure" { XCTAssertTrue(consumer.status.contains("业务结果为失败")) }
            }
        }
    }

    func testInvalidSubmitDoesNotConsumePresentationSlotOrLoseCurrentSourceState() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding)
        XCTAssertThrowsError(try consumer.beginSubmit(eventID: "event", capturedAt: "invalid", text: "text"))
        XCTAssertNil(consumer.eventID)
        XCTAssertNil(consumer.submission)
        XCTAssertTrue(try consumer.canBeginSubmit)
        _ = try consumer.beginSubmit(eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z", text: "valid")
        XCTAssertEqual(consumer.eventID, "event")
    }

    #if os(macOS)
    func testColdSealedReplayAcrossIndependentConsumerProcesses() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let mode = environment["PAIOS_CENTRAL_COLD_MODE"] else {
            let directory = URL(fileURLWithPath: environment["PAIOS_CENTRAL_COLD_LOG_ROOT"] ?? FileManager.default.temporaryDirectory.appendingPathComponent("paios-central-cold").path)
                .appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for mode in ["partial_rendered_replay", "full_rendered_replay"] {
                let worker = Process()
                worker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
                worker.arguments = ["-XCTest", "HealthKitExporterTests.AssistantCentralTextTests/testColdSealedReplayAcrossIndependentConsumerProcesses", Bundle(for: Self.self).bundlePath]
                worker.environment = environment.merging(["PAIOS_CENTRAL_COLD_MODE": mode]) { _, value in value }
                let log = directory.appendingPathComponent(mode + ".log")
                FileManager.default.createFile(atPath: log.path, contents: nil)
                let output = try FileHandle(forWritingTo: log)
                worker.standardOutput = output
                worker.standardError = output
                try worker.run()
                worker.waitUntilExit()
                try output.close()
                let diagnostics = try String(contentsOf: log, encoding: .utf8)
                XCTAssertEqual(worker.terminationStatus, 0, diagnostics)
                XCTAssertTrue(diagnostics.contains("PAIOS_COLD_SEALED_MODE=" + mode), diagnostics)
                print("PAIOS_COLD_WORKER_LOG=" + log.path)
            }
            return
        }
        try assertColdReplay(mode)
        print("PAIOS_COLD_SEALED_MODE=" + mode)
    }
    #endif

    private func assertColdReplay(_ key: String) throws {
        let fixture = try CentralTextTestFixture()
        let replay = try XCTUnwrap(fixture.values[key] as? [String: Any])
        let header = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: XCTUnwrap(replay["header"])))
        let packets = try XCTUnwrap(replay["text_chunks"] as? [[String: Any]]).map {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: $0, options: .sortedKeys))
        }
        var consumer = try fixture.consumer(header: header)
        let watermark = try XCTUnwrap((try header.fields.value("rendered_text_through_seq", as: Int.self)))
        XCTAssertEqual((try header.fields.value("text_replay", as: String.self)), "sealed")
        XCTAssertEqual(packets.count, 71)
        XCTAssertNil(consumer.presentation)
        XCTAssertNil(consumer.renderedACK, "A fresh process has no local ACK history")
        for packet in packets {
            try consumer.accept(packet)
            let display = try XCTUnwrap(consumer.presentation)
            let sequence = try XCTUnwrap((try packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self)))
            let ack = try consumer.consumedByUI(display, observedAt: "2026-10-01T00:00:01.000Z")
            if sequence <= watermark {
                XCTAssertNil(ack, "Read-only rendered prefix is displayed without a backward ACK")
            } else {
                let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(ack)) as? [String: Any])
                let original = try XCTUnwrap(fields["ack"] as? [String: Any])
                XCTAssertEqual(original["highest_contiguous_seq"] as? Int, sequence)
                XCTAssertEqual(original["reply_id"] as? String, (try packet.fields.value("chunk", as: CentralBody.self)?.value("reply_id", as: String.self)))
                XCTAssertEqual(original["reply_epoch"] as? Int, (try packet.fields.value("chunk", as: CentralBody.self)?.value("reply_epoch", as: Int.self)))
            }
        }
        XCTAssertEqual(consumer.presentation?.text.utf8.count, 240_000)
        XCTAssertEqual(consumer.presentation?.isFinal, true)
        for packet in packets { try consumer.accept(packet) }
        XCTAssertEqual(consumer.presentation?.text.utf8.count, 240_000)
        if watermark == 71 { XCTAssertNil(consumer.renderedACK) }
        XCTAssertFalse(consumer.ackConfirmed, "A source watermark does not fabricate a receipt callback")
    }

    func testSealedHeaderRejectsPendingAndRegressingWatermarksWithoutLosingDisplay() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        for packet in try fixture.chunks() { try consumer.accept(packet) }
        let display = try XCTUnwrap(consumer.presentation)
        _ = try consumer.consumedByUI(display, observedAt: "2026-10-01T00:00:01.000Z")
        let full = try XCTUnwrap(fixture.values["full_rendered_replay"] as? [String: Any])
        var header = try XCTUnwrap(full["header"] as? [String: Any])
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header)))
        XCTAssertNil(consumer.renderedACK, "Source watermark suppresses stale explicit retry without inventing a receipt")
        for changed in ["pending", "regressed", "overflow"] {
            var invalid = header
            if changed == "pending" { invalid["text_replay"] = "pending" }
            if changed == "regressed" { invalid["rendered_text_through_seq"] = 0; invalid["pending_text_chunk_count"] = 71 }
            if changed == "overflow" { invalid["rendered_text_through_seq"] = 72 }
            XCTAssertThrowsError(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: invalid))))
            XCTAssertEqual(consumer.presentation, display)
        }
        header["reply_epoch"] = (header["reply_epoch"] as? Int ?? 0) + 1
        XCTAssertThrowsError(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header))))
        XCTAssertEqual(consumer.presentation, display)
    }

    func testInitialResultAndExplicitSealedReadUseDistinctSourcePaths() throws {
        let fixture = try CentralTextTestFixture()
        let submit = try XCTUnwrap(fixture.values["input_submit"] as? [String: String])
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding)
        _ = try consumer.beginSubmit(eventID: XCTUnwrap(submit["event_id"]), capturedAt: XCTUnwrap(submit["captured_at"]), text: XCTUnwrap(submit["text"]))
        try consumer.accept(fixture.packet("accepted"))
        let initial = try consumer.requestResult()
        XCTAssertEqual(try JSONSerialization.jsonObject(with: initial) as? NSDictionary, fixture.values["input_pending_result"] as? NSDictionary)
        XCTAssertNil(consumer.presentation, "A request before source terminal completion does not imply a result")
        XCTAssertNil(consumer.renderedACK)
        let evidence = try XCTUnwrap(fixture.values["first_completion_evidence"] as? [String: Any])
        XCTAssertEqual(evidence["running_default_error"] as? String, "OUTPUT_NATIVE_NOT_TERMINAL")
        XCTAssertEqual(evidence["no_seal_during_running"] as? Bool, true)
        try consumer.accept(fixture.packet("pending_header"))
        for packet in try fixture.chunks() { try consumer.accept(packet) }
        XCTAssertEqual(consumer.presentation?.text.utf8.count, 240_000)
        XCTAssertThrowsError(try consumer.accept(fixture.packet("after_ack_header")), "No automatic pending-to-sealed fallback")
        let reread = try consumer.requestResult(sealed: true)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: reread) as? NSDictionary, fixture.values["input_result"] as? NSDictionary)
        try consumer.accept(fixture.packet("after_ack_header"))
        XCTAssertEqual(consumer.presentation?.text.utf8.count, 240_000)
    }

    /// A reconnect into the same source session resends the original packet; any other session or owner ends the wait
    /// (unknown outcome) and never holds the next request.
    func testTypedRecoveryRetainsOriginalEnvelopeOnlyForOriginalScope() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding, generation: 1, ownerPairingIdentity: "owner")
        let submit = try XCTUnwrap(fixture.values["input_submit"] as? [String: String])
        let original = try consumer.beginSubmit(eventID: XCTUnwrap(submit["event_id"]),
            capturedAt: XCTUnwrap(submit["captured_at"]), text: XCTUnwrap(submit["text"]))
        try consumer.reset(binding: nil, generation: 2)
        XCTAssertEqual(consumer.submission, original)
        XCTAssertFalse(try consumer.needsTypedRecovery)
        var resumed = fixture.binding
        resumed = CentralTransportBinding(sessionID: resumed.sessionID, deviceID: resumed.deviceID,
            connectionEpoch: "reconnected", expectedGatewayIdentity: resumed.expectedGatewayIdentity,
            maxPacketBytes: resumed.maxPacketBytes, callRejoinWindowS: resumed.callRejoinWindowS)
        try consumer.reset(binding: resumed, generation: 3, ownerPairingIdentity: "owner")
        XCTAssertTrue(try consumer.needsTypedRecovery)
        XCTAssertEqual(try consumer.retryTypedSubmission(), original)
        let wrongScopes = [
            CentralTransportBinding(sessionID: "new-session", deviceID: resumed.deviceID,
                connectionEpoch: "4", expectedGatewayIdentity: resumed.expectedGatewayIdentity, maxPacketBytes: 12_288, callRejoinWindowS: 120),
            CentralTransportBinding(sessionID: resumed.sessionID, deviceID: "new-device",
                connectionEpoch: "4", expectedGatewayIdentity: resumed.expectedGatewayIdentity, maxPacketBytes: 12_288, callRejoinWindowS: 120),
            CentralTransportBinding(sessionID: resumed.sessionID, deviceID: resumed.deviceID,
                connectionEpoch: "4", expectedGatewayIdentity: "new-gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120)
        ]
        let event = try XCTUnwrap(consumer.eventID)
        for wrong in wrongScopes + [resumed] {
            var copy = consumer
            try copy.reset(binding: wrong, generation: 4, ownerPairingIdentity: wrong == resumed ? "new-owner" : "owner")
            XCTAssertNil(copy.submission)
            XCTAssertEqual(copy.submissionDelivery(eventID: event), .unconfirmed)
            XCTAssertTrue(try copy.canBeginSubmit)
            XCTAssertFalse(try copy.needsTypedRecovery)
            XCTAssertThrowsError(try copy.retryTypedSubmission(), "the original packet never moves to another session")
            XCTAssertThrowsError(try copy.requestResult())
            XCTAssertThrowsError(try copy.requestControl("cancel_run", controlID: "other-scope-control"))
            try copy.reset(binding: resumed, generation: 5, ownerPairingIdentity: "owner")
            XCTAssertThrowsError(try copy.retryTypedSubmission(), "an ended wait stays ended")
        }
        var rejected = consumer
        var rejection: [String: Any] = ["schema_version": AssistantCentralTextWire.schema,
            "operation": "rejected", "session_id": fixture.binding.sessionID,
            "request_operation": "submit", "event_id": try XCTUnwrap(consumer.eventID),
            "control_id": NSNull(), "processed_event_id": NSNull(), "error_code": "FORMAL_TEXT_REQUEST_FAILED"]
        try rejected.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: rejection)))
        XCTAssertEqual(try rejected.retryTypedSubmission(), original)
        rejection["error_code"] = "ADMISSION_CAPACITY_EXCEEDED"
        try rejected.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: rejection)))
        XCTAssertFalse(try rejected.needsTypedRecovery)
        XCTAssertTrue(try rejected.canBeginSubmit)
        XCTAssertFalse(rejected.canRetryTypedSubmission)
        try rejected.reset(binding: wrongScopes[0], generation: 6)
        XCTAssertNil(rejected.submission)
        XCTAssertTrue(try rejected.canBeginSubmit)
    }

    func testTypedRecoveryPreservesRenderedACKUntilOriginalReceipt() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        for chunk in try fixture.chunks() { try consumer.accept(chunk) }
        let displayed = try XCTUnwrap(consumer.presentation)
        var unrendered = consumer
        try unrendered.reset(binding: nil, generation: 2)
        try unrendered.reset(binding: fixture.binding, generation: 3)
        XCTAssertEqual(unrendered.presentation?.text, displayed.text)
        let rejection: [String: Any] = ["schema_version": AssistantCentralTextWire.schema,
            "operation": "rejected", "session_id": fixture.binding.sessionID,
            "request_operation": "result", "control_id": NSNull(),
            "processed_event_id": try XCTUnwrap(consumer.accepted?.fields.value("processed_event_id", as: String.self)),
            "event_id": try XCTUnwrap(consumer.eventID), "error_code": "FORMAL_TEXT_REQUEST_FAILED"]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: rejection)))
        let inputACK = try XCTUnwrap(fixture.values["input_ack"] as? [String: Any])
        let ack = try XCTUnwrap(inputACK["ack"] as? [String: Any])
        let original = try XCTUnwrap(consumer.consumedByUI(displayed,
            observedAt: XCTUnwrap(ack["observed_at"] as? String)))
        var replaced = consumer
        _ = try replaced.beginSubmit(eventID: "next-before-repair", capturedAt: "2026-10-11T00:00:00.000Z", text: "next")
        try replaced.reset(binding: nil, generation: 2)
        try replaced.reset(binding: fixture.binding, generation: 3, ownerPairingIdentity: "replacement-owner")
        _ = try replaced.beginSubmit(eventID: "new-pairing-request", capturedAt: "2026-10-11T00:00:01.000Z", text: "new owner")
        XCTAssertTrue(replaced.pendingRenderedACKs.isEmpty, "A new pairing cannot deliver the previous owner's retained ACK")
        try consumer.reset(binding: nil, generation: 2)
        XCTAssertEqual(consumer.pendingRenderedACKs, [original])
        try consumer.reset(binding: fixture.binding, generation: 3)
        XCTAssertEqual(consumer.pendingRenderedACKs, [original])
        XCTAssertTrue(try consumer.needsTypedRecovery)
        XCTAssertFalse(consumer.ackConfirmed)
        try consumer.accept(fixture.packet("ack_receipt"))
        XCTAssertTrue(consumer.ackConfirmed)
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
        XCTAssertFalse(try consumer.needsTypedRecovery)
        try consumer.reset(binding: nil, generation: 4)
        XCTAssertNil(consumer.submission)
        XCTAssertNil(consumer.header)
        XCTAssertNil(consumer.presentation)
    }

    func testProducerUnicodeChunksPreserveOriginalTupleAndOnlyUIConsumptionACKs() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        let chunks = try fixture.chunks()
        XCTAssertEqual(chunks.count, 71)
        XCTAssertNil(consumer.presentation, "Header is transport metadata, not a RESULT or text")
        for chunk in chunks { try consumer.accept(chunk) }
        let displayed = try XCTUnwrap(consumer.presentation)
        XCTAssertEqual(displayed.text.utf8.count, 240_000)
        XCTAssertTrue(displayed.isFinal)
        XCTAssertNil(consumer.renderedACK, "Receiving every chunk is not rendering")
        let original = displayed.text
        for chunk in chunks { try consumer.accept(chunk) }
        XCTAssertEqual(consumer.presentation?.text, original, "Lost ACK retransmission cannot duplicate Unicode text")
        let inputAck = try XCTUnwrap(fixture.values["input_ack"] as? [String: Any])
        let sourceAck = try XCTUnwrap(inputAck["ack"] as? [String: Any])
        let ack = try XCTUnwrap(consumer.consumedByUI(displayed, observedAt: XCTUnwrap(sourceAck["observed_at"] as? String)))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: ack) as? NSDictionary, inputAck as NSDictionary)
        XCTAssertFalse(consumer.ackConfirmed, "SDK publication alone cannot confirm receipt")
        XCTAssertNil(try consumer.consumedByUI(displayed, observedAt: "2026-10-01T00:00:01.000Z"), "No automatic ACK resend")
        XCTAssertEqual(consumer.renderedACK, ack, "Explicit retry retains exact original ACK bytes/time")
        try consumer.accept(fixture.packet("ack_receipt"))
        XCTAssertTrue(consumer.ackConfirmed)
        try consumer.accept(fixture.packet("after_ack_header"))
        XCTAssertEqual(consumer.presentation?.text, original)
    }

    // The producer names the verified native message when Hermes proves it; the contract, not the consumer, owns the shape.
    func testAcceptsTheProducersNativeMessageReference() throws {
        let fixture = try CentralTextTestFixture()
        var packet = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture.chunks().first!.bytes) as? [String: Any])
        var chunk = try XCTUnwrap(packet["chunk"] as? [String: Any])
        chunk["message_ref"] = "native-message:session-1:message-7"
        packet["chunk"] = chunk
        var consumer = try fixture.consumer()
        XCTAssertNoThrow(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet))))
    }

    func testRejectsWrongTupleOrderOldEpochAndPrematureFinalWithoutDisplayOrACK() throws {
        let fixture = try CentralTextTestFixture()
        let source = try fixture.chunks().first!.fields
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture.chunks().first!.bytes) as? [String: Any])
        for (field, replacement) in ["run_id": "other-run", "event_id": "other-event", "reply_id": "other-reply",
            "target_device_id": "other-device", "route_version": "other-route", "output_id": "output:other"] {
            var consumer = try fixture.consumer()
            var packet = original
            var chunk = try XCTUnwrap(packet["chunk"] as? [String: Any])
            chunk[field] = replacement
            packet["chunk"] = chunk
            let changed = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet))
            if field == "output_id" {
                try consumer.accept(fixture.chunks()[0])
                XCTAssertThrowsError(try consumer.accept(changed))
            } else {
                XCTAssertThrowsError(try consumer.accept(changed), field)
                XCTAssertNil(consumer.presentation)
            }
            XCTAssertNil(consumer.renderedACK)
        }
        XCTAssertEqual((try source.value("operation", as: String.self)), "text_chunk")
        for (field, replacement) in [("reply_epoch", 0 as Any), ("seq", 2 as Any), ("final", true as Any)] {
            var consumer = try fixture.consumer()
            var packet = original
            var chunk = try XCTUnwrap(packet["chunk"] as? [String: Any])
            chunk[field] = replacement
            packet["chunk"] = chunk
            XCTAssertThrowsError(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet))))
            XCTAssertNil(consumer.presentation)
            XCTAssertNil(consumer.renderedACK)
        }
    }

    func testClosedWireRejectsInterimToolJSONUnknownFieldsAndInputBudget() throws {
        let fixture = try CentralTextTestFixture()
        for key in ["accepted", "result_header", "ack_receipt"] {
            var packet = try XCTUnwrap(fixture.values[key] as? [String: Any])
            packet["tool_json"] = ["saved": true]
            XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: packet)))
        }
        var header = try XCTUnwrap(fixture.values["result_header"] as? [String: Any])
        header["reply_phase"] = "interim"
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header)))
        XCTAssertThrowsError(try AssistantCentralTextWire.submit(eventID: "event", capturedAt: "bad", text: "text"))
        XCTAssertThrowsError(try AssistantCentralTextWire.submit(eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z", text: String(repeating: "字", count: 3_000)))
        var consumer = try fixture.consumer()
        try consumer.reset(binding: nil)
        XCTAssertThrowsError(try consumer.accept(fixture.packet("accepted")))
        XCTAssertThrowsError(try consumer.beginSubmit(eventID: "event", capturedAt: "2026-10-01T00:00:00.000Z", text: "text"))
    }

    // Bundle.module exists only in the SwiftPM test build; the Xcode test target has no resource bundle for this fixture.
    #if SWIFT_PACKAGE
    func testA61UnsolicitedErrandUsesFormalTextAndWAVWithoutReplacingTyping() async throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "formal-voice.fixture", withExtension: "json", subdirectory: "Fixtures/FormalVoice"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let source = try XCTUnwrap(fixture["trusted_binding"] as? [String: Any])
        let binding = CentralTransportBinding(sessionID: source["session_id"] as! String, deviceID: source["device_id"] as! String,
            connectionEpoch: source["connection_epoch"] as! String, expectedGatewayIdentity: source["expected_gateway_identity"] as! String,
            maxPacketBytes: 12_288, voiceTransport: AssistantCentralTextWire.voiceTransport)
        let event = "errand:job-0123456789ab"
        func packet(_ value: Any) throws -> CentralTextPacket {
            var body = try XCTUnwrap(value as? [String: Any])
            if body["event_id"] != nil { body["event_id"] = event }
            if var chunk = body["chunk"] as? [String: Any], chunk["event_id"] != nil { chunk["event_id"] = event; body["chunk"] = chunk }
            return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
        }
        let accepted = try packet(XCTUnwrap(fixture["accepted"]))
        var typing = AssistantCentralTextConsumer(); try typing.reset(binding: binding)
        _ = try typing.beginSubmit(eventID: "typed", capturedAt: "2026-10-01T00:00:00.000Z", text: "顺便记一下")
        let submit = typing.submission
        try typing.accept(accepted); try typing.accept(accepted)
        XCTAssertEqual(typing.eventID, "typed"); XCTAssertEqual(typing.submission, submit)
        XCTAssertTrue(typing.isLocallySubmitted, "A queued server errand does not relabel the active local submission")
        var consumer = AssistantCentralTextConsumer(); try consumer.reset(binding: binding)
        var wrongSession = try XCTUnwrap(JSONSerialization.jsonObject(with: accepted.bytes) as? [String: Any])
        wrongSession["session_id"] = "another-session"
        XCTAssertThrowsError(try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wrongSession))))
        try consumer.accept(accepted); try consumer.accept(accepted)
        try consumer.accept(packet(XCTUnwrap(fixture["header"])))
        for text in try XCTUnwrap(fixture["text_chunks"] as? [[String: Any]]) { try consumer.accept(packet(text)) }
        let shown = try XCTUnwrap(consumer.presentation)
        XCTAssertFalse(consumer.isLocallySubmitted, "A server errand must remain eligible for a background notification")
        XCTAssertEqual(shown.text, "原回复🔬"); XCTAssertTrue(shown.isFinal)
        XCTAssertNotNil(try consumer.consumedByUI(shown, observedAt: "2026-10-01T00:00:01.000Z"))
        let voice = try packet(XCTUnwrap(fixture["voice"])), bytes = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(fixture["wav_base64"] as? String)))
        let stream = AsyncThrowingStream<Data, Error> { $0.yield(bytes); $0.finish() }
        let audio = try XCTUnwrap(voice.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self))
        let resource = try await CentralVoiceFile.receive(stream, audio: audio); defer { resource.remove() }
        try resource.validate(chunk: XCTUnwrap(voice.fields.value("chunk", as: CentralBody.self)))
        #if os(macOS)
        let mac = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        do {
            try await mac.playCentralVoice(CentralVoicePlayback(packet: voice, resource: resource), binding: binding, attemptID: 1)
            XCTFail("Mac playback must require a current joined transport attempt")
        } catch { XCTAssertEqual(error as? LiveKitSessionError, .superseded) }
        #endif
        try consumer.receiveVoice(CentralVoicePlayback(packet: voice, resource: resource))
        let playing = try XCTUnwrap(consumer.takeVoicePlayback())
        let ack = try XCTUnwrap(consumer.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:01.000Z"))
        let fields = try XCTUnwrap((JSONSerialization.jsonObject(with: ack) as? [String: Any])?["ack"] as? [String: Any])
        XCTAssertEqual(fields["status"] as? String, "played"); XCTAssertEqual(consumer.eventID, event)
        XCTAssertEqual(consumer.presentation?.text, shown.text)
    }
    #endif

    func testNoneAndUnsupportedVoiceNeverDisplayOrGeneratePlayed() throws {
        let fixture = try CentralTextTestFixture()
        for mode in ["none", "voice"] {
            var consumer = AssistantCentralTextConsumer()
            try consumer.reset(binding: fixture.binding)
            let noneReplay = try XCTUnwrap(fixture.values["none_sealed_replay"] as? [String: Any])
            var header = try XCTUnwrap(noneReplay["header"] as? [String: Any])
            _ = try consumer.beginSubmit(eventID: XCTUnwrap(header["event_id"] as? String), capturedAt: "2026-10-01T00:00:00.000Z", text: "quiet")
            var accepted = try XCTUnwrap(fixture.values["accepted"] as? [String: Any])
            accepted["event_id"] = header["event_id"]
            accepted["processed_event_id"] = header["processed_event_id"]
            try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: accepted)))
            _ = try consumer.requestResult(sealed: true)
            header["reply_mode"] = mode
            try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header)))
            XCTAssertNil(consumer.presentation)
            XCTAssertNil(consumer.renderedACK)
            XCTAssertThrowsError(try consumer.accept(fixture.chunks()[0]))
        }
    }

    func testControlCallbackQueuePreservesOrderAndTerminatesOldCallbacks() async throws {
        let ingress = AssistantRealtimeEventIngress(capacity: 2)
        XCTAssertTrue(ingress.yield(.connected))
        XCTAssertTrue(ingress.yield(.encryptionActive))
        XCTAssertTrue(ingress.yield(.reconnected))
        XCTAssertFalse(ingress.takeOverflow())
        var iterator = ingress.stream.makeAsyncIterator()
        let first = await iterator.next()
        let second = await iterator.next()
        let third = await iterator.next()
        XCTAssertEqual(first, .connected)
        XCTAssertEqual(second, .encryptionActive)
        XCTAssertEqual(third, .reconnected)
        ingress.close()
        XCTAssertFalse(ingress.yield(.centralText(try CentralTextTestFixture().packet("accepted"))))
        XCTAssertFalse(ingress.takeOverflow(), "Generation teardown is expected termination, not a new failure")
        let ended = await iterator.next()
        XCTAssertNil(ended)
    }

    func testRenderCallbackCannotACKNewContextOrChangedDisplayedText() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        try consumer.accept(fixture.chunks()[0])
        let shown = try XCTUnwrap(consumer.presentation)
        let changed = CentralTextPresentation(binding: shown.binding, packet: shown.packet, text: "forged", isFinal: shown.isFinal)
        XCTAssertThrowsError(try consumer.consumedByUI(changed, observedAt: "2026-10-01T00:00:00.000Z"))
        try consumer.reset(binding: CentralTransportBinding(sessionID: "new", deviceID: "mac", connectionEpoch: "2", expectedGatewayIdentity: "controlled-gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        XCTAssertNil(try consumer.consumedByUI(shown, observedAt: "2026-10-01T00:00:00.000Z"))
        XCTAssertNil(consumer.renderedACK)
    }

    func testSettledDisplayCallbackAfterNextSubmitDoesNotClaimAnUnknownOutcome() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        for chunk in try fixture.chunks() { try consumer.accept(chunk) }
        let displayed = try XCTUnwrap(consumer.presentation)
        let ack = try XCTUnwrap((fixture.values["input_ack"] as? [String: Any])?["ack"] as? [String: Any])
        let observedAt = try XCTUnwrap(ack["observed_at"] as? String)
        _ = try consumer.consumedByUI(displayed, observedAt: observedAt)
        try consumer.accept(fixture.packet("ack_receipt"))
        XCTAssertTrue(consumer.ackConfirmed)
        _ = try consumer.beginSubmit(eventID: "next-submit", capturedAt: observedAt, text: "next")
        XCTAssertNil(try consumer.consumedByUI(displayed, observedAt: observedAt))
        XCTAssertNil(consumer.renderedACK)
        XCTAssertEqual(consumer.submissionDelivery(eventID: "next-submit"), .pending)
    }
}


extension AssistantCentralTextTests {
    private func watchControlFixture() throws -> [String: Any] {
        let override = ProcessInfo.processInfo.environment["PAIOS_WATCH_CONTROL_FIXTURE"]
        #if SWIFT_PACKAGE
        let bundled = Bundle.module.url(forResource: "watch-run-control.fixture", withExtension: "json", subdirectory: "Fixtures/CentralText")
        #else
        let bundled = Bundle(for: Self.self).url(forResource: "watch-run-control.fixture", withExtension: "json")
        #endif
        let url = try override.map { URL(fileURLWithPath: $0) } ?? XCTUnwrap(bundled)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    func testWatchStableINGIdentityAndPrimaryControlUseActualAcceptedConsumer() throws {
        let fixture = try watchControlFixture(), wire = try XCTUnwrap(fixture["wire"] as? [String: Any])
        let origin = try XCTUnwrap(wire["origin"] as? [String: Any]), trusted = try XCTUnwrap(fixture["trusted_binding"] as? [String: Any])
        let events = try XCTUnwrap(fixture["accepted"] as? [[String: Any]])
        let current = try XCTUnwrap(events.first { ($0["admission"] as? [String: Any])?["run_id"] is String })
        let eventID = try AssistantCentralTextWire.watchEventID(deviceID: XCTUnwrap(origin["device_id"] as? String), idempotencyKey: XCTUnwrap(wire["idempotency_key"] as? String))
        XCTAssertEqual(current["event_id"] as? String, eventID)
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: trusted["session_id"] as! String, deviceID: trusted["device_id"] as! String, connectionEpoch: trusted["connection_epoch"] as! String, expectedGatewayIdentity: trusted["expected_gateway_identity"] as! String, maxPacketBytes: 12_288, callRejoinWindowS: 120), generation: 1)
        let packet = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: current))
        XCTAssertThrowsError(try consumer.accept(packet), "Gateway acceptance does not register an unsent event")
        try consumer.beginObservation(eventID: eventID)
        try consumer.accept(packet)
        XCTAssertFalse(consumer.isLocallySubmitted, "An observed device event is not a locally submitted message")
        XCTAssertTrue(try consumer.canCancelRun)
        // A later observation and its pending D do not replace the running run.
        let pendingID = "watch:" + String(repeating: "b", count: 64)
        try consumer.beginObservation(eventID: pendingID)
        var pending = current
        pending["event_id"] = pendingID; pending["processed_event_id"] = "d:" + String(repeating: "c", count: 64)
        pending["admission"] = ["state": "pending", "run_id": NSNull(), "idempotency_key": "paios:" + String(repeating: "c", count: 64)]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: pending)))
        let bytes = try consumer.requestControl("cancel_run", controlID: "explicit-phone-control")
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(request["processed_event_id"] as? String, current["processed_event_id"] as? String)
        XCTAssertEqual(request["operation"] as? String, "cancel_run")
        if let output = ProcessInfo.processInfo.environment["PAIOS_NATIVE_CONTROL_FRAME"] { try bytes.write(to: URL(fileURLWithPath: output)) }
        let terminal = try XCTUnwrap(events.first(where: { ($0["admission"] as? [String: Any])?["state"] as? String == "cancelled" }))
        do {
            try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: terminal)))
            XCTAssertFalse(try consumer.canCancelRun)
            XCTAssertThrowsError(try consumer.accept(packet), "Late accepted cannot undo a real terminal")
        }
        try consumer.reset(binding: nil, generation: 2)
        XCTAssertFalse(try consumer.canCancelRun)
        XCTAssertThrowsError(try consumer.accept(packet), "Stop clears source registration")
    }
    func testWatchPendingAdmissionHasBoundedCapacityAndDoesNotPretendToCancel() throws {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "phone", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        for index in 0..<16 { try consumer.beginObservation(eventID: "watch-pending-\(index)") }
        XCTAssertThrowsError(try consumer.beginObservation(eventID: "watch-over-budget"))
        XCTAssertFalse(try consumer.canCancelRun)
        XCTAssertThrowsError(try consumer.requestControl("cancel_run", controlID: "no-native-run"))
        try consumer.reset(binding: nil)
        XCTAssertThrowsError(try consumer.beginObservation(eventID: "watch-after-stop"))
    }
    func testAuthoritativeRunOrderOverridesArrivalAndLateStateWithoutTerminal() throws {
        let fixture = try watchControlFixture(), trusted = try XCTUnwrap(fixture["trusted_binding"] as? [String: Any])
        let packets = try XCTUnwrap(fixture["accepted"] as? [[String: Any]])
        let original = try XCTUnwrap(packets.first { ($0["admission"] as? [String: Any])?["run_id"] is String })
        let binding = CentralTransportBinding(sessionID: trusted["session_id"] as! String, deviceID: trusted["device_id"] as! String, connectionEpoch: trusted["connection_epoch"] as! String, expectedGatewayIdentity: trusted["expected_gateway_identity"] as! String, maxPacketBytes: 12_288, callRejoinWindowS: 120)
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: binding, generation: 1)
        // Synthetic state ordering only. Registration order does not select native ownership.
        func event(_ id: String, _ order: Int?, _ state: String = "running") throws -> CentralTextPacket {
            var p = original
            p["event_id"] = id; p["processed_event_id"] = "d-" + id
            var admission: [String: Any] = ["state": state, "run_id": "run-" + id, "idempotency_key": "paios-" + id]
            if let order { admission["run_order"] = order }
            p["admission"] = admission
            return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: p))
        }
        try consumer.beginObservation(eventID: "earlier-observation")
        try consumer.beginObservation(eventID: "later-explicit")
        let explicit = try event("later-explicit", 8)
        try consumer.accept(explicit)
        let selected = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.requestControl("cancel_run", controlID: "cancel-explicit")) as? [String: Any])
        XCTAssertEqual(selected["processed_event_id"] as? String, "d-later-explicit")
        // The terminal packet is lost. Original pump next binds the earlier observation.
        try consumer.accept(event("earlier-observation", 9))
        let cancel = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.requestControl("cancel_run", controlID: "cancel-observation")) as? [String: Any])
        XCTAssertEqual(cancel["processed_event_id"] as? String, "d-earlier-observation")
        try consumer.accept(explicit) // delayed old native state cannot replace current run
        let late = try XCTUnwrap(JSONSerialization.jsonObject(with: consumer.requestControl("cancel_run", controlID: "cancel-late")) as? [String: Any])
        XCTAssertEqual(late["processed_event_id"] as? String, "d-earlier-observation")
        try consumer.accept(event("earlier-observation", 9, "completed"))
        XCTAssertFalse(try consumer.canCancelRun)
        try consumer.accept(explicit)
        XCTAssertFalse(try consumer.canCancelRun, "old active state cannot undo the newer terminal watermark")
        try consumer.reset(binding: binding, generation: 2)
        XCTAssertThrowsError(try consumer.accept(explicit), "epoch reset requires original source registration")
        try consumer.beginObservation(eventID: "legacy")
        try consumer.accept(event("legacy", nil))
        XCTAssertFalse(try consumer.canCancelRun, "legacy binding cannot invent run order")
    }

    func testKnownCapacityRejectionReleasesOnlyUnacceptedRegisteredObservation() throws {
        let fixture = try watchControlFixture(), trusted = try XCTUnwrap(fixture["trusted_binding"] as? [String: Any])
        let accepted = try XCTUnwrap((fixture["accepted"] as? [[String: Any]])?.first { ($0["admission"] as? [String: Any])?["run_id"] is String })
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: trusted["session_id"] as! String, deviceID: trusted["device_id"] as! String, connectionEpoch: trusted["connection_epoch"] as! String, expectedGatewayIdentity: trusted["expected_gateway_identity"] as! String, maxPacketBytes: 12_288, callRejoinWindowS: 120))
        let activeID = try XCTUnwrap(accepted["event_id"] as? String)
        try consumer.beginObservation(eventID: activeID)
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: accepted)))
        for n in 0..<15 { try consumer.beginObservation(eventID: "capacity-\(n)") }
        XCTAssertThrowsError(try consumer.beginObservation(eventID: "overflow"))
        func reject(_ id: String, _ code: String) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: ["schema_version":"paios.central.text-envelope.v1", "operation":"rejected", "session_id":trusted["session_id"]!, "request_operation":"submit", "control_id":NSNull(), "processed_event_id":NSNull(), "event_id":id, "error_code":code]))
        }
        try consumer.accept(reject("capacity-0", "FORMAL_TEXT_REQUEST_FAILED"))
        XCTAssertThrowsError(try consumer.beginObservation(eventID: "still-unknown"))
        try consumer.accept(reject("capacity-0", "ADMISSION_CAPACITY_EXCEEDED"))
        try consumer.beginObservation(eventID: "capacity-0") // explicit retry after capacity recovery
        XCTAssertTrue(try consumer.canCancelRun)
        try consumer.accept(reject(activeID, "ADMISSION_CAPACITY_EXCEEDED"))
        XCTAssertTrue(try consumer.canCancelRun, "late rejection cannot discard an already bound run")
        XCTAssertThrowsError(try consumer.beginObservation(eventID: "still-full"))
    }

}


extension AssistantCentralTextTests {
    func testConversationOrdersCallTurnsAndUpdatesBothSurfacesWithoutDuplicates() throws {
        let date = Date(timeIntervalSince1970: 100)
        var timeline = YimiConversationTimeline()
        var call = CentralCall(id: "one", state: "live", lines: [
            .init(callID: "one", turn: 1, role: "assistant", text: "第二句回复", interrupted: false),
            .init(callID: "one", turn: 0, role: "main_agent", text: "补充", interrupted: false),
            .init(callID: "one", turn: 0, role: "assistant", text: "第一句回复", interrupted: false),
            .init(callID: "one", turn: 1, role: "user", text: "第二句", interrupted: false),
            .init(callID: "one", turn: 0, role: "user", text: "第一句", interrupted: false)])
        var opening = call
        opening.state = "opening"
        timeline.accept(opening, at: date)
        timeline.accept(call, at: date)
        XCTAssertEqual(timeline.callLines("one").map(\.text), ["第一句", "第一句回复", "补充", "第二句", "第二句回复"])
        call.lines[2] = .init(callID: "one", turn: 0, role: "assistant", text: "第一句完整回复", interrupted: false)
        timeline.accept(call, at: date.addingTimeInterval(5))
        XCTAssertEqual(timeline.items.count, 6)
        XCTAssertEqual(timeline.chatItems.map(\.id), ["call-one"], "manual call turns appear only inside their card")
        XCTAssertEqual(timeline.callLines("one"), timeline.items.filter { $0.kind != .call })
        XCTAssertEqual(timeline.callLines("one").first?.date, date)
        XCTAssertEqual(timeline.callLines("one")[1].text, "第一句完整回复")
        XCTAssertEqual(timeline.callLines("one").first?.kind, .me)
        XCTAssertEqual(timeline.callLines("one").first?.via, "call")
        call.state = "closed"
        timeline.accept(call, at: date.addingTimeInterval(10))
        XCTAssertEqual(timeline.items.first?.endedAt, date.addingTimeInterval(10))
        var restored = YimiConversationTimeline(items: try JSONDecoder().decode([YimiItem].self, from: JSONEncoder().encode(timeline.items)))
        restored.accept(call, at: date.addingTimeInterval(15))
        XCTAssertEqual(restored.items.filter { $0.kind == .call }.map(\.id), ["call-one"])
        XCTAssertEqual(restored.chatItems.map(\.id), ["call-one"])
        XCTAssertEqual(restored.items.first?.endedAt, date.addingTimeInterval(10))
    }

    func testConversationKeepsLongCallsAndSeparatesCallsThatRestartAtTurnZero() {
        var timeline = YimiConversationTimeline()
        var first = CentralCall(id: "one", state: "live")
        for turn in 0..<650 {
            first.lines = [.init(callID: "one", turn: turn, role: "user", text: "同一句", interrupted: false)]
            timeline.accept(first)
        }
        first.state = "closed"
        timeline.accept(first)
        var second = CentralCall(id: "two", state: "live", lines: first.lines)
        second.lines.append(.init(callID: "two", turn: 0, role: "user", text: "同一句", interrupted: false))
        timeline.accept(second)
        XCTAssertEqual(timeline.callLines("one").count, 650, "the live window and item limit must not erase a call's beginning")
        XCTAssertEqual(timeline.callLines("two").count, 1)
        XCTAssertEqual(Set(timeline.items.map(\.id)).count, timeline.items.count)
        XCTAssertEqual(timeline.callLines("one").first?.turn, 0)
    }

    func testConversationRetiresWholeCallRecordsAtTheExistingHistoryLimit() {
        var timeline = YimiConversationTimeline()
        timeline.accept(CentralCall(id: "old", state: "closed", lines: [
            .init(callID: "old", turn: 0, role: "user", text: "旧通话", interrupted: false)]))
        for index in 0..<600 {
            timeline.upsert(YimiItem(id: "typed-\(index)", kind: .me, text: "文字", date: Date()))
        }
        XCTAssertEqual(timeline.items.count, 600)
        XCTAssertTrue(timeline.callLines("old").isEmpty)
        XCTAssertFalse(timeline.items.contains { $0.id == "call-old" })
    }

    func testConversationRecordsPTTAndBothAmbientRoutesInOrder() throws {
        var timeline = YimiConversationTimeline()
        let candidate = CentralVoiceCandidate(candidateRef: "candidate", candidateRevision: "1", windowRef: "window",
            selectedInputSHA256: "input", transcript: "按住说的话", transcriptSHA256: "text")
        let id = timeline.accept(candidate)
        XCTAssertEqual(timeline.accept(candidate), id)
        XCTAssertEqual(timeline.items.count, 1)
        timeline.upsert(YimiItem(id: "her-ambient-d", kind: .her, text: "先到的回复", date: Date()))
        let reply = try CentralAmbientReply(central(["operation": "ambient_reply", "processed_event_id": "ambient-d",
            "heard": "随身模式听到的话", "text": "随身模式回复"]).fields)
        timeline.accept(reply)
        timeline.accept(reply)
        XCTAssertEqual(timeline.items.map(\.text), ["按住说的话", "随身模式听到的话", "随身模式回复"])
        XCTAssertEqual(timeline.items[1].kind, .me)
        XCTAssertEqual(timeline.items[1].via, "ambient")
        XCTAssertEqual(timeline.chatItems.map(\.recordKind), [.message, .ambient, .ambient])
        timeline.accept(CentralCall(id: "ambient-call", state: "live", mode: "ambient", lines: [
            .init(callID: "ambient-call", turn: 0, role: "user", text: "随身语音", interrupted: false),
            .init(callID: "ambient-call", turn: 0, role: "main_agent", text: "随身回答", interrupted: false)]))
        XCTAssertEqual(timeline.callLines("ambient-call").map(\.kind), [.me, .her])
        XCTAssertEqual(timeline.callLines("ambient-call").first?.via, "ambient")
        timeline.accept(CentralAmbientReply(id: "care:fall:checkin", heard: "", text: "你还好吗？"))
        let restored = YimiConversationTimeline(items: try JSONDecoder().decode([YimiItem].self, from: JSONEncoder().encode(timeline.items)))
        XCTAssertEqual(restored.chatItems.map(\.text), ["按住说的话", "随身模式听到的话", "随身模式回复", "随身语音", "随身回答", "你还好吗？"])
        XCTAssertTrue(restored.chatItems.dropFirst().allSatisfy { $0.recordKind == .ambient })
    }

    func testConversationGroupsSavedCallsAndReplaysLiveLinesOnce() throws {
        let date = Date(timeIntervalSince1970: 100)
        let saved = YimiItem(id: "call-one", kind: .call, text: "", lines: [
            .init(role: "assistant", text: "回答", turn: 0), .init(role: "user", text: "问题", turn: 0)], date: date)
        var timeline = YimiConversationTimeline(items: [saved])
        let flat = try JSONDecoder().decode([YimiItem].self, from: JSONEncoder().encode(timeline.items))
        timeline = YimiConversationTimeline(items: flat)
        timeline.accept(CentralCall(id: "one", state: "live", lines: [
            .init(callID: "one", turn: 0, role: "user", text: "问题", interrupted: false),
            .init(callID: "one", turn: 0, role: "assistant", text: "回答", interrupted: false)]))
        XCTAssertEqual(timeline.items.count, 3)
        XCTAssertTrue(timeline.items.allSatisfy { $0.lines.isEmpty })
        XCTAssertEqual(timeline.callLines("one").map(\.text), ["问题", "回答"])
        XCTAssertEqual(timeline.callLines("one").map(\.date), [date, date])
        XCTAssertEqual(timeline.chatItems.map(\.id), ["call-one"])
    }

    func testConversationClassifiesHistorySavedBeforeSourceMarkers() throws {
        let date = Date(timeIntervalSince1970: 100)
        let saved = [
            YimiItem(id: "call-ambient-old", kind: .call, text: "", lines: [.init(role: "user", text: "旧随身语音")], date: date),
            YimiItem(id: "call-one", kind: .call, text: "", date: date, endedAt: date.addingTimeInterval(60)),
            YimiItem(id: "call-one/0-user", kind: .me, text: "已展开的通话", date: date, via: "call", callID: "one", turn: 0, role: "user"),
            YimiItem(id: "me-ambient-wake", kind: .me, text: "旧唤醒", date: date, via: "ambient"),
            YimiItem(id: "her-wake", kind: .her, text: "旧回复", date: date),
            YimiItem(id: "her-care:fall:alert", kind: .her, text: "旧关怀", date: date),
            YimiItem(id: "her-typed", kind: .her, text: "文字回复", date: date)]
        let data = try JSONEncoder().encode(saved)
        let migrated = YimiConversationTimeline(items: try JSONDecoder().decode([YimiItem].self, from: data))
        let reloaded = YimiConversationTimeline(items: try JSONDecoder().decode([YimiItem].self, from: JSONEncoder().encode(migrated.items)))
        XCTAssertEqual(reloaded.chatItems.map(\.text), ["旧随身语音", "", "旧唤醒", "旧回复", "旧关怀", "文字回复"])
        XCTAssertEqual(reloaded.chatItems.map(\.recordKind), [.ambient, .call, .ambient, .ambient, .ambient, .message])
        XCTAssertEqual(reloaded.chatItems[1].endedAt?.timeIntervalSince(date), 60)
        XCTAssertEqual(reloaded.callLines("one").map(\.text), ["已展开的通话"])
    }
}

extension AssistantCentralTextTests {
    private static func nextSession(_ binding: CentralTransportBinding) -> CentralTransportBinding {
        CentralTransportBinding(sessionID: "next-session", deviceID: binding.deviceID, connectionEpoch: "2",
            expectedGatewayIdentity: binding.expectedGatewayIdentity, maxPacketBytes: 12_288, callRejoinWindowS: 120)
    }

    /// Every start is a new source session. A typed request still waiting in the old one ends there: not admitted is
    /// unknown (the row offers the text resend), admitted is delivered and its unsent display ACK is dropped. Neither
    /// holds the next request. Only a reconnect into the same session keeps and resends the original packet.
    func testResetIntoAnotherSessionEndsTheTypedWaitAndReleasesSubmission() throws {
        let fixture = try CentralTextTestFixture()
        let next = Self.nextSession(fixture.binding)
        let submit = try XCTUnwrap(fixture.values["input_submit"] as? [String: String])
        let event = try XCTUnwrap(submit["event_id"])

        var unadmitted = AssistantCentralTextConsumer()
        try unadmitted.reset(binding: fixture.binding, generation: 1)
        let original = try unadmitted.beginSubmit(eventID: event, capturedAt: XCTUnwrap(submit["captured_at"]), text: XCTUnwrap(submit["text"]))
        var inPlace = unadmitted
        try unadmitted.reset(binding: nil, generation: 2)
        try unadmitted.reset(binding: next, generation: 3)
        XCTAssertEqual(unadmitted.submissionDelivery(eventID: event), .unconfirmed)
        XCTAssertTrue(try unadmitted.canBeginSubmit)
        XCTAssertNil(unadmitted.submission)
        XCTAssertThrowsError(try unadmitted.retryTypedSubmission())
        _ = try unadmitted.beginSubmit(eventID: "typed-next", capturedAt: "2026-10-17T00:00:00.000Z", text: "重发这段文字")
        XCTAssertEqual(unadmitted.submissionDelivery(eventID: "typed-next"), .pending)

        var streaming = try fixture.consumer()
        let chunks = try fixture.chunks()
        if chunks.count > 1 { try streaming.accept(chunks[0]) }
        XCTAssertTrue(try streaming.canBeginSubmit)
        try streaming.reset(binding: next, generation: 2)
        XCTAssertEqual(streaming.submissionDelivery(eventID: event), .accepted)
        XCTAssertTrue(try streaming.canBeginSubmit)
        XCTAssertFalse(try streaming.needsTypedRecovery)
        XCTAssertNil(streaming.presentation)

        var shown = try fixture.consumer()
        for chunk in chunks { try shown.accept(chunk) }
        let ack = try XCTUnwrap((fixture.values["input_ack"] as? [String: Any])?["ack"] as? [String: Any])
        _ = try shown.consumedByUI(XCTUnwrap(shown.presentation), observedAt: XCTUnwrap(ack["observed_at"] as? String))
        XCTAssertFalse(shown.pendingRenderedACKs.isEmpty)
        try shown.reset(binding: next, generation: 2)
        XCTAssertTrue(shown.pendingRenderedACKs.isEmpty, "an old-session ACK can no longer be sent")
        XCTAssertEqual(shown.submissionDelivery(eventID: event), .accepted)
        XCTAssertTrue(try shown.canBeginSubmit)

        try inPlace.reset(binding: nil, generation: 2)
        try inPlace.reset(binding: fixture.binding, generation: 3)
        XCTAssertEqual(inPlace.submissionDelivery(eventID: event), .pending)
        XCTAssertTrue(try inPlace.canBeginSubmit)
        XCTAssertTrue(try inPlace.needsTypedRecovery)
        XCTAssertEqual(try inPlace.retryTypedSubmission(), original, "the same session resends the original packet")
    }

    /// An identical resend (a saved 千问 reply) that an earlier session already admitted is refused with
    /// D_SESSION_CONFLICT: it was delivered, so it settles instead of being resent again.
    func testResendAdmittedByAnEarlierSessionSettlesAsDelivered() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: fixture.binding, generation: 1)
        _ = try consumer.beginSubmit(eventID: "qwen-reply", capturedAt: "2026-10-17T00:00:00.000Z", text: "千问的回复")
        let rejection: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "rejected",
            "session_id": fixture.binding.sessionID, "request_operation": "submit", "event_id": "qwen-reply",
            "control_id": NSNull(), "processed_event_id": NSNull(), "error_code": "D_SESSION_CONFLICT"]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: rejection)))
        XCTAssertEqual(consumer.submissionDelivery(eventID: "qwen-reply"), .accepted)
        XCTAssertTrue(try consumer.canBeginSubmit)
    }

    /// The one place the iPhone maps Core's submissionDelivery to rows: a typed row still sending for an event Core
    /// no longer tracks (its session ended) becomes unconfirmed and offers the text resend, like the Mac.
    func testOrphanedTypedSendBecomesUnconfirmedAndOffersTheTextResend() throws {
        let date = Date(timeIntervalSince1970: 100)
        var timeline = YimiConversationTimeline(items: [
            YimiItem(id: "me-orphan", kind: .me, text: "帮我订明天的票", date: date, delivery: .sending),
            YimiItem(id: "me-voice-one", kind: .me, text: "语音", date: date, delivery: .sending, via: "ptt"),
            YimiItem(id: "me-live", kind: .me, text: "现在这句", date: date, delivery: .sending)])
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTextTestFixture().binding, generation: 1)
        _ = try consumer.beginSubmit(eventID: "live", capturedAt: "2026-10-17T00:00:00.000Z", text: "现在这句")
        timeline.settleTypedSends(consumer)
        let rows = Dictionary(uniqueKeysWithValues: timeline.items.map { ($0.id, $0) })
        XCTAssertEqual(rows["me-orphan"]?.delivery, .unconfirmed)
        XCTAssertEqual(rows["me-orphan"]?.offersTextResend, true)
        XCTAssertEqual(rows["me-voice-one"]?.delivery, .sending, "a spoken row follows its voice turn")
        XCTAssertEqual(rows["me-live"]?.delivery, .sending)
        XCTAssertEqual(rows["me-live"]?.offersTextResend, false)
        XCTAssertNil(YimiItem.Delivery.row(.accepted))
        XCTAssertEqual(YimiItem.Delivery.row(.rejected), .failed)
    }
}


extension AssistantCentralTextTests {
    func testConcurrentSubmitPreservesForegroundAndTracksServerQueue() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        let originalEvent = try XCTUnwrap(consumer.eventID)
        let chunks = try fixture.chunks()
        try consumer.accept(XCTUnwrap(chunks.first))
        let originalPresentation = consumer.presentation
        let bytes = try consumer.beginSubmit(eventID: "queued-next", capturedAt: "2026-10-17T00:00:00.000Z", text: "下一句")
        XCTAssertEqual((try JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["operation"] as? String, "submit")
        XCTAssertEqual(consumer.eventID, originalEvent)
        XCTAssertEqual(consumer.presentation, originalPresentation)
        XCTAssertEqual(consumer.submissionDelivery(eventID: "queued-next"), .pending)
        var wire = try XCTUnwrap(fixture.values["accepted"] as? [String: Any])
        wire["event_id"] = "queued-next"
        wire["processed_event_id"] = "d-queued-next"
        wire["admission"] = ["state": "pending", "idempotency_key": "queue-next", "run_id": NSNull()]
        func packet() throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire))
        }
        try consumer.accept(packet())
        XCTAssertEqual(consumer.submissionDelivery(eventID: "queued-next"), .queued)
        XCTAssertEqual(consumer.presentation, originalPresentation)
        let recovery = try consumer.typedRecoveryRequests().map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        XCTAssertEqual(recovery.count, 2)
        XCTAssertTrue(recovery.allSatisfy { $0["operation"] as? String == "result" }, "Accepted queued turns only reattach; they never resend submit")
        XCTAssertTrue(recovery.contains { $0["processed_event_id"] as? String == "d-queued-next" })
        try consumer.reset(binding: nil, generation: 2)
        try consumer.reset(binding: fixture.binding, generation: 3)
        XCTAssertEqual(consumer.submissionDelivery(eventID: "queued-next"), .queued)
        for chunk in chunks.dropFirst() { try consumer.accept(chunk) }
        let displayed = try XCTUnwrap(consumer.presentation)
        XCTAssertTrue(displayed.isFinal)
        let ack = try consumer.consumedByUI(displayed, observedAt: "2026-10-17T00:00:01.000Z")
        XCTAssertNotNil(ack)
        XCTAssertTrue(try consumer.needsTypedRecovery, "A completed foreground cannot end queued recovery")
        let queuedRecovery = try consumer.typedRecoveryRequests().map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        XCTAssertEqual(queuedRecovery.count, 1)
        XCTAssertEqual(queuedRecovery.first?["processed_event_id"] as? String, "d-queued-next")
        XCTAssertEqual(consumer.submissionDelivery(eventID: originalEvent), .accepted)
        wire["admission"] = ["state": "accepted", "idempotency_key": "queue-next", "run_id": "run-next", "run_order": 2]
        try consumer.accept(packet())
        XCTAssertEqual(consumer.submissionDelivery(eventID: "queued-next"), .accepted)
        XCTAssertFalse(consumer.pendingRenderedACKs.isEmpty)
    }

    func testQueuedExpiryAndRefusalSettleDelivery() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        _ = try consumer.beginSubmit(eventID: "expired-next", capturedAt: "2026-10-17T00:00:00.000Z", text: "下一句")
        var wire = try XCTUnwrap(fixture.values["accepted"] as? [String: Any])
        wire["event_id"] = "expired-next"; wire["processed_event_id"] = "d-expired-next"
        wire["admission"] = ["state": "pending", "idempotency_key": "expiry-next", "run_id": NSNull()]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)))
        XCTAssertEqual(consumer.submissionDelivery(eventID: "expired-next"), .queued)
        wire["admission"] = ["state": "expired", "idempotency_key": "expiry-next", "run_id": NSNull()]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: wire)))
        XCTAssertEqual(consumer.submissionDelivery(eventID: "expired-next"), .rejected)
        _ = try consumer.beginSubmit(eventID: "refused-next", capturedAt: "2026-10-17T00:00:01.000Z", text: "再下一句")
        let refusal: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "rejected", "session_id": fixture.binding.sessionID,
            "event_id": "refused-next", "request_operation": "submit", "error_code": "ADMISSION_CAPACITY_EXCEEDED",
            "control_id": NSNull(), "processed_event_id": NSNull()]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: refusal)))
        XCTAssertEqual(consumer.submissionDelivery(eventID: "refused-next"), .rejected)
    }
    func testPendingRepliesPromoteByServerRunOrderRatherThanEventID() throws {
        let fixture = try CentralTextTestFixture()
        var consumer = try fixture.consumer()
        let originalEvent = consumer.eventID
        let chunks = try fixture.chunks()
        try consumer.accept(XCTUnwrap(chunks.first))
        func accepted(_ event: String, _ order: Int) throws -> CentralTextPacket {
            var value = try XCTUnwrap(fixture.values["accepted"] as? [String: Any])
            value["event_id"] = event; value["processed_event_id"] = "d-" + event
            value["admission"] = ["state": "accepted", "run_id": "run-" + event, "idempotency_key": event, "run_order": order]
            return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value))
        }
        for (event, order) in [("z-second", 2), ("a-third", 3)] {
            _ = try consumer.beginSubmit(eventID: event, capturedAt: "2026-10-17T00:00:00.000Z", text: event)
            try consumer.accept(accepted(event, order))
            var header = try XCTUnwrap(fixture.values["result_header"] as? [String: Any])
            header["event_id"] = event; header["processed_event_id"] = "d-" + event; header["run_id"] = "run-" + event
            header["text_replay"] = "pending"
            try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: header)))
        }
        for chunk in chunks.dropFirst() { try consumer.accept(chunk) }
        XCTAssertFalse(try consumer.canStartForegroundSubmission)
        _ = try consumer.beginSubmit(eventID: "fourth-fresh", capturedAt: "2026-10-17T00:00:01.000Z", text: "第四句")
        XCTAssertEqual(consumer.eventID, originalEvent, "A fresh submission cannot overtake older pending replies")
        XCTAssertEqual(consumer.submissionDelivery(eventID: "fourth-fresh"), .pending)
        let displayed = try XCTUnwrap(consumer.presentation)
        _ = try consumer.consumedByUI(displayed, observedAt: "2026-10-17T00:00:01.000Z")
        try consumer.accept(accepted("a-third", 3))
        XCTAssertEqual(consumer.eventID, "z-second")
    }

}
