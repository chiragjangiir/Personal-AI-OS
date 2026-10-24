import AVFAudio
import XCTest
@testable import HealthKitExporter

/// The avatar playback bridge: a bounded SPSC ring that ARTC's thread fills and the render block drains.
final class PCMRingTests: XCTestCase {
    private func makeRing(cap: Int = 100, target: Int = 50, prime: Int = 10, refill: Int = 40) -> PCMRing {
        let ring = PCMRing(cap: cap, target: target, prime: prime, refill: refill)
        ring.setOpen(true)
        return ring
    }

    private func push(_ ring: PCMRing, _ values: some Sequence<Int>) {
        Array(values).map { Int16($0) }.withUnsafeBufferPointer { ring.push($0) }
    }

    /// Pulled samples as the integers that were pushed (0 = silence).
    private func pull(_ ring: PCMRing, _ count: Int) -> [Int] {
        var out = [Float](repeating: .nan, count: count)
        _ = out.withUnsafeMutableBufferPointer { ring.pull(into: $0.baseAddress!, count: count) }
        return out.map { Int(($0 * 32_768).rounded()) }
    }

    func testFIFOAcrossWrapAround() {
        let ring = makeRing()
        for round in 0..<10 { // 300 samples through a 100-sample ring.
            push(ring, (round * 30 + 1)...(round * 30 + 30))
            XCTAssertEqual(pull(ring, 30), Array((round * 30 + 1)...(round * 30 + 30)))
        }
        let stats = ring.stats()
        XCTAssertEqual([stats.pushed, stats.played, stats.buffered, stats.overflowed, stats.drains], [300, 300, 0, 0, 0])
    }

    func testOverflowDropsTheOldestAndKeepsTheNewestWithinTheCap() {
        let ring = makeRing()
        for frame in 0..<11 { push(ring, (frame * 10 + 1)...(frame * 10 + 10)) } // 110 samples > cap 100.
        XCTAssertEqual(ring.stats().buffered, 50, "trimmed to target once past the cap")
        XCTAssertEqual(ring.stats().overflowed, 60)
        XCTAssertEqual(pull(ring, 50), Array(61...110))

        push(ring, 1...300) // One frame larger than the target keeps only its newest part.
        XCTAssertEqual(ring.stats().buffered, 50)
        XCTAssertEqual(pull(ring, 50), Array(251...300))
        XCTAssertLessThanOrEqual(ring.stats().buffered, ring.cap)
    }

    func testOversizedPushCountsEveryInputAndKeepsNewestWaveform() {
        let ring = makeRing()
        push(ring, 1...300)
        let queued = ring.stats()
        XCTAssertEqual(queued.pushed, 300)
        XCTAssertEqual(queued.overflowed, 250)
        XCTAssertEqual(queued.buffered, 50)
        XCTAssertEqual(queued.pushed, queued.played + queued.overflowed + queued.discarded + queued.buffered)
        XCTAssertEqual(pull(ring, 20), Array(251...270))
        XCTAssertEqual(ring.flush(), 30)
        ring.setOpen(false)
        push(ring, 301...600)
        let final = ring.stats()
        XCTAssertEqual(final.pushed, 300)
        XCTAssertEqual(final.refused, 300)
        XCTAssertEqual(final.pushed, final.played + final.overflowed + final.discarded + final.buffered)
    }

    func testOversizedPushCountsBothClippedInputAndEvictedBuffer() {
        let ring = makeRing()
        push(ring, 1...40)
        push(ring, 41...80)
        let baseline = ring.stats()
        push(ring, 101...400)
        let change = ring.stats().since(baseline)
        XCTAssertEqual(change.pushed, 300)
        XCTAssertEqual(change.overflowed, 330, "250 incoming samples clipped and 80 queued samples evicted")
        XCTAssertEqual(change.buffered, 50)
        XCTAssertEqual(baseline.buffered + change.pushed,
                       change.played + change.overflowed + change.discarded + change.buffered)
        XCTAssertEqual(pull(ring, 50), Array(351...400))
        let final = ring.stats()
        XCTAssertEqual(final.pushed, final.played + final.overflowed + final.discarded + final.buffered)
    }

    func testUnderrunGivesSilenceAndAShortTailStillPlays() {
        let ring = makeRing()
        XCTAssertEqual(pull(ring, 8), Array(repeating: 0, count: 8), "empty ring renders silence")
        push(ring, 1...5) // Below `prime`: waits at most `prime` render samples, then plays.
        XCTAssertEqual(pull(ring, 4), [0, 0, 0, 0])
        XCTAssertEqual(pull(ring, 4), [0, 0, 0, 0])
        XCTAssertEqual(pull(ring, 4), [1, 2, 3, 4])
        XCTAssertEqual(pull(ring, 4), [5, 0, 0, 0], "ran dry mid-quantum: the rest is silence")
        XCTAssertEqual(ring.stats().drains, 1)
        XCTAssertEqual(ring.stats().underruns, 0)
        push(ring, 6...20) // Refilled 4 render samples after the drain: a gap inside speech.
        XCTAssertEqual(pull(ring, 15), Array(6...20))
        XCTAssertEqual(ring.stats().underruns, 1)
    }

    func testClosedRingRefusesAndFlushDiscards() {
        let ring = PCMRing(cap: 100, target: 50, prime: 10, refill: 40)
        push(ring, 1...30)
        XCTAssertEqual(ring.stats().refused, 30, "ARTC frames while disabled are counted, not queued")
        ring.setOpen(true)
        push(ring, 1...30)
        XCTAssertEqual(ring.flush(), 30)
        XCTAssertEqual(pull(ring, 30), Array(repeating: 0, count: 30), "nothing from before the flush plays")
        push(ring, 31...45)
        XCTAssertEqual(pull(ring, 15), Array(31...45), "audio after the flush plays")
        XCTAssertEqual(ring.stats().discarded, 30)
        XCTAssertEqual(ring.stats().underruns, 0, "a flush is not an underrun")
    }

