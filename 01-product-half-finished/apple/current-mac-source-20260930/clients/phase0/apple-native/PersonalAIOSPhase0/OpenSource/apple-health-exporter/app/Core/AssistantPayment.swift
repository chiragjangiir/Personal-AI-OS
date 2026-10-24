import Foundation
import CryptoKit

enum CentralPaymentState: String, Codable, Sendable, CaseIterable {
    case awaiting_owner
    case auto_pending
    case verifying
    case granted
    case paying
    case paid
    case outcome_unknown
    case cancelled
    case expired
    case superseded
    case failed
}

enum CentralPaymentReason: String, Codable, Sendable, CaseIterable {
    case INITIATING_NOT_VOICE
    case INITIATING_NOT_OWNER_VERIFIED
    case DIFFERENT_TERMINAL
    case TERMINAL_LOCKED
    case REQUEST_STALE
    case OVER_AUTO_LIMIT
    case OVER_AUTO_DAY_LIMIT
    case OVER_VOICE_LIMIT
    case OVER_BUDGET
    case NEW_PAYEE
    case PAYEE_UNREADABLE
    case SAME_PAYEE_RECENT
    case AUTO_PAUSED
    case VOICE_NOT_RECOGNIZED
    case VOICE_INSUFFICIENT
    case VOICE_ATTEMPTS_EXHAUSTED
    case VOICE_UNAVAILABLE
    case VOICE_DISABLED
    case AUTO_DISABLED
    case LOCKS_NOT_ENABLED
    case AMOUNT_CHANGED
    case AUTO_INTERRUPTED
}

struct CentralPaymentLimits: Codable, Sendable {
    let auto_order_fen: Int
    let auto_day_fen: Int
    let voice_order_fen: Int
}

struct CentralPaymentMethods: Codable, Sendable {
    let voice: CentralPaymentVoiceMethod
    let auto: CentralPaymentAutoMethod
}

struct CentralPaymentVoiceMethod: Codable, Sendable {
    let available: Bool
    let reason: CentralPaymentReason?
    let tries_left: Int
}

struct CentralPaymentAutoMethod: Codable, Sendable {
    let available: Bool
    let reason: CentralPaymentReason?
}

struct CentralPaymentCard: Codable, Sendable, Identifiable {
    var id: String { payment_id }
    let payment_id: String
    let intent_id: String
    let version: Int
    let state: CentralPaymentState
    let amount_fen: Int
    let payee: String?
    let app: String
    let items: [String]
    let delivery: String?
    let expires_in_ms: Int
    let auto_in_ms: Int?
    let decision_nonce: String?
    let payee_key: String?
    let methods: CentralPaymentMethods
    let notice: CentralPaymentNotice?
    let result: CentralPaymentResult?
    let today_auto_used_fen: Int?
}

struct CentralPaymentNotice: Codable, Sendable {
    let reason: CentralPaymentReason
    let amount_fen: Int?
    let previous_amount_fen: Int?
    let limit_fen: Int?
}

struct CentralPaymentResult: Codable, Sendable {
    let method: String?
    let terminal: String?
    let order_cancel: String?
    let finished_ago_ms: Int
}

struct CentralPaymentApproval: Codable, Sendable, Identifiable {
    var id: String { approval_id }
    let approval_id: String
    let kind: String
    let target_device_id: String
    let device_label: String
    let expires_in_ms: Int
    let nonce: String
}

struct CentralPaymentRecordItem: Codable, Sendable, Identifiable {
    var id: String { payment_id }
    let payment_id: String
    let at: String
    let app: String
    let payee: String?
    let summary: String
    let amount_fen: Int
    let state: CentralPaymentState
    let method: String?
    let terminal: String?
}

struct CentralPaymentRecordData: Codable, Sendable {
    let reason: String?
    let state: CentralPaymentState?
    let method: String?
    let decision: String?
    let amount_fen: Int?
    let old_amount_fen: Int?
    let read_amount_fen: Int?
    let payee: String?
    let items: [String]?
    let outcome: String?
    let detail: String?
    let verdict: String?
    let tries_left: Int?
    let change_kind: String?
    let signed: Bool?
    let enabled: Bool?
    let relock_s: Int?
    let cause: String?
    let turned_off: [String]?
    let until_ms: Int?
    let kind: String?
    let decision_label: String?
}

struct CentralPaymentCards: Codable, Sendable {
    let complete: Bool
    let cards: [CentralPaymentCard]
}

