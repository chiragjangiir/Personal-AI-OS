import Foundation
import LocalAuthentication

enum CentralVoiceBiometrics {
    static func faceID() async throws {
        let context = LAContext()
        defer { context.invalidate() }
        context.localizedFallbackTitle = ""
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
              context.biometryType == .faceID else {
            throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_FACE_ID_UNAVAILABLE")
        }
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "确认刚才这句话是你说的") else {
                throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_FACE_ID_FAILED")
            }
        } catch {
            throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_FACE_ID_FAILED")
        }
    }
}

/// The owner profile as central reports it; embeddings and the speaker model never reach the phone.
struct CentralVoiceprintOwner: Equatable, Sendable {
    let enrolled: Bool
    let reenrollmentRequired: Bool
    let samples: Int
    let updatedAt: Date?
    init(_ fields: CentralBody) throws {
        guard let enrolled = try fields.value("enrolled", as: Bool.self),
              let reenrollment = try fields.value("reenrollment_required", as: Bool.self),
              let samples = try fields.value("samples", as: Int.self) else { throw CentralTextError.invalidPacket }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.enrolled = enrolled; reenrollmentRequired = reenrollment; self.samples = samples
        updatedAt = try fields.value("updated_at", as: String.self).flatMap(formatter.date(from:))
    }
}

/// Natural enrollment is a server-owned draft, separate from payment sentence samples.
struct CentralVoiceEnrollment: Equatable, Sendable {
    enum Phase: String, Sendable { case idle, collecting, paused, checked, committed, discarded }
    private(set) var phase: Phase = .idle
    private(set) var available = false
    private(set) var sessionID: String?
    private(set) var callID: String?
    private(set) var recordedMS = 0
    private(set) var previewAudio: Data?
    private(set) var cleanSpeechMS = 0
    private(set) var targetSpeechMS = 0
    private(set) var issue: String?
    private(set) var canUse = false
    private(set) var sourceDevice: String?
    private(set) var owner: CentralVoiceprintOwner?
    private(set) var pending: String?
    private(set) var controlError: String?

    mutating func control(_ action: String, id: String, callID: String?) throws -> Data {
        guard pending == nil else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voiceEnrollment(action, controlID: id, sessionID: sessionID, callID: callID)
        pending = id; controlError = nil
        return bytes
    }
    mutating func expire(_ id: String, code: String) {
        guard pending == id else { return }
        pending = nil; controlError = code
    }
    mutating func accept(_ fields: CentralBody) throws {
        if try fields.value("operation", as: String.self) == "rejected" {
            if let id = try fields.value("control_id", as: String.self) { expire(id, code: try fields.value("error_code", as: String.self) ?? "VOICE_ENROLLMENT_REJECTED") }
            return
        }
        let controlID = try fields.value("control_id", as: String.self)
        if let controlID, controlID != pending { return }
        guard let body = try fields.value("enrollment", as: CentralBody.self),
              let phase = try body.value("phase", as: String.self).flatMap(Phase.init),
              let available = try body.value("available", as: Bool.self),
              let recorded = try body.value("recorded_ms", as: Int.self),
              let clean = try body.value("clean_speech_ms", as: Int.self),
              let target = try body.value("target_speech_ms", as: Int.self),
              let canUse = try body.value("can_use", as: Bool.self), recorded >= 0, clean >= 0, target >= 0 else { throw CentralTextError.invalidPacket }
        let session = try body.value("session_id", as: String.self)
        if controlID == nil, let sessionID, session != sessionID { return }
        var next = self
        next.phase = phase; next.available = available; next.cleanSpeechMS = clean; next.targetSpeechMS = target
        next.recordedMS = recorded; next.previewAudio = nil
        if let encoded = try body.value("preview_audio_base64", as: String.self) {
            guard let audio = Data(base64Encoded: encoded) else { throw CentralTextError.invalidPacket }
            next.previewAudio = audio
        }
        next.sessionID = session; next.callID = try body.value("call_id", as: String.self)
        next.canUse = canUse; next.issue = try body.value("issue", as: String.self)
        next.sourceDevice = try body.value("source_device", as: CentralBody.self)?.value("device_type", as: String.self)
        next.owner = try body.value("owner", as: CentralBody.self).map(CentralVoiceprintOwner.init)
        if controlID != nil { next.pending = nil; next.controlError = nil }
        self = next
    }
}

