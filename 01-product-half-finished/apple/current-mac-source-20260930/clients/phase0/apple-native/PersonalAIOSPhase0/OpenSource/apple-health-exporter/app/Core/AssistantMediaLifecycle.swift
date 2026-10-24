import AVFoundation
import Foundation
#if canImport(UIKit)
import UIKit
import CallKit
#endif

enum AssistantMediaLifecycleSignal: Equatable, Sendable {
    case appDidEnterBackground
    case appBecameActive
    case incomingCall
    case audioRouteChanged
    case audioInterruptionBegan
    case audioInterruptionEnded(shouldResume: Bool)
    case networkPath(AssistantNetworkPathState)
}

enum AssistantMediaLifecycleState: Equatable, Sendable {
    case idle
    case running
    case stopping(reasonCode: String)
    case stopped(reasonCode: String)
}

actor AssistantMediaLifecycle {
    typealias StopHandler = @Sendable (String) async -> Void

    private var state: AssistantMediaLifecycleState = .idle
    private var stopHandler: StopHandler?
    /// Says whether the session keeps running despite this reason (随身模式 keeps it across app_background).
    private var retainer: (@Sendable (String) async -> Bool)?
    private var stopIssued = false

    func setStopHandler(_ handler: StopHandler?) {
        stopHandler = handler
    }

    func setRetainer(_ retainer: (@Sendable (String) async -> Bool)?) {
        self.retainer = retainer
    }

    func markRunning() {
        guard !stopIssued else {
            return
        }
        state = .running
    }

    func snapshot() -> AssistantMediaLifecycleState {
        state
    }

    func handle(_ signal: AssistantMediaLifecycleSignal) async {
        switch signal {
        case .appDidEnterBackground:
            await stop(reasonCode: "app_background")
        case .audioInterruptionBegan:
            await stop(reasonCode: "audio_interruption")
        case .networkPath(let path)
            where path.status != .satisfied:
            await stop(reasonCode: "network_unavailable")
        case .incomingCall, .audioRouteChanged, .appBecameActive, .audioInterruptionEnded(_), .networkPath(_):
            // Foreground/interruption recovery never silently resumes media.
            return
        }
    }

    func stop(reasonCode: String) async {
        guard !stopIssued else {
            return
        }
        // A retained session was not stopped: a later reason (interruption, network) can still stop it.
        if let retainer, await retainer(reasonCode) { return }
        guard !stopIssued else { return }
        stopIssued = true
        state = .stopping(reasonCode: reasonCode)
        await stopHandler?(reasonCode)
        state = .stopped(reasonCode: reasonCode)
    }

    func resetForNextSession() {
        stopIssued = false
        state = .idle
    }
}
#if canImport(UIKit)
private final class AssistantIncomingCallObserver: NSObject, CXCallObserverDelegate, @unchecked Sendable {
    private let observer = CXCallObserver()
    private let incoming: @Sendable () async -> Void
    init(incoming: @escaping @Sendable () async -> Void) {
        self.incoming = incoming; super.init(); observer.setDelegate(self, queue: .main)
    }
    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        if !call.isOutgoing, !call.hasEnded { Task { await incoming() } }
    }
}
@MainActor
final class AssistantMediaLifecycleObserver {
    private let lifecycle: AssistantMediaLifecycle
    private let incomingCalls: AssistantIncomingCallObserver
    private var tokens: [NSObjectProtocol] = []
    private let notificationCenter: NotificationCenter

    init(lifecycle: AssistantMediaLifecycle,
         notificationCenter: NotificationCenter = .default,
         onAudioInterruption: @escaping @Sendable (AssistantMediaLifecycleSignal) async -> Void) {
        self.lifecycle = lifecycle
        incomingCalls = AssistantIncomingCallObserver { await onAudioInterruption(.incomingCall) }
        self.notificationCenter = notificationCenter
        tokens.append(notificationCenter.addObserver(forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(), queue: nil) { notification in
                guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                      let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                      [.newDeviceAvailable, .oldDeviceUnavailable].contains(reason) else { return }
                Task { await onAudioInterruption(.audioRouteChanged) }
            })
        tokens.append(
            notificationCenter.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: AVAudioSession.sharedInstance(),
                queue: nil
            ) { [weak lifecycle] notification in
                guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
                let options = AVAudioSession.InterruptionOptions(rawValue:
                    notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                let signal: AssistantMediaLifecycleSignal = type == .began
                    ? .audioInterruptionBegan
                    : .audioInterruptionEnded(shouldResume: options.contains(.shouldResume))
                Task {
                    await onAudioInterruption(signal)
                    await lifecycle?.handle(signal)
                }
            }
        )
        tokens.append(
            notificationCenter.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: nil
            ) { [weak lifecycle] _ in
                Task {
                    await lifecycle?.handle(.appDidEnterBackground)
                }
            }
        )
        tokens.append(
            notificationCenter.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: nil
            ) { [weak lifecycle] _ in
                Task {
                    await lifecycle?.handle(.appBecameActive)
                }
            }
        )
    }

    deinit {
        tokens.forEach { notificationCenter.removeObserver($0) }
    }
}
#endif
