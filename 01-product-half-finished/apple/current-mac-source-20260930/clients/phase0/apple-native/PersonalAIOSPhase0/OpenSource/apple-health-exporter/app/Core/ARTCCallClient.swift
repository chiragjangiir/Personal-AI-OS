import Foundation

enum ARTCCallEvent: Sendable { case firstFrame, failed }

@MainActor
protocol ARTCCallClient: AnyObject, Sendable {
    func join(_ media: CentralCall.Media, camera: Bool, events: @escaping @Sendable (ARTCCallEvent) -> Void) throws
    func setMedia(_ source: AssistantMediaSource, enabled: Bool) throws
    /// Flips the published camera; returns whether the back camera is live now.
    func switchCamera() throws -> Bool
    func flushPlayback()
    nonisolated func setInputMonitoring(_ enabled: Bool)
    nonisolated func setInputMuted(_ muted: Bool)
    func leave() async throws
}

extension ARTCCallClient {
    nonisolated func setInputMonitoring(_ enabled: Bool) {}
    nonisolated func setInputMuted(_ muted: Bool) {}
}

#if os(iOS) || (os(macOS) && canImport(AliRTCSdk))
#if os(iOS)
import AliVCSDK_ARTC
import UIKit
private typealias ARTCNativeView = UIView
#else
import AliRTCSdk
import AppKit
private typealias ARTCNativeView = NSView
#endif
import AVFAudio
import LiveKit
import os

@MainActor
final class AliyunARTCCallClient: NSObject, ARTCCallClient, AliRtcEngineDelegate {
    private let preview: AssistantVideoPreviewModel
    private nonisolated let probe = ARTCCallProbe()
    private var engine: AliRtcEngine?
    private var events: (@Sendable (ARTCCallEvent) -> Void)?
    private var remote: ARTCNativeView?
    private var teardown: Task<Void, Error>?
    private let routeTrace: VoiceAudioRouteTrace
    #if os(iOS)
    private nonisolated let inputHealth: VoiceCallInputHealth
    #endif
    private lazy var pcm = ARTCPlaybackObserver(probe: probe, trace: routeTrace)

    init(preview: AssistantVideoPreviewModel) {
        self.preview = preview
        let trace = VoiceAudioRouteTrace()
        self.routeTrace = trace
        #if os(iOS)
        self.inputHealth = VoiceCallInputHealth(trace: trace)
        #endif
        super.init()
        // Installed before the room starts. This node survives video/voice switches with the same VPIO engine.
        let manager = AudioManager.shared
#if os(iOS)
        manager.set(engineObservers: [inputHealth, manager.audioSession, manager.mixer, routeTrace, pcm])
        manager.add(localAudioRenderer: inputHealth)
#else
        manager.set(engineObservers: [manager.mixer, routeTrace, pcm])
#endif
    }

    /// Component calls keep LiveKit capture, playback and AEC. ARTC only decodes the synchronized avatar.
    func join(_ media: CentralCall.Media, camera: Bool, events: @escaping @Sendable (ARTCCallEvent) -> Void) throws {
        guard !Task.isCancelled else { throw CancellationError() }
        self.events = events
        probe.begin()
        guard media.audio_input == "gateway", !camera else { throw CentralTextError.unavailable }
        let extras = "{\"user_specified_use_external_audio_player\":\"TRUE\",\"user_specified_use_external_audio_record\":\"TRUE\"}"
        let rtc = AliRtcEngine.sharedInstance(self, extras: extras)
        engine = rtc
        rtc.setLogLevel(.none); rtc.enableUploadLog(false); rtc.enableStatsReport(false)
#if os(iOS)
        try check(rtc.setAudioSessionOperationRestriction([.configureSession, .activateSession, .deactivateSession]))
#endif
        _ = rtc.enableAudioVolumeIndication(500, smooth: 3, reportVad: 0)
        let remote = ARTCNativeView()
        self.remote = remote
        preview.setARTC(remote: remote, local: nil)
        try check(rtc.enableLocalVideo(false))
        try check(rtc.publishLocalVideoStream(false))
        try check(rtc.publishLocalAudioStream(false))
        try check(rtc.registerAudioFrameObserver(pcm))
        // nil config is documented 48 kHz, mono, read-only playback PCM.
        try check(rtc.enableAudioFrameObserver(true, audioSource: .playback, config: nil))
        pcm.setEnabled(true)
        // Native single-token join: the Base64 credential owns channel/user identity; user_id is also the display name.
        try check(rtc.joinChannel(media.token, channelId: nil, userId: media.user_id, name: media.user_id,
                                  onResultWithUserId: { [weak self, probe] code, _, _, elapsed in
            probe.stage("joined", "\"code\":\(code),\"elapsed\":\(elapsed)")
            if code != 0 { self?.events?(.failed) }
        }))
    }