struct CentralPaymentNoticeSnapshot: Codable, Sendable {
    let notice: CentralPaymentNoticeValue?
}

struct CentralPaymentSettings: Codable, Sendable {
    let request_id: String?
    let wire_version: Int
    let policy_version: Int
    let voice_enabled: Bool
    let auto_enabled: Bool
    let paused_until: String?
    let limits: CentralPaymentLimits
    let limit_max_fen: Int
    let today_auto_used_fen: Int
    let locks: CentralPaymentLocks
    let voiceprint: CentralPaymentVoiceprint
    let keys: CentralPaymentKeys
    let prerequisites: CentralPaymentPrerequisites
}

struct CentralPaymentLocks: Codable, Sendable {
    let phone: CentralPaymentPhone
    let glasses: CentralPaymentGlasses
}

struct CentralPaymentPhone: Codable, Sendable {
    let enabled: Bool
    let relock_s: Int
    let relock_choices_s: [Int]
    let unlocked: Bool
}

struct CentralPaymentGlasses: Codable, Sendable {
    let paired: Bool
    let device_id: String?
    let enabled: Bool
    let unlocked: Bool
    let worn: Bool
}

struct CentralPaymentVoiceprint: Codable, Sendable {
    let phone_app: Bool
    let glasses: Bool
}

struct CentralPaymentKeys: Codable, Sendable {
    let device: Bool
    let user: Bool
    let registered_at: String?
}

struct CentralPaymentPrerequisites: Codable, Sendable {
    let voice: [String]
    let auto: [String]
}

struct CentralPaymentLockState: Codable, Sendable {
    let lock_enabled: Bool
    let locked: Bool
    let reason: String?
    let approval_expires_in_ms: Int?
    let wear_poll_ms: Int
    let lock_cycle: Int?
    let enrolment: CentralPaymentEnrolment?
}

struct CentralPaymentEnrolment: Codable, Sendable {
    let granted: Bool
    let expires_in_ms: Int?
    let sentences: [String]?
}

struct CentralPaymentApprovals: Codable, Sendable {
    let complete: Bool
    let approvals: [CentralPaymentApproval]
}

struct CentralPaymentChallenge: Codable, Sendable {
    let request_id: String
    let purpose: String
    let nonce: String
    let expires_in_ms: Int
}

struct CentralPaymentReceipt: Codable, Sendable {
    let control_id: String
    let ok: Bool
    let error_code: String?
    let missing: [String]?
    let payment_id: String?
    let state: CentralPaymentState?
}

struct CentralPaymentRecords: Codable, Sendable {
    let request_id: String
    let items: [CentralPaymentRecordItem]
    let next_before: String?
}

struct CentralPaymentRecord: Codable, Sendable {
    let request_id: String
    let payment: CentralPaymentRecordDetail
    let timeline: [CentralPaymentTimeline]
    let next_seq: Int?
}

struct CentralPaymentRecordDetail: Codable, Sendable {
    let payment_id: String
    let at: String
    let app: String
    let payee: String?
    let summary: String
    let amount_fen: Int
    let state: CentralPaymentState
    let method: String?
    let terminal: String?
    let intent_id: String
    let initiating_text: String?
    let order_cancel: String?
}

struct CentralPaymentTimeline: Codable, Sendable {
    let at: String
    let kind: String
    let terminal: String?
    let data: CentralPaymentRecordData
}

// Locked glasses notices intentionally contain no payment details.
struct CentralPaymentNoticeValue: Codable, Sendable {
    let payment_id: String
    let state: CentralPaymentState
    let reason: CentralPaymentReason?
    let expires_in_ms: Int?
    let amount_fen: Int?
    let payee: String?
    let line: String?
    let voice_hint: Bool?
}

struct CentralPaymentChange: Codable, Sendable {
    let kind: String
    var enabled: Bool? = nil
    var auto_order_fen: Int? = nil
    var auto_day_fen: Int? = nil
    var voice_order_fen: Int? = nil
    var relock_s: Int? = nil
    var device_id: String? = nil
    var requiresUserSignature: Bool { !(["voice", "auto"].contains(kind) && enabled == false) }
}

