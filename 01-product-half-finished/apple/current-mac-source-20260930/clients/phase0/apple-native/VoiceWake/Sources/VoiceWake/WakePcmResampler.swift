import AVFAudio
import Foundation

public enum WakePcmError: Error { case conversionFailed }

/// Serial, band-limited source conversion. Converter lookahead changes packet
/// length, not capture time. finish drains captured audio before an epoch reset;
/// only samples beyond the source duration are noncaptured padding and trimmed.
public final class WakePcmResampler {
    private var converter: AVAudioConverter?
    private var rate = 0
    private var origin = 0.0
    private var inputSamples = 0
    private var outputSamples = 0
    public init() {}
    public var inputSampleRate: Int { rate }
    /// Callback wall-time estimates can jitter; a missing callback beyond 20 ms
    /// ends the source epoch so an actual outage never compresses capture time.
    public func hasCaptureGap(capturedAtMs: Double) -> Bool {
        guard rate != 0 else { return false }
        return capturedAtMs - (origin + Double(inputSamples) * 1000 / Double(rate)) > 20
    }
    public func reset() { converter = nil; rate = 0; inputSamples = 0; outputSamples = 0 }

    public func convert(samples: [Float], sampleRate: Int, capturedAtMs: Double) throws -> (samples: [Int16], capturedAtMs: Double) {
        guard !samples.isEmpty, (8000...192000).contains(sampleRate), samples.count <= sampleRate else {
            throw WakePcmError.conversionFailed
        }
        if rate != sampleRate {
            reset()
            let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
            let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false)!
            converter = AVAudioConverter(from: input, to: output)
            converter?.primeMethod = .none
            converter?.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            rate = sampleRate; origin = capturedAtMs
        }
        guard let converter, let input = AVAudioPCMBuffer(pcmFormat: converter.inputFormat,
            frameCapacity: AVAudioFrameCount(samples.count)) else { throw WakePcmError.conversionFailed }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        inputSamples += samples.count
        let values = try convert(input: input, capacity: targetSamples - outputSamples + 32)
        return emit(Array(values.prefix(targetSamples - outputSamples)))
    }

    public func finish() throws -> (samples: [Int16], capturedAtMs: Double) {
        guard let converter else { return ([], origin) }
        let remaining = targetSamples - outputSamples
        let padding = Int(ceil(Double(converter.primeInfo.trailingFrames) * 16000 / Double(rate))) + 32
        // A callback holds at most one second, plus the standard converter tail.
        guard remaining <= 16000 + padding else { throw WakePcmError.conversionFailed }
        var values: [Int16] = []
        while values.count < remaining {
            let block = try convert(input: nil, capacity: remaining - values.count + padding)
            guard !block.isEmpty else { throw WakePcmError.conversionFailed }
            values.append(contentsOf: block.prefix(remaining - values.count))
        }
        return emit(values)
    }

    private var targetSamples: Int { Int(ceil(Double(inputSamples) * 16000 / Double(rate))) }
    private func emit(_ values: [Int16]) -> (samples: [Int16], capturedAtMs: Double) {
        let timestamp = origin + Double(outputSamples) / 16
        outputSamples += values.count
        return (values, timestamp)
    }
    private func convert(input: AVAudioPCMBuffer?, capacity: Int) throws -> [Int16] {
        guard let converter, let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat,
            frameCapacity: AVAudioFrameCount(max(1, capacity))) else { throw WakePcmError.conversionFailed }
        var supplied = false
        var error: NSError?
        let result = converter.convert(to: output, error: &error) { _, status in
            guard let input else { status.pointee = .endOfStream; return nil }
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if result == .error {
            if let error { throw error }
            throw WakePcmError.conversionFailed
        }
        return Array(UnsafeBufferPointer(start: output.int16ChannelData![0], count: Int(output.frameLength)))
    }
}
