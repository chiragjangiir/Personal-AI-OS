#if os(watchOS)
import AVFoundation
import Foundation

@MainActor
final class WatchUtteranceRecorder: NSObject, AVAudioRecorderDelegate, WatchUtteranceRecording {
    enum RecorderError: Error { case permissionDenied, couldNotStart, encodingFailed }
    var onFinish: ((Result<(Data, Int), Error>) -> Void)?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var segmenter = WatchRecorderSegmenter()
    private var file: URL?

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { allowed in continuation.resume(returning: allowed) }
        }
    }
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("m4a")
        file = url
        do {
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 24000])
            recorder.delegate = self
            recorder.isMeteringEnabled = true
            self.recorder = recorder
            segmenter = WatchRecorderSegmenter()
            // Priming and final AAC frames must fit inside the 30-second encoded upload limit.
            let encoderAllowance = 3 * 1024.0 / 16000
            guard recorder.record(forDuration: segmenter.maximumDuration - encoderAllowance) else { throw RecorderError.couldNotStart }
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.meter() }
            }
        } catch { cancel(); throw error }
    }
    private func meter() {
        guard let recorder else { return }
        recorder.updateMeters()
        if segmenter.sample(elapsed: recorder.currentTime, level: recorder.averagePower(forChannel: 0)) != nil { finish() }
    }
    func finish(wristDown: Bool = false) {
        guard let recorder else { return }
        _ = segmenter.finish(wristDown: wristDown)
        self.recorder = nil
        timer?.invalidate(); timer = nil
        recorder.stop()
        do {
            guard let file else { throw RecorderError.encodingFailed }
            let audio = try AVAudioFile(forReading: file)
            let milliseconds = Int((Double(audio.length) * 1000 / audio.processingFormat.sampleRate).rounded())
            let bytes = try Data(contentsOf: file)
            cleanup()
            onFinish?(.success((bytes, milliseconds)))
        } catch { cleanup(); onFinish?(.failure(error)) }
    }
    func cancel() {
        let active = recorder
        recorder = nil
        timer?.invalidate(); timer = nil
        active?.stop()
        cleanup()
    }
    private func cleanup() {
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            if flag { self.finish() }
            else { self.cancel(); self.onFinish?(.failure(RecorderError.encodingFailed)) }
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            guard self.recorder === recorder else { return }
            self.cancel()
            self.onFinish?(.failure(error ?? RecorderError.encodingFailed))
        }
    }
}
#endif
