import AVFAudio
import Foundation

/// Bounded PCM ring with one synchronized owner for samples, cursors and render state.
/// Each operation holds the same lock for a bounded copy or O(1) state change. The render thread can briefly
/// wait for that critical section; no allocation or external call occurs while the lock is held.
/// The newest audio wins: a push past `cap` drops the oldest down to `target`.
final class PCMRing: @unchecked Sendable {
    struct Stats: Equatable, Sendable {
        /// `pushed` counts all input accepted while open, including overflow; refused input is separate.
        /// Lifetime conservation: pushed = played + overflowed + discarded + buffered.
        var buffered = 0, pushed = 0, played = 0, refused = 0, overflowed = 0, discarded = 0, flushes = 0, drains = 0, underruns = 0
        /// Counters since `base`; `buffered` stays the current fill.
        func since(_ base: Stats) -> Stats {
            Stats(buffered: buffered, pushed: pushed - base.pushed, played: played - base.played, refused: refused - base.refused,
                  overflowed: overflowed - base.overflowed, discarded: discarded - base.discarded, flushes: flushes - base.flushes,
                  drains: drains - base.drains, underruns: underruns - base.underruns)
        }
    }

    let cap: Int, target: Int, prime: Int, refill: Int
    private let storage: UnsafeMutablePointer<Float>
    private let lock = NSLock()
    private var head = 0, tail = 0, open = false
    private var counters = Stats()
    private var primed = false, waited = 0, clock = 0, drainedAt = Int.min / 2

    /// `prime`: start playing once this much is buffered or the first sample waited this long (render time).
    /// `refill`: a drain refilled sooner than this is an underrun (a gap inside speech, not a turn boundary).
    init(cap: Int, target: Int, prime: Int, refill: Int) {
        precondition(0 < prime && prime <= target && target < cap)
        (self.cap, self.target, self.prime, self.refill) = (cap, target, prime, refill)
        storage = .allocate(capacity: cap); storage.initialize(repeating: 0, count: cap)
    }
    deinit { storage.deallocate() }

    func setOpen(_ open: Bool) { lock.withLock { self.open = open } }
    func refuse(_ samples: Int) { lock.withLock { counters.refused += samples } }

    /// Producer: converts 16-bit PCM into the ring. A closed ring refuses.
    func push(_ pcm: UnsafeBufferPointer<Int16>) {
        lock.withLock {
            guard open else { counters.refused += pcm.count; return }
            let keep = min(pcm.count, target)
            guard keep > 0, let base = pcm.baseAddress else { return }
            counters.overflowed += pcm.count - keep
            let source = base + (pcm.count - keep), end = tail + keep
            if end - head > cap {
                let dropped = end - target - head
                head += dropped
                counters.overflowed += dropped
            }
            for i in 0..<keep { storage[(tail + i) % cap] = Float(source[i]) / 32_768 }
            tail = end
            counters.pushed += pcm.count
        }
    }

    /// Any thread, O(1) critical section: discard all buffered samples and reset priming together.
    @discardableResult func flush() -> Int {
        lock.withLock {
            let discarded = tail - head
            head = tail
            counters.flushes += 1
            counters.discarded += discarded
            primed = false; waited = 0; drainedAt = Int.min / 2
            return discarded
        }
    }

    /// Consumer: fills `count` samples, silence where nothing is ready. No allocation or call out under the lock.
    /// Returns the number of real samples.
    func pull(into out: UnsafeMutablePointer<Float>, count: Int) -> Int {
        lock.withLock {
            let available = tail - head
            clock += count
            if !primed {
                if available > 0, waited == 0, clock - drainedAt < refill { counters.underruns += 1 }
                waited = available > 0 ? waited + count : 0
                primed = available >= prime || waited >= prime
            }
            let taken = primed ? min(count, available) : 0
            for i in 0..<taken { out[i] = storage[(head + i) % cap] }
            head += taken
            (out + taken).update(repeating: 0, count: count - taken)
            if primed, available < count { primed = false; waited = 0; drainedAt = clock; counters.drains += 1 }
            counters.played += taken
            return taken
        }
    }

    func stats() -> Stats {
        lock.withLock {
            var snapshot = counters
            snapshot.buffered = tail - head
            return snapshot
        }
    }

    /// The consumer as a pull-model node: its render block only pulls from this ring (mono Float32 at `sampleRate`).
    func makeSourceNode(sampleRate: Double) -> AVAudioSourceNode {
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        return AVAudioSourceNode(format: format) { [self] isSilence, _, frames, list in
            let buffer = list.pointee.mBuffers
            guard let data = buffer.mData else { isSilence.pointee = true; return noErr }
            let count = min(Int(frames), Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
            if pull(into: data.assumingMemoryBound(to: Float.self), count: count) == 0 { isSilence.pointee = true }
            return noErr
        }
    }
}
