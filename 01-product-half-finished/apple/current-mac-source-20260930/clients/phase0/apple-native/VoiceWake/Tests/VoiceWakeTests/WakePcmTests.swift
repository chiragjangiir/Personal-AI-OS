import XCTest
@testable import VoiceWake

final class WakePcmTests: XCTestCase {
    func testQuestionSeventyMillisecondsAfterWakePrecedesLiveAudioAfterLateReceipt() {
        let queue = WakePcmBuffer()
        queue.setArmed(true)
        for index in 0..<100 {
            queue.append(samples: Array(repeating: 8, count: 160), capturedAtMs: Double(index * 10))
        }
        XCTAssertNil(queue.next()) // Standby never uploads.
        queue.begin(generation: 7) // Word ends at 1000 ms.
        for index in 100..<160 {
            queue.append(samples: Array(repeating: index >= 107 ? 9 : 0, count: 160), capturedAtMs: Double(index * 10))
        }
        XCTAssertNil(queue.next()) // Server opening receipt has not arrived.
        queue.unlock() // Receipt arrives 600 ms after wake end.
        queue.append(samples: Array(repeating: 10, count: 160), capturedAtMs: 1600)
        var frames: [WakePcmFrame] = []
        while let frame = queue.next() { frames.append(frame); queue.acknowledge(sequence: frame.sequence) }
        XCTAssertEqual(frames.map(\.sequence), Array(0...160))
        XCTAssertEqual(frames.first?.samples.first, 8) // Wake prefix retained for identity.
        XCTAssertEqual(frames.first(where: { $0.samples.first == 9 })?.capturedAtMs, 1070)
        XCTAssertEqual(frames.last?.capturedAtMs, 1600)
        XCTAssertEqual(frames.last?.samples.first, 10)
        XCTAssertEqual(queue.retainedSampleCount, 0)
    }

    func testLocalCloseSealsNewCaptureButDrainsQueuedAndInFlightTailInOrder() {
        let queue = WakePcmBuffer()
        queue.setArmed(true)
        queue.append(samples: [1, 2], capturedAtMs: 1000)
        queue.begin(generation: 7); queue.unlock()
        let first = queue.next()!
        queue.append(samples: [3], capturedAtMs: 1000.125) // Final partial frame.
        queue.seal()
        queue.append(samples: [99], capturedAtMs: 1001) // After the local cutoff.
        XCTAssertEqual(queue.retainedSampleCount, 3)
        XCTAssertNil(queue.next()) // The reliable publisher still owns sequence zero.
        queue.acknowledge(sequence: first.sequence)
        let tail = queue.next()!
        XCTAssertEqual(tail.sequence, 1)
        XCTAssertEqual(tail.samples, [3])
        XCTAssertEqual(tail.capturedAtMs, 1000.125)
        queue.acknowledge(sequence: tail.sequence)
        XCTAssertNil(queue.next())
        XCTAssertEqual(queue.retainedSampleCount, 0)
        queue.end()
    }

    func testCaptureOutageDrainsOldEpochBeforeUsingActualNewCaptureTime() throws {
        let converter = WakePcmResampler()
        let first = try converter.convert(samples: Array(repeating: 0.25, count: 4800), sampleRate: 48000, capturedAtMs: 1000)
        XCTAssertFalse(converter.hasCaptureGap(capturedAtMs: 1102))
        XCTAssertTrue(converter.hasCaptureGap(capturedAtMs: 1400))
        let tail = try converter.finish()
        XCTAssertEqual(first.samples.count + tail.samples.count, 1600)
        converter.reset()
        let resumed = try converter.convert(samples: Array(repeating: 0.5, count: 4800), sampleRate: 48000, capturedAtMs: 1400)
        XCTAssertEqual(resumed.capturedAtMs, 1400)
        XCTAssertEqual(resumed.samples.count + (try converter.finish()).samples.count, 1600)
    }

    func testRollingPrefixIsAtMostOneSecondAndDiscardCannotEndAnotherWake() {
        let queue = WakePcmBuffer()
        queue.setArmed(true)
        for index in 0..<20 { queue.append(samples: Array(repeating: 1, count: 1600), capturedAtMs: Double(index * 100)) }
        queue.begin(generation: 2)
        XCTAssertEqual(queue.retainedSampleCount, 16000)
        queue.discard(generation: 1)
        queue.unlock()
        XCTAssertEqual(queue.next()?.capturedAtMs, 1000)
        queue.end()
        XCTAssertFalse(queue.isCapturingCall)
        XCTAssertNil(queue.next())
    }

    func testFiveSecondBudgetIncludesInFlightAndOverflowIsExplicitWithoutDiscardingOldAudio() {
        let queue = WakePcmBuffer(), probe = PcmFailureProbe()
        queue.setCallbacks(onAvailable: {}, onFailure: { probe.record($0) })
        queue.setArmed(true)
        queue.append(samples: Array(repeating: 1, count: 16000), capturedAtMs: 0)
        queue.begin(generation: 3)
        queue.unlock()
        XCTAssertNotNil(queue.next()) // 100 ms now in flight and still charged.
        queue.append(samples: Array(repeating: 2, count: 64000), capturedAtMs: 1000)
        XCTAssertEqual(queue.retainedSampleCount, 80000)
        queue.append(samples: Array(repeating: 3, count: 160), capturedAtMs: 5000)
        XCTAssertEqual(probe.values, ["wake_pcm_overflow"])
        XCTAssertEqual(queue.retainedSampleCount, 80000)
        XCTAssertNil(queue.next())
    }

