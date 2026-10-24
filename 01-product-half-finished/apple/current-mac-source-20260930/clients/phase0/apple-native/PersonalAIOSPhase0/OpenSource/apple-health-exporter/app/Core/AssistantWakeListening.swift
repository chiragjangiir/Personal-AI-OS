import AVFAudio
import Foundation
import LiveKit
import VoiceWake

/// Local recording uses the same SDK audio engine as calls, without publishing a track.
final class AssistantWakeListening: AudioRenderer, @unchecked Sendable {
    let controller: WakeListeningController
    let pcm: WakePcmBuffer
    private let resampler = WakePcmResampler()
    private let processingLock = NSLock()
    private var wireMuted = false
    private let captureTimeMs: @Sendable () -> Double
    private(set) var isRecording = false
    private let startCapture: @Sendable () throws -> Void
    private let stopCapture: @Sendable () throws -> Void
    private let receiveSamples: @Sendable ([Float], Int) -> Void

    init(onWake: @escaping @Sendable (UInt64) -> Void,
         onState: @escaping @Sendable (WakeListeningPhase, String?) -> Void,
         onPcmReady: @escaping @Sendable () -> Void = {},
         onPcmFailure: @escaping @Sendable (String) -> Void = { _ in },
         startCapture: @escaping @Sendable () throws -> Void = { try AudioManager.shared.startLocalRecording() },
         stopCapture: @escaping @Sendable () throws -> Void = { try AudioManager.shared.stopLocalRecording() },
         receiveSamples: (@Sendable ([Float], Int) -> Void)? = nil,
         captureTimeMs: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        let pcm = WakePcmBuffer()
        pcm.setCallbacks(onAvailable: onPcmReady, onFailure: onPcmFailure)
        let listening = WakeListeningController(onWake: { generation in
            pcm.begin(generation: generation)
            onWake(generation)
        }, onState: onState)
        controller = listening
        self.pcm = pcm
        self.captureTimeMs = captureTimeMs
        self.startCapture = startCapture
        self.stopCapture = stopCapture
        self.receiveSamples = receiveSamples ?? { listening.submit(samples: $0, sampleRate: $1) }
    }

    func start(usingPublishedCapture: Bool) throws {
        controller.setEnabled(true)
        pcm.setArmed(true)
        guard !isRecording else { return }
        AudioManager.shared.add(localAudioRenderer: self)
        do {
            if !usingPublishedCapture { try startCapture() }
            isRecording = true
        } catch {
            AudioManager.shared.remove(localAudioRenderer: self)
            controller.setEnabled(false)
            pcm.setArmed(false)
            throw error
        }
    }

    func stop(captureInUse: Bool = false) throws {
        controller.setEnabled(false)
        pcm.setArmed(false)
        processingLock.withLock { finishCaptureEpoch() }
        guard !pcm.isCapturingCall, isRecording else { return }
        AudioManager.shared.remove(localAudioRenderer: self)
        isRecording = false
        if !captureInUse { try stopCapture() }
    }

    /// Publishing and teardown mutate the shared SDK input; unpublish must re-arm it.
    func restoreCapture() throws {
        guard isRecording else { return }
        controller.captureInterrupted()
        processingLock.withLock { finishCaptureEpoch() }
        try startCapture()
    }

    private func finishCaptureEpoch() {
        do {
            let tail = try resampler.finish()
            pcm.append(samples: wireMuted ? tail.samples.map { _ in 0 } : tail.samples, capturedAtMs: tail.capturedAtMs)
        } catch { pcm.fail("wake_pcm_conversion_failed") }
        resampler.reset()
    }

    func setWireMuted(_ muted: Bool) { processingLock.withLock { wireMuted = muted } }

    func sealWakeCall() {
        processingLock.withLock { finishCaptureEpoch(); pcm.seal() }
    }

    func finishWakeCall() {
        processingLock.withLock { finishCaptureEpoch(); wireMuted = false }
        pcm.end()
        if controller.phase == .off { try? stop(captureInUse: true) }
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let capturedAtMs = captureTimeMs()
            - Double(pcmBuffer.frameLength) / pcmBuffer.format.sampleRate * 1000
        processingLock.lock()
        defer { processingLock.unlock() }
        guard let channels = pcmBuffer.int16ChannelData else { return }
        let count = Int(pcmBuffer.frameLength), rate = Int(pcmBuffer.format.sampleRate)
        guard count > 0, count <= rate else { return }
        let channelCount = Int(pcmBuffer.format.channelCount)
        let stride = pcmBuffer.stride
        var mono = [Float](repeating: 0, count: count)
        for channel in 0..<channelCount {
            let data = channels[pcmBuffer.format.isInterleaved ? 0 : channel]
            let offset = pcmBuffer.format.isInterleaved ? channel : 0
            for frame in 0..<count { mono[frame] += Float(data[frame * stride + offset]) / 32_768 / Float(channelCount) }
        }
        do {
            if (resampler.inputSampleRate != 0 && resampler.inputSampleRate != rate)
                || resampler.hasCaptureGap(capturedAtMs: capturedAtMs) { finishCaptureEpoch() }
            let frame = try resampler.convert(samples: mono, sampleRate: rate, capturedAtMs: capturedAtMs)
            pcm.append(samples: wireMuted ? frame.samples.map { _ in 0 } : frame.samples,
                       capturedAtMs: frame.capturedAtMs)
        } catch { pcm.fail("wake_pcm_conversion_failed") }
        receiveSamples(mono, rate)
    }
}

extension WakeListeningPhase {
    var displayName: String {
        switch self {
        case .off: return "本地唤醒已关闭"
        case .loading: return "正在准备本地唤醒"
        case .waitingForAudio: return "本地唤醒等待麦克风"
        case .localReady: return "唤醒词待命 · 仅本机"
        case .opening: return "正在接通依米"
        case .inCall: return "正在通话"
        case .unavailable: return "唤醒不可用"
        }
    }
}
