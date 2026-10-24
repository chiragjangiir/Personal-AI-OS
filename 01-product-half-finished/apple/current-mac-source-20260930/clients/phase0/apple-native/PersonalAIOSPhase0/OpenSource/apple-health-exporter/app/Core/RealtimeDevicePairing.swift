import CryptoKit
import Foundation
import Security

/// Governance refs exactly as the client sends them with every control request (ids only).
struct RealtimeWireGovernance: Codable, Equatable, Sendable {
    let purposeScopes: [String]
    let consentRecordRefs: [String]
    let policyDecisionRefs: [String]
    let purposeTokenRefs: [String]
    let capabilityGrantRefs: [String]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case purposeScopes = "purpose_scopes"
        case consentRecordRefs = "consent_record_refs"
        case policyDecisionRefs = "policy_decision_refs"
        case purposeTokenRefs = "purpose_token_refs"
        case capabilityGrantRefs = "capability_grant_refs"
    }

    static var wireFieldNames: Set<String> { Set(CodingKeys.allCases.map(\.rawValue)) }

    var wireObject: [String: Any] {
        ["purpose_scopes": purposeScopes, "consent_record_refs": consentRecordRefs,
         "policy_decision_refs": policyDecisionRefs, "purpose_token_refs": purposeTokenRefs,
         "capability_grant_refs": capabilityGrantRefs]
    }
}

enum RealtimeDevicePairingError: Error, Equatable, Sendable {
    case invalidPairing
    case unavailable
    case duplicate
}

/// The phone's one pairing with the Mac gateway, issued once by `mac-product-provision.ts pair`. The gateway's
/// paired_devices row is the authority; the phone builds every control request from this pairing plus the binding
/// the latest bootstrap returned.
struct RealtimeDevicePairing: Codable, Equatable, Sendable {
    static let schema = "paios.device-pairing.v1"

    let schema: String
    var origin: String
    let deviceID: String
    let userID: String
    let token: String
    let governance: RealtimeWireGovernance
    let media: [String]
    let pairedAt: String
    var deviceType: String? = nil
    var capabilities: [String]? = nil
    var anchorOrigin: String? = nil
    var fallbackOrigin: String? = nil
    var canonicalSuccesses: Int? = nil

    var originalOrigin: String { anchorOrigin ?? origin }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schema, origin, token, governance, media, capabilities
        case deviceType = "device_type"
        case deviceID = "device_id"
        case userID = "user_id"
        case pairedAt = "paired_at"
        case anchorOrigin = "anchor_origin"
        case fallbackOrigin = "fallback_origin"
        case canonicalSuccesses = "canonical_successes"
    }

    static func decode(_ data: Data) throws -> RealtimeDevicePairing {
        guard (2...16_384).contains(data.count),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).subtracting(["anchor_origin", "fallback_origin", "canonical_successes", "device_type", "capabilities"]) == Set(CodingKeys.allCases.map(\.rawValue)).subtracting(["anchor_origin", "fallback_origin", "canonical_successes", "device_type", "capabilities"]),
              (object["device_type"] == nil && object["capabilities"] == nil) || (["glasses", "mac"].contains(object["device_type"] as? String ?? "") && object["capabilities"] is [String]),
              let governance = object["governance"] as? [String: Any],
              Set(governance.keys) == RealtimeWireGovernance.wireFieldNames,
              let pairing = try? JSONDecoder().decode(RealtimeDevicePairing.self, from: data) else {
            throw RealtimeDevicePairingError.invalidPairing
        }
        let refs = pairing.governance.consentRecordRefs + pairing.governance.policyDecisionRefs
            + pairing.governance.purposeTokenRefs + pairing.governance.capabilityGrantRefs
        guard pairing.schema == schema,
              (try? EndpointResolver.canonicalRealtimeOrigin(from: pairing.origin)) == pairing.origin,
              RealtimeUUIDv7.isValid(pairing.deviceID), RealtimeUUIDv7.isValid(pairing.userID),
              pairing.token.range(of: "^[A-Za-z0-9_-]{16,512}$", options: .regularExpression) != nil,
              !pairing.governance.purposeScopes.isEmpty, pairing.governance.purposeScopes.allSatisfy({ !$0.isEmpty }),
              refs.count >= 4, refs.allSatisfy(RealtimeUUIDv7.isValid),
              pairing.media.contains("data"), Set(pairing.media).count == pairing.media.count,
              Set(pairing.media).isSubset(of: ["audio", "video", "data"]),
              !pairing.pairedAt.isEmpty,
              (pairing.anchorOrigin == nil && pairing.fallbackOrigin == nil && pairing.canonicalSuccesses == nil)
                || ([RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin].contains(pairing.origin)
                    && pairing.anchorOrigin == RealtimeAPIOriginMigration.legacyOrigin
                    && pairing.fallbackOrigin == RealtimeAPIOriginMigration.legacyOrigin
                    && (1...2).contains(pairing.canonicalSuccesses ?? 0)) else {
            throw RealtimeDevicePairingError.invalidPairing
        }
        if pairing.deviceType == "mac" {
            let capabilities = pairing.capabilities ?? []
            guard Set(capabilities).count == capabilities.count,
                  Set(["display", "chat_ui", "desktop_tools"]).isSubset(of: Set(capabilities)),
                  Set(capabilities).isSubset(of: ["display", "speaker", "microphone", "camera", "notifications", "chat_ui", "desktop_tools", "owner_unlock"]) else {
                throw RealtimeDevicePairingError.invalidPairing
            }
        } else if pairing.capabilities?.contains("desktop_tools") == true {
            throw RealtimeDevicePairingError.invalidPairing
        }
        return pairing
    }
}

