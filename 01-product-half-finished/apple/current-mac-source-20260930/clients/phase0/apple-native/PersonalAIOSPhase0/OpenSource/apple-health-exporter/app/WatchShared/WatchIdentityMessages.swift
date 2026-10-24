import Foundation

// The command producers remain platform-owned; the acknowledgement wire has one definition.
#if os(watchOS)
typealias WatchSharedCyclingControlAction = WatchCyclingControlAction
typealias WatchSharedCyclingControlCommand = WatchCyclingControlCommand
typealias WatchSharedCyclingControlCommandError = WatchCyclingControlCommandError
#else
typealias WatchSharedCyclingControlAction = AssistantCyclingControlAction
typealias WatchSharedCyclingControlCommand = AssistantCyclingControlCommand
typealias WatchSharedCyclingControlCommandError = AssistantCyclingControlCommandError
#endif

enum WatchCyclingControlAckStatus: String, Codable, Equatable, Sendable {
    case accepted
    case duplicate
    case rejected
}

struct WatchCyclingControlAcknowledgement:
    Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let currentKind = "cycling_control_ack"

    let version: Int
    let kind: String
    let action: WatchSharedCyclingControlAction
    let requestID: String
    let sequence: UInt64
    let status: WatchCyclingControlAckStatus

    init(
        command: WatchSharedCyclingControlCommand,
        status: WatchCyclingControlAckStatus
    ) {
        self.version = Self.currentVersion
        self.kind = Self.currentKind
        self.action = command.action
        self.requestID = command.requestID
        self.sequence = command.sequence
        self.status = status
    }

    func encodedStrict() throws -> Data {
        try JSONEncoder().encode(self)
    }

    static func decodeStrict(_ data: Data) throws
        -> WatchCyclingControlAcknowledgement {
        #if !os(watchOS)
        guard !data.isEmpty, data.count <= 4_096 else {
            throw WatchSharedCyclingControlCommandError.malformed
        }
        #endif
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            throw WatchSharedCyclingControlCommandError.malformed
        }
        let allowed = Set([
            "version", "kind", "action", "request_id", "sequence", "status"
        ])
        guard Set(dictionary.keys) == allowed else {
            throw WatchSharedCyclingControlCommandError.malformed
        }
        let acknowledgement: WatchCyclingControlAcknowledgement
        do {
            acknowledgement = try JSONDecoder().decode(
                WatchCyclingControlAcknowledgement.self,
                from: data
            )
        } catch {
            throw WatchSharedCyclingControlCommandError.malformed
        }
        guard acknowledgement.version == Self.currentVersion,
              acknowledgement.kind == Self.currentKind,
              acknowledgement.sequence > 0,
              !acknowledgement.requestID.isEmpty
        else {
            throw WatchSharedCyclingControlCommandError.invalidEnvelope
        }
        return acknowledgement
    }

    func matches(_ command: WatchSharedCyclingControlCommand) -> Bool {
        action == command.action
            && requestID == command.requestID
            && sequence == command.sequence
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case kind
        case action
        case requestID = "request_id"
        case sequence
        case status
    }
}

enum WatchInstallationIdentityEnvelopeError: Error, Equatable, Sendable {
    case malformed
    case invalidEnvelope
}

struct WatchInstallationIdentityRequest: Codable, Equatable, Sendable {
    static let currentKind = "preworkout_installation_identity_request"

    let kind: String
    let nonce: String

    #if os(watchOS)
    init(kind: String, nonce: String) {
        self.kind = kind
        self.nonce = nonce
    }
    #endif

    init(nonce: String) {
        self.kind = Self.currentKind
        self.nonce = nonce
    }

