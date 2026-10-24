import Foundation

public struct WakePcmFrame: Sendable, Equatable {
    public let sequence: Int
    public let capturedAtMs: Double
    public let samples: [Int16]
    public var littleEndianData: Data {
        samples.withUnsafeBufferPointer { source in
            let words = source.map { $0.littleEndian }
            return words.withUnsafeBytes { Data($0) }
        }
    }
}

/// Capture-source owner: one second of local history, then five seconds total
/// pending plus in-flight audio. Nothing is readable for sending before a wake
/// and its matching server receipt. Only a successful send releases budget.
public final class WakePcmBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var token: UInt64?
    private var sealed = false
    private var ready = false
    private var notified = false
    private var failed = false
    private var ring: [WakePcmFrame] = []
    private var pending: [WakePcmFrame] = []
    private var inFlight: WakePcmFrame?
    private var nextSequence = 0
    private var onAvailable: @Sendable () -> Void = {}
    private var onFailure: @Sendable (String) -> Void = { _ in }

    public init() {}
    public var hasFailed: Bool { locked { failed } }
    public var isCapturingCall: Bool { locked { token != nil } }
    var retainedSampleCount: Int { locked { bufferedSamples } }
    public var hasReadyFrames: Bool { locked { ready && !failed && !pending.isEmpty } }
    public func setCallbacks(onAvailable: @escaping @Sendable () -> Void,
                             onFailure: @escaping @Sendable (String) -> Void) {
        locked { self.onAvailable = onAvailable; self.onFailure = onFailure }
    }
    public func setArmed(_ armed: Bool) {
        locked { self.armed = armed; if !armed { ring.removeAll() } }
    }
    /// Called on the detector worker before scheduling the host wake callback.
    public func begin(generation: UInt64) {
        locked {
            guard armed, token == nil else { return }
            token = generation; ready = false; failed = false; notified = false
            nextSequence = 0
            pending = ring.map { frame in
                defer { nextSequence += 1 }
                return WakePcmFrame(sequence: nextSequence, capturedAtMs: frame.capturedAtMs, samples: frame.samples)
            }
            ring.removeAll()
        }
    }
    public func discard(generation: UInt64) {
        locked { if token == generation { clear() } }
    }
    public func seal() { locked { if token != nil { sealed = true } } }
    public func end() { locked { clear() } }
    public func unlock() {
        let callback = locked { () -> (@Sendable () -> Void)? in
            guard token != nil, !failed else { return nil }
            ready = true
            return signal()
        }
        callback?()
    }
    public func fail(_ code: String) {
        let callback = locked { () -> (@Sendable (String) -> Void)? in
            guard token != nil, !failed else { return nil }
            failed = true
            return onFailure
        }
        callback?(code)
    }
    public func append(samples: [Int16], capturedAtMs: Double) {
        guard !samples.isEmpty else { return }
        var callback: (@Sendable () -> Void)?
        var failure: (@Sendable (String) -> Void)?
        locked {
            guard (armed || token != nil), !failed, !sealed else { return }
            if token != nil && bufferedSamples + samples.count > 80_000 {
                failed = true; failure = onFailure
                return // Close explicitly; never discard an older queued frame.
            }
            for start in stride(from: 0, to: samples.count, by: 1600) {
                let end = min(start + 1600, samples.count)
                let frame = WakePcmFrame(sequence: nextSequence,
                    capturedAtMs: capturedAtMs + Double(start) / 16, samples: Array(samples[start..<end]))
                if token != nil { pending.append(frame); nextSequence += 1 }
                else { ring.append(frame) }
            }
            if token == nil {
                var excess = ring.reduce(0) { $0 + $1.samples.count } - 16_000
                while excess > 0, let first = ring.first {
                    ring.removeFirst()
                    if first.samples.count <= excess { excess -= first.samples.count }
                    else {
                        ring.insert(WakePcmFrame(sequence: 0, capturedAtMs: first.capturedAtMs + Double(excess) / 16,
                            samples: Array(first.samples.dropFirst(excess))), at: 0)
                        excess = 0
                    }
                }
            } else { callback = signal() }
        }
        failure?("wake_pcm_overflow")
        callback?()
    }
    /// Exactly one sender owns a returned frame until acknowledge succeeds.
    public func next() -> WakePcmFrame? {
        locked {
            guard ready, !failed, inFlight == nil, !pending.isEmpty else {
                notified = false
                return nil
            }
            inFlight = pending.removeFirst()
            return inFlight
        }
    }
    public func acknowledge(sequence: Int) {
        locked { if inFlight?.sequence == sequence { inFlight = nil } }
    }
    private var bufferedSamples: Int {
        pending.reduce(inFlight?.samples.count ?? 0) { $0 + $1.samples.count }
    }
    private func signal() -> (@Sendable () -> Void)? {
        guard ready, !failed, !notified, !pending.isEmpty else { return nil }
        notified = true
        return onAvailable
    }
    private func clear() {
        token = nil; sealed = false; ready = false; notified = false; failed = false
        ring.removeAll(); pending.removeAll(); inFlight = nil; nextSequence = 0
    }
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }; return body()
    }
}
