import Foundation
import SherpaOnnxC

public enum WakeWordError: Error, LocalizedError {
    case missingAsset(String), creationFailed
    public var errorDescription: String? {
        switch self {
        case .missingAsset(let name): return "Wake word asset missing: \(name)"
        case .creationFailed: return "Native wake word model could not be loaded"
        }
    }
}

/// Serial consumer of mono PCM. Uses the same 依米 model and thresholds as glasses.
/// No recording, network, files or audio logging occurs here.
public final class WakeWordDetector {
    private let spotter: OpaquePointer
    private var stream: OpaquePointer
    private var sampleRate = 0

    public init() throws {
        let names = ["encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                     "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                     "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                     "tokens.txt", "keywords.txt"]
        // Keep every C string alive through the C constructor, which copies config.
        let paths = try names.map { name -> String in
            guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "kws") else {
                throw WakeWordError.missingAsset(name)
            }
            return url.path
        }
        let strings = (paths + ["cpu"]).map { strdup($0)! }
        defer { strings.forEach { free($0) } }
        var config = SherpaOnnxKeywordSpotterConfig()
        config.feat_config.sample_rate = 16000
        config.feat_config.feature_dim = 80
        config.model_config.transducer.encoder = UnsafePointer(strings[0])
        config.model_config.transducer.decoder = UnsafePointer(strings[1])
        config.model_config.transducer.joiner = UnsafePointer(strings[2])
        config.model_config.tokens = UnsafePointer(strings[3])
        config.model_config.num_threads = 1
        config.model_config.provider = UnsafePointer(strings[5])
        config.keywords_file = UnsafePointer(strings[4])
        config.max_active_paths = 4
        config.num_trailing_blanks = 1
        config.keywords_score = 2
        config.keywords_threshold = 0.15
        guard let native = SherpaOnnxCreateKeywordSpotter(&config) else { throw WakeWordError.creationFailed }
        guard let active = SherpaOnnxCreateKeywordStream(native) else {
            SherpaOnnxDestroyKeywordSpotter(native)
            throw WakeWordError.creationFailed
        }
        spotter = native
        stream = active
    }

    deinit {
        SherpaOnnxDestroyOnlineStream(stream)
        SherpaOnnxDestroyKeywordSpotter(spotter)
    }

    /// Full stream recreation clears feature history as well as decoder state.
    public func reset() {
        let next = SherpaOnnxCreateKeywordStream(spotter)!
        SherpaOnnxDestroyOnlineStream(stream)
        stream = next
        sampleRate = 0
    }

    public func accept(samples: [Float], sampleRate: Int) -> Bool {
        guard (8000...192000).contains(sampleRate), !samples.isEmpty else { return false }
        // sherpa streams cannot change input rate: recreate before accepting it.
        if self.sampleRate != sampleRate { reset(); self.sampleRate = sampleRate }
        SherpaOnnxOnlineStreamAcceptWaveform(stream, Int32(sampleRate), samples, Int32(samples.count))
        while SherpaOnnxIsKeywordStreamReady(spotter, stream) == 1 {
            SherpaOnnxDecodeKeywordStream(spotter, stream)
            guard let result = SherpaOnnxGetKeywordResult(spotter, stream) else { continue }
            let heard = result.pointee.keyword.map { String(cString: $0) == "依米" } ?? false
            SherpaOnnxDestroyKeywordResult(result)
            if heard { reset(); return true }
        }
        return false
    }
}