/// One measured sentence. Only an `ok` sample has an id and counts toward the profile.
struct CentralVoiceprintSample: Equatable, Sendable {
    enum Quality: String, Sendable { case ok, tooShort = "too_short", noSpeech = "no_speech" }
    let sampleID: String?
    let speechMS: Int
    let quality: Quality
}

struct CentralVoiceDevice: Decodable, Equatable, Sendable, Identifiable {
    let device_id: String
    let device_type: String
    let name: String?
    var id: String { device_id }
    var title: String { name ?? ["phone": "iPhone", "glasses": "眼镜", "watch": "Apple Watch", "mac": "Mac"][device_type] ?? device_type }
}

/// 录入我的声音 on the formal channel: one sentence window at a time on the published microphone (open → recording →
/// commit → measured; central archives it only, never as a request), and the owner controls (read / enroll / forget),
/// each answered by `voiceprint_owner` for its control id. The registry on the Mac alone judges a committed set.
struct CentralVoiceprint: Equatable, Sendable {
    enum Phase: Equatable, Sendable { case idle, opening, recording, measuring, measured, failed }
    struct Control: Equatable, Sendable { let id: String; let operation: String }
    /// The registry's verdict on the last commit: `rejected` names the samples that did not sound like the rest.
    struct Enrollment: Equatable, Sendable { let enrolled: Bool; let rejected: Set<String> }

    private(set) var operationID: String?
    private(set) var phase: Phase = .idle
    private(set) var sample: CentralVoiceprintSample?
    private(set) var errorCode: String?
    private(set) var owner: CentralVoiceprintOwner?
    private(set) var pending: Control?
    private(set) var enrollment: Enrollment?
    private(set) var controlError: String?

    private(set) var voiceDevices: [CentralVoiceDevice] = []
    private(set) var activeVoiceDeviceID: String?
    private(set) var trustConfirmationID: String?

    var isWindowActive: Bool { [.opening, .recording, .measuring].contains(phase) }

    mutating func open(operationID: String) throws -> Data {
        guard !isWindowActive else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voiceprintWindow("voiceprint_open", operationID: operationID)
        self.operationID = operationID
        phase = .opening; sample = nil; errorCode = nil
        return bytes
    }
    // Commit only after the recording receipt: central handles packets concurrently, so open must land first.
    mutating func commit() throws -> Data {
        guard let operationID, phase == .recording else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voiceprintWindow("voiceprint_commit", operationID: operationID)
        phase = .measuring
        return bytes
    }
    /// Drops an opening/recording window at once; a late answer for it is ignored.
    mutating func cancel() throws -> Data? {
        guard let operationID, phase == .opening || phase == .recording else { return nil }
        let bytes = try AssistantCentralTextWire.voiceprintWindow("voiceprint_cancel", operationID: operationID)
        self.operationID = nil; phase = .idle
        return bytes
    }
    /// A receipt that never came fails the window visibly so the button works again.
    mutating func expire(_ code: String) {
        guard isWindowActive else { return }
        phase = .failed; errorCode = code
    }
    mutating func control(_ operation: String, controlID: String, sampleIDs: [String]? = nil, sourceDeviceID: String? = nil) throws -> Data {
        let bytes = try AssistantCentralTextWire.voiceprintControl(operation, controlID: controlID, sampleIDs: sampleIDs, sourceDeviceID: sourceDeviceID)
        pending = Control(id: controlID, operation: operation); controlError = nil
        if operation == "voiceprint_enroll" { enrollment = nil }
        if operation == "voice_trust_window_open" { trustConfirmationID = nil }
        return bytes
    }
    mutating func expireControl(_ controlID: String, code: String) {
        guard pending?.id == controlID else { return }
        pending = nil; controlError = code
    }