enum RealtimeTerminalClass: String, Sendable { case glasses, mac }

typealias RealtimeGlassesEnrollment = RealtimeTerminalEnrollment

struct RealtimeTerminalEnrollment: Sendable {
    let qrData: Data
    let expiresAt: Date

    static func decode(_ data: Data, origin: String, deviceClass: RealtimeTerminalClass = .glasses, now: Date = Date()) throws -> Self {
        guard data.count <= 4_096,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
              Set(object.keys) == ["schema", "origin", "token", "expires_at"],
              object["schema"] == "paios.\(deviceClass.rawValue)-enrollment.v1",
              object["origin"] == origin || (deviceClass == .glasses && Set([origin, object["origin"] ?? ""]) == Set([RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin])),
              (try? EndpointResolver.canonicalRealtimeOrigin(from: origin)) == origin,
              object["token"]?.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let timestamp = object["expires_at"] else { throw RealtimeDevicePairingError.invalidPairing }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: timestamp)
        formatter.formatOptions = [.withInternetDateTime]
        guard let expiry = fractional ?? formatter.date(from: timestamp), expiry > now else { throw RealtimeDevicePairingError.invalidPairing }
        return Self(qrData: data, expiresAt: expiry)
    }
}

enum RealtimeUUIDv7 {
    private static let pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

    static func isValid(_ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    static func make(now: Date = Date()) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let millis = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: millis >> (8 * (5 - UInt64(index)))) }
        var random = [UInt8](repeating: 0, count: 10)
        if SecRandomCopyBytes(kSecRandomDefault, random.count, &random) != errSecSuccess {
            random = (0..<10).map { _ in UInt8.random(in: 0...255) }
        }
        bytes[6] = 0x70 | (random[0] & 0x0f)
        bytes[7] = random[1]
        bytes[8] = 0x80 | (random[2] & 0x3f)
        for index in 9..<16 { bytes[index] = random[index - 6] }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let parts = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { range -> String in
            let start = hex.index(hex.startIndex, offsetBy: range.lowerBound)
            let end = hex.index(hex.startIndex, offsetBy: range.upperBound)
            return String(hex[start..<end])
        }
        return parts.joined(separator: "-")
    }
}

protocol RealtimeDevicePairingStoring: Sendable {
    func loadPairingData() throws -> Data?
    func replacePairingData(_ data: Data) throws
    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool
}

extension RealtimeDevicePairingStoring {
    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool {
        guard try loadPairingData() == expected else { return false }
        try replacePairingData(data)
        return true
    }
}

