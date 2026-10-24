import AVFAudio
import LiveKit
import XCTest
@testable import HealthKitExporter

final class VoiceCallInputHealthTests: XCTestCase {
    func testDeadHFPFallsBackAfterThreeSecondsOnceAndConfirmsPCM() {
        let session = InputSession(), health = makeHealth(session)
        health.setEnabled(true); health.check()
        session.now = 2.99; health.check()
        XCTAssertTrue(session.selections.isEmpty)
        session.now = 3; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
        XCTAssertTrue(session.notices.isEmpty, "selection alone does not prove working input")
        session.now = 3.1; health.render(pcmBuffer: silence()); health.check()
        XCTAssertEqual(session.notices, ["蓝牙设备没有声音输入，已改用手机麦克风"])
        session.current = session.glasses
        session.now = 10; health.check(); session.now = 20; health.check()
        XCTAssertEqual(session.selections, [session.phone.id], "a dead port cannot start a route loop")
    }

    func testAnotherConnectedHFPIsPreferredAndItsFailureFallsBackToPhone() {
        let session = InputSession(), health = makeHealth(session)
        session.available = [session.glasses, session.pods, session.phone]
        health.setEnabled(true); health.check()
        session.now = 3; health.check()
        XCTAssertEqual(session.selections, [session.pods.id])
        session.now = 3.1; health.check()
        session.now = 6.1; health.check()
        XCTAssertEqual(session.selections, [session.pods.id, session.phone.id])
        session.now = 6.2; health.render(pcmBuffer: silence()); health.check()
        XCTAssertEqual(session.notices, ["蓝牙设备没有声音输入，已改用手机麦克风"])
    }

    func testHealthyHFPSilentPCMIsKeptAndLaterLossIsDetected() {
        let session = InputSession(), health = makeHealth(session)
        health.setEnabled(true); health.check()
        for second in 1...8 {
            session.now = Double(second)
            health.render(pcmBuffer: silence()); health.check()
        }
        XCTAssertTrue(session.selections.isEmpty)
        session.now = 10.99; health.check()
        XCTAssertTrue(session.selections.isEmpty)
        session.now = 11; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
    }

    func testAlternateSCOWithNoRouteStillExpiresAndFallsBackToPhone() {
        let session = InputSession(), health = makeHealth(session)
        session.available = [session.glasses, session.pods, session.phone]
        health.setEnabled(true); health.check(); session.now = 3; health.check()
        session.current = nil; session.now = 6; health.check()
        XCTAssertEqual(session.selections, [session.pods.id, session.phone.id])
    }

    func testSCORestartsCannotResetOriginalOrAlternateInputDeadline() {
        let session = InputSession(), health = makeHealth(session), engine = AVAudioEngine()
        session.available = [session.glasses, session.pods, session.phone]
        health.setEnabled(true); health.check()
        for second in 1...6 {
            session.now = Double(second)
            _ = health.engineDidDisable(engine, isPlayoutEnabled: true, isRecordingEnabled: false)
            _ = health.engineWillEnable(engine, isPlayoutEnabled: true, isRecordingEnabled: true)
            health.check()
        }
        XCTAssertEqual(session.selections, [session.pods.id, session.phone.id])
    }

    func testSCORetryWithMissingRouteDoesNotRestartTheBound() {
        let session = InputSession(), health = makeHealth(session)
        health.setEnabled(true); health.check()
        session.current = nil; session.now = 2; health.check()
        session.current = session.glasses; session.now = 3; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
    }

    func testMuteSuspendsDetectionWithoutForgettingDeadPortsAndEndDisarmsIt() {
        let session = InputSession(), health = makeHealth(session)
        health.setEnabled(true); health.check()
        health.setMuted(true); session.now = 10; health.check()
        XCTAssertTrue(session.selections.isEmpty)
        health.setMuted(false); health.check()
        session.now = 13; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
        health.setMuted(true); health.check(); health.setMuted(false)
        session.current = session.glasses; session.now = 14; health.check()
        session.now = 17; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
        health.setEnabled(false); health.check()
        session.now = 30; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
        health.setEnabled(true); health.check()
        session.now = 33; health.check()
        XCTAssertEqual(session.selections, [session.phone.id, session.phone.id], "new call clears dead ports")
    }

    func testUserSpeakerAirPodsSpeakerSelectionDoesNotTriggerFallback() {
        let session = InputSession(), health = makeHealth(session)
        session.current = session.phone
        health.setEnabled(true); health.check()
        session.now = 4; health.render(pcmBuffer: silence()); health.check()
        session.current = session.pods; health.check()
        session.now = 5; health.render(pcmBuffer: silence()); health.check()
        session.current = session.phone; session.now = 10; health.check()
        health.setEnabled(false); health.check()
        XCTAssertTrue(session.selections.isEmpty)
    }