enum AssistantPayment {
    static let contractSHA256 = "02468dc5412c932565d76ebe26fcb9e0f68b165ce178f0af24e657883f07de70"
    static func amount(_ fen: Int) -> String {
        let yuan = fen / 100, fraction = abs(fen % 100)
        if fraction == 0 { return "\(yuan)" }
        return fraction % 10 == 0 ? "\(yuan).\(fraction / 10)" : String(format: "%d.%02d", yuan, fraction)
    }
    static func statement(_ fields: [String: Any]) throws -> Data {
        let bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 2048 else { throw CentralTextError.invalidPacket }
        return bytes
    }
    static func keyRegistrationStatement(deviceID: String, nonce: String, role: String, publicKey: Data) throws -> Data {
        try statement(["purpose": "keys_register", "role": role, "device_id": deviceID, "nonce": nonce,
                       "key_sha256": SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()])
    }
    static func unlockStatement(deviceID: String, nonce: String) throws -> Data {
        try statement(["purpose": "phone_unlock", "device_id": deviceID, "nonce": nonce])
    }
    static func decisionStatement(deviceID: String, card: CentralPaymentCard) throws -> Data {
        guard let nonce = card.decision_nonce else { throw CentralTextError.invalidPacket }
        return try statement(["purpose": "payment_decide", "device_id": deviceID, "payment_id": card.payment_id,
                              "decision": "pay", "amount_fen": card.amount_fen, "payee_key": card.payee_key as Any? ?? NSNull(), "nonce": nonce])
    }
    static func settingsStatement(deviceID: String, nonce: String, policyVersion: Int, change: CentralPaymentChange) throws -> Data {
        try statement(["purpose": "settings", "device_id": deviceID, "nonce": nonce, "policy_version": policyVersion,
                       "change": try object(change)])
    }
    static func approvalStatement(deviceID: String, approval: CentralPaymentApproval) throws -> Data {
        try statement(["purpose": "approval", "device_id": deviceID, "nonce": approval.nonce, "approval_id": approval.approval_id,
                       "kind": approval.kind, "target_device_id": approval.target_device_id, "decision": "approve"])
    }
    static func forgetStatement(deviceID: String, nonce: String, channel: String = "glasses") throws -> Data {
        try statement(["purpose": "voiceprint_forget", "device_id": deviceID, "nonce": nonce, "channel": channel])
    }
    static func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] else { throw CentralTextError.invalidPacket }
        return object
    }
    static func signedFields(statement: Data, signature: Data) -> [String: Any] {
        ["statement_b64": statement.base64EncodedString(), "signature_b64": signature.base64EncodedString()]
    }
    static func errorLine(_ code: String) -> String {
        switch code {
        case "PAYMENT_DEVICE_KEY_UNKNOWN": return "请重新配对这台 iPhone"
        case "PAYMENT_TERMINAL_LOCKED", "GLASSES_LOCKED": return "请先解锁依米，再确认付款"
        case "PAYMENT_EXPIRED", "PAYMENT_CHALLENGE_INVALID", "APPROVAL_EXPIRED": return "确认已过期，请重新操作"
        case "PAYMENT_ALREADY_DECIDED", "PAYMENT_NOT_PENDING": return "这笔付款已处理，请查看最新状态"
        case "PAYMENT_ALREADY_PAYING": return "正在付款，请等待结果"
        case "PAYMENT_POLICY_VERSION_STALE": return "设置已更新，请刷新后重试"
        case "PAYMENT_PREREQUISITE_MISSING": return "请先完成页面列出的支付条件"
        case "PAYMENT_LIMIT_OUT_OF_RANGE": return "金额或锁定时间超出允许范围"
        case "PAYMENT_SIGNATURE_REQUIRED", "PAYMENT_SIGNATURE_INVALID": return "身份确认未通过，请重新确认"
        case "PAYMENT_CHECKPOINT_ACTIVE": return "请先完成或取消一笔进行中的付款"
        case "APPROVAL_BUSY": return "请先处理眼镜上正在等待确认的请求"
        case "PAYMENT_DISABLED": return "支付暂未开放"
        case "GLASSES_NOT_WORN", "APPROVAL_WEAR_CHANGED": return "请戴好眼镜，再发起确认"
        case "GLASSES_NOT_CONNECTED": return "请先连接眼镜"
        default: return "操作未完成，请刷新状态后重试（\(code)）"
        }
    }
}