    func encodedStrict() throws -> Data {
        guard Self.isCanonicalUUID(nonce) else {
            throw WatchInstallationIdentityEnvelopeError.invalidEnvelope
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= 512,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set(["kind", "nonce"]),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              value.kind == currentKind,
              isCanonicalUUID(value.nonce) else {
            throw WatchInstallationIdentityEnvelopeError.malformed
        }
        return value
    }

    static func declaresKind(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else { return false }
        return dictionary["kind"] as? String == currentKind
    }

    static func isCanonicalUUID(_ value: String) -> Bool {
        guard value == value.lowercased(), UUID(uuidString: value) != nil else {
            return false
        }
        let bytes = Array(value.utf8)
        guard bytes.count == 36,
              bytes[8] == 45, bytes[13] == 45,
              bytes[18] == 45, bytes[23] == 45,
              [56, 57, 97, 98].contains(bytes[19]) else { return false }
        return bytes.enumerated().allSatisfy { index, byte in
            [8, 13, 18, 23].contains(index)
                ? byte == 45
                : (48...57).contains(byte) || (97...102).contains(byte)
        }
    }
}

struct WatchInstallationIdentityReply: Codable, Equatable, Sendable {
    static let currentKind = "preworkout_installation_identity_reply"
    static let allowedSources = Set([
        "existing_watch_install_identity", "app_installation_uuid_v1"
    ])

    let kind: String
    let nonce: String
    let localClientInstanceID: String
    let localClientSource: String

    func encodedStrict() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= 1_024,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set([
                "kind", "nonce", "local_client_instance_id",
                "local_client_source"
              ]),
              let value = try? JSONDecoder().decode(Self.self, from: data)
        else { throw WatchInstallationIdentityEnvelopeError.malformed }
        try value.validate()
        return value
    }

    private func validate() throws {
        guard kind == Self.currentKind,
              WatchInstallationIdentityRequest.isCanonicalUUID(nonce),
              WatchInstallationIdentityRequest.isCanonicalUUID(
                localClientInstanceID
              ),
              Self.allowedSources.contains(localClientSource) else {
            throw WatchInstallationIdentityEnvelopeError.invalidEnvelope
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case nonce
        case localClientInstanceID = "local_client_instance_id"
        case localClientSource = "local_client_source"
    }
}

/// App-local, non-canonical latest-state observation. It carries only the
/// persisted Watch installation UUID and its closed local provenance.
struct WatchInstallationIdentityObservation: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let currentKind = "preworkout_installation_identity_observation"

    let version: Int
    let kind: String
    let localClientInstanceID: String
    let localClientSource: String

    func encodedStrict() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= 1_024,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set([
                "version", "kind", "local_client_instance_id",
                "local_client_source"
              ]),
              let value = try? JSONDecoder().decode(Self.self, from: data)
        else { throw WatchInstallationIdentityEnvelopeError.malformed }
        try value.validate()
        return value
    }

    static func declaresKind(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else { return false }
        return dictionary["kind"] as? String == currentKind
    }

    func reply(nonce: String) -> WatchInstallationIdentityReply {
        WatchInstallationIdentityReply(
            kind: WatchInstallationIdentityReply.currentKind,
            nonce: nonce,
            localClientInstanceID: localClientInstanceID,
            localClientSource: localClientSource
        )
    }

    private func validate() throws {
        guard version == Self.currentVersion,
              kind == Self.currentKind,
              WatchInstallationIdentityRequest.isCanonicalUUID(
                localClientInstanceID
              ),
              WatchInstallationIdentityReply.allowedSources.contains(
                localClientSource
              ) else {
            throw WatchInstallationIdentityEnvelopeError.invalidEnvelope
        }
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case kind
        case localClientInstanceID = "local_client_instance_id"
        case localClientSource = "local_client_source"
    }
}

struct WatchInstallationIdentity: Equatable, Sendable {
    let id: String
    let source: String
}

extension WatchInstallationIdentityReply {
    init(request: WatchInstallationIdentityRequest, identity: WatchInstallationIdentity) {
        self.init(kind: Self.currentKind, nonce: request.nonce,
                  localClientInstanceID: identity.id, localClientSource: identity.source)
    }
}

extension WatchInstallationIdentityObservation {
    init(identity: WatchInstallationIdentity) {
        self.init(version: Self.currentVersion, kind: Self.currentKind,
                  localClientInstanceID: identity.id, localClientSource: identity.source)
    }
}
