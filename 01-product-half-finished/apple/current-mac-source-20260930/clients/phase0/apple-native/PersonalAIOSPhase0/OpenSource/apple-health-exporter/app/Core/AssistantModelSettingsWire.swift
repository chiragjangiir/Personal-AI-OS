import Foundation
import CryptoKit

/// The formal schema validates the wire; these DTOs project its one revision or draft.
enum AssistantModelSettingsWire {
    struct State: Decodable { let environment_id: String; let desired: Int; let groups: [String: ModelSettingsGroup] }
    struct Page: Decodable {
        let environment_id: String
        let revision: Int
        let desired: Int
        let groups: [String: ModelSettingsGroup]
        let usage: ModelSettingsUsage?
        let items: [Item]
        let next_offset: Int?
        let draft: FrozenAction?
    }
    struct FrozenAction: Decodable {
        let draft_id: String
        let action: String
        let payload: [String: Value]
    }
    enum Item: Decodable {
        case provider(ModelSettingsProvider), role(ModelSettingsRole), credential(ModelSettingsCredential)
        private enum CodingKeys: String, CodingKey { case kind, value }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            switch try fields.decode(String.self, forKey: .kind) {
            case "provider": self = .provider(try fields.decode(ModelSettingsProvider.self, forKey: .value))
            case "role": self = .role(try fields.decode(ModelSettingsRole.self, forKey: .value))
            case "credential": self = .credential(try fields.decode(ModelSettingsCredential.self, forKey: .value))
            default: throw CentralTextError.invalidPacket
            }
        }
    }
    indirect enum Value: Codable {
        case null, bool(Bool), number(Double), string(String), array([Value]), object([String: Value])
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null }
            else if let v = try? c.decode(Bool.self) { self = .bool(v) }
            else if let v = try? c.decode(Double.self) { self = .number(v) }
            else if let v = try? c.decode(String.self) { self = .string(v) }
            else if let v = try? c.decode([Value].self) { self = .array(v) }
            else { self = .object(try c.decode([String: Value].self)) }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .null: try c.encodeNil()
            case .bool(let v): try c.encode(v)
            case .number(let v): try c.encode(v)
            case .string(let v): try c.encode(v)
            case .array(let v): try c.encode(v)
            case .object(let v): try c.encode(v)
            }
        }
    }
    struct Challenge: Decodable { let nonce: String; let expires_in_ms: Double }
    struct KeyChallenge: Decodable {
        let nonce: String
        let expires_in_ms: Double
        let server_public_key_b64: String
        let algorithm: String
    }
    struct PendingMacs: Decodable { let items: [ModelSettingsMac]; let next_offset: Int? }

    static func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
    static func pretty<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
    static func result<T: Decodable>(_ packet: CentralTextPacket, as type: T.Type) throws -> T {
        guard try packet.fields.value("ok", as: Bool.self) == true else {
            throw ModelSettingsError.server(try packet.fields.value("error_code", as: String.self) ?? "MODEL_SETTINGS_RECEIPT_INVALID")
        }
        guard let value = try packet.fields.value("result", as: T.self) else { throw CentralTextError.invalidPacket }
        return value
    }
    static func statement(review: ModelSettingsReview) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["purpose": "model_settings", "device_id": review.binding.deviceID,
            "principal_id": review.draft.principal_id, "nonce": review.nonce, "action": review.draft.action,
            "draft_id": review.draft.draft_id, "expected_revision": review.draft.expected_revision,
            "change_sha256": review.draft.change_sha256, "expires_at_ms": review.draft.expires_at_ms],
            options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func publication(publicKey: Data, recipient: Curve25519.KeyAgreement.PrivateKey,
                            challenge: KeyChallenge, deviceID: String, principalID: String) throws -> [String: Any] {
        guard challenge.algorithm == "X25519-HKDF-SHA256-HMAC-SHA256",
              let server = Data(base64Encoded: challenge.server_public_key_b64), server.count == 32,
              let salt = Data(base64Encoded: challenge.nonce.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=") else {
            throw CentralTextError.invalidPacket
        }
        let shared = try recipient.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: server))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data("paios.model_settings.publish_key.v1".utf8), outputByteCount: 32)
        let digest = SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
        let statement = try JSONSerialization.data(withJSONObject: ["purpose": "model_settings_publish_key",
            "device_id": deviceID, "principal_id": principalID, "nonce": challenge.nonce, "key_sha256": digest], options: [.sortedKeys])
        let signature = Data(HMAC<SHA256>.authenticationCode(for: statement, using: key))
        return ["request": ["public_x963_b64": publicKey.base64EncodedString()],
            "statement_b64": statement.base64EncodedString(), "signature_b64": signature.base64EncodedString()]
    }
}
