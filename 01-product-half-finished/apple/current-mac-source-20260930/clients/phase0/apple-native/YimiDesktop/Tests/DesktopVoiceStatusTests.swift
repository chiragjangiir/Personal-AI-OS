import Foundation
import XCTest

final class DesktopVoiceStatusTests: XCTestCase {
    @MainActor
    func testMenuUsesAuthoritativeWakeCallAndPlaybackTransitions() async throws {
        let model = try DesktopAppModel(desktop: FakeDesktopControl(),
            storeURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        var revision: UInt64 = 0
        func accept(_ call: CentralCall, _ media: AssistantMediaSnapshot,
                    phase: AssistantVoiceStatus.Phase) async {
            revision += 1
            var snapshot = AssistantSessionSnapshot(state: .idle, revision: revision,
                isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false)
            snapshot.media = media
            snapshot.voiceStatus = AssistantVoiceStatus(call: call, media: media)
            await model.accept(snapshot)
            XCTAssertEqual(model.voiceStatus.phase, phase)
        }
        var call = CentralCall(), media = AssistantMediaSnapshot()
        media.wakeArmed = true; media.wake = .waitingForAudio
        await accept(call, media, phase: .inactive)
        XCTAssertNotEqual(model.voiceStatusTitle, "等你唤醒 · 仅本机")
        media.wake = .localReady
        await accept(call, media, phase: .standby)
        XCTAssertEqual(model.voiceStatusTitle, "等你唤醒 · 仅本机")
        call.id = "mac-call"; call.state = "opening"
        await accept(call, media, phase: .connecting)
        call.state = "live"; media.callMicrophone = .on; media.microphone = .on
        await accept(call, media, phase: .listening)
        call.foregroundReplyInFlight = true
        await accept(call, media, phase: .thinking)
        call.foregroundReplyInFlight = false; call.backgroundWorkCount = 2
        await accept(call, media, phase: .handedOff)
        XCTAssertEqual(model.voiceStatus.backgroundCount, 2)
        media.callAudioPlaying = true
        await accept(call, media, phase: .speaking)
        media.callAudioPlaying = false
        await accept(call, media, phase: .handedOff)
        call.state = "closed"; media.callMicrophone = .closing
        await accept(call, media, phase: .ending)
        media.callMicrophone = .off; media.microphone = .off
        await accept(call, media, phase: .endedWithWork)
        XCTAssertEqual(model.voiceStatusTitle, "通话已结束 · 还有 2 件在办")
        call.backgroundWorkCount = 0
        await accept(call, media, phase: .ended)
        XCTAssertFalse(model.listening)
        XCTAssertNil(model.callEngine, "A work count update must never create another call")
        XCTAssertEqual(model.callSnapshot?.media.callMicrophone, .off)
        XCTAssertFalse(model.callSnapshot?.media.callAudioPlaying == true)
    }
}