    mutating func accept(_ fields: CentralBody) throws {
        switch try fields.value("operation", as: String.self) {
        case "voiceprint_sample":
            guard let operationID, try fields.value("operation_id", as: String.self) == operationID else { return }
            switch try fields.value("status", as: String.self) {
            case "recording":
                if phase == .opening { phase = .recording }
            case "measured":
                guard phase == .measuring, let quality = try fields.value("quality", as: String.self).flatMap(CentralVoiceprintSample.Quality.init),
                      let speech = try fields.value("speech_ms", as: Int.self) else { return }
                let id = try fields.value("sample_id", as: String.self)
                guard (quality == .ok) == (id != nil) else { throw CentralTextError.invalidPacket }
                sample = CentralVoiceprintSample(sampleID: id, speechMS: speech, quality: quality)
                phase = .measured
            case "failed":
                guard isWindowActive else { return }
                phase = .failed; errorCode = try fields.value("error_code", as: String.self) ?? "VOICEPRINT_SAMPLE_FAILED"
            default:
                return
            }
        case "voice_trust_window_opened":
            guard let pending, try fields.value("control_id", as: String.self) == pending.id else { return }
            guard let id = try fields.value("confirmation_id", as: String.self) else { throw CentralTextError.invalidPacket }
            trustConfirmationID = id; self.pending = nil
        case "voiceprint_owner":
            guard let body = try fields.value("owner", as: CentralBody.self) else { throw CentralTextError.invalidPacket }
            owner = try CentralVoiceprintOwner(body)
            voiceDevices = try fields.value("voice_devices", as: [CentralVoiceDevice].self) ?? []
            activeVoiceDeviceID = try fields.value("active_voice_device_id", as: String.self)
            guard let pending, try fields.value("control_id", as: String.self) == pending.id else { return }
            if let result = try fields.value("enrollment", as: CentralBody.self) {
                let rejected = try (result.value("samples", as: [CentralBody].self) ?? []).compactMap { sample -> String? in
                    try sample.value("ok", as: Bool.self) == false ? sample.value("sample_id", as: String.self) : nil
                }
                enrollment = Enrollment(enrolled: try result.value("status", as: String.self) == "enrolled", rejected: Set(rejected))
            }
            self.pending = nil
        case "rejected":
            let code = try fields.value("error_code", as: String.self) ?? "unknown"
            if let pending, try fields.value("control_id", as: String.self) == pending.id {
                self.pending = nil; controlError = code
            } else if try fields.value("request_operation", as: String.self)?.hasPrefix("voiceprint_") == true, isWindowActive {
                phase = .failed; errorCode = code
            }
        default:
            return
        }
    }
}

/// One pending "确认是我": what was heard and until when it can be answered (central's remaining TTL from arrival). The
/// confirmed request is the D `eventID`, followed like any submission.
enum CentralVoiceConfirmationChoice: String, Sendable { case approve, deny }

struct CentralVoiceConfirmation: Equatable, Sendable, Identifiable {
    let id: String
    let eventID: String
    let text: String?
    let kind: String?
    let purpose: String?
    var isNativeApproval: Bool { kind == "native_approval" }
    let deadline: Date
    init(_ fields: CentralBody, receivedAt: Date) throws {
        guard let id = try fields.value("confirmation_id", as: String.self), let event = try fields.value("event_id", as: String.self),
              let remaining = try fields.value("expires_in_ms", as: Int.self) else { throw CentralTextError.invalidPacket }
        self.id = id; eventID = event; text = try fields.value("text", as: String.self)
        kind = try fields.value("kind", as: String.self)
        purpose = try fields.value("purpose", as: String.self)
        deadline = receivedAt.addingTimeInterval(Double(remaining) / 1000)
        guard !isNativeApproval || text?.isEmpty == false else { throw CentralTextError.invalidPacket }
    }
}

/// A wake turn heard by 随身模式 and 依米's answer to it (one bounded text; its D is projected by central, not followed).
struct AssistantReminder: Equatable, Sendable {
    let id: String
    let text: String
    let fireAt: Date
    init(_ fields: CentralBody) throws {
        let formatter = ISO8601DateFormatter()
        guard let id = try fields.value("id", as: String.self), !id.isEmpty,
              let text = try fields.value("text", as: String.self), !text.isEmpty,
              let raw = try fields.value("fire_at", as: String.self) else { throw CentralTextError.invalidPacket }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: raw)
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = fractional ?? formatter.date(from: raw) else { throw CentralTextError.invalidPacket }
        self.id = id; self.text = text; self.fireAt = date
    }
}

struct CentralAmbientReply: Equatable, Sendable, Identifiable {
    let privacy: AssistantReplyPrivacy?
    let reminderID: String?
    let id: String
    let heard: String
    let text: String
    init(id: String, heard: String, text: String, privacy: AssistantReplyPrivacy? = nil) {
        self.id = id; self.heard = heard; self.text = text; reminderID = nil; self.privacy = privacy
    }
    init(_ fields: CentralBody) throws {
        guard let id = try fields.value("processed_event_id", as: String.self), let heard = try fields.value("heard", as: String.self),
              let text = try fields.value("text", as: String.self) else { throw CentralTextError.invalidPacket }
        self.id = id; self.heard = heard; self.text = text
        privacy = try fields.value("private", as: AssistantReplyPrivacy.self)
        reminderID = try fields.value("reminder_id", as: String.self)
    }
}

