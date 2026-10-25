import Foundation

struct ModelSettingsThinking: Codable, Equatable, Sendable {
    var enabled: Bool
    var budget: Int? = nil
}
struct ModelSettingsParameters: Codable, Equatable, Sendable {
    var thinking: ModelSettingsThinking? = nil
    var max_output_tokens: Int? = nil
    var temperature: Double? = nil
    var context_limit: Int? = nil
    var reasoning_effort: String? = nil
}
struct ModelSettingsProvider: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var display_name: String
    var wire_protocol: String
    var base_url: String
    var credential_ref: String?
    var region: String? = nil
    var catalog_capability: String? = nil
    var usage_capability: String? = nil
    var session_affinity: String? = nil
}
struct ModelSettingsRoute: Codable, Equatable, Sendable {
    var provider_ref: String
    var model_id: String
    var parameters: ModelSettingsParameters = .init()
}
struct ModelSettingsRole: Codable, Equatable, Sendable {
    var id: String
    var profile: String
    var provider_ref: String? = nil
    var model_id: String? = nil
    var parameters: ModelSettingsParameters = .init()
    var ordered_fallbacks: [ModelSettingsRoute] = []
    var inherit_from: String? = nil
    var disabled: Bool? = nil
    var read_only: Bool? = nil
    var activation_boundary: String
    var key: String { profile + "/" + id }
    var editable: Bool { read_only != true && activation_boundary != "read_only" && profile != "local" }
    var isDaily: Bool { editable && profile == "owner" && ["brain", "main", "vision", "delegation"].contains(id) }
    var routeDescription: String {
        let provider = provider_ref ?? "继承"
        let model = model_id ?? inherit_from ?? "已停用"
        return [key, provider, model].joined(separator: " · ")
    }
    var displayName: String {
        switch id {
        case "brain", "main": "主脑"
        case "vision": "看图与文字识别"
        case "delegation": "子代理"
        case "compression": "上下文压缩"
        case "build": "构建"
        default: id
        }
    }
}
struct ModelSettingsCredential: Codable, Equatable, Sendable {
    var credential_ref: String
    var version: Int
    var configured: Bool
    var last4: String?
    var updated_at: String?
    var test_status: String?
}
struct ModelSettingsGroup: Codable, Equatable, Sendable {
    var desired: Int
    var effective: Int
    var status: String
    var error: String?
}
struct ModelSettingsUsage: Codable, Equatable, Sendable {
    var local_date: String
    var attempts: Int
    var known_cny: Double
    var estimated_cny: Double
    var unknown_attempts: Int
    var foreign_currency_attempts: Int
    var subscription_remaining: String
    var threshold_cny: Double
    var owner_reserve_cny: Double
    var pause_on_limit: Bool
    var paused: Bool
    var resumed_local_date: String?
}
struct ModelSettingsSnapshot: Codable, Equatable, Sendable {
    var environment_id: String
    var revision: Int
    var desired: Int
    var groups: [String: ModelSettingsGroup]
    var providers: [ModelSettingsProvider] = []
    var roles: [ModelSettingsRole] = []
    var credentials: [ModelSettingsCredential] = []
    var usage: ModelSettingsUsage? = nil
    var activationText: String {
        if groups.values.contains(where: { $0.status == "failed" }) { return "应用失败，仍用原设置" }
        if groups.values.contains(where: { $0.effective != desired || $0.status != "effective" }) {
            return "已保存，当前任务结束后生效"
        }
        return "已生效"
    }
}
struct ModelSettingsDraft: Decodable, Equatable, Sendable {
    var draft_id: String
    var action: String
    var expected_revision: Int
    var change_sha256: String
    var expires_at_ms: Double
    var principal_id: String
    var preview: Preview? = nil
    struct Preview: Decodable, Equatable, Sendable {
        var change_summary: String?
        var key: Key?
        struct Key: Decodable, Equatable, Sendable {
            var credential_ref: String
            var configured: Bool
            var last4: String
        }
    }
}
struct ModelSettingsDifference: Identifiable, Equatable, Sendable {
    var id: String
    var title: String
    var before: String
    var after: String
}
struct ModelSettingsReview: Sendable {
    var draft: ModelSettingsDraft
    var before: ModelSettingsSnapshot
    var after: ModelSettingsSnapshot
    var changes: [ModelSettingsDifference]
    var payloadText: String
    var pageCount: Int
    var complete: Bool
    var nonce: String
    var expiresAt: Date
    var binding: CentralTransportBinding
}
struct ModelSettingsMac: Decodable, Identifiable, Sendable {
    var device_id: String
    var purpose: String
    var label: String?
    var public_x963_b64: String?
    var key_sha256: String?
    var id: String { device_id }
}
struct ModelSettingsCatalogItem: Decodable, Identifiable, Equatable, Sendable {
    var id: String
    var display_name: String?
}
struct ModelSettingsCatalog: Decodable, Sendable {
    var status: String
    var source: String
    var fetched_at: String
    var models: [ModelSettingsCatalogItem]
    var safe_error: String?
    var message: String?
    var next_offset: Int?
    var draft_id: String
    var change_sha256: String
    var provider_ref: String
    var credential_ref: String?
    var credential_version: Int?
}

enum ModelSettingsError: LocalizedError {
    case server(String), incomplete, expired, changed
    var errorDescription: String? {
        switch self {
        case .server("MODEL_SETTINGS_REVISION_CONFLICT"): return "设置已在另一台设备修改。已读取最新设置，请重新检查并确认。"
        case .server("MODEL_SETTINGS_KEY_REENTRY_REQUIRED"): return "那一版的密钥已被替换，请在服务商详情中重新填写，再检查改回去的版本。"
        case .server("MODEL_SETTINGS_MAC_UNAUTHORIZED"): return "在 iPhone 上授权这台 Mac"
        case .server("MODEL_SETTINGS_MAC_KEY_CHANGED"): return "Mac 的签名密钥已变化，请刷新授权列表后重新检查。"
        case .server(let code): return "模型设置操作失败（\(code)），请检查后重试。"
        case .incomplete: return "未读完冻结草稿，请重新读取后确认。"
        case .expired: return "确认已过期，请重新读取草稿后再确认。"
        case .changed: return "连接或身份已变化，请重新检查设置。"
        }
    }
}
