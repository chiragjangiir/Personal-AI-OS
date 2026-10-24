import XCTest
#if canImport(UIKit)
import AVFAudio
#endif
@testable import HealthKitExporter

final class AssistantMediaLifecycleTests: XCTestCase {
#if canImport(UIKit)
    @MainActor
    func testInterruptionNotificationsForwardSystemResumeOptions() async {
        let center = NotificationCenter()
        let received = expectation(description: "interruption events forwarded")
        received.expectedFulfillmentCount = 3
        let probe = InterruptionProbe()
        let observer = AssistantMediaLifecycleObserver(lifecycle: AssistantMediaLifecycle(), notificationCenter: center) { signal in
            await probe.record(signal)
            received.fulfill()
        }
        let session = AVAudioSession.sharedInstance()
        center.post(name: AVAudioSession.interruptionNotification, object: session,
                    userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
        center.post(name: AVAudioSession.interruptionNotification, object: session,
                    userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
        center.post(name: AVAudioSession.interruptionNotification, object: session,
                    userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                               AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        await fulfillment(of: [received], timeout: 2)
        let signals = await probe.signals
        XCTAssertEqual(signals.count, 3)
        XCTAssertTrue(signals.contains(.audioInterruptionBegan))
        XCTAssertTrue(signals.contains(.audioInterruptionEnded(shouldResume: false)))
        XCTAssertTrue(signals.contains(.audioInterruptionEnded(shouldResume: true)))
        withExtendedLifetime(observer) {}
    }
#endif

    func testBackgroundStopsOnceAndDoesNotAutoResume() async {
        let lifecycle = AssistantMediaLifecycle()
        let probe = StopProbe()
        await lifecycle.setStopHandler { reason in
            await probe.record(reason)
        }
        await lifecycle.markRunning()
        await lifecycle.handle(.appDidEnterBackground)
        await lifecycle.handle(.appBecameActive)
        await lifecycle.handle(.appDidEnterBackground)

        let reasons = await probe.reasons
        let snapshot = await lifecycle.snapshot()
        XCTAssertEqual(reasons, ["app_background"])
        XCTAssertEqual(
            snapshot,
            .stopped(reasonCode: "app_background")
        )
    }

    func testNetworkLossStopsMedia() async {
        let lifecycle = AssistantMediaLifecycle()
        await lifecycle.handle(
            .networkPath(
                AssistantNetworkPathState(
                    status: .unsatisfied,
                    isExpensive: false,
                    isConstrained: false,
                    usesWiFi: false,
                    usesCellular: false
                )
            )
        )
        let snapshot = await lifecycle.snapshot()
        XCTAssertEqual(
            snapshot,
            .stopped(reasonCode: "network_unavailable")
        )
    }

    func testAudioInterruptionStopsSecondSessionAfterReset() async {
        let lifecycle = AssistantMediaLifecycle()
        let probe = StopProbe()
        await lifecycle.setStopHandler { reason in
            await probe.record(reason)
        }

        await lifecycle.markRunning()
        await lifecycle.stop(reasonCode: "first_session")
        await lifecycle.resetForNextSession()
        await lifecycle.markRunning()
        await lifecycle.handle(.audioInterruptionBegan)
        await lifecycle.handle(
            .audioInterruptionEnded(shouldResume: true)
        )

        let reasons = await probe.reasons
        let snapshot = await lifecycle.snapshot()
        XCTAssertEqual(reasons, ["first_session", "audio_interruption"])
        XCTAssertEqual(
            snapshot,
            .stopped(reasonCode: "audio_interruption")
        )
    }

    func testNetworkStopAlsoWorksOnSecondSession() async {
        let lifecycle = AssistantMediaLifecycle()
        let probe = StopProbe()
        await lifecycle.setStopHandler { reason in
            await probe.record(reason)
        }

        await lifecycle.markRunning()
        await lifecycle.handle(
            .networkPath(
                AssistantNetworkPathState(
                    status: .unsatisfied,
                    isExpensive: false,
                    isConstrained: false,
                    usesWiFi: false,
                    usesCellular: false
                )
            )
        )
        await lifecycle.resetForNextSession()
        await lifecycle.markRunning()
        await lifecycle.handle(
            .networkPath(
                AssistantNetworkPathState(
                    status: .requiresConnection,
                    isExpensive: false,
                    isConstrained: false,
                    usesWiFi: false,
                    usesCellular: false
                )
            )
        )

        let reasons = await probe.reasons
        XCTAssertEqual(
            reasons,
            ["network_unavailable", "network_unavailable"]
        )
    }

    /// 随身模式 retains the session across app_background only; a later interruption still stops it.
    func testARetainedBackgroundDoesNotStopAndALaterReasonStill() async {
        let lifecycle = AssistantMediaLifecycle()
        let probe = StopProbe()
        await lifecycle.setStopHandler { reason in await probe.record(reason) }
        await lifecycle.setRetainer { reason in reason == "app_background" }
        await lifecycle.markRunning()
        await lifecycle.handle(.appDidEnterBackground)
        let kept = await probe.reasons
        XCTAssertEqual(kept, [])
        let state = await lifecycle.snapshot()
        XCTAssertEqual(state, .running)
        await lifecycle.handle(.audioInterruptionBegan)
        let stopped = await probe.reasons
        XCTAssertEqual(stopped, ["audio_interruption"])
    }
}

private actor StopProbe {
    private(set) var reasons: [String] = []

    func record(_ reason: String) {
        reasons.append(reason)
    }
}

#if canImport(UIKit)
private actor InterruptionProbe {
    private(set) var signals: [AssistantMediaLifecycleSignal] = []
    func record(_ signal: AssistantMediaLifecycleSignal) { signals.append(signal) }
}
#endif
