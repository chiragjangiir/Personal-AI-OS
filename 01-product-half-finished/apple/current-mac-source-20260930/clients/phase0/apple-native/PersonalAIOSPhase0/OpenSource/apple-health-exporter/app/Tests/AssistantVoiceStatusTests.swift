import AVFAudio
import Foundation
import XCTest
@testable import HealthKitExporter

final class AssistantVoiceStatusTests: XCTestCase {
    func testPhoneUsesCaptureReplyPlaybackAndHangupProducers() {
        var call = CentralCall(), media = AssistantMediaSnapshot()
        func phase() -> AssistantVoiceStatus.Phase { AssistantVoiceStatus(call: call, media: media).phase }
        media.wakeArmed = true; media.wake = .waitingForAudio
        XCTAssertEqual(phase(), .inactive)
        media.wake = .localReady
        XCTAssertEqual(phase(), .standby)
        XCTAssertEqual(AssistantVoiceStatus(call: call, media: media).detail, "仅本机检测唤醒词 · 随身关")
        media.wake = .unavailable
        XCTAssertEqual(phase(), .wakeUnavailable)
        media.wake = .inCall
        call = CentralCall(id: "phone-call", state: "opening")
        XCTAssertEqual(phase(), .connecting)
        call.state = "live"; media.callMicrophone = .opening
        XCTAssertNotEqual(phase(), .listening)
        media.callMicrophone = .on; media.microphone = .on
        XCTAssertEqual(phase(), .listening)
        call.media = CentralCall.Media(provider: "artc", app_id: "test-app", channel_id: "avatar", user_id: "phone",
                                      token: "fixture", token_expire_at: "1800003600", audio_input: "gateway")
        XCTAssertEqual(call.state, "connecting")
        XCTAssertEqual(phase(), .listening, "Avatar first frame cannot hide actual voice media")
        call.media = nil
        media.callMicrophone = .unknown
        XCTAssertNotEqual(phase(), .listening)
        XCTAssertTrue(AssistantVoiceStatus(call: call, media: media).detail.contains("你仍可能被听到"))
        media.callMicrophone = .on
        call.foregroundReplyInFlight = true
        XCTAssertEqual(phase(), .thinking)
        call.backgroundWorkCount = 2
        XCTAssertEqual(phase(), .thinking)
        call.foregroundReplyInFlight = false
        XCTAssertEqual(phase(), .handedOff)
        media.callAudioPlaying = true
        XCTAssertEqual(phase(), .speaking)
        media.callAudioPlaying = false
        XCTAssertEqual(phase(), .handedOff)
        call.state = "closed"; media.callMicrophone = .closing
        XCTAssertEqual(phase(), .ending)
        media.callMicrophone = .off; media.microphone = .off; media.wake = .localReady
        XCTAssertEqual(phase(), .endedWithWork)
        XCTAssertEqual(AssistantVoiceStatus(call: call, media: media).title, "通话已结束 · 还有 2 件在办")
        XCTAssertEqual(AssistantVoiceStatus(call: call, media: media).standby, "唤醒词待命 · 仅本机")
        call.backgroundWorkCount = 0
        XCTAssertEqual(phase(), .ended)
        XCTAssertFalse(call.isActive)
    }

    func testTurnSnapshotIsSessionBoundAndDoesNotAttachAnOldReplyToANewCall() throws {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "phone-session", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, callRejoinWindowS: 120))
        _ = try consumer.openCall()
        let old = try XCTUnwrap(consumer.call.id)
        func snapshot(session: String = "phone-session", call: String, count: Int) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
                "schema_version": AssistantCentralTextWire.schema, "operation": "turns_state", "session_id": session,
                "foreground_replies": [["call_id": call, "turn": 1]], "background_work_count": count
            ]))
        }
        try consumer.accept(snapshot(call: old, count: 1))
        XCTAssertEqual(consumer.call.foregroundReplyInFlight, true)
        consumer.finishCall(old)
        _ = try consumer.openCall()
        try consumer.accept(snapshot(call: old, count: 2))
        XCTAssertEqual(consumer.call.foregroundReplyInFlight, false)
        XCTAssertEqual(consumer.call.backgroundWorkCount, 2)
        XCTAssertNotEqual(consumer.call.id, old)
        XCTAssertThrowsError(try consumer.accept(snapshot(session: "other", call: old, count: 99)))
        XCTAssertEqual(consumer.call.backgroundWorkCount, 2)
    }

    func testPlaybackAppearsOnlyForRenderedAudioAndStopsWithoutMoreFrames() async throws {
        let started = expectation(description: "actual PCM")
        let stopped = expectation(description: "renderer stopped delivering")
        let observer = AssistantCallPlaybackObserver { playing in
            if playing { started.fulfill() } else { stopped.fulfill() }
        }
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        buffer.frameLength = 160
        for index in 0..<160 { buffer.int16ChannelData![0][index] = 1000 }
        observer.render(pcmBuffer: buffer)
        await fulfillment(of: [started, stopped], timeout: 1)
        observer.stop()
    }
}
