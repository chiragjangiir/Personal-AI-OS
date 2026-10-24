import Foundation

struct AssistantAppearanceQuote: Codable, Equatable, Sendable {
    let quote_id: String
    let price_text: String
    let scope_text: String
}
typealias AssistantAvatarPrice = AssistantAppearanceQuote
extension AssistantAppearanceQuote {
    var priceText: String { price_text }
    var scopeText: String { scope_text }
}
struct AssistantAppearanceLook: Codable, Equatable, Identifiable, Sendable {
    let look_id: String
    let style: String
    let image_url: URL
    let focus: CentralAvatarProfile.Focus
    var id: String { look_id }
}
struct AssistantAppearanceVersion: Codable, Equatable, Identifiable, Sendable {
    let version: Int
    let profile: CentralAvatarProfile?
    var id: Int { version }
}
struct AssistantAppearanceLoadedReceipt: Codable, Equatable, Sendable {
    let device_id: String
    let device_type: String
    let profile_version: Int
    let loaded_at: String
}
struct AssistantAppearanceOptions: Codable, Equatable, Sendable {
    let looks: [AssistantAppearanceLook]
    let preparation_quote: AssistantAppearanceQuote?
    let call_quote: AssistantAppearanceQuote?
    let unavailable_reason: String?
    var photo_upload_available: Bool = false
    var current_preparation: AssistantAppearancePreparation? = nil
    var current_version: Int = 0
    var recent_versions: [AssistantAppearanceVersion] = []
}
struct AssistantAppearancePreparation: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case ready, pending, failed, submission_uncertain, superseded, cancelled }
    let command_id: String
    let status: Status
    let profile: CentralAvatarProfile?
    let error: String?
    var profile_version: Int = 0
    var message: String {
        switch status {
        case .cancelled: return "已取消生效。已提交给视频服务的请求仍需对账，不能保证退款。"
        case .ready: return "新样子已准备好，下一通使用新形象。当前通话继续使用原来的她。"
        case .pending: return "她的新样子正在准备，当前样子继续使用。可以离开此页。"
        case .submission_uncertain: return "准备请求的结果尚未确认。当前样子继续使用，请查询进度，避免重复付费。"
        case .superseded: return "已改用另一项准备请求。当前样子继续使用。"
        case .failed:
            switch error {
            case "AVATAR_QUOTE_CHANGED": return "费用或使用范围已更新，请重新查看后确认。"
            case "AVATAR_VERSION_UNKNOWN": return "这版形象已不在最近三版中，请刷新后重新选择。当前样子继续使用。"
            case "AVATAR_VERSION_CONFLICT": return "形象已在其他终端更新，请刷新后再选择。"
            case "AVATAR_PREPARATION_UNAVAILABLE", "AVATAR_GENERATION_UNAVAILABLE": return "形象准备服务尚未开放。当前样子继续使用。"
            case "provider_rejected": return "视频服务未接受这张图。请换一张后再试。"
            case "processing_timeout": return "视频服务仍未返回成片。请查询进度，当前样子继续使用。"
            default: return "形象准备失败：" + (error ?? "服务未提供原因") + "。当前样子继续使用。"
            }
        }
    }
}

extension AssistantAppearancePreparation {
    private enum CodingKeys: String, CodingKey { case command_id, status, profile, error, profile_version }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        command_id = try values.decode(String.self, forKey: .command_id)
        status = try values.decode(Status.self, forKey: .status)
        profile = try values.decodeIfPresent(CentralAvatarProfile.self, forKey: .profile)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        profile_version = try values.decodeIfPresent(Int.self, forKey: .profile_version) ?? profile?.version ?? 0
    }
}

/// Only draft workflow state. The active profile remains owned by CentralTerminalState/YimiAvatarStore.
struct AssistantAppearanceState {
    private(set) var options: AssistantAppearanceOptions?
    private(set) var preparation: AssistantAppearancePreparation?
    private(set) var error: String?
    private(set) var optionsRequestID: String?
    private(set) var preparationRequestID: String?
    private(set) var commandID: String?
    var hasOutstandingCommand: Bool {
        guard commandID != nil else { return false }
        guard let preparation else { return true }
        return preparation.status == .pending || preparation.status == .submission_uncertain || preparation.status == .failed && preparation.error == "processing_timeout"
    }
    var busy: Bool { optionsRequestID != nil || preparationRequestID != nil }

