import Foundation
import AVFAudio
import XCTest
@testable import HealthKitExporter

final class AssistantWakeListeningTests: XCTestCase {
    private final class Capture: @unchecked Sendable {
        var starts = 0, stops = 0
        var refuseStop = false
        var samples: [Float] = []
        var sampleRate = 0
        func start() { starts += 1 }
        func stop() throws {
            stops += 1
            if refuseStop { throw CocoaError(.executableRuntimeMismatch) }
        }
        func listener() -> AssistantWakeListening {
            AssistantWakeListening(onWake: { _ in }, onState: { _, _ in },
                                   startCapture: { self.start() }, stopCapture: { try self.stop() },
                                   receiveSamples: { self.samples = $0; self.sampleRate = $1 })
        }
    }

    func testRawTapPreservesSeventyMillisecondQuestionAcrossOpeningReceiptAndWireEnvelope() throws {
        let clock = CaptureClock(), origin = 1_700_000_000_000.0
        let listener = AssistantWakeListening(onWake: { _ in }, onState: { _, _ in },
            receiveSamples: { _, _ in }, captureTimeMs: { clock.value })
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        buffer.frameLength = 160
        let channel = try XCTUnwrap(buffer.int16ChannelData)[0]
        func render(_ index: Int, value: Int16) {
            clock.value = origin + Double((index + 1) * 10)
            for sample in 0..<160 { channel[sample] = value }
            listener.render(pcmBuffer: buffer)
        }
        listener.pcm.setArmed(true)
        for index in 0..<100 { render(index, value: 16384) }
        XCTAssertNil(listener.pcm.next())
        listener.pcm.begin(generation: 9) // KWS hit after the word ends at +1000 ms.
        for index in 100..<160 { render(index, value: index >= 107 ? -8192 : 0) }
        XCTAssertNil(listener.pcm.next())
        listener.pcm.unlock() // Matching server receipt at +1600 ms.
        render(160, value: 4096)
        var frames = 0, firstQuestionTime: Double?
        while let frame = listener.pcm.next() {
            let bytes = try AssistantCentralTextWire.callPcm(callID: "call-wake", sessionID: "session-wake", frame: frame)
            let packet = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            XCTAssertEqual(packet["schema_version"] as? String, "paios.central.text-envelope.v1")
            XCTAssertEqual(packet["session_id"] as? String, "session-wake")
            XCTAssertEqual(packet["seq"] as? Int, frames)
            XCTAssertEqual(packet["captured_at_ms"] as? Double, origin + Double(frames * 10))
            let pcm = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(packet["pcm_s16le_base64"] as? String)))
            XCTAssertEqual(pcm.count, 320)
            let firstSample = Int16(bitPattern: UInt16(pcm[0]) | UInt16(pcm[1]) << 8)
            XCTAssertEqual(firstSample, frame.samples.first)
            if firstQuestionTime == nil, frame.samples.contains(where: { $0 < 0 }) { firstQuestionTime = frame.capturedAtMs }
            listener.pcm.acknowledge(sequence: frame.sequence)
            frames += 1
        }
        XCTAssertEqual(frames, 161)
        XCTAssertEqual(firstQuestionTime, origin + 1070)
        listener.finishWakeCall()
    }

    func testCaptureGapReanchorsAndLocalCloseKeepsConvertedPartialTailUntilAcknowledged() throws {
        let clock = CaptureClock()
        let listener = AssistantWakeListening(onWake: { _ in }, onState: { _, _ in },
            receiveSamples: { _, _ in }, captureTimeMs: { clock.value })
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 1, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
        buffer.frameLength = 4800
        for index in 0..<4800 { buffer.int16ChannelData![0][index] = 8192 }
        listener.pcm.setArmed(true)
        clock.value = 1100; listener.render(pcmBuffer: buffer)
        listener.pcm.begin(generation: 1); listener.pcm.unlock()
        clock.value = 1500; listener.render(pcmBuffer: buffer) // Capture resumes at 1400, not 1100.
        listener.sealWakeCall()
        clock.value = 1600; listener.render(pcmBuffer: buffer) // Outside the sealed call.
        var sampleCount = 0, sequences: [Int] = [], timestamps: [Double] = []
        while let frame = listener.pcm.next() {
            sampleCount += frame.samples.count; sequences.append(frame.sequence); timestamps.append(frame.capturedAtMs)
            listener.pcm.acknowledge(sequence: frame.sequence)
        }
        XCTAssertEqual(sampleCount, 3200)
        XCTAssertEqual(sequences, Array(0..<sequences.count))
        XCTAssertTrue(timestamps.contains(1400))
        XCTAssertTrue(timestamps.allSatisfy { $0 < 1100 || $0 >= 1400 })
        XCTAssertNil(listener.pcm.next())
        listener.finishWakeCall()
    }

    func testInterleavedStereoTapDownmixesIntoMonoWireAndExplicitMuteKeepsSampleTime() throws {
        let listener = AssistantWakeListening(onWake: { _ in }, onState: { _, _ in },
            receiveSamples: { _, _ in }, captureTimeMs: { 1000 })
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 2, interleaved: true))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        buffer.frameLength = 160
        let data = try XCTUnwrap(buffer.int16ChannelData)[0]
        for index in 0..<160 { data[index * 2] = 16384; data[index * 2 + 1] = -8192 }
        listener.pcm.setArmed(true)
        listener.render(pcmBuffer: buffer)
        listener.pcm.begin(generation: 1)
        listener.pcm.unlock()
        let frame = try XCTUnwrap(listener.pcm.next())
        XCTAssertEqual(frame.samples, Array(repeating: 4096, count: 160))
        let bytes = try AssistantCentralTextWire.callPcm(callID: "call-stereo", sessionID: "session-stereo", frame: frame)
        let packet = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let pcm = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(packet["pcm_s16le_base64"] as? String)))
        XCTAssertEqual(Array(pcm.prefix(2)), [0, 16]) // 4096, little-endian.
        listener.pcm.acknowledge(sequence: frame.sequence)
        listener.setWireMuted(true)
        listener.render(pcmBuffer: buffer)
        let muted = try XCTUnwrap(listener.pcm.next())
        XCTAssertTrue(muted.samples.allSatisfy { $0 == 0 })
        XCTAssertEqual(muted.capturedAtMs, frame.capturedAtMs + 10)
        listener.finishWakeCall()
    }

    func testPinnedLiveKitInt16FramesReachTheLocalDetector() throws {
        let capture = Capture(), listener = capture.listener()
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 2, interleaved: false))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
        buffer.frameLength = 2
        let channels = try XCTUnwrap(buffer.int16ChannelData)
        channels[0][0] = 16_384; channels[1][0] = 0
        channels[0][1] = -32_768; channels[1][1] = 0
        listener.render(pcmBuffer: buffer)
        XCTAssertEqual(capture.sampleRate, 48_000)
        XCTAssertEqual(capture.samples, [0.25, -0.5])
    }

    func testDisarmingWakeDoesNotStopAnExistingCallsMicrophone() throws {
        let capture = Capture(), listener = capture.listener()
        try listener.start(usingPublishedCapture: true)
        try listener.stop(captureInUse: true)
        XCTAssertEqual(capture.starts, 0)
        XCTAssertEqual(capture.stops, 0)
    }

    func testReenableDuringPendingDisarmRearmsTheExistingCapture() throws {
        let capture = Capture(), listener = capture.listener()
        try listener.start(usingPublishedCapture: false)
        listener.controller.setEnabled(false)
        XCTAssertEqual(listener.controller.phase, .off)
        try listener.start(usingPublishedCapture: false)
        XCTAssertEqual(capture.starts, 1)
        XCTAssertNotEqual(listener.controller.phase, .off)
        try listener.stop()
    }

    func testFinalUnpublishRestoresLocalCaptureAndStandaloneOffStopsIt() throws {
        let capture = Capture(), listener = capture.listener()
        try listener.start(usingPublishedCapture: false)
        try listener.restoreCapture()
        XCTAssertEqual(capture.starts, 2)
        try listener.stop()
        XCTAssertEqual(capture.stops, 1)
        XCTAssertFalse(listener.isRecording)
    }

    func testARefusedStopDoesNotPreventReattachingTheDetector() throws {
        let capture = Capture(), listener = capture.listener()
        try listener.start(usingPublishedCapture: false)
        capture.refuseStop = true
        XCTAssertThrowsError(try listener.stop())
        XCTAssertFalse(listener.isRecording)
        try listener.start(usingPublishedCapture: false)
        XCTAssertEqual(capture.starts, 2)
        try listener.stop(captureInUse: true)
    }
}

private final class CaptureClock: @unchecked Sendable {
    var value = 0.0
}