/// Non-secret pairing generation authenticated during session setup. A locked Keychain never changes it.
final class RealtimePairingSessionIdentity: @unchecked Sendable {
    struct Snapshot: Equatable, Sendable {
        let identity: String?
        let generation: UInt64
    }
    static let shared = RealtimePairingSessionIdentity()
    static let didChange = Notification.Name("paios.realtime-pairing-session-identity-changed")
    static let snapshotKey = "snapshot"
    private let lock = NSLock()
    private var state = Snapshot(identity: nil, generation: 0)

    func snapshot() -> Snapshot { lock.lock(); defer { lock.unlock() }; return state }

    func authenticate(_ pairing: RealtimeDevicePairing) { update(CentralOwnerDataIdentity.pairing(pairing)) }
    func invalidate() { update(nil) }

    func matches(_ owner: String?) -> Bool {
        let current = snapshot()
        return owner != nil && owner == current.identity
    }

    private func update(_ identity: String?) {
        lock.lock()
        guard state.identity != identity else { lock.unlock(); return }
        state = Snapshot(identity: identity, generation: state.generation &+ 1)
        let change = state
        lock.unlock()
        NotificationCenter.default.post(name: Self.didChange, object: self, userInfo: [Self.snapshotKey: change])
    }
}

/// The pairing (including its bearer token) lives only in a ThisDeviceOnly Keychain item; it is never printed.
final class KeychainRealtimeDevicePairingStore: RealtimeDevicePairingStoring, @unchecked Sendable {
    static let service = KeychainE2EERecipientKeyStore.service
    static let account = "realtime-device-pairing"

    private var accessibility: CFString
    private let keychainService: String
    private let dataProtectionKeychain: Bool
    init(service: String = KeychainRealtimeDevicePairingStore.service, accessibility: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly, dataProtectionKeychain: Bool = false) {
        self.keychainService = service; self.accessibility = accessibility; self.dataProtectionKeychain = dataProtectionKeychain
    }

    /// Keep the same pairing item and bearer token while changing locked-phone access.
    func setNavigationStandbyAccess(enabled: Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        let protection = enabled ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemUpdate(baseQuery() as CFDictionary,
            [kSecAttrAccessible as String: protection] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RealtimeDevicePairingError.unavailable
        }
        accessibility = protection
    }

    func removePairing() throws {
        lock.lock()
        let status = SecItemDelete(baseQuery() as CFDictionary)
        lock.unlock()
        guard status == errSecSuccess || status == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
        RealtimePairingSessionIdentity.shared.invalidate()
    }

    private static let sharedLock = NSLock()
    private var lock: NSLock { Self.sharedLock }

    func loadPairingData() throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw RealtimeDevicePairingError.unavailable
        }
        return data
    }

    func replacePairingData(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        try replaceUnlocked(data)
    }

    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        var query = baseQuery()
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              result as? Data == expected else { return false }
        try replaceUnlocked(data)
        return true
    }

    private func replaceUnlocked(_ data: Data) throws {
        let query = baseQuery()
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = accessibility
        let add = SecItemAdd(item as CFDictionary, nil)
        guard add == errSecSuccess else {
            throw add == errSecDuplicateItem ? RealtimeDevicePairingError.duplicate : RealtimeDevicePairingError.unavailable
        }
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
         kSecAttrAccount as String: Self.account, kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: dataProtectionKeychain]
    }
}

enum RealtimePairingImportResult: Equatable, Sendable {
    case absent
    case imported
    case rejected
}

enum RealtimeDevicePairingRuntime {
    /// Drop location (under Application Support) for the file `mac-product-provision.ts pair` writes.
    static let pairingRelativePath = "PersonalAIOS/E2EE/device-pairing.v1.json"
    static let registrationRelativePath = "Application Support/PersonalAIOS/E2EE/e2ee-recipient-registration.v1.json"

