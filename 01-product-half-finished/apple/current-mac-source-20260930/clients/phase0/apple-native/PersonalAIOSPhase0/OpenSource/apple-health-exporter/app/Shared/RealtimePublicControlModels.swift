import Foundation

// Client-local projections of the T01/T11B successor fixtures. These types
// deliberately do not define or publish a shared wire contract.
struct RealtimeCanonicalReference: Codable, Equatable, Sendable {
    let refType: String
    let refID: String
    let objectVersion: String
    let canonicalPayloadSha256: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case refType = "ref_type"
        case refID = "ref_id"
        case objectVersion = "object_version"
        case canonicalPayloadSha256 = "canonical_payload_sha256"
    }

    static var wireFieldNames: Set<String> {
        Set(CodingKeys.allCases.map(\.rawValue))
    }
}

struct RealtimeTransportAlias: Codable, Equatable, Sendable {
    let aliasType: String
    let issuer: String
    let value: String

    private enum CodingKeys: String, CodingKey {
        case aliasType = "alias_type"
        case issuer
        case value
    }
}

struct RealtimeLiveKitCredentials: Codable, Equatable, Sendable {
    let serverURL: String
    let participantToken: String
    let credentialExpiresAt: String

    private enum CodingKeys: String, CodingKey {
        case serverURL = "server_url"
        case participantToken = "participant_token"
        case credentialExpiresAt = "credential_expires_at"
    }
}

/// Non-secret bootstrap metadata for the application-controlled HPKE key
/// envelope.  Content key bytes are delivered only by the resolve response.
struct RealtimeE2EEKeyEnvelopeScope: Codable, Equatable, Sendable {
    let deviceID: String
    let channels: [String]
    let distributionMode: String

    private enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case channels
        case distributionMode = "distribution_mode"
    }
}

struct RealtimeE2EEKeyEnvelope: Codable, Equatable, Sendable {
    let keyEnvelopeRef: RealtimeTransportAlias
    let keyIndex: Int
    let keyGeneration: String
    let expiresAt: String
    let scope: RealtimeE2EEKeyEnvelopeScope
    let realtimeSessionRef: RealtimeCanonicalReference
    let continuityID: String

    private enum CodingKeys: String, CodingKey {
        case keyEnvelopeRef = "key_envelope_ref"
        case keyIndex = "key_index"
        case keyGeneration = "key_generation"
        case expiresAt = "expires_at"
        case scope
        case realtimeSessionRef = "realtime_session_ref"
        case continuityID = "continuity_id"
    }
}

/// Canonical server context is supplied by the owner-side body provider. The
/// client carries it only to build a public registration projection.
struct RealtimeE2EERecipientRegistrationContext: Equatable, Sendable {
    let deviceID: String
    let deviceCredentialRef: RealtimeCanonicalReference
    let audience: RealtimeTransportAlias
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let expiresAt: String
}

/// Public-only X25519 registration material. It intentionally contains no
/// private key, bearer, content key, or server authority.
struct RealtimeE2EERecipientCredentialRegistration: Equatable, Sendable {
    let algorithm: String
    let purpose: String
    let publicKeyRaw: Data
    let publicKey: String
    let publicKeySha256: String
    let deviceCredentialRef: RealtimeCanonicalReference
    let audience: RealtimeTransportAlias
    let deviceID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let expiresAt: String
}

/// Owner-provisioned, app-local enrollment metadata. The bundle is accepted
/// only after its canonical body bytes and binding references are validated;
/// this client never creates or repairs any of its fields.
struct RealtimeEnrollmentBinding: Codable, Equatable, Sendable {
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
    }

    static var wireFieldNames: Set<String> {
        Set(CodingKeys.allCases.map(\.rawValue))
    }
}

struct RealtimeFormalWatchBinding: Codable, Equatable, Sendable {
    struct Endpoint: Codable, Equatable, Sendable {
        let deviceId: String
        let clientInstanceId: String
        let deviceLeaseRef: RealtimeCanonicalReference
    }
    let bindingId: String
    let kind: String
    let status: String
    let pairVersion: String
    let installationId: String
    let userId: String
    let issuedAt: String
    let expiresAt: String
    let canonicalPayloadSha256: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let iphone: Endpoint
    let watch: Endpoint

    var origin: CyclingWatchOriginBinding? {
        CyclingWatchOriginBinding(serverAuthoritativeDeviceID: watch.deviceId,
            serverAuthoritativeClientInstanceID: watch.clientInstanceId,
            serverAuthoritativeDeviceClass: "apple_watch")
    }
}

