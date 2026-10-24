import AVFAudio
import Foundation
import LiveKit

/// Projects rendered remote PCM, rather than the server's intention to speak.
final class AssistantCallPlaybackObserver: AudioRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ai.paios.call.playback-status")
    private var expiry: DispatchWorkItem?
    private var playing = false
    private var stopped = false
    private let changed: @Sendable (Bool) -> Void

    init(changed: @escaping @Sendable (Bool) -> Void) { self.changed = changed }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let frames = Int(pcmBuffer.frameLength)
        guard frames > 0 else { return }
        let channels = Int(pcmBuffer.format.channelCount)
        let audible: Bool
        if let data = pcmBuffer.int16ChannelData {
            audible = (0..<channels).contains { channel in
                (0..<frames).contains { data[pcmBuffer.format.isInterleaved ? 0 : channel][$0 * pcmBuffer.stride + (pcmBuffer.format.isInterleaved ? channel : 0)] != 0 }
            }
        } else if let data = pcmBuffer.floatChannelData {
            audible = (0..<channels).contains { channel in
                (0..<frames).contains { abs(data[pcmBuffer.format.isInterleaved ? 0 : channel][$0 * pcmBuffer.stride + (pcmBuffer.format.isInterleaved ? channel : 0)]) > 0.00003 }
            }
        } else { return }
        let duration = Double(frames) / pcmBuffer.format.sampleRate
        queue.async { [self] in
            lock.lock()
            guard !stopped else { lock.unlock(); return }
            expiry?.cancel()
            let previous = playing
            playing = audible
            lock.unlock()
            if previous != audible { changed(audible) }
            guard audible else { return }
            let item = DispatchWorkItem { [weak self] in self?.silence() }
            lock.withLock { expiry = item }
            queue.asyncAfter(deadline: .now() + duration * 2, execute: item)
        }
    }

    private func silence() {
        let notify = lock.withLock { let old = playing; playing = false; return old }
        if notify { changed(false) }
    }

    func stop() {
        lock.withLock { stopped = true; expiry?.cancel(); expiry = nil }
        queue.async { [self] in silence() }
    }
}
