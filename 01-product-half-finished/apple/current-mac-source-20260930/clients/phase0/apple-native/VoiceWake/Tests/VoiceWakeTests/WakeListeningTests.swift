import XCTest
@testable import VoiceWake

final class WakeListeningTests: XCTestCase {
    func testNativeModelLoadsAcceptsSilenceAndChangesRate() throws {
        let detector = try WakeWordDetector()
        XCTAssertFalse(detector.accept(samples: Array(repeating: 0, count: 16000), sampleRate: 16000))
        detector.reset()
        XCTAssertFalse(detector.accept(samples: Array(repeating: 0, count: 4800), sampleRate: 48000))
    }

    func testLifecycleAndRearm() {
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let detector = FakeDetector()
        let controller = WakeListeningController(factory: { detector }, onWake: { _ in }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        })
        XCTAssertEqual(controller.phase, .off)
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        XCTAssertEqual(controller.phase, .localReady)
        let old = controller.generation
        controller.setCallPhase(.opening)
        XCTAssertEqual(controller.phase, .opening)
        XCTAssertFalse(controller.isCurrentWake(old))
        controller.setCallPhase(.active)
        XCTAssertEqual(controller.phase, .inCall)
        controller.setCallPhase(.closed)
        XCTAssertEqual(controller.phase, .waitingForAudio)
        controller.submit(samples: [0], sampleRate: 16000)
        XCTAssertEqual(controller.phase, .localReady)
        controller.setEnabled(false)
        XCTAssertEqual(controller.phase, .off)
    }

    func testWakeCanBeClaimedThenRearmsAfterHangup() {
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let first = expectation(description: "first wake")
        let second = expectation(description: "wake after hangup")
        let counter = WakeCounter()
        let controller = WakeListeningController(factory: { FakeDetector { true } }, onWake: { _ in
            if counter.next() == 1 { first.fulfill() } else { second.fulfill() }
        }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [first], timeout: 2)
        let claimed = controller.generation
        XCTAssertTrue(controller.isCurrentWake(claimed))
        controller.setCallPhase(.opening)
        XCTAssertFalse(controller.isCurrentWake(claimed))
        controller.setCallPhase(.active)
        controller.setCallPhase(.closed)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [second], timeout: 2)
    }

    func testADeclinedWakeDoesNotLeaveStandbyLatched() {
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let first = expectation(description: "declined wake")
        let second = expectation(description: "next wake")
        let counter = WakeCounter()
        let controller = WakeListeningController(factory: { FakeDetector { true } }, onWake: { _ in
            if counter.next() == 1 { first.fulfill() } else { second.fulfill() }
        }, onState: { phase, _ in if phase == .waitingForAudio { loaded.fulfill() } })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [first], timeout: 2)
        controller.discardWake(controller.generation)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [second], timeout: 2)
    }

    func testReadinessRequiresFreshValidPCMAndResetsOnCaptureInterruption() {
        let loaded = expectation(description: "model loaded, awaiting capture")
        loaded.assertForOverFulfill = false
        let controller = WakeListeningController(factory: { FakeDetector() }, onWake: { _ in }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        XCTAssertEqual(controller.phase, .waitingForAudio)
        controller.submit(samples: [], sampleRate: 16000)
        controller.submit(samples: [0], sampleRate: 0)
        XCTAssertEqual(controller.phase, .waitingForAudio)
        controller.submit(samples: [0], sampleRate: 16000)
        XCTAssertEqual(controller.phase, .localReady)
        let old = controller.generation
        controller.captureInterrupted()
        XCTAssertEqual(controller.phase, .waitingForAudio)
        XCTAssertFalse(controller.isCurrentWake(old))
        controller.submit(samples: [0], sampleRate: 48000)
        XCTAssertEqual(controller.phase, .localReady)
    }

    func testUnavailableIsExplicit() {
        let unavailable = expectation(description: "unavailable")
        let controller = WakeListeningController(factory: { throw WakeWordError.creationFailed }, onWake: { _ in }, onState: { phase, _ in
            if phase == .unavailable { unavailable.fulfill() }
        })
        controller.setEnabled(true)
        wait(for: [unavailable], timeout: 2)
        XCTAssertEqual(controller.phase, .unavailable)
        XCTAssertNotNil(controller.failure)
    }

    func testCaptureExpiryInvalidatesNativeWakeAndRejectsInvalidPCM() {
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let entered = expectation(description: "native detection entered")
        let completed = expectation(description: "stale native detection finished")
        let staleWake = expectation(description: "stale wake rejected")
        staleWake.isInverted = true
        let gate = DispatchSemaphore(value: 0)
        let clock = CaptureClock()
        let controller = WakeListeningController(factory: { FakeDetector {
            entered.fulfill(); gate.wait(); completed.fulfill(); return true
        } }, onWake: { _ in staleWake.fulfill() }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        }, now: { clock.now })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [entered], timeout: 2)
        let old = controller.generation
        clock.advance(2)
        controller.checkCaptureLiveness()
        XCTAssertEqual(controller.phase, .unavailable)
        XCTAssertEqual(controller.failure, "wake_capture_stalled")
        XCTAssertFalse(controller.isCurrentWake(old))
        gate.signal()
        wait(for: [completed, staleWake], timeout: 0.15)
        controller.submit(samples: [], sampleRate: 16000)
        controller.submit(samples: [0], sampleRate: 0)
        XCTAssertEqual(controller.phase, .unavailable)
        // Disable before recovery to avoid invoking the gated fake again.
        controller.setEnabled(false)
        controller.setEnabled(true)
        XCTAssertEqual(controller.phase, .waitingForAudio)
    }

    func testCaptureTimerExpiresAndFreshPCMRecoversWithoutRearming() {
        let loaded = expectation(description: "loaded")
        let expired = expectation(description: "periodic timer detected missing PCM")
        let clock = CaptureClock()
        let controller = WakeListeningController(factory: { FakeDetector() }, onWake: { _ in }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
            if phase == .unavailable { expired.fulfill() }
        }, captureTimeout: 0.1, now: { clock.now })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        clock.advance(0.1)
        wait(for: [expired], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        XCTAssertEqual(controller.phase, .localReady)
        XCTAssertNil(controller.failure)
        controller.setCallPhase(.active)
        clock.advance(5)
        controller.checkCaptureLiveness()
        XCTAssertEqual(controller.phase, .inCall)
        controller.setEnabled(false)
        controller.checkCaptureLiveness()
        XCTAssertEqual(controller.phase, .off)
    }

    func testDisableRejectsDetectionAlreadyInFlight() {
        let entered = expectation(description: "entered native")
        let completed = expectation(description: "native completed")
        let gate = DispatchSemaphore(value: 0)
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let wake = expectation(description: "stale wake")
        wake.isInverted = true
        let detector = FakeDetector {
            entered.fulfill()
            gate.wait()
            completed.fulfill()
            return true
        }
        let controller = WakeListeningController(factory: { detector }, onWake: { _ in wake.fulfill() }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: [0], sampleRate: 16000)
        wait(for: [entered], timeout: 2)
        let old = controller.generation
        controller.setEnabled(false)
        gate.signal()
        wait(for: [completed, wake], timeout: 0.15)
        XCTAssertFalse(controller.isCurrentWake(old))
    }

    func testOverflowInvalidatesInFlightAndDropsPending() {
        let loaded = expectation(description: "loaded")
        loaded.assertForOverFulfill = false
        let entered = expectation(description: "entered native")
        let gate = DispatchSemaphore(value: 0)
        let completed = expectation(description: "completed")
        let wake = expectation(description: "overflow wake")
        wake.isInverted = true
        let detector = FakeDetector {
            entered.fulfill()
            gate.wait()
            completed.fulfill()
            return true
        }
        let controller = WakeListeningController(factory: { detector }, onWake: { _ in wake.fulfill() }, onState: { phase, _ in
            if phase == .waitingForAudio { loaded.fulfill() }
        })
        controller.setEnabled(true)
        wait(for: [loaded], timeout: 2)
        controller.submit(samples: Array(repeating: 0, count: 8000), sampleRate: 16000)
        wait(for: [entered], timeout: 2)
        let old = controller.generation
        controller.submit(samples: Array(repeating: 0, count: 9000), sampleRate: 16000)
        XCTAssertFalse(controller.isCurrentWake(old))
        gate.signal()
        wait(for: [completed, wake], timeout: 0.15)
        XCTAssertEqual(controller.phase, .localReady)
    }
}

private final class CaptureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 0
    var now: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: TimeInterval) { lock.lock(); defer { lock.unlock() }; value += seconds }
}

private final class FakeDetector: WakeDetecting {
    private let consume: () -> Bool
    init(consume: @escaping () -> Bool = { false }) { self.consume = consume }
    func accept(samples: [Float], sampleRate: Int) -> Bool { consume() }
    func reset() {}
}

private final class WakeCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}
