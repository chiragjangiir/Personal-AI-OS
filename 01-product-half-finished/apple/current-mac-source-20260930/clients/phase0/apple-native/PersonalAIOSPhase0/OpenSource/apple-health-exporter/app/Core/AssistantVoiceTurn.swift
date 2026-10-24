import Foundation

struct CentralVoiceCandidate: Equatable, Sendable, Identifiable {
    let candidateRef: String
    let candidateRevision: String
    let windowRef: String
    let selectedInputSHA256: String
    let transcript: String
    let transcriptSHA256: String
    var id: String { candidateRef + ":" + candidateRevision }
}

/// One push-to-talk turn on the formal channel. Central PCM cuts the window and the frontend only proposes
/// candidates; nothing becomes a request until voice_send names one exact transcript. The commit receipt's
/// event_id is the turn's D, which the consumer then follows exactly like a text submit.
struct CentralVoiceTurn: Equatable, Sendable {
    /// `unconfirmed`: terminal. voice_send left (or may have) but no admission came back within the bounded wait, or
    /// central could only answer that the outcome is unknown. It never holds the next request; a late admission still
    /// marks it sent, and within its own source session the identical packet may be resent.
    enum Phase: Equatable, Sendable { case idle, opening, recording, committing, transcribing, ready, sending, unconfirmed, sent, failed }
    private(set) var operationID: String?
    private(set) var phase: Phase = .idle
    private(set) var eventID: String?
    private(set) var candidates: [CentralVoiceCandidate] = []
    private(set) var selectedCandidate: CentralVoiceCandidate?
    private(set) var preview = ""
    private(set) var errorCode: String?
    /// The exact voice_send packet of this turn, kept for an unchanged resend while its outcome is unknown.
    private(set) var sentPacket: Data?

    static let activePhases: Set<Phase> = [.opening, .recording, .committing, .transcribing, .ready, .sending]
    static let unknownOutcomeCodes: Set<String> = ["VOICE_PROCESS_FAILED", "FORMAL_TEXT_REQUEST_FAILED", "VOICE_SEND_OUTCOME_UNKNOWN"]
    /// The window ended with only empty transcripts: nothing was heard.
    static let noSpeechCode = "VOICE_NO_SPEECH"
    var isActive: Bool { Self.activePhases.contains(phase) }
    /// What a hold-to-talk UI tells the owner when the turn ended before anything was sent (a sent turn's outcome is on
    /// its own message).
    var unsentOutcome: String? {
        guard phase == .failed, sentPacket == nil else { return nil }
        return errorCode == Self.noSpeechCode ? "没听清，请按住再说一次" : "这句语音没发出去，请按住再说一次"
    }
    var status: String {
        switch phase {
        case .idle: return "按住说话"
        case .opening: return "正在打开录音窗口"
        case .recording: return "录音中，松开结束"
        case .committing: return "正在提交录音窗口"
        case .transcribing: return preview.isEmpty ? "正在转写" : "正在转写：" + preview
        case .ready: return "请确认要发送的原文"
        case .sending: return "原文发送中；确认尚未记录"
        case .unconfirmed: return "未确认是否送达；可重发这段文字"
        case .sent: return "已发送；按住再说一句"
        case .failed: return "语音未完成：" + (errorCode ?? "unknown")
        }
    }