struct CentralQuestion: Equatable, Sendable, Identifiable {
    struct Option: Equatable, Sendable, Identifiable {
        let id: String; let label: String; let lines: [String]; let recommended: Bool
        init(_ fields: CentralBody) throws {
            guard let id = try fields.value("id", as: String.self), let label = try fields.value("label", as: String.self),
                  let lines = try fields.value("lines", as: [String].self) else { throw CentralTextError.invalidPacket }
            self.id = id; self.label = label; self.lines = lines
            recommended = try fields.value("recommended", as: Bool.self) ?? false
        }
    }
    let id: String; let question: String?; let options: [Option]; let deadline: Date; let expiresAt: String
    init(_ fields: CentralBody) throws {
        guard let id = try fields.value("card_id", as: String.self), let rows = try fields.value("options", as: [CentralBody].self),
              let expires = try fields.value("expires_at", as: String.self) else { throw CentralTextError.invalidPacket }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let deadline = formatter.date(from: expires) else { throw CentralTextError.invalidPacket }
        self.id = id; self.deadline = deadline; self.expiresAt = expires; question = try fields.value("question", as: String.self)
        options = try rows.map(Option.init)
    }
}

/// Captured source identity and option IDs survive awaits; the source revalidates before sending.
struct AssistantQuestionSelection: Equatable, Sendable {
    let identity: String
    let cardID: String
    let optionID: String

    func text(for card: CentralQuestion, now: Date) throws -> String {
        guard card.id == cardID, card.deadline > now,
              let index = card.options.firstIndex(where: { $0.id == optionID }) else { throw CentralTextError.contextChanged() }
        return "就选第\(index + 1)项：\(card.options[index].label)（仅选择，不授权付款、身份或记忆写入）"
    }
}

/// Owner-voice state that lives beside submissions for the whole session (a new request never clears it, a session
/// reset does): enrollment, the pushed "确认是我" prompts and the replies to 随身模式 wake turns.
struct CentralOwnerVoice: Equatable, Sendable {
    var voiceprint = CentralVoiceprint()
    var enrollment = CentralVoiceEnrollment()
    private(set) var questionCard: CentralQuestion?
    private(set) var confirmations: [CentralVoiceConfirmation] = []
    /// Taps in flight: confirmation id → the confirmed request's event id (followed as an observation).
    private(set) var confirming: [String: String] = [:]
    private(set) var confirmationError: String?
    private(set) var careCheckins: [CentralAmbientReply] = []
    private(set) var careControl: String?
    private(set) var careOutcome: String?
    private(set) var careError: String?
    mutating func careSafe(controlID: String) throws -> Data {
        guard careControl == nil || careControl == controlID else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.careSafe(controlID: controlID)
        careControl = controlID; careOutcome = nil; careError = nil
        return bytes
    }
    mutating func expireCare(_ controlID: String) {
        guard careControl == controlID else { return }
        careControl = nil; careError = "CARE_ACK_TIMEOUT"
    }
    private(set) var ambientReplies: [CentralAmbientReply] = []
    private(set) var reminders: [AssistantReminder]?
    private var reminderSyncID: String?
    private var reminderPart = 0
    private var reminderParts: [AssistantReminder] = []

