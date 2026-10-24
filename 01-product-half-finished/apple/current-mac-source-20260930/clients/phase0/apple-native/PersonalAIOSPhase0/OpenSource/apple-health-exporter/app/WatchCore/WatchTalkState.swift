import Foundation

struct WatchUtterance: Equatable, Sendable {
    let id: UUID
    let bytes: Data
    let durationMilliseconds: Int
    let scope: WatchBindingScope
}

enum WatchTalkFailure: String, CaseIterable, Sendable {
    case invalid_request, credential_missing, credential_invalid, credential_expired, credential_revoked
    case watch_unregistered, watch_scope_denied, audio_too_large, audio_too_long, audio_invalid
    case codec_unsupported, not_heard, turn_conflict, turn_not_found, busy, service_unavailable, processing_failed

    var screen: WatchTalkState.FailureScreen {
        switch self {
        case .credential_missing, .credential_invalid, .credential_expired, .credential_revoked, .watch_unregistered, .watch_scope_denied: return .registration
        default: return .server
        }
    }
    var message: String {
        switch self {
        case .credential_missing, .credential_invalid, .credential_expired: return "打开一下 iPhone 上的依米，再试一次。"
        case .credential_revoked, .watch_unregistered, .watch_scope_denied: return "请先在 iPhone 上登记这块手表。"
        case .not_heard, .audio_invalid: return "没听清。请点说话，再说一次。"
        case .audio_too_large, .audio_too_long: return "这次说得太长了。请分成短句。"
        case .busy, .service_unavailable: return "暂时连不上她，请稍后重试。"
        case .turn_not_found: return "这句话还没送到，可以重发。"
        default: return "这次没能完成，请再试一次。"
        }
    }
    var needsCredential: Bool {
        [.credential_missing, .credential_invalid, .credential_expired].contains(self)
    }
}

struct WatchTalkState: Equatable {
    enum Phase: Equatable { case idle, listening, thinking, reply, failure }
    enum FailureScreen: Equatable { case network, server, microphone, registration, delayed }
    enum Request: Equatable { case upload(WatchUtterance), poll(UUID) }
    private enum Delivery: Equatable { case absent, uncertain, accepted }
    private(set) var phase: Phase = .idle
    private(set) var heard: String?
    private(set) var reply: String?
    private(set) var failure: String?
    private(set) var failureScreen: FailureScreen?
    private(set) var canRetry = false
    private(set) var utterance: WatchUtterance?
    private var delivery: Delivery = .absent
    private var requestActive = false

    mutating func startByUser() -> Bool {
        guard phase != .listening, phase != .thinking else { return false }
        self = Self()
        phase = .listening
        return true
    }
    mutating func recorded(_ value: WatchUtterance) -> Request? {
        guard phase == .listening else { return nil }
        utterance = value
        phase = .thinking
        return beginUpload()
    }
    private mutating func beginUpload() -> Request? {
        guard !requestActive, let utterance else { return nil }
        delivery = .uncertain // Set BEFORE networking: a lost response must never authorize another POST.
        requestActive = true
        canRetry = false
        phase = .thinking
        failure = nil
        return .upload(utterance)
    }
    mutating func retryByUser() -> Request? {
        guard canRetry, !requestActive, let utterance else { return nil }
        if delivery == .absent { return beginUpload() }
        return beginPoll(id: utterance.id)
    }
    mutating func resumePoll() -> Request? {
        guard phase == .thinking, !requestActive, delivery != .absent, let utterance else { return nil }
        return beginPoll(id: utterance.id)
    }
    private mutating func beginPoll(id: UUID) -> Request {
        requestActive = true
        canRetry = false
        phase = .thinking
        failure = nil
        return .poll(id)
    }
    mutating func receivedHeard(_ text: String) {
        requestActive = false
        delivery = .accepted
        heard = text
    }
    mutating func receivedWorking() { requestActive = false; delivery = .accepted }
    mutating func receivedReply(_ text: String) {
        requestActive = false
        phase = .reply
        reply = text
        canRetry = false
    }
    mutating func receivedFailure(_ reason: WatchTalkFailure, polling: Bool) {
        requestActive = false
        if polling && reason == .turn_not_found { delivery = .absent }
        phase = .failure
        failureScreen = reason.screen
        failure = reason.message
        canRetry = utterance != nil && (reason == .turn_not_found || reason == .busy || reason == .service_unavailable || reason.needsCredential)
    }
    mutating func transportFailed(screen: FailureScreen = .network) {
        requestActive = false
        phase = .failure
        failureScreen = screen
        failure = screen == .network ? "连接中断。请重试，确认这句话的回复。" : "暂时联系不上她，请稍后重试。"
        canRetry = utterance != nil
    }
    mutating func recordingFailed(_ message: String, screen: FailureScreen = .microphone) {
        phase = .failure; failure = message; failureScreen = screen; canRetry = false
    }
    mutating func prolongedThinking() {
        guard phase == .thinking else { return }
        failureScreen = .delayed
        failure = "她还在想，稍后抬手看看。"
    }
    mutating func pausePoll() { requestActive = false }
    mutating func reset() { self = Self() }
}
