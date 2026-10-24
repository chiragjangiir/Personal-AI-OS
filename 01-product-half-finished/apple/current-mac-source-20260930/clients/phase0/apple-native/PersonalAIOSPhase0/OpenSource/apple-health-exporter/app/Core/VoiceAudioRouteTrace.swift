import AVFAudio
import Foundation
import LiveKit
import os

/// Observes the SDK-owned graph. Never configures the session, selects a route or restarts the engine.
final class VoiceAudioRouteTrace: AudioEngineObserver, @unchecked Sendable {
    var next: (any AudioEngineObserver)?
    private static let logger = Logger(subsystem: "ai.paios.personal.phase0", category: "voice")
    private let center: NotificationCenter
    private let snapshot: @Sendable () -> String
    private let write: @Sendable (String) -> Void
    private var routeToken: NSObjectProtocol?
    private var engineToken: NSObjectProtocol?

    static var routeNotification: Notification.Name {
        #if os(iOS)
        AVAudioSession.routeChangeNotification
        #else
        Notification.Name("AVAudioSessionRouteChangeNotification")
        #endif
    }

    init(center: NotificationCenter = .default,
         snapshot: @escaping @Sendable () -> String = { sessionSnapshot() },
         write: @escaping @Sendable (String) -> Void = { logger.notice("\($0, privacy: .public)") }) {
        self.center = center; self.snapshot = snapshot; self.write = write
        routeToken = center.addObserver(forName: Self.routeNotification, object: nil, queue: nil) { [weak self] note in
            var details = ""
            #if os(iOS)
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            details = "reason=\(reason) previous_in=\(previous?.inputs.map { $0.portType.rawValue } ?? []) previous_out=\(previous?.outputs.map { $0.portType.rawValue } ?? [])"
            #endif
            self?.record("route_change", details: details)
        }
        record("installed") // Also captures earphones already connected before the call starts.
    }

    deinit {
        if let routeToken { center.removeObserver(routeToken) }
        if let engineToken { center.removeObserver(engineToken) }
    }

    func record(_ event: String, details: String = "") {
        write("voice_route event=\(event) \(details) \(snapshot())")
    }

    func engineDidCreate(_ engine: AVAudioEngine) -> Int {
        engineToken = center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self, weak engine] _ in
            guard let engine else { return }
            self?.record("engine_config_change", details: "engine=\(ObjectIdentifier(engine)) running=\(engine.isRunning)")
        }
        let result = next?.engineDidCreate(engine) ?? 0
        record("engine_create", details: "engine=\(ObjectIdentifier(engine)) result=\(result)")
        return result
    }

    func engineWillConnectOutput(_ engine: AVAudioEngine, src: AVAudioNode, dst: AVAudioNode?, format: AVAudioFormat, context: [AnyHashable: Any]) -> Int {
        let result = next?.engineWillConnectOutput(engine, src: src, dst: dst, format: format, context: context) ?? 0
        record("engine_connect_output", details: "engine=\(ObjectIdentifier(engine)) rate=\(format.sampleRate) channels=\(format.channelCount) result=\(result)")
        return result
    }

    func engineWillStart(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        let result = next?.engineWillStart(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
        record("engine_will_start", details: "engine=\(ObjectIdentifier(engine)) playout=\(isPlayoutEnabled) recording=\(isRecordingEnabled) result=\(result)")
        return result
    }

    func engineDidStop(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        record("engine_stop", details: "engine=\(ObjectIdentifier(engine)) playout=\(isPlayoutEnabled) recording=\(isRecordingEnabled)")
        return next?.engineDidStop(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
    }

    func engineWillRelease(_ engine: AVAudioEngine) -> Int {
        if let engineToken { center.removeObserver(engineToken); self.engineToken = nil }
        let result = next?.engineWillRelease(engine) ?? 0
        record("engine_release", details: "engine=\(ObjectIdentifier(engine)) result=\(result)")
        return result
    }

    private static func sessionSnapshot() -> String {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        let route = s.currentRoute
        return "in=\(route.inputs.map { $0.portType.rawValue }) out=\(route.outputs.map { $0.portType.rawValue }) category=\(s.category.rawValue) mode=\(s.mode.rawValue) options=\(s.categoryOptions.rawValue) hfp=\(s.categoryOptions.contains(.allowBluetooth)) a2dp=\(s.categoryOptions.contains(.allowBluetoothA2DP)) defaultSpeaker=\(s.categoryOptions.contains(.defaultToSpeaker)) rate=\(s.sampleRate) io=\(s.ioBufferDuration) volume=\(s.outputVolume)"
        #else
        return "platform=host"
        #endif
    }
}