    mutating func requestOptions() throws -> Data {
        let id = UUID().uuidString
        let data = try AssistantCentralTextWire.encode("avatar_options", fields: ["request_id": id])
        optionsRequestID = id; error = nil
        return data
    }
    mutating func prepare(lookID: String, focus: CentralAvatarProfile.Focus, expectedVersion: Int,
                          confirmedQuote: AssistantAppearanceQuote) throws -> Data {
        guard !busy, let options, options.looks.contains(where: { $0.look_id == lookID }),
              let quote = options.preparation_quote, quote == confirmedQuote,
              !quote.price_text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !quote.scope_text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              expectedVersion >= 0, (0...1).contains(focus.x), (0...1).contains(focus.y),
              !hasOutstandingCommand else {
            throw CocoaError(.coderInvalidValue)
        }
        let request = UUID().uuidString, command = UUID().uuidString
        let data = try AssistantCentralTextWire.encode("avatar_prepare", fields: ["request_id": request, "command_id": command,
            "look_id": lookID, "focus": ["x": focus.x, "y": focus.y], "expected_version": expectedVersion,
            "quote_id": confirmedQuote.quote_id, "confirmed_quote": ["quote_id": confirmedQuote.quote_id, "price_text": confirmedQuote.price_text, "scope_text": confirmedQuote.scope_text], "owner_request": "确认费用：\(quote.price_text)。使用范围：\(quote.scope_text)"])
        preparationRequestID = request; commandID = command; preparation = nil; error = nil
        return data
    }
    mutating func registerUploadedLook(_ look: AssistantAppearanceLook) throws {
        guard let options, options.photo_upload_available else { throw CentralTextError.unavailable }
        self.options = AssistantAppearanceOptions(looks: options.looks.filter { $0.look_id != look.look_id } + [look],
            preparation_quote: options.preparation_quote, call_quote: options.call_quote,
            unavailable_reason: options.unavailable_reason, photo_upload_available: true, current_preparation: options.current_preparation, current_version: options.current_version, recent_versions: options.recent_versions)
    }
    mutating func cancel() throws -> Data {
        guard let commandID else { throw CocoaError(.coderInvalidValue) }
        let id = UUID().uuidString
        let data = try AssistantCentralTextWire.encode("avatar_cancel", fields: ["request_id": id, "command_id": commandID])
        preparationRequestID = id; error = nil
        return data
    }
    mutating func reuse(version: Int, expectedVersion: Int) throws -> Data {
        guard !busy, version == 0 || options?.recent_versions.contains(where: { $0.version == version }) == true else { throw CocoaError(.coderInvalidValue) }
        let id = UUID().uuidString, command = UUID().uuidString
        let data = try AssistantCentralTextWire.encode("avatar_reuse", fields: ["request_id": id, "command_id": command,
            "version": version, "expected_version": expectedVersion, "owner_request": version == 0 ? "恢复内置默认形象" : "复用第 \(version) 版形象"])
        preparationRequestID = id; commandID = command; preparation = nil; error = nil
        return data
    }
    mutating func reconcile() throws -> Data {
        guard let commandID else { throw CocoaError(.coderInvalidValue) }
        let id = UUID().uuidString
        let data = try AssistantCentralTextWire.encode("avatar_reconcile", fields: ["request_id": id, "command_id": commandID])
        preparationRequestID = id; error = nil
        return data
    }
    @discardableResult mutating func consume(_ operation: String, fields: CentralBody) throws -> Bool {
        let request = try fields.value("request_id", as: String.self)
        if operation == "avatar_options_state", request != nil, request == optionsRequestID {
            guard let looks = try fields.value("looks", as: [AssistantAppearanceLook].self) else { throw CentralTextError.invalidPacket }
            let current = try fields.value("current_preparation", as: AssistantAppearancePreparation.self)
            try current?.profile?.validate()
            options = AssistantAppearanceOptions(looks: looks,
                preparation_quote: try fields.value("preparation_quote", as: AssistantAppearanceQuote.self),
                call_quote: try fields.value("call_quote", as: AssistantAppearanceQuote.self),
                unavailable_reason: try fields.value("unavailable_reason", as: String.self),
                photo_upload_available: try fields.value("photo_upload_available", as: Bool.self) == true, current_preparation: current,
                current_version: try fields.value("current_version", as: Int.self) ?? 0,
                recent_versions: try fields.value("recent_versions", as: [AssistantAppearanceVersion].self) ?? [])
            if preparationRequestID == nil, let current, current.command_id == commandID || !hasOutstandingCommand {
                commandID = current.command_id; preparation = current
            }
            optionsRequestID = nil; return true
        }
        if operation == "avatar_preparation", request != nil, request == preparationRequestID {
            guard let command = try fields.value("command_id", as: String.self),
                  let status = try fields.value("status", as: AssistantAppearancePreparation.Status.self) else { throw CentralTextError.invalidPacket }
            let result = AssistantAppearancePreparation(command_id: command, status: status,
                profile: try fields.value("profile", as: CentralAvatarProfile.self), error: try fields.value("error", as: String.self),
                profile_version: try fields.value("profile_version", as: Int.self) ?? 0)
            guard result.command_id == commandID else { throw CocoaError(.coderInvalidValue) }
            try result.profile?.validate()
            preparation = result; preparationRequestID = nil; return true
        }
        return false
    }
    mutating func fail(_ message: String) {
        optionsRequestID = nil; preparationRequestID = nil; error = message
    }
}