    // The supported component's microphone and camera belong to LiveKit.
    func setMedia(_ source: AssistantMediaSource, enabled: Bool) throws { throw CentralTextError.unavailable }
    func switchCamera() throws -> Bool { throw CentralTextError.unavailable }

    func flushPlayback() { pcm.flush() }

    nonisolated func setInputMonitoring(_ enabled: Bool) {
        #if os(iOS)
        inputHealth.setEnabled(enabled)
        #endif
    }

    nonisolated func setInputMuted(_ muted: Bool) {
        #if os(iOS)
        inputHealth.setMuted(muted)
        #endif
    }

    func leave() async throws {
        if let teardown { try await teardown.value; return }
        events = nil
        let destroy = engine != nil
        pcm.setEnabled(false)
        if let engine {
            _ = engine.enableAudioFrameObserver(false, audioSource: .playback, config: nil)
            _ = engine.registerAudioFrameObserver(nil)
            _ = engine.leaveChannel()
            self.engine = nil
            probe.stage("left")
        }
        let work = Task<Void, Error> {
            if destroy { await Task.detached { AliRtcEngine.destroy() }.value }
            self.remote = nil; self.preview.setARTC(remote: nil, local: nil)
        }
        teardown = work
        defer { teardown = nil }
        try await work.value
    }

    func onRemoteTrackAvailableNotify(_ uid: String, audioTrack: AliRtcAudioTrack, videoTrack: AliRtcVideoTrack) {
        probe.stage("avatar_tracks", "\"audio\":\(audioTrack.rawValue),\"video\":\(videoTrack.rawValue)")
        guard let engine, let remote, videoTrack != .no else { return }
        let canvas = AliVideoCanvas(); canvas.view = remote; canvas.renderMode = .crop
        let track: AliRtcVideoTrack = videoTrack == .screen ? .screen : .camera
        if engine.setRemoteViewConfig(canvas, uid: uid, for: track) != 0 { events?(.failed) }
    }

    func onFirstRemoteVideoFrameDrawn(_ uid: String, videoTrack: AliRtcVideoTrack, width: Int32, height: Int32, elapsed: Int32) {
        probe.stage("avatar_first_frame")
        if videoTrack == .camera || videoTrack == .screen { events?(.firstFrame) }
    }
    func onOccurError(_ error: Int32, message: String) {
        probe.stage("error", "\"code\":\(error)")
        // The SDK reports 推流无效 on every subscribe-only join. Errors on paths this client never uses leave the avatar up.
        if !Self.unusedPathErrors.contains(error) { events?(.failed) }
    }
    /// AliRtcErrorCode values (AliRtcEngine.h) for publishing and local capture: a component call does neither
    /// through ARTC (nothing is published, LiveKit owns the microphone and camera).
    private static let unusedPathErrors: Set<Int32> = [
        0x01030305, 0x01010406, 0x01010450, 0x01010451, 0x01010452, 0x01010453, 0x01010454, // AliRtcErrPublish*
        0x01040404, 0x01040406, 0x01040408, 0x01040409, // AliRtcErrMic*
        0x01040104, 0x01040106, // AliRtcErrCamera*
    ]
    func onConnectionLost() { probe.stage("connection_lost"); events?(.failed) }
    func onAuthInfoExpired() { probe.stage("auth_expired"); events?(.failed) }