struct RealtimeFormalWatchPairState: Codable, Equatable, Sendable {
    let pairVersion: String
    let status: String
    let requiresRebind: Bool
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case pairVersion = "pair_version"
        case status
        case requiresRebind = "requires_rebind"
    }

    static var wireFieldNames: Set<String> {
        Set(CodingKeys.allCases.map(\.rawValue))
    }
}

/// The only artifact emitted by the DEBUG registration export (input to pairing). It contains
/// public X25519 material and a hash of the fixed local Keychain slot only.
struct RealtimeE2EERecipientRegistrationExport:
    Codable, Equatable, Sendable {
    static let schema = "paios.realtime-e2ee-recipient-registration.v1"

    let schema: String
    let publicRaw32Base64URL: String
    let publicSha256: String
    let localSlotRefHash: String
    let createdAt: String

    private enum CodingKeys: String, CodingKey {
        case schema
        case publicRaw32Base64URL = "public_raw32_base64url"
        case publicSha256 = "public_sha256"
        case localSlotRefHash = "local_slot_ref_hash"
        case createdAt = "created_at"
    }
}

struct RealtimeBootstrapProjection: Codable, Equatable, Sendable {
    let operation: String
    let bootstrapMode: String
    let status: String
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let transportAliases: [RealtimeTransportAlias]
    let connectionEpoch: String
    let livekit: RealtimeLiveKitCredentials
    let e2eeKeyEnvelope: RealtimeE2EEKeyEnvelope

    private enum CodingKeys: String, CodingKey {
        case operation
        case bootstrapMode = "bootstrap_mode"
        case status
        case requestID = "request_id"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case transportAliases = "transport_aliases"
        case connectionEpoch = "connection_epoch"
        case livekit
        case e2eeKeyEnvelope = "e2ee_key_envelope"
    }
}

struct RealtimeHandoffProjection: Codable, Equatable, Sendable {
    let operation: String
    let status: String
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let previousDeviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String
    let fromDeviceID: String
    let toDeviceID: String
    let leaseVersion: String
    let fencingToken: String
    let operationOutcome: RealtimeOperationOutcome
    let executionFacts: RealtimeExecutionFacts

    private enum CodingKeys: String, CodingKey {
        case operation
        case status
        case requestID = "request_id"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case previousDeviceLeaseRef = "previous_device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
        case fromDeviceID = "from_device_id"
        case toDeviceID = "to_device_id"
        case leaseVersion = "lease_version"
        case fencingToken = "fencing_token"
        case operationOutcome = "operation_outcome"
        case executionFacts = "execution_facts"
    }
}

struct RealtimeOperationOutcome: Codable, Equatable, Sendable {
    let outcomeClass: String
    let resolutionMode: String

    private enum CodingKeys: String, CodingKey {
        case outcomeClass = "outcome_class"
        case resolutionMode = "resolution_mode"
    }
}

struct RealtimeExecutionFacts: Codable, Equatable, Sendable {
    let closureStatus: String
    let deviceLeaseRelease: String
    let participantCleanup: String?
    let trackCleanup: String?
    let roomCleanup: String?

    private enum CodingKeys: String, CodingKey {
        case closureStatus = "closure_status"
        case deviceLeaseRelease = "device_lease_release"
        case participantCleanup = "participant_cleanup"
        case trackCleanup = "track_cleanup"
        case roomCleanup = "room_cleanup"
    }
}

struct RealtimeMediaStopProjection: Codable, Equatable, Sendable {
    let operation: String
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String
    let reason: String
    let releaseScope: String

    private enum CodingKeys: String, CodingKey {
        case operation
        case requestID = "request_id"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
        case reason
        case releaseScope = "release_scope"
    }
}

struct RealtimeDeferredProjection: Codable, Equatable, Sendable {
    let operation: String
    let status: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference?
    let requestID: String
    let continuityID: String
    let connectionEpoch: String

    private enum CodingKeys: String, CodingKey {
        case operation, status
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case requestID = "request_id"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
    }
}

struct RealtimeRefreshedCredential: Decodable {
    let transportCredential: TransportCredential

    struct TransportCredential: Decodable {
        let credential: String
        let expiresAt: String
        let credentialGeneration: String

        private enum CodingKeys: String, CodingKey {
            case credential
            case expiresAt = "expires_at"
            case credentialGeneration = "credential_generation"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case transportCredential = "transport_credential"
    }
}