    static func applicationSupportURL(fileManager: FileManager = .default) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    }

    /// Imports an owner-only file through the local database's recoverable pairing replacement transaction.
    static func importPairing(
        from fileURL: URL,
        fileManager: FileManager = .default,
        store: any RealtimeDevicePairingStoring = KeychainRealtimeDevicePairingStore(),
        database: AssistantLocalOperationDatabase? = nil
    ) -> RealtimePairingImportResult {
        guard fileManager.fileExists(atPath: fileURL.path) else { return .absent }
        do {
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            let permissions = (try fileManager.attributesOfItem(atPath: fileURL.path)[.posixPermissions] as? NSNumber)?.intValue
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, (2...16_384).contains(size), permissions == 0o600 else {
                return .rejected
            }
            let data = try Data(contentsOf: fileURL)
            let operations = try database ?? AssistantLocalOperationDatabase(url: AssistantLocalOperationDatabase.defaultURL())
            try operations.replacePairing(data: data, store: store)
            try? fileManager.removeItem(at: fileURL)
            return .imported
        } catch {
            return .rejected
        }
    }
}

/// The control-plane bearer is the pairing token; the local health device identity is unchanged.
struct PairedRealtimeCredentialStore: CredentialStoring {
    let store: any RealtimeDevicePairingStoring
    private let identity: any DeviceIdentityStoring

    init(store: any RealtimeDevicePairingStoring = KeychainRealtimeDevicePairingStore(),
         identity: any DeviceIdentityStoring = KeychainCredentialStore()) {
        self.store = store
        self.identity = identity
    }

    func apiToken() throws -> String? {
        try store.loadPairingData().map { try RealtimeDevicePairing.decode($0).token }
    }

    func apiToken(for origin: String) throws -> String? {
        guard let data = try store.loadPairingData() else { return nil }
        let pairing = try RealtimeDevicePairing.decode(data)
        guard pairing.origin == origin || pairing.fallbackOrigin == origin
                || (pairing.anchorOrigin == RealtimeAPIOriginMigration.legacyOrigin && origin == RealtimeAPIOriginMigration.canonicalOrigin) else { throw RealtimePublicControlAdapterError.invalidPublicOrigin }
        return pairing.token
    }

    func setAPIToken(_ token: String) throws {
        _ = token
        throw RealtimeDevicePairingError.unavailable // owned by pairing import only
    }

    func deviceID() throws -> UUID { try identity.deviceID() }
}

/// Builds every control request body from the pairing and the retained bootstrap binding (the same rules the
/// gateway's verified simulated phone uses). Bodies are built once per operation; durable replays reuse the bytes.
struct PairedRealtimeRequestBodyProvider: RealtimeCanonicalRequestBodyProviding {
    typealias IdentifierFactory = @Sendable (Date) -> String

    private let store: any RealtimeDevicePairingStoring
    private let now: @Sendable () -> Date
    private let makeID: IdentifierFactory

    init(store: any RealtimeDevicePairingStoring = KeychainRealtimeDevicePairingStore(),
         now: @escaping @Sendable () -> Date = { Date() },
         makeID: @escaping IdentifierFactory = { RealtimeUUIDv7.make(now: $0) }) {
        self.store = store
        self.now = now
        self.makeID = makeID
    }

    var isReady: Bool { (try? pairing()) != nil }

    func pairing() throws -> RealtimeDevicePairing? {
        guard let data = try store.loadPairingData() else { return nil }
        let pairing = try RealtimeDevicePairing.decode(data)
        RealtimePairingSessionIdentity.shared.authenticate(pairing)
        return pairing
    }

    /// Replays are bound to the pairing that recorded them.
    func replayScope() throws -> Data? {
        guard let pairing = try pairing() else { return nil }
        return Data(SHA256.hash(data: Data("\(RealtimeDevicePairing.schema)\n\(pairing.deviceID)\n\(pairing.pairedAt)".utf8)))
    }

    func canonicalBody(for operation: RealtimePublicControlOperation,
                       context: RealtimeCanonicalRequestContext) async throws -> Data? {
        guard context.isPresent else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
        guard let pairing = try pairing() else { return nil }
        let at = now()
        return try RealtimeControlRequestBuilder(pairing: pairing, requestID: makeID(at), at: at)
            .body(for: operation, binding: context.retainedBootstrapBinding)
    }
}

struct RealtimeControlRequestBuilder {
    let pairing: RealtimeDevicePairing
    let requestID: String
    let at: Date