    // Evidence only (no call-diagnostics channel reaches the gateway): SDK threads, so nonisolated and lock-guarded.
    nonisolated func onLocalDeviceException(_ deviceType: AliRtcLocalDeviceType, exceptionType: AliRtcLocalDeviceExceptionType, message msg: String?) {
        probe.stage("device_exception", "\"device\":\(deviceType.rawValue),\"type\":\(exceptionType.rawValue)")
    }
    nonisolated func onRemoteUser(onLineNotify uid: String, elapsed: Int32) {
        probe.stage("avatar_online", "\"elapsed\":\(elapsed)")
    }
    nonisolated func onConnectionStatusChange(_ status: AliRtcConnectionStatus, reason: AliRtcConnectionStatusChangeReason) {
        probe.stage("connection", "\"status\":\(status.rawValue),\"reason\":\(reason.rawValue)")
    }
    nonisolated func onAudioVolumeCallback(_ array: [AliRtcUserVolumeInfo]?, totalVolume: Int32) {
        // uid "0" is the local microphone, "1" the mixed remote (avatar) audio.
        let volumes = array ?? []
        probe.levels(mic: volumes.first { $0.uid == "0" }?.volume, avatar: volumes.first { $0.uid == "1" }?.volume)
    }

    private func check(_ result: Int32) throws {
        if result != 0 { throw CentralTextError.unavailable }
    }
}

/// The avatar PCM enters LiveKit's device output graph, so VPIO sees the same echo reference as voice calls.
/// Installed once; the source node survives video/voice switches with the same VPIO engine. ARTC's playout thread only
/// converts into `ring`, the render block only pulls from it, and flush/disable/leave are O(1) ring operations: no path
/// waits on another thread or calls AVFoundation, so the main actor and ARTC never stall behind the audio graph.
private final class ARTCPlaybackObserver: NSObject, AliRtcAudioFrameDelegate, AudioEngineObserver, @unchecked Sendable {
    var next: (any AudioEngineObserver)?
    // ARTC delivers 10 ms (480-sample) frames at 48 kHz; the render quantum is 10-20 ms. Play once 60 ms is buffered (or
    // the first sample waited 60 ms): two quanta plus frame jitter, the old player's priming, which measured a steady
    // 50-150 ms. Past 200 ms (above that steady state) drop the oldest down to 100 ms, so after any hiccup her voice
    // is again within about 100 ms of her lips. A drain refilled within 200 ms is counted as an underrun.
    private let ring = PCMRing(cap: 9_600, target: 4_800, prime: 2_880, refill: 9_600)
    private let node: AVAudioSourceNode
    private let probe: ARTCCallProbe
    private weak var trace: VoiceAudioRouteTrace?
    // Evidence only, off every audio thread. `baseline` and `outputRate` belong to `reports`; `timer` to the main actor.
    private let reports = DispatchQueue(label: "ai.paios.artc.playback.report", qos: .utility)
    private var baseline = PCMRing.Stats(), outputRate = 0.0
    private var timer: DispatchSourceTimer?

    init(probe: ARTCCallProbe, trace: VoiceAudioRouteTrace) {
        self.probe = probe
        self.trace = trace
        node = ring.makeSourceNode(sampleRate: 48_000)
    }

    @MainActor func setEnabled(_ value: Bool) {
        trace?.record("artc_playback", details: "enabled=\(value)")
        timer?.cancel(); timer = nil
        if value {
            ring.flush()
            reports.async { [self] in baseline = ring.stats() }
            ring.setOpen(true)
            let timer = DispatchSource.makeTimerSource(queue: reports)
            timer.schedule(deadline: .now() + 10, repeating: 10)
            timer.setEventHandler { [weak self] in self?.emit("periodic") }
            timer.resume(); self.timer = timer
        } else {
            ring.setOpen(false); ring.flush(); report("disabled")
        }
    }
    func flush() { ring.flush(); report("flush") }
    private func report(_ reason: String) { reports.async { [self] in emit(reason) } }
    private func emit(_ reason: String) {
        let s = ring.stats().since(baseline)
        // pushed_samples includes input later overflowed or discarded; dropped_samples counts refused input only.
        probe.stage("playback", "\"reason\":\"\(reason)\",\"sample_rate\":48000,\"output_rate\":\(outputRate),\"buffered_samples\":\(s.buffered),\"buffered_ms\":\(Double(s.buffered) / 48),\"pushed_samples\":\(s.pushed),\"played_samples\":\(s.played),\"dropped_samples\":\(s.refused),\"overflow_samples\":\(s.overflowed),\"discarded_samples\":\(s.discarded),\"flushes\":\(s.flushes),\"drains\":\(s.drains),\"underruns\":\(s.underruns)")
    }

