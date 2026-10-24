import Foundation

public enum WakeListeningPhase: Equatable, Sendable {
    case off, loading, waitingForAudio, localReady, opening, inCall, unavailable
}
public enum WakeCallPhase: Sendable { case closed, opening, active }

protocol WakeDetecting: AnyObject {
    func accept(samples: [Float], sampleRate: Int) -> Bool
    func reset()
}
extension WakeWordDetector: WakeDetecting {}

/// Owns local-listening lifecycle and the only pending PCM buffer. The capture
/// owner calls submit; it never creates a recorder or uploads pre-wake audio.
public final class WakeListeningController: @unchecked Sendable {
    private let lock = NSLock()
    private let worker = DispatchQueue(label: "ai.yimi.wake", qos: .utility)
    private let onWake: @Sendable (UInt64) -> Void
    private let onState: @Sendable (WakeListeningPhase, String?) -> Void
    private var enabled = false
    private var call: WakeCallPhase = .closed
    private var loaded = false
    private var observedAudio = false
    private var error: String?
    private var epoch: UInt64 = 0
    private var pending: [Float] = []
    private var rate = 0
    private var inFlightSeconds: Double = 0
    private var draining = false
    private var wakePending = false
    private var detectorEpoch: UInt64 = .max
    private var detector: WakeDetecting?
    private let now: @Sendable () -> TimeInterval
    private let captureTimeout: TimeInterval
    private var lastAudioAt: TimeInterval?
    private var captureStalled = false
    private var captureTimer: DispatchSourceTimer?

    public var generation: UInt64 { locked { epoch } }
    public var phase: WakeListeningPhase { locked { currentPhase } }
    public var failure: String? { locked { currentFailure } }
    public func isCurrentWake(_ generation: UInt64) -> Bool {
        locked { epoch == generation && currentPhase == .localReady }
    }

    public convenience init(onWake: @escaping @Sendable (UInt64) -> Void,
                            onState: @escaping @Sendable (WakeListeningPhase, String?) -> Void) {
        self.init(factory: { try WakeWordDetector() }, onWake: onWake, onState: onState)
    }

    init(factory: @escaping () throws -> WakeDetecting,
         onWake: @escaping @Sendable (UInt64) -> Void,
         onState: @escaping @Sendable (WakeListeningPhase, String?) -> Void,
         captureTimeout: TimeInterval = 2,
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.onWake = onWake
        self.onState = onState
        self.captureTimeout = captureTimeout
        self.now = now
        worker.async { [weak self] in
            guard let self else { return }
            do {
                self.detector = try factory()
                self.locked { self.loaded = true }
            } catch { self.locked { self.error = error.localizedDescription } }
            self.notify()
        }
    }

    deinit { captureTimer?.cancel() }

    public func setEnabled(_ enabled: Bool) {
        locked {
            guard self.enabled != enabled else { return }
            self.enabled = enabled
            invalidate(resetAudio: true)
            updateCaptureTimer()
        }
        notify()
    }

    public func setCallPhase(_ phase: WakeCallPhase) {
        locked {
            guard call != phase else { return }
            call = phase
            invalidate(resetAudio: true)
            updateCaptureTimer()
        }
        notify()
    }

    /// A capture owner may decline a candidate while a press/enrollment owns the microphone.
    public func discardWake(_ generation: UInt64) {
        locked {
            guard epoch == generation, wakePending else { return }
            invalidate()
        }
        notify()
    }

    /// Call before the capture owner stops or restarts the SDK input.
    public func captureInterrupted() {
        locked { invalidate(resetAudio: true) }
        notify()
    }

    public func submit(samples: [Float], sampleRate: Int) {
        guard !samples.isEmpty else { return }
        var becameReady = false
        let schedule = locked { () -> Bool in
            guard enabled, call == .closed, loaded, error == nil, !wakePending,
                  (8000...192000).contains(sampleRate), samples.count <= sampleRate else { return false }
            if rate != sampleRate { invalidate(resetAudio: true); rate = sampleRate }
            becameReady = !observedAudio
            observedAudio = true
            captureStalled = false
            lastAudioAt = now()
            // A gap resets native history. Overflow drops this frame and all
            // pending audio; it never silently joins noncontiguous speech.
            guard Double(pending.count + samples.count) / Double(sampleRate) + inFlightSeconds <= 1 else {
                invalidate()
                return false
            }
            pending.append(contentsOf: samples)
            guard !draining else { return false }
            draining = true
            return true
        }
        if becameReady { notify() }
        if schedule { worker.async { [weak self] in self?.drain() } }
    }

    private var currentPhase: WakeListeningPhase {
        if !enabled { return .off }
        if call == .opening { return .opening }
        if call == .active { return .inCall }
        if error != nil { return .unavailable }
        if captureStalled { return .unavailable }
        if !loaded { return .loading }
        return observedAudio ? .localReady : .waitingForAudio
    }

    // Must hold lock. Invalidates callbacks and buffered audio synchronously.
    private func invalidate(resetAudio: Bool = false) {
        if resetAudio { observedAudio = false; lastAudioAt = nil; captureStalled = false }
        epoch &+= 1
        wakePending = false
        pending.removeAll(keepingCapacity: false)
    }

    private var currentFailure: String? { error ?? (captureStalled ? "wake_capture_stalled" : nil) }

    // One periodic monitor, separate from the detector queue so a blocked native
    // detection cannot retain readiness or deliver a wake from stale capture.
    private func updateCaptureTimer() {
        captureTimer?.cancel(); captureTimer = nil
        guard enabled, call == .closed else { return }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        let interval = min(0.5, captureTimeout / 2)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self] in self?.checkCaptureLiveness() }
        captureTimer = timer
        timer.resume()
    }

    func checkCaptureLiveness() {
        let expired = locked { () -> Bool in
            guard enabled, call == .closed, let lastAudioAt,
                  now() - lastAudioAt >= captureTimeout else { return false }
            invalidate(resetAudio: true)
            captureStalled = true
            return true
        }
        if expired { notify() }
    }

    private func drain() {
        while true {
            let batch = locked { () -> ([Float], Int, UInt64)? in
                guard currentPhase == .localReady, !pending.isEmpty else {
                    draining = false
                    return nil
                }
                let samples = pending
                pending = []
                inFlightSeconds = Double(samples.count) / Double(rate)
                return (samples, rate, epoch)
            }
            guard let (samples, sampleRate, generation) = batch, let detector else { return }
            if detectorEpoch != generation { detector.reset(); detectorEpoch = generation }
            let heard = detector.accept(samples: samples, sampleRate: sampleRate)
            let valid = locked { () -> Bool in
                inFlightSeconds = 0
                guard heard && epoch == generation && currentPhase == .localReady else { return false }
                wakePending = true
                pending.removeAll(keepingCapacity: false)
                return true
            }
            if valid {
                // Stop duplicate detections until host claims this generation.
                // The host validates generation immediately before opening.
                onWake(generation)
            }
        }
    }

    private func notify() {
        let state = locked { (currentPhase, currentFailure) }
        onState(state.0, state.1)
    }
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