    mutating func open(operationID: String) throws -> Data {
        guard !isActive else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voice("voice_open", operationID: operationID)
        self = CentralVoiceTurn()
        self.operationID = operationID
        phase = .opening
        return bytes
    }
    // Commit only after the recording receipt: central handles packets concurrently, so open must land first.
    mutating func commit() throws -> Data {
        guard let operationID, phase == .recording else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voice("voice_commit", operationID: operationID)
        phase = .committing
        return bytes
    }
    func candidatesRequest() throws -> Data {
        guard let operationID, phase == .transcribing else { throw CentralTextError.unavailable }
        return try AssistantCentralTextWire.voice("voice_candidates", operationID: operationID)
    }
    mutating func send(_ candidate: CentralVoiceCandidate) throws -> (bytes: Data, eventID: String) {
        guard let operationID, let eventID, phase == .ready, candidates.contains(candidate) else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voice("voice_send", operationID: operationID, candidate: candidate)
        phase = .sending
        selectedCandidate = candidate
        sentPacket = bytes
        return (bytes, eventID)
    }
    /// No confirmation within the bounded wait: the outcome is unknown, shown as such.
    mutating func markUnconfirmed() {
        if phase == .sending { phase = .unconfirmed }
    }
    /// Resends the identical original packet (same operation and candidate; the server's receipt is idempotent).
    mutating func resend() throws -> Data {
        guard phase == .unconfirmed, let sentPacket else { throw CentralTextError.unavailable }
        phase = .sending
        return sentPacket
    }
    /// The turn's D was admitted: that proves the voice_send landed even when its own receipt was lost.
    mutating func admissionObserved(eventID: String) {
        if eventID == self.eventID, sentPacket != nil, [.sending, .unconfirmed, .failed].contains(phase) {
            phase = .sent
            errorCode = nil
        }
    }
    /// A receipt that never came fails the turn visibly so the button works again; central gets a close for the window.
    mutating func expire(_ code: String) throws -> Data? {
        guard let operationID, isActive, phase != .sending else { return nil }
        let bytes = try AssistantCentralTextWire.voice("voice_close", operationID: operationID)
        phase = .failed
        errorCode = code
        return bytes
    }
    /// The close for a window that ended without speech (central keeps it until the client closes it).
    func closeRequest() throws -> Data? {
        guard let operationID, phase == .failed, errorCode == Self.noSpeechCode else { return nil }
        return try AssistantCentralTextWire.voice("voice_close", operationID: operationID)
    }
    /// Drops the local turn at once; a late receipt for the closed operation is ignored.
    mutating func close() throws -> Data? {
        defer { self = CentralVoiceTurn() }
        guard let operationID, isActive, phase != .sending else { return nil }
        return try AssistantCentralTextWire.voice("voice_close", operationID: operationID)
    }

    mutating func accept(_ fields: CentralBody) throws {
        guard let operationID, try fields.value("operation_id", as: String.self) == operationID,
              phase != .failed, phase != .sent else { return }
        if let code = try fields.value("error_code", as: String.self) {
            // These answers do not say whether the sent request was admitted: the turn ends unconfirmed, not failed.
            if sentPacket != nil, Self.unknownOutcomeCodes.contains(code) {
                phase = .unconfirmed
                errorCode = code
                return
            }
            phase = .failed
            errorCode = code
            return
        }
        switch try fields.value("source_status", as: String.self) {
        case "recording":
            guard phase == .opening else { throw CentralTextError.contextChanged() }
            phase = .recording
        case "pending":
            guard phase == .committing, let event = try fields.value("event_id", as: String.self) else { throw CentralTextError.contextChanged() }
            eventID = event
            phase = .transcribing
        case "candidates":
            guard phase == .transcribing || phase == .ready else { return }
            var transcripts: [CentralVoiceCandidate] = []
            for item in try fields.value("candidates", as: [CentralBody].self) ?? [] {
                let kind = try item.value("kind", as: String.self)
                if kind == "partial", let text = try item.value("preview", as: String.self) ?? item.value("transcript", as: String.self) { preview = text }
                guard kind == "transcript", let text = try item.value("transcript", as: String.self),
                      let digest = try item.value("transcript_sha256", as: String.self),
                      let ref = try item.value("candidate_ref", as: String.self),
                      let revision = try item.value("candidate_revision", as: String.self),
                      let window = try item.value("window_ref", as: String.self),
                      let selected = try item.value("selected_input_sha256", as: String.self) else { continue }
                transcripts.removeAll { $0.candidateRef == ref }
                transcripts.append(CentralVoiceCandidate(candidateRef: ref, candidateRevision: revision, windowRef: window,
                    selectedInputSHA256: selected, transcript: text, transcriptSHA256: digest))
            }
            // Only a spoken transcript can be sent; a window whose transcripts are all empty heard nothing.
            let spoken = transcripts.filter { !$0.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            if !spoken.isEmpty { candidates = spoken; phase = .ready }
            else if !transcripts.isEmpty, phase == .transcribing { phase = .failed; errorCode = Self.noSpeechCode }
        case "confirmation_recorded":
            guard phase == .sending || phase == .unconfirmed else { throw CentralTextError.contextChanged() }
            // Selection was recorded; only the D admission proves the request was accepted.
            break
        case "cancel_requested":
            self = CentralVoiceTurn()
        default:
            if phase != .sent { phase = .failed; errorCode = "VOICE_STATUS_UNKNOWN" }
        }
    }
}