    func engineDidCreate(_ engine: AVAudioEngine) -> Int {
        engine.attach(node)
        trace?.record("artc_node_attach", details: "engine=\(ObjectIdentifier(engine))")
        return next?.engineDidCreate(engine) ?? 0
    }
    func engineWillConnectOutput(_ engine: AVAudioEngine, src: AVAudioNode, dst: AVAudioNode?, format: AVAudioFormat, context: [AnyHashable: Any]) -> Int {
        engine.connect(node, to: engine.mainMixerNode, format: node.outputFormat(forBus: 0))
        trace?.record("artc_node_connect", details: "engine=\(ObjectIdentifier(engine)) render_rate=48000 node_rate=\(node.outputFormat(forBus: 0).sampleRate) node_channels=\(node.outputFormat(forBus: 0).channelCount) output_rate=\(format.sampleRate)")
        let rate = engine.outputNode.outputFormat(forBus: 0).sampleRate // Once per graph, on LiveKit's configuration thread.
        reports.async { [self] in outputRate = rate }
        return next?.engineWillConnectOutput(engine, src: src, dst: dst, format: format, context: context) ?? 0
    }
    func engineWillRelease(_ engine: AVAudioEngine) -> Int {
        ring.flush(); report("engine_release")
        engine.detach(node)
        trace?.record("artc_node_detach", details: "engine=\(ObjectIdentifier(engine))")
        return next?.engineWillRelease(engine) ?? 0
    }

    /// ARTC playout thread: convert and copy only. Frames that are not 48 kHz mono 16-bit are refused and counted.
    func onPlaybackAudioFrame(_ frame: AliRtcAudioFrame) -> Bool {
        let count = Int(frame.numOfSamples)
        guard frame.bytesPerSample == 2, frame.numOfChannels == 1, frame.samplesPerSec == 48_000,
              count > 0, count <= 48_000, let data = frame.dataPtr else { ring.refuse(max(0, count)); return false }
        ring.push(UnsafeBufferPointer(start: data.assumingMemoryBound(to: Int16.self), count: count))
        return true
    }
}

/// One compact unified-log line per video-call media stage (`log stream --predicate 'category == "artc_call"'`):
/// `{"artc_call_stage":…,"ms":<since join>,…}`. Microphone/avatar levels (0–255) are summarised every 10 s, plus the
/// first non-zero microphone level, so a call that captures silence is visible. Never tokens, ids or audio.
final class ARTCCallProbe: @unchecked Sendable {
    private static let logger = Logger(subsystem: "ai.paios.personal.phase0", category: "artc_call")
    private let lock = NSLock()
    private var start: UInt64 = 0, window: UInt64 = 0, micMax: Int32 = 0, avatarMax: Int32 = 0, micHeard = false

    func begin() {
        lock.withLock { start = DispatchTime.now().uptimeNanoseconds; window = start; micMax = 0; avatarMax = 0; micHeard = false }
    }

    func stage(_ name: String, _ fields: String = "") {
        let ms = lock.withLock { (DispatchTime.now().uptimeNanoseconds &- start) / 1_000_000 }
        write(name, ms, fields)
    }

    func levels(mic: Int32?, avatar: Int32?) {
        var lines: [(String, UInt64, String)] = []
        lock.withLock {
            let now = DispatchTime.now().uptimeNanoseconds, ms = (now &- start) / 1_000_000
            if let mic {
                micMax = max(micMax, mic)
                if mic > 0, !micHeard { micHeard = true; lines.append(("mic_level_first", ms, "\"volume\":\(mic)")) }
            }
            if let avatar { avatarMax = max(avatarMax, avatar) }
            if now &- window >= 10_000_000_000 {
                lines.append(("levels", ms, "\"mic_max\":\(micMax),\"avatar_max\":\(avatarMax)"))
                window = now; micMax = 0; avatarMax = 0
            }
        }
        for line in lines { write(line.0, line.1, line.2) }
    }

    private func write(_ name: String, _ ms: UInt64, _ fields: String) {
        let line = "{\"artc_call_stage\":\"\(name)\",\"ms\":\(ms)\(fields.isEmpty ? "" : ",")\(fields)}"
        Self.logger.notice("\(line, privacy: .public)")
    }
}
#endif