    /// A paused producer and an absent render consumer cannot prevent control operations from completing.
    func testFlushAndDisableDoNotWaitForConsumerProgress() {
        let ring = makeRing(cap: 9_600, target: 4_800, prime: 2_880, refill: 9_600)
        let produced = expectation(description: "producer filled ring"), controls = expectation(description: "controls complete")
        let resume = DispatchSemaphore(value: 0)
        let producer = Thread {
            let frame = [Int16](repeating: 1, count: 480)
            for _ in 0..<100 { frame.withUnsafeBufferPointer { ring.push($0) } }
            produced.fulfill()
            resume.wait() // Outside the ring owner; no callback or consumer can make further progress.
        }
        producer.start()
        defer { resume.signal() }
        guard XCTWaiter.wait(for: [produced], timeout: 5) == .completed else { XCTFail("Producer did not fill ring"); return }
        let buffered = ring.stats().buffered
        DispatchQueue.global().async {
            let frame = [Int16](repeating: 1, count: 480)
            ring.flush(); ring.setOpen(false)
            frame.withUnsafeBufferPointer { ring.push($0) }
            ring.setOpen(true)
            frame.withUnsafeBufferPointer { ring.push($0) }
            controls.fulfill()
        }
        // Deadlock bound, not a scheduler-speed microbenchmark. Never inspect the owner after a timeout.
        guard XCTWaiter.wait(for: [controls], timeout: 5) == .completed else { XCTFail("Controls waited for callback progress"); return }
        let stats = ring.stats()
        XCTAssertEqual(stats.discarded, buffered)
        XCTAssertEqual(stats.pushed, 48_480)
        XCTAssertEqual(stats.refused, 480)
        XCTAssertEqual(stats.played, 0)
        XCTAssertEqual(stats.buffered, 480)
        XCTAssertLessThanOrEqual(stats.buffered, ring.cap)
    }

    /// Producer, render consumer and a flusher on three threads: what plays is never torn, stale or repeated, and every
    /// pushed sample is accounted for exactly once. The tight ring makes the producer lap the reader constantly.
    func testConcurrentFlushWhileProducerAndConsumerRun() {
        race(makeRing(cap: 9_600, target: 4_800, prime: 2_880, refill: 9_600), frame: 480, quantum: 256)
        race(makeRing(cap: 64, target: 32, prime: 8, refill: 64), frame: 16, quantum: 16)
    }

    private func race(_ ring: PCMRing, frame: Int, quantum: Int, file: StaticString = #filePath, line: UInt = #line) {
        let total = frame * 4_000, done = Flag(), failures = Flag(), group = DispatchGroup()
        DispatchQueue.global().async(group: group) {
            var next = 0, samples = [Int16](repeating: 0, count: frame)
            while next < total {
                for i in 0..<frame { samples[i] = Int16((next + i) % 32_000 + 1) }
                samples.withUnsafeBufferPointer { ring.push($0) }
                next += frame
            }
            done.value = true
        }
        DispatchQueue.global().async(group: group) {
            var out = [Float](repeating: 0, count: quantum), last: Int?
            while !done.value || ring.stats().buffered > 0 {
                let got = out.withUnsafeMutableBufferPointer { ring.pull(into: $0.baseAddress!, count: quantum) }
                for (index, value) in out[0..<got].map({ Int(($0 * 32_768).rounded()) }).enumerated() {
                    // Values wrap at 32,000. One pull is one contiguous run (no tear, no stale slot); between pulls a
                    // drop may skip any distance, so only a repeat is an error there.
                    let step = last.map { (value - $0 + 32_000) % 32_000 } ?? 1
                    if value == 0 || step == 0 || (index > 0 && step != 1) { failures.value = true }
                    last = value
                }
            }
        }
        DispatchQueue.global().async(group: group) {
            while !done.value { ring.flush(); usleep(200) }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 60), .success, file: file, line: line)
        XCTAssertFalse(failures.value, "consumer saw a repeated, reordered or torn sample", file: file, line: line)
        let stats = ring.stats()
        XCTAssertEqual(stats.pushed, total, file: file, line: line)
        XCTAssertEqual(stats.pushed, stats.played + stats.overflowed + stats.discarded + stats.buffered, file: file, line: line)
        XCTAssertGreaterThan(stats.played, 0, file: file, line: line)
        XCTAssertGreaterThan(stats.discarded, 0, file: file, line: line)
    }

    /// The real render path: the source node pulls the ring through an engine graph (offline, so no device needed).
    func testSourceNodeRendersTheRingThroughAnEngine() throws {
        let ring = makeRing(cap: 9_600, target: 4_800, prime: 2_880, refill: 9_600)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let engine = AVAudioEngine()
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 480)
        let node = ring.makeSourceNode(sampleRate: 48_000)
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try engine.start()
        defer { engine.stop() }
        let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 480)!
        func render() throws -> [Int] {
            XCTAssertEqual(try engine.renderOffline(480, to: buffer), .success)
            return (0..<Int(buffer.frameLength)).map { Int((buffer.floatChannelData![0][$0] * 32_768).rounded()) }
        }
        push(ring, 1...2_880)
        XCTAssertEqual(try render(), Array(1...480))
        XCTAssertEqual(try render(), Array(481...960))
        ring.flush()
        XCTAssertEqual(try render(), Array(repeating: 0, count: 480), "a flush silences the node at once")
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