extension CentralPaymentState {
    var isTerminal: Bool { [.paid, .outcome_unknown, .cancelled, .expired, .superseded, .failed].contains(self) }
    var canDecide: Bool { [.awaiting_owner, .auto_pending, .verifying].contains(self) }
    var title: String {
        switch self {
        case .awaiting_owner: return "等待确认"
        case .auto_pending: return "即将自动付款"
        case .verifying: return "正在核对两句话"
        case .granted, .paying: return "付款中"
        case .paid: return "已付款"
        case .outcome_unknown: return "付款结果待确认"
        case .cancelled: return "已取消"
        case .expired: return "已过期"
        case .superseded: return "金额已更新"
        case .failed: return "未付款"
        }
    }
}

extension CentralPaymentReason {
    func line(limitFen: Int? = nil, usedFen: Int? = nil, budgetFen: Int? = nil, newFen: Int? = nil,
              oldFen: Int? = nil, triesLeft: Int = 0, terminal: String = "iPhone") -> String? {
        func money(_ value: Int?) -> String { value.map(AssistantPayment.amount) ?? "—" }
        switch self {
        case .INITIATING_NOT_VOICE: return "这件事是你打字发起的，没有声音可核对，请点「付款」"
        case .INITIATING_NOT_OWNER_VERIFIED: return "发起这件事那句话没认出是你，这一单要你确认"
        case .DIFFERENT_TERMINAL: return "要在发起这件事的同一台设备上说「付吧」"
        case .TERMINAL_LOCKED: return "\(terminal)还没解锁，不能用声音付款"
        case .REQUEST_STALE: return "离你说这件事已经超过 10 分钟，请点「付款」"
        case .OVER_AUTO_LIMIT: return limitFen == nil ? "超过免密上限，这一单要你确认" : "超过免密上限 ¥\(money(limitFen))，这一单要你确认"
        case .OVER_AUTO_DAY_LIMIT: return usedFen == nil || limitFen == nil ? "今天免密额度不足，这一单要你确认" : "今天免密已用 ¥\(money(usedFen)) / ¥\(money(limitFen))，这一单要你确认"
        case .OVER_VOICE_LIMIT: return limitFen == nil ? "超过声纹支付上限，请点「付款」" : "超过声纹支付上限 ¥\(money(limitFen))，请点「付款」"
        case .OVER_BUDGET: return budgetFen == nil ? "超过你说的预算" : "超过你说的预算 ¥\(money(budgetFen))"
        case .NEW_PAYEE: return "第一次付给这家，先点一次卡片"
        case .PAYEE_UNREADABLE: return "没读到收款方，请点「付款」"
        case .SAME_PAYEE_RECENT: return "30 分钟内同一家第二单，这一单要你确认"
        case .AUTO_PAUSED: return "今天免密已暂停"
        case .VOICE_NOT_RECOGNIZED: return "没听出是你的声音，这次没有付款"
        case .VOICE_INSUFFICIENT: return "声音有点杂，没听清是不是你 · 语音机会还剩 \(triesLeft) 次"
        case .VOICE_ATTEMPTS_EXHAUSTED: return "语音机会用完了，请点「付款」"
        case .VOICE_UNAVAILABLE: return "声纹暂不可用，请点「付款」"
        case .AMOUNT_CHANGED: return newFen == nil || oldFen == nil ? "收银台金额变了，所以没有付" : "收银台金额变成 ¥\(money(newFen))（和你看到的 ¥\(money(oldFen)) 不一样），所以没有付"
        case .AUTO_INTERRUPTED: return "自动付款被打断了，请点「付款」"
        case .VOICE_DISABLED, .AUTO_DISABLED, .LOCKS_NOT_ENABLED: return nil
        }
    }
}

extension AssistantPayment {
    static func validateOutput(operation: String, data: Data) throws {
        let decoder = JSONDecoder()
        switch operation {
        case "payment_cards": _ = try decoder.decode(CentralPaymentCards.self, from: data)
        case "payment_notice": _ = try decoder.decode(CentralPaymentNoticeSnapshot.self, from: data)
        case "payment_settings": _ = try decoder.decode(CentralPaymentSettings.self, from: data)
        case "payment_lock_state": _ = try decoder.decode(CentralPaymentLockState.self, from: data)
        case "payment_approvals": _ = try decoder.decode(CentralPaymentApprovals.self, from: data)
        case "payment_challenge": _ = try decoder.decode(CentralPaymentChallenge.self, from: data)
        case "payment_receipt": _ = try decoder.decode(CentralPaymentReceipt.self, from: data)
        case "payment_records": _ = try decoder.decode(CentralPaymentRecords.self, from: data)
        case "payment_record": _ = try decoder.decode(CentralPaymentRecord.self, from: data)
        default: break
        }
    }
}