    static func handles(_ fields: CentralBody) throws -> Bool {
        switch try fields.value("operation", as: String.self) {
        case "voice_enrollment_state", "gesture_card", "voiceprint_sample", "voiceprint_owner", "voice_trust_window_opened", "voice_confirmations", "voice_confirmation_decided", "ambient_reply", "care_checkin", "care_safe_ack", "reminders_sync": return true
        case "rejected":
            let request = try fields.value("request_operation", as: String.self) ?? ""
            return request == "voice_enrollment_control" || request.hasPrefix("voiceprint_") || request == "voice_trust_window_open" || request == "voice_confirm" || request == "care_safe"
        default: return false
        }
    }
    /// Applies one packet; returns the event ids of confirmations whose tap was refused (their observation is dropped).
    mutating func accept(_ fields: CentralBody, now: Date = Date()) throws -> [String] {
        switch try fields.value("operation", as: String.self) {
        case "voice_enrollment_state": try enrollment.accept(fields)
        case "rejected" where try fields.value("request_operation", as: String.self) == "voice_enrollment_control": try enrollment.accept(fields)
        case "gesture_card": questionCard = try CentralQuestion(fields)
        case "reminders_sync":
            guard let rows = try fields.value("reminders", as: [CentralBody].self) else { throw CentralTextError.invalidPacket }
            guard let syncID = try fields.value("sync_id", as: String.self),
                  let part = try fields.value("part", as: Int.self),
                  let final = try fields.value("final", as: Bool.self) else { throw CentralTextError.invalidPacket }
            let page = try rows.map(AssistantReminder.init)
            if part == 0 { reminderSyncID = syncID; reminderPart = 0; reminderParts = [] }
            guard reminderSyncID == syncID, part == reminderPart else { throw CentralTextError.contextChanged() }
            let snapshot = reminderParts + page
            guard Set(snapshot.map(\.id)).count == snapshot.count else { throw CentralTextError.invalidPacket }
            reminderParts = snapshot; reminderPart += 1
            if final { reminders = snapshot; reminderSyncID = nil; reminderParts = [] }
        case "voice_confirmations":
            confirmations = try (fields.value("confirmations", as: [CentralBody].self) ?? []).map { try CentralVoiceConfirmation($0, receivedAt: now) }
            // A snapshot can remove an expired card. Only a decision, rejection or timeout settles its tap.
        case "voice_confirmation_decided":
            guard let id = try fields.value("confirmation_id", as: String.self) else { throw CentralTextError.invalidPacket }
            confirming.removeValue(forKey: id)
            confirmations.removeAll { $0.id == id }
        case "care_checkin":
            guard let id = try fields.value("care_id", as: String.self), let text = try fields.value("text", as: String.self) else { throw CentralTextError.invalidPacket }
            if !careCheckins.contains(where: { $0.id == id }) {
                careCheckins.append(CentralAmbientReply(id: id, heard: "", text: text))
                if careCheckins.count > 16 { careCheckins.removeFirst(careCheckins.count - 16) }
            }
        case "care_safe_ack":
            guard let careControl, try fields.value("control_id", as: String.self) == careControl,
                  let cancelled = try fields.value("cancelled", as: Int.self) else { return [] }
            self.careControl = nil; careCheckins.removeAll()
            careOutcome = cancelled > 0 ? "已告诉依米你没事，已取消待发送的紧急提醒" : "已告诉依米你没事"
        case "rejected" where try fields.value("request_operation", as: String.self) == "care_safe":
            guard let careControl, try fields.value("control_id", as: String.self) == careControl else { return [] }
            self.careControl = nil; careError = try fields.value("error_code", as: String.self) ?? "unknown"
        case "ambient_reply":
            let reply = try CentralAmbientReply(fields)
            guard !ambientReplies.contains(where: { $0.id == reply.id }) else { return [] }
            ambientReplies.append(reply)
            if ambientReplies.count > 16 { ambientReplies.removeFirst(ambientReplies.count - 16) }
        case "rejected" where try fields.value("request_operation", as: String.self) == "voice_confirm":
            confirmationError = try fields.value("error_code", as: String.self) ?? "unknown"
            defer { confirming.removeAll() }
            return Array(confirming.values)
        default:
            try voiceprint.accept(fields)
        }
        return []
    }
    /// The prompt a tap may confirm: pending, not past its deadline, not already in flight.
    func confirmable(_ id: String, now: Date = Date()) -> CentralVoiceConfirmation? {
        confirmations.first { $0.id == id && $0.deadline > now && confirming[id] == nil }
    }
    mutating func confirm(_ id: String, choice: CentralVoiceConfirmationChoice? = nil, auth: String? = nil, now: Date = Date()) throws -> Data {
        guard let item = confirmable(id, now: now) else { throw CentralTextError.unavailable }
        guard item.isNativeApproval == (choice != nil) else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.voiceConfirm(confirmationID: id, choice: choice, auth: auth)
        confirming[id] = item.eventID; confirmationError = nil
        return bytes
    }
    /// No answer in time: the tap is no longer shown as in flight (the prompt stays while central still lists it).
    mutating func expireConfirm(_ id: String) -> String? { confirming.removeValue(forKey: id) }
}

/// A voiceprint or "确认是我" step that central refused or never answered; `code` is central's (or a local timeout).
struct CentralVoiceprintFailure: Error, Equatable, Sendable { let code: String }
