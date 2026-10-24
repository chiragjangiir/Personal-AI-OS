import Foundation

struct WatchRecorderSegmenter {
    enum End: Equatable { case silence, maximumDuration, wristDown, manual }
    private(set) var ended: End?
    private var lastSpeech: TimeInterval = 0
    let silenceInterval: TimeInterval = 1.2
    let maximumDuration: TimeInterval = 30
    let speechThreshold: Float

    init(speechThreshold: Float = -38) { self.speechThreshold = speechThreshold }

    mutating func sample(elapsed: TimeInterval, level: Float) -> End? {
        guard ended == nil else { return ended }
        if elapsed >= maximumDuration { ended = .maximumDuration }
        else {
            if level >= speechThreshold { lastSpeech = elapsed }
            if elapsed - lastSpeech >= silenceInterval { ended = .silence }
        }
        return ended
    }

    mutating func finish(wristDown: Bool = false) -> End {
        if let ended { return ended }
        let reason: End = wristDown ? .wristDown : .manual
        ended = reason
        return reason
    }
}