    func testUnavailableAlternateHFPFallsThroughToPhoneWithoutRetryLoop() {
        let session = InputSession(), health = makeHealth(session)
        session.available = [session.glasses, session.pods, session.phone]
        session.failures = [session.pods.id]
        health.setEnabled(true); health.check()
        session.now = 3; health.check()
        XCTAssertEqual(session.selections, [session.pods.id, session.phone.id])
        session.now = 3.1; health.render(pcmBuffer: silence()); health.check()
        XCTAssertEqual(session.notices.count, 1)
        health.setEnabled(false); health.check()
        XCTAssertEqual(session.selections.last, "automatic")
    }

    func testManualRouteWinsWhileFallbackIsPendingAndAfterReturningToSpeaker() {
        let session = InputSession(), health = makeHealth(session)
        session.available = [session.glasses, session.pods, session.phone]
        health.setEnabled(true); health.check()
        session.now = 3; health.check() // Pending AirPods, before its first frame.
        session.current = session.phone; session.now = 3.1; health.check()
        session.now = 7; health.check()
        XCTAssertEqual(session.selections, [session.pods.id])
        health.setEnabled(false); health.check()
        XCTAssertEqual(session.selections, [session.pods.id], "hang-up cannot clear the later user choice")

        let second = InputSession(), next = makeHealth(second)
        next.setEnabled(true); next.check(); second.now = 3; next.check()
        second.now = 3.1; next.render(pcmBuffer: silence()); next.check()
        second.current = second.pods; second.now = 4; next.check()
        second.current = second.phone; second.now = 5; next.check()
        next.setEnabled(false); next.check()
        XCTAssertEqual(second.selections, [second.phone.id], "a switch away and back also relinquishes our preference")
    }

    func testBuiltinWithoutFramesSurfacesFailureWithoutRepeatingSelection() {
        let session = InputSession(), health = makeHealth(session)
        health.setEnabled(true); health.check(); session.now = 3; health.check()
        session.now = 6; health.check(); session.now = 9; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
        XCTAssertEqual(session.notices, ["麦克风仍无声音输入，请重新拨打"])
    }

    func testEngineHookPreservesDownstreamFailureAndCannotResetTheDeadline() {
        let session = InputSession(), health = makeHealth(session)
        health.next = FailedInputEngine()
        health.setEnabled(true); health.check()
        let engine = AVAudioEngine()
        session.now = 2
        XCTAssertEqual(health.engineWillEnable(engine, isPlayoutEnabled: true, isRecordingEnabled: true), -17)
        session.now = 3; health.check()
        XCTAssertEqual(session.selections, [session.phone.id])
    }

    private func makeHealth(_ session: InputSession) -> VoiceCallInputHealth {
        let health = VoiceCallInputHealth(snapshot: { (session.current, session.available) },
            select: { try session.select($0) }, notify: { session.notices.append($0) },
            clock: { session.now }, automatic: false)
        _ = health.engineWillEnable(AVAudioEngine(), isPlayoutEnabled: true, isRecordingEnabled: true)
        return health
    }

    private func silence() -> AVAudioPCMBuffer {
        let buffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!, frameCapacity: 160)!
        buffer.frameLength = 160
        buffer.floatChannelData![0].initialize(repeating: 0, count: 160)
        return buffer
    }
}

private final class InputSession: @unchecked Sendable {
    let glasses = VoiceCallInputHealth.Input(id: "glasses", name: "眼镜", hfp: true)
    let pods = VoiceCallInputHealth.Input(id: "pods", name: "AirPods", hfp: true)
    let phone = VoiceCallInputHealth.Input(id: "phone", name: "iPhone", builtIn: true)
    var current: VoiceCallInputHealth.Input?
    var available: [VoiceCallInputHealth.Input]
    var selections: [String] = [], notices: [String] = [], failures: Set<String> = []
    var now: TimeInterval = 0
    init() {
        current = glasses; available = [glasses, phone]
    }
    func select(_ input: VoiceCallInputHealth.Input?) throws {
        selections.append(input?.id ?? "automatic")
        if let input, failures.contains(input.id) { throw CentralTextError.unavailable }
        current = input
    }
}

private final class FailedInputEngine: AudioEngineObserver, @unchecked Sendable {
    var next: (any AudioEngineObserver)?
    func engineWillEnable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int { -17 }
}