    func body(for operation: RealtimePublicControlOperation, binding: RealtimeBootstrapLocalBinding?) throws -> Data? {
        switch operation {
        case .bootstrap:
            let media = ["audio", "video", "data"].filter(pairing.media.contains)
            return try encode([
                "operation": "bootstrap", "bootstrap_mode": "initial", "request_id": requestID,
                "device_id": pairing.deviceID, "governance": pairing.governance.wireObject,
                "start": ["kind": "explicit_user_start", "device_id": pairing.deviceID, "modalities": media,
                          "started_at": Self.timestamp(at)],
                "requested_media": ["audio": media.contains("audio"), "video": media.contains("video"),
                                    "data": media.contains("data")]
            ], operation: operation, target: nil)
        case .e2eeKeyResolve, .credentialRefresh, .mediaStop, .endContinuity:
            guard let binding else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
            return try bound(operation, binding)
        case .handoff, .watchBinding:
            return nil
        }
    }

    private func bound(_ operation: RealtimePublicControlOperation, _ binding: RealtimeBootstrapLocalBinding) throws -> Data {
        let session = try Self.object(binding.realtimeSessionRef)
        var body: [String: Any] = ["operation": operation.rawValue, "request_id": requestID, "realtime_session_ref": session,
            "continuity_id": binding.continuityID, "connection_epoch": binding.connectionEpoch,
            "governance": pairing.governance.wireObject]
        let lease = try Self.object(binding.deviceLeaseRef)
        let aliases = try binding.transportAliases.map(Self.object)
        switch operation {
        case .e2eeKeyResolve:
            guard let credential = binding.recipientDeviceCredentialRef,
                  let audience = binding.transportAliases.first(where: { $0.aliasType == "participant" }) else {
                throw RealtimePublicControlAdapterError.missingCanonicalContext
            }
            let envelope = binding.e2eeKeyEnvelope
            body.merge(["device_lease_ref": lease, "transport_aliases": aliases,
                "key_envelope_ref": try Self.object(envelope.keyEnvelopeRef), "key_index": envelope.keyIndex,
                "key_generation": envelope.keyGeneration, "device_id": pairing.deviceID,
                "recipient_device_credential_ref": try Self.object(credential),
                "participant_audience": try Self.object(audience)]) { $1 }
            return try encode(body, operation: operation, target: binding.realtimeSessionRef)
        case .credentialRefresh:
            body.merge(["device_lease_ref": lease, "transport_aliases": aliases, "refresh_reason": "server_refresh"]) { $1 }
            return try encode(body, operation: operation, target: binding.realtimeSessionRef)
        case .mediaStop:
            body.merge(["device_lease_ref": lease, "transport_aliases": aliases, "reason": "user_stop",
                "release_scope": "media_device_lease_only"]) { $1 }
            return try encode(body, operation: operation, target: binding.deviceLeaseRef)
        default:
            body["confirmation"] = "explicit_user_end_continuity"
            return try encode(body, operation: operation, target: binding.realtimeSessionRef)
        }
    }

    /// Device-side idempotency context: the request hash covers the body without the context; the server stores and
    /// compares the whole context for replay and binds it into the E2EE AAD.
    private func encode(_ body: [String: Any], operation: RealtimePublicControlOperation,
                        target: RealtimeCanonicalReference?) throws -> Data {
        let (slug, kind): (String, String) = {
            switch operation {
            case .bootstrap: return ("bootstrap", "realtime_bootstrap")
            case .e2eeKeyResolve: return ("e2ee-key-resolve", "realtime_e2ee_key_resolve")
            case .credentialRefresh: return ("credential-refresh", "realtime_credential_refresh")
            case .mediaStop: return ("media-stop", "realtime_media_stop")
            default: return ("end-continuity", "realtime_end_continuity")
            }
        }()
        let profileID = "https://personal-ai-os.local/contracts/realtime/idempotency/\(slug)"
        var scope: [String: Any] = ["owner_module": "T11B", "operation_kind": kind,
            "target_object_type": operation == .mediaStop ? "DeviceLease" : "RealtimeSession", "user_id": pairing.userID]
        if let target { scope["target_object_id"] = target.refID }
        var complete = body
        complete["idempotency_context"] = [
            "idempotency_scope": scope, "idempotency_key": requestID, "idempotency_profile_id": profileID,
            "idempotency_profile_version": "1.0.0",
            "idempotency_profile_sha256": Self.sha256(try Self.canonical(["profile_id": profileID,
                "profile_version": "1.0.0", "hash_algorithm": "sha256_rfc8785_jcs"])),
            "idempotency_request_sha256": Self.sha256(try Self.canonical(body))
        ]
        let data = try Self.canonical(complete)
        guard data.count <= ProductionRealtimePublicControlProvider.maximumCanonicalBodyBytes else {
            throw RealtimePublicControlAdapterError.canonicalBodyTooLarge
        }
        return data
    }

