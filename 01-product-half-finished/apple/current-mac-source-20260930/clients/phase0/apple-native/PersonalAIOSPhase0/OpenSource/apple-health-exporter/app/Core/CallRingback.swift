import AVFAudio
import Foundation
import LiveKit

/// The "嘟…嘟…" a phone makes while the other side has not picked up yet. Played from the tap until the server says the
/// call is live (or the call failed / was hung up); `start` and `stop` are idempotent.
protocol CallRingbackPlaying: AnyObject, Sendable {
    func start()
    func stop()
}

/// Chinese ringback: a soft 450 Hz tone, one second on, 2.5 s off, looped. Synthesized here (no bundled asset); the tone
/// is faded in and out so it never clicks. It plays through the call's audio route (AVAudioPlayer under the shared
/// audio-session requirement, like 依米's replies), so it follows the call's route and ignores the silent switch.
enum CallRingbackTone {
    static let frequency = 450.0, sampleRate = 16_000, onSeconds = 1.0, offSeconds = 2.5
    static let amplitude = 0.22, fadeSeconds = 0.04

    /// One period as a mono 16-bit PCM WAV file.
    static func wav() -> Data {
        let on = Int(onSeconds * Double(sampleRate)), total = on + Int(offSeconds * Double(sampleRate))
        let fade = Int(fadeSeconds * Double(sampleRate))
        var pcm = Data(capacity: total * 2)
        for index in 0..<total {
            var sample = 0.0
            if index < on {
                let edge = Double(min(1, Double(min(index, on - 1 - index)) / Double(fade)))
                sample = amplitude * edge * sin(2 * .pi * frequency * Double(index) / Double(sampleRate))
            }
            withUnsafeBytes(of: Int16(sample * Double(Int16.max)).littleEndian) { pcm.append(contentsOf: $0) }
        }
        var wav = Data("RIFF".utf8)
        for value in [UInt32(36 + pcm.count)] { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        wav.append(contentsOf: Data("WAVEfmt ".utf8))
        withUnsafeBytes(of: UInt32(16).littleEndian) { wav.append(contentsOf: $0) }
        for value in [UInt16(1), UInt16(1)] { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        for value in [UInt32(sampleRate), UInt32(sampleRate * 2)] { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        for value in [UInt16(2), UInt16(16)] { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        wav.append(contentsOf: Data("data".utf8))
        withUnsafeBytes(of: UInt32(pcm.count).littleEndian) { wav.append(contentsOf: $0) }
        wav.append(pcm)
        return wav
    }
}

final class CallRingback: CallRingbackPlaying, @unchecked Sendable {
    private let lock = NSLock()
    private var player: AVAudioPlayer?
    private var release: (() -> Void)?

    func start() {
        lock.lock(); defer { lock.unlock() }
        guard player == nil else { return }
        do {
            let requirement = try AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            do {
                let next = try AVAudioPlayer(data: CallRingbackTone.wav())
                next.numberOfLoops = -1
                guard next.play() else { throw CallRingbackError.notPlaying }
                player = next
                release = { try? requirement.release() }
            } catch { try? requirement.release() }
        } catch { /* no audio session: the call still connects, just silently */ }
    }

    func stop() {
        lock.lock()
        let current = player, finish = release
        player = nil; release = nil
        lock.unlock()
        current?.stop(); finish?()
    }
}

private enum CallRingbackError: Error { case notPlaying }