    func testResamplerKeepsCaptureAxisAndResetUsesNewCaptureOrigin() throws {
        let converter = WakePcmResampler()
        let input = Array(repeating: Float(0.25), count: 4800)
        let first = try converter.convert(samples: input, sampleRate: 48000, capturedAtMs: 1000)
        let second = try converter.convert(samples: input, sampleRate: 48000, capturedAtMs: 1102)
        let tail = try converter.finish()
        XCTAssertEqual(first.capturedAtMs, 1000)
        XCTAssertEqual(second.capturedAtMs, 1000 + Double(first.samples.count) / 16)
        XCTAssertEqual(tail.capturedAtMs, 1000 + Double(first.samples.count + second.samples.count) / 16)
        let complete = first.samples + second.samples + tail.samples
        XCTAssertEqual(complete.count, 3200) // All captured duration, including converter lookahead.
        XCTAssertTrue(complete.dropFirst(256).dropLast(256).allSatisfy { abs(Int($0) - 8192) <= 2 })
        XCTAssertTrue(try converter.finish().samples.isEmpty)
        converter.reset()
        let restarted = try converter.convert(samples: input, sampleRate: 48000, capturedAtMs: 9000)
        XCTAssertEqual(restarted.capturedAtMs, 9000)
        XCTAssertEqual(restarted.samples.count + (try converter.finish()).samples.count, 1600)
    }

    func testEndOfStreamPreservesCapturedFirstAndLastSignalInsteadOfDiscardingTail() throws {
        let converter = WakePcmResampler()
        var input = Array(repeating: Float(0), count: 4800)
        for index in 0..<64 { input[index] = 0.5; input[4799 - index] = 0.5 }
        let first = try converter.convert(samples: input, sampleRate: 48000, capturedAtMs: 1000)
        let tail = try converter.finish()
        let complete = first.samples + tail.samples
        XCTAssertEqual(complete.count, 1600)
        XCTAssertTrue(complete.prefix(32).contains { abs(Int($0)) > 1000 })
        XCTAssertTrue(complete.suffix(32).contains { abs(Int($0)) > 1000 })
        XCTAssertFalse(tail.samples.isEmpty)
        converter.reset()
        let silence = try converter.convert(samples: Array(repeating: 0, count: 4800), sampleRate: 48000, capturedAtMs: 9000)
        XCTAssertTrue((silence.samples + (try converter.finish()).samples).allSatisfy { $0 == 0 })
    }

    func testUneven44100HzChunksMatchContinuousCapturedSourceAfterDrain() throws {
        let input = (0..<4410).map { Float(sin(Double($0) * 2 * .pi * 1000 / 44100)) * 0.25 }
        let whole = WakePcmResampler()
        let expected = try whole.convert(samples: input, sampleRate: 44100, capturedAtMs: 1000).samples + whole.finish().samples
        let chunked = WakePcmResampler()
        var actual: [Int16] = []
        for start in stride(from: 0, to: input.count, by: 17) {
            let result = try chunked.convert(samples: Array(input[start..<min(start + 17, input.count)]),
                sampleRate: 44100, capturedAtMs: 1000 + Double(start) / 44.1)
            XCTAssertEqual(result.capturedAtMs, 1000 + Double(actual.count) / 16)
            actual += result.samples
        }
        actual += try chunked.finish().samples
        XCTAssertEqual(actual.count, 1600)
        XCTAssertEqual(actual.count, expected.count)
        XCTAssertTrue(zip(actual, expected).allSatisfy { pair in abs(Int(pair.0) - Int(pair.1)) <= 2 })
    }

    func testDownsamplingRejectsTwelveKilohertzInsteadOfAliasingItIntoSpeechBand() throws {
        func convertTone(_ frequency: Double) throws -> [Int16] {
            let converter = WakePcmResampler()
            let input = (0..<9600).map { Float(sin(Double($0) * 2 * .pi * frequency / 48000)) * 0.5 }
            return try converter.convert(samples: input, sampleRate: 48000, capturedAtMs: 1000).samples + converter.finish().samples
        }
        func rms(_ samples: [Int16]) -> Double {
            let interior = samples.dropFirst(512).dropLast(512)
            return sqrt(interior.reduce(0) { $0 + pow(Double($1) / 32768, 2) } / Double(interior.count))
        }
        let speechBand = try convertTone(1000), outOfBand = try convertTone(12000)
        XCTAssertEqual(speechBand.count, 3200)
        XCTAssertEqual(outOfBand.count, 3200)
        let pass = rms(speechBand), reject = rms(outOfBand)
        XCTAssertEqual(pass, 0.5 / sqrt(2), accuracy: 0.02)
        XCTAssertLessThan(reject, pass * 0.02) // Linear decimation would alias 12 kHz at full amplitude.
    }

    func testDisarmDuringWokenCallKeepsThatAudioSourceUntilHangup() {
        let queue = WakePcmBuffer()
        queue.setArmed(true)
        queue.begin(generation: 1)
        queue.setArmed(false)
        queue.append(samples: [1, 2], capturedAtMs: 100)
        queue.unlock()
        XCTAssertEqual(queue.next()?.samples, [1, 2])
        queue.end()
        queue.append(samples: [3], capturedAtMs: 101)
        XCTAssertFalse(queue.isCapturingCall)
        XCTAssertNil(queue.next())
    }
}

private final class PcmFailureProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var values: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
    func record(_ value: String) { lock.lock(); defer { lock.unlock() }; recorded.append(value) }
}