    private static func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private static func canonical(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

/// Only the scoped background token is retained; the pairing bearer stays in its original item.
struct PlaceCredential: Codable, Equatable, Sendable {
    let origin: String
    let deviceID: String
    let pairingIdentity: String
    let token: String

    init(origin: String, deviceID: String, pairingIdentity: String, token: String) {
        self.origin = origin; self.deviceID = deviceID; self.pairingIdentity = pairingIdentity; self.token = token
    }
    init(pairing: RealtimeDevicePairing, token: String) {
        self.init(origin: pairing.origin, deviceID: pairing.deviceID,
                  pairingIdentity: CentralOwnerDataIdentity.pairing(pairing), token: token)
    }
}

protocol PlaceCredentialStoring: Sendable {
    func load() throws -> PlaceCredential?
    func save(_ credential: PlaceCredential?) throws
}

final class KeychainPlaceCredentialStore: PlaceCredentialStoring, @unchecked Sendable {
    static let account = "place-upload-credential"
    private let lock = NSLock()
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: KeychainRealtimeDevicePairingStore.service,
         kSecAttrAccount as String: Self.account, kSecAttrSynchronizable as String: false]
    }

    func load() throws -> PlaceCredential? {
        lock.lock(); defer { lock.unlock() }
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw RealtimeDevicePairingError.unavailable }
        return try JSONDecoder().decode(PlaceCredential.self, from: data)
    }

    func save(_ credential: PlaceCredential?) throws {
        lock.lock(); defer { lock.unlock() }
        guard let credential else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
            return
        }
        let fields: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(credential),
                                   kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
        let item = query.merging(fields) { _, new in new }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw RealtimeDevicePairingError.unavailable }
    }
}

/// This release migrates one owner-controlled origin pair. An exact allowlist avoids guessing a
/// registrable domain from host labels (which is unsafe for public suffixes such as co.uk).
enum RealtimeAPIOriginMigration {
    private struct Endpoints: Decodable {
        let legacyOrigin: String
        let canonicalOrigin: String
    }
    private static let endpoints: Endpoints = {
#if SWIFT_PACKAGE
        let bundle = Bundle.module
#else
        let bundle = Bundle.main
#endif
        guard let url = bundle.url(forResource: "client-endpoints", withExtension: "json", subdirectory: "Contracts") else {
            preconditionFailure("Packaged client endpoint configuration is missing")
        }
        do {
            let value = try JSONDecoder().decode(Endpoints.self, from: Data(contentsOf: url))
            guard try EndpointResolver.canonicalRealtimeOrigin(from: value.canonicalOrigin) == value.canonicalOrigin,
                  try EndpointResolver.canonicalRealtimeOrigin(from: value.legacyOrigin) == value.legacyOrigin,
                  value.canonicalOrigin != value.legacyOrigin else {
                preconditionFailure("Packaged client endpoint configuration is invalid")
            }
            return value
        } catch { preconditionFailure("Packaged client endpoint configuration could not be loaded: \(error)") }
    }()
    static var legacyOrigin: String { endpoints.legacyOrigin }
    static var canonicalOrigin: String { endpoints.canonicalOrigin }

    static func announcedOrigin(_ data: Data) throws -> String? {
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return object?["canonical_api_origin"] as? String
    }

    static func migrated(_ pairing: RealtimeDevicePairing) throws -> RealtimeDevicePairing {
        guard pairing.origin == legacyOrigin else { throw RealtimeDevicePairingError.invalidPairing }
        var migrated = pairing
        migrated.origin = canonicalOrigin
        migrated.anchorOrigin = pairing.originalOrigin
        migrated.fallbackOrigin = legacyOrigin
        migrated.canonicalSuccesses = 1
        return migrated
    }
}
