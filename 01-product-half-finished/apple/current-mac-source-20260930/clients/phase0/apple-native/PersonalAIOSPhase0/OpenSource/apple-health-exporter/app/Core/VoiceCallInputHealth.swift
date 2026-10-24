import AVFAudio
import Foundation
import LiveKit

/// Route-only extension of LiveKit's session owner. No category, activation or engine changes.
final class VoiceCallInputHealth: NSObject, AudioEngineObserver, AudioRenderer, @unchecked Sendable {
    struct Input: Equatable {
        let id: String
        let name: String
        var hfp = false
        var builtIn = false
    }
    static let notice = Notification.Name("VoiceCallInputHealth.notice")
    var next: (any AudioEngineObserver)?
    private let queue = DispatchQueue(label: "ai.paios.call.input-health")
    private let frameLock = NSLock()
    private var lastFrame: TimeInterval = 0
    private let snapshot: @Sendable () -> (current: Input?, available: [Input])
    private let select: @Sendable (Input?) throws -> Void
    private let notify: @Sendable (String) -> Void
    private let clock: @Sendable () -> TimeInterval
    private let automatic: Bool
    private var timer: DispatchSourceTimer?
    private var routeToken: NSObjectProtocol?
    private var enabled = false, muted = false
    private var engineRecording = false
    private var dead: Set<String> = []
    private var watched: String?, since: TimeInterval = 0
    private var preferred: Input?, pending: Input?, selectedAt: TimeInterval = 0

    init(snapshot: @escaping @Sendable () -> (current: Input?, available: [Input]),
         select: @escaping @Sendable (Input?) throws -> Void,
         notify: @escaping @Sendable (String) -> Void,
         clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         automatic: Bool = true) {
        self.snapshot = snapshot; self.select = select; self.notify = notify
        self.clock = clock; self.automatic = automatic
    }

    deinit {
        timer?.cancel()
        if let routeToken { NotificationCenter.default.removeObserver(routeToken) }
    }

    func setEnabled(_ value: Bool) {
        queue.async { [self] in
            guard value != enabled else { return }
            enabled = value
            timer?.cancel(); timer = nil
            watched = nil; pending = nil; dead.removeAll()
            frameLock.withLock { lastFrame = 0 }
            if value {
                muted = false
                if engineRecording { startTimer() }
            } else if preferred != nil {
                // Release only our own preference; do not overwrite a later Control Center choice.
                if snapshot().current?.id == preferred?.id {
                    do { try select(nil) } catch { notify("音频输入恢复失败，请在控制中心选择设备") }
                }
                preferred = nil
            }
        }
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        guard pcmBuffer.frameLength > 0 else { return }
        frameLock.withLock { lastFrame = clock() } // Silent PCM is healthy. No audio is retained.
    }

    func setMuted(_ value: Bool) {
        queue.async { [self] in
            muted = value; watched = nil
            if !value, pending != nil { selectedAt = clock() }
        }
    }

    // Installed before audioSession: activation may itself wait for a dead SCO link.
    func engineWillEnable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        queue.async { [self] in
            engineRecording = isRecordingEnabled
            if enabled, engineRecording { startTimer() }
        }
        return next?.engineWillEnable(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
    }

    func engineDidDisable(_ engine: AVAudioEngine, isPlayoutEnabled: Bool, isRecordingEnabled: Bool) -> Int {
        queue.async { [self] in
            engineRecording = isRecordingEnabled
            // SCO retries may disable the engine. Only mute or call end suspends the no-frame deadline.
        }
        return next?.engineDidDisable(engine, isPlayoutEnabled: isPlayoutEnabled, isRecordingEnabled: isRecordingEnabled) ?? 0
    }

    private func startTimer() {
        guard automatic, timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.evaluate() }
        timer.resume(); self.timer = timer
    }

    /// Drains observer events and polls with the injected monotonic clock (also used by deterministic tests).
    func check() { queue.sync { evaluate() } }

    private func evaluate() {
        guard enabled, !muted else { return }
        let route = snapshot(), now = clock(), frame = frameLock.withLock { lastFrame }
        if let current = route.current, let preferred, current.id != preferred.id, pending == nil || !dead.contains(current.id) {
            // A later system/user route wins, including a switch away and back to the phone.
            self.preferred = nil; pending = nil
        }
        if let pending, route.current?.id == pending.id, frame > selectedAt {
            notify(pending.builtIn ? "蓝牙设备没有声音输入，已改用手机麦克风" : "蓝牙设备没有声音输入，已改用\(pending.name)")
            self.pending = nil
        }
        if let pending, now - selectedAt >= 3 {
            dead.insert(pending.id); self.pending = nil
            if pending.builtIn { notify("麦克风仍无声音输入，请重新拨打") }
            else { fallback(available: route.available, now: now) }
            return
        }
        guard let current = route.current else { return } // SCO retries can briefly remove the input.
        guard current.hfp else { watched = nil; return }
        if watched != current.id { watched = current.id; since = now }
        guard now - max(since, frame) >= 3, !dead.contains(current.id) else { return }
        dead.insert(current.id) // One attempt per dead port for this entire call, including reconnects.
        fallback(available: route.available, now: now)
    }

    private func fallback(available: [Input], now: TimeInterval) {
        let targets = available.filter { $0.hfp && !dead.contains($0.id) }
            + available.filter { $0.builtIn && !dead.contains($0.id) }.prefix(1)
        for target in targets {
            do {
                try select(target)
                preferred = target; pending = target; selectedAt = now
                return
            } catch { dead.insert(target.id) }
        }
        notify("蓝牙设备没有声音输入，切换失败，请在控制中心选择设备")
    }
}

#if os(iOS)
extension VoiceCallInputHealth {
    convenience init(trace: VoiceAudioRouteTrace) {
        self.init(snapshot: {
            let session = AVAudioSession.sharedInstance()
            func input(_ port: AVAudioSessionPortDescription) -> Input {
                Input(id: port.uid, name: port.portName, hfp: port.portType == .bluetoothHFP, builtIn: port.portType == .builtInMic)
            }
            return (session.currentRoute.inputs.first.map(input), (session.availableInputs ?? []).map(input))
        }, select: { target in
            let session = AVAudioSession.sharedInstance()
            if let target {
                guard let port = session.availableInputs?.first(where: { $0.uid == target.id }) else { throw CentralTextError.unavailable }
                try session.setPreferredInput(port)
            } else { try session.setPreferredInput(nil) }
            trace.record("input_fallback", details: "target=\(target?.builtIn == true ? "builtIn" : target == nil ? "automatic" : "hfp")")
        }, notify: { text in
            trace.record("input_health", details: text)
            NotificationCenter.default.post(name: Self.notice, object: text)
        })
        routeToken = NotificationCenter.default.addObserver(forName: VoiceAudioRouteTrace.routeNotification, object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { [weak self] in self?.evaluate() }
        }
    }
}
#endif
