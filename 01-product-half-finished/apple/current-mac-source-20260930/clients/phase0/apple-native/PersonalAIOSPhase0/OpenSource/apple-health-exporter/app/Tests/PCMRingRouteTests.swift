import AVFAudio
import XCTest
@testable import HealthKitExporter

final class PCMRingRouteTests: XCTestCase {
    /// Reuses the actual avatar source across SDK-style engine releases. The fake remote track and avatar must
    /// both remain audible at each negotiated rate. This is graph validation, not Bluetooth hardware acceptance.
    func testMixedDownlinkSurvivesEngineRecreationAtHeadsetRates() throws {
        let ring = PCMRing(cap: 9600, target: 4800, prime: 2880, refill: 9600)
        ring.setOpen(true)
        let avatar = ring.makeSourceNode(sampleRate: 48000)
        for rate in [16000.0, 48000, 44100, 8000, 24000, 48000] {
            let engine = AVAudioEngine()
            let output = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            try engine.enableManualRenderingMode(.offline, format: output, maximumFrameCount: 960)
            // The SDK establishes its native output graph before calling engineWillConnectOutput.
            let remote = AVAudioSourceNode(format: output) { silence, _, frames, list in
                let samples = list.pointee.mBuffers.mData!.assumingMemoryBound(to: Float.self)
                samples.update(repeating: 0.125, count: Int(frames)); silence.pointee = false
                return noErr
            }
            engine.attach(avatar); engine.attach(remote)
            engine.connect(remote, to: engine.mainMixerNode, format: output)
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: output)
            engine.connect(avatar, to: engine.mainMixerNode, format: avatar.outputFormat(forBus: 0))
            try engine.start()
            let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 960)!
            ring.flush()
            for _ in 0..<4 { XCTAssertEqual(try engine.renderOffline(960, to: buffer), .success) }
            XCTAssertEqual(buffer.floatChannelData![0][500], 0.125, accuracy: 0.005, "remote-only rate=\(rate)")
            let pcm = [Int16](repeating: 8192, count: 4800) // avatar amplitude 0.25, plus remote 0.125
            for _ in 0..<4 {
                pcm.withUnsafeBufferPointer { ring.push($0) }
                XCTAssertEqual(try engine.renderOffline(960, to: buffer), .success)
            }
            XCTAssertGreaterThan(buffer.floatChannelData![0][500], 0.2, "avatar must add to the remote track at rate=\(rate)")
            XCTAssertGreaterThan(ring.stats().played, 0)
            engine.stop()
            engine.detach(avatar)
        }
    }
}
