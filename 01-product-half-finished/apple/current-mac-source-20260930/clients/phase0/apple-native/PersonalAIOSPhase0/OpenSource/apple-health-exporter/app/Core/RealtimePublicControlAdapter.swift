import CryptoKit
import CoreFoundation
import Foundation

enum RealtimePublicControlOperation: String, CaseIterable, Sendable {
    case bootstrap
    case e2eeKeyResolve = "realtime_e2ee_key_resolve"
    case credentialRefresh = "connected_credential_refresh"
    case mediaStop = "media_stop"
    case endContinuity = "end_continuity"
    case handoff
    case watchBinding = "watch_binding"

    var path: String {
        switch self {
        case .bootstrap:
            return "/v1/realtime/bootstrap"
        case .e2eeKeyResolve:
            return "/v1/realtime/e2ee/key/resolve"
        case .credentialRefresh:
            return "/v1/realtime/credentials/refresh"
        case .mediaStop:
            return "/v1/realtime/media/stop"
        case .endContinuity:
            return "/v1/realtime/end-continuity"
        case .handoff:
            return "/v1/realtime/handoff"
        case .watchBinding:
            return "/v1/realtime/watch-binding"
        }
    }
}

// This key is app-local routing context only. It is never serialized, sent, or
// interpreted as identity, governance, authority, or idempotency material.
struct RealtimeCanonicalRequestContext: Equatable, Sendable {
    let operation: RealtimePublicControlOperation
    let localBinding: String
    let retainedBootstrapBinding: RealtimeBootstrapLocalBinding?

    init(
        operation: RealtimePublicControlOperation,
        localBinding: String,
        retainedBootstrapBinding: RealtimeBootstrapLocalBinding? = nil
    ) {
        self.operation = operation
        self.localBinding = localBinding
        self.retainedBootstrapBinding = retainedBootstrapBinding
    }

    var isPresent: Bool {
        !localBinding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

protocol RealtimeCanonicalRequestBodyProviding: Sendable {
    // The returned bytes are already canonical. Implementations must not ask
    // this Apple client to synthesize or repair any wire-contract field.
    func canonicalBody(
        for operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> Data?
    func replayScope() throws -> Data?
}

extension RealtimeCanonicalRequestBodyProviding {
    func replayScope() throws -> Data? { nil }
}

struct AppLocalCanonicalRequestBodyProvider:
    RealtimeCanonicalRequestBodyProviding,
    Sendable {
    typealias Resolver = @Sendable (
        RealtimePublicControlOperation,
        RealtimeCanonicalRequestContext
    ) async throws -> Data?

    private let resolver: Resolver
    private let scope: Data?

    init(replayScope: Data? = nil, resolver: @escaping Resolver) {
        self.scope = replayScope
        self.resolver = resolver
    }

    func replayScope() throws -> Data? { scope }

    func canonicalBody(
        for operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> Data? {
        try await resolver(operation, context)
    }
}

struct MissingRealtimeCanonicalRequestBodyProvider:
    RealtimeCanonicalRequestBodyProviding,
    Sendable {
    func canonicalBody(
        for operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> Data? {
        _ = operation
        _ = context
        return nil
    }
}

private enum RealtimeEnrollmentDigest {
    static func hex(_ data: Data) -> String {
        SHA256.hash(data: data).map {
            String(format: "%02x", $0)
        }.joined()
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}

enum RealtimeControlValidationError: Error, Equatable, Sendable {
    case invalidEnvelope
    case invalidSchema
    case invalidOrigin
    case invalidReference
    case invalidTimestamp
    case invalidBody
    case bundleExpired
}

enum RealtimeControlValidation {
    static func validateFormalWatch(_ formal: RealtimeFormalWatchBinding, raw: [String: Any], binding: RealtimeEnrollmentBinding, now: Date, allowRevoked: Bool = false) throws {
        let keys: Set<String> = ["bindingId", "canonicalPayloadSha256", "expiresAt", "idempotencyKey", "iphone", "issuedAt", "kind", "objectVersion", "realtimeSessionRef", "requestFingerprintSha256", "requestId", "watch", "pairVersion", "installationId", "userId", "principalRef", "status"]
        let uuid7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        guard Set(raw.keys) == keys, formal.kind == "t02.apple.watch-binding.v1", formal.status == "active" || (allowRevoked && formal.status == "revoked"),
              (allowRevoked && formal.status == "revoked") || (formal.realtimeSessionRef == binding.realtimeSessionRef && formal.iphone.deviceLeaseRef == binding.deviceLeaseRef),
              [formal.bindingId, formal.userId, formal.iphone.deviceId, formal.iphone.clientInstanceId, formal.watch.deviceId, formal.watch.clientInstanceId].allSatisfy({ $0.range(of: uuid7, options: .regularExpression) != nil }),
              formal.pairVersion.range(of: "^[1-9][0-9]{0,37}$", options: .regularExpression) != nil,
              let expiry = parseTimestamp(formal.expiresAt), expiry > now || (allowRevoked && formal.status == "revoked"),
              let issued = parseTimestamp(formal.issuedAt), issued < expiry,
              formal.origin != nil else { throw RealtimeControlValidationError.invalidReference }
        for name in ["iphone", "watch"] {
            guard let endpoint = raw[name] as? [String: Any], Set(endpoint.keys) == Set(["deviceId", "clientInstanceId", "deviceLeaseRef"]),
                  let reference = endpoint["deviceLeaseRef"] as? [String: Any], Set(reference.keys) == RealtimeCanonicalReference.wireFieldNames else { throw RealtimeControlValidationError.invalidReference }
        }
        try validateReference(formal.realtimeSessionRef, expectedType: "RealtimeSession")
        try validateReference(formal.iphone.deviceLeaseRef, expectedType: "DeviceLease")
        try validateReference(formal.watch.deviceLeaseRef, expectedType: "DeviceLease")
        var body = raw
        body.removeValue(forKey: "canonicalPayloadSha256")
        let canonical = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        let domain = Data("paios.t02.apple-watch-binding.receipt.v1\n".utf8)
        guard RealtimeEnrollmentDigest.hex(domain + canonical) == formal.canonicalPayloadSha256 else {
            throw RealtimeControlValidationError.invalidReference
        }
    }

    private static func validateReference(_ reference: RealtimeCanonicalReference,
        expectedType: String) throws {
        guard validReference(reference, expectedType: expectedType, strictText: true) else {
            throw RealtimeControlValidationError.invalidReference
        }
    }

    static func validReference(_ reference: RealtimeCanonicalReference,
        expectedType: String, strictText: Bool) -> Bool {
        let values = [reference.refType, reference.refID, reference.objectVersion,
            reference.canonicalPayloadSha256]
        let textValid = values.allSatisfy { value in
            !value.isEmpty && (!strictText || (value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil && value.unicodeScalars.allSatisfy {
                !$0.properties.isWhitespace && !((0x00...0x1F).contains($0.value) || $0.value == 0x7F)
            }))
        }
        return reference.refType == expectedType && textValid
            && reference.canonicalPayloadSha256.utf8.count == 64
            && reference.canonicalPayloadSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    static func parseTimestamp(_ value: String) -> Date? {
        guard value.range(
            of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$"#,
            options: .regularExpression
        ) != nil else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds
        ]
        if let value = formatter.date(from: value) {
            return value
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

private enum RealtimeEnrollmentTimestamp {
    static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds
        ]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

enum RealtimeE2EERegistrationRuntime {
    static func exportRegistration(
        to fileURL: URL,
        fileManager: FileManager = .default,
        keyStore: any E2EERecipientKeyStoring =
            KeychainE2EERecipientKeyStore(),
        now: Date = Date()
    ) throws {
        let manager = RealtimeE2EERecipientKeyManager(store: keyStore)
        let registration = try manager.registrationExport(now: now)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(registration)

        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: .atomic)
        try applyOwnerOnlyFilePolicy(fileURL, fileManager: fileManager)
    }

    private static func applyOwnerOnlyFilePolicy(
        _ fileURL: URL,
        fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [
                .protectionKey: FileProtectionType.complete,
                .posixPermissions: NSNumber(value: 0o600)
            ],
            ofItemAtPath: fileURL.path
        )
        var mutableURL = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
    }
}

protocol AssistantBootstrapInvalidating: Sendable {
    func invalidatePendingBootstrap() async
}

enum RealtimePublicControlAdapterError: Error, Equatable, Sendable {
    case malformedFixture
    case unexpectedOperation
    case unsupportedFirstSliceOperation
    case invalidCommittedStop
    case invalidConnectionDetails
    case missingCanonicalContext
    case missingCanonicalBody
    case canonicalBodyTooLarge
    case invalidPublicOrigin
    case invalidEndpointURL
    case missingBearerCredential
    case invalidBearerCredential
    case invalidHTTPResponse
    case unexpectedHTTPStatus(Int, String?)
    case responseTooLarge
    case transportFailure
    case bootstrapSuperseded
    case bootstrapCancelled
    case staleBinding
    case e2eeOpenFailed

    /// Only the device/bearer authority can end pairing; an unrelated HTTP rejection cannot.
    var isPairingRevoked: Bool {
        switch self {
        case .unexpectedHTTPStatus(401, "CONTROL_CAPABILITY_INVALID"),
             .unexpectedHTTPStatus(403, "PAIRED_DEVICE_REVOKED"): return true
        default: return false
        }
    }

    static func unexpectedHTTPStatus(_ status: Int) -> Self {
        .unexpectedHTTPStatus(status, nil)
    }
}

struct RealtimeBootstrapLocalBinding: Codable, Equatable, Sendable {
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String
    let transportAliases: [RealtimeTransportAlias]
    let e2eeKeyEnvelope: RealtimeE2EEKeyEnvelope
    /// The paired device's E2EE recipient credential, named by the bootstrap response (optional only so replay rows
    /// recorded before pairing still decode; key resolution requires it).
    var recipientDeviceCredentialRef: RealtimeCanonicalReference? = nil
}

struct RealtimeBootstrapMapping: Sendable {
    let connectionDetails: AssistantConnectionDetails
    // A local correlation snapshot only; the server remains authoritative.
    let localBinding: RealtimeBootstrapLocalBinding
    let centralTransportBinding: CentralTransportBinding?
}

struct RealtimeStopConfirmation: Equatable, Sendable {
    let requestID: String
    let confirmed: Bool
}

struct RealtimeStopExpectation: Equatable, Sendable {
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String

    func matches(_ binding: RealtimeBootstrapLocalBinding) -> Bool {
        realtimeSessionRef == binding.realtimeSessionRef
            && deviceLeaseRef == binding.deviceLeaseRef
            && continuityID == binding.continuityID
            && connectionEpoch == binding.connectionEpoch
    }
}

struct RealtimePublicControlAdapter: Sendable {
    private let decoder: JSONDecoder
    fileprivate let e2eeNow: @Sendable () -> Date

    init(e2eeNow: @escaping @Sendable () -> Date = { Date() }) {
        decoder = JSONDecoder()
        self.e2eeNow = e2eeNow
    }

    func decodeBootstrap(_ data: Data) throws -> RealtimeBootstrapProjection {
        let projection = try decode(RealtimeBootstrapProjection.self, data)
        guard projection.operation == "bootstrap",
              projection.status == "bootstrap_accepted" else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return projection
    }

    func mapBootstrap(_ data: Data) throws -> RealtimeBootstrapMapping {
        let wire = try decode(BootstrapWireEnvelope.self, data)
        return try mapBootstrap(wire, central: AssistantCentralTextWire.bootstrapEnvelope(data))
    }

    private func mapBootstrap(_ wire: BootstrapWireEnvelope, central: CentralBody?) throws -> RealtimeBootstrapMapping {
        let projection = wire.projection
        let grants = wire.mediaGrants
        guard projection.operation == "bootstrap", projection.status == "bootstrap_accepted" else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }

        guard !projection.livekit.participantToken.isEmpty,
        projection.livekit.participantToken.utf8.count <= 32_768,
        let serverURL = URL(string: projection.livekit.serverURL),
        let serverComponents = URLComponents(
            url: serverURL,
            resolvingAgainstBaseURL: false
        ),
        serverComponents.scheme?.lowercased() == "wss",
        serverComponents.host?.isEmpty == false,
        serverComponents.user == nil,
        serverComponents.password == nil,
        serverComponents.query == nil,
        serverComponents.fragment == nil
        else {
            throw RealtimePublicControlAdapterError.invalidConnectionDetails
        }

        let roomAliases = projection.transportAliases.filter {
            $0.aliasType == "room"
                && $0.issuer == "livekit_cloud"
                && !$0.value.isEmpty
        }
        let e2ee = projection.e2eeKeyEnvelope
        let localBinding = try qualifyPublicBinding(RealtimeEnrollmentBinding(
            realtimeSessionRef: projection.realtimeSessionRef, deviceLeaseRef: projection.deviceLeaseRef,
            continuityID: projection.continuityID, connectionEpoch: projection.connectionEpoch),
            aliases: projection.transportAliases, e2ee: e2ee, credential: wire.credentialRef)

        var sources = Set<AssistantMediaSource>()
        if grants.audio.enabled {
            sources.insert(.microphone)
        }
        if grants.video.enabled {
            sources.insert(.camera)
        }

        var centralBinding: CentralTransportBinding?
        if let metadata = central {
            guard let gateway = (try metadata.value("expected_gateway_identity", as: String.self)),
                  let limit = (try metadata.value("max_packet_bytes", as: Int.self)) else {
                throw RealtimePublicControlAdapterError.invalidConnectionDetails
            }
            centralBinding = CentralTransportBinding(sessionID: projection.continuityID,
                deviceID: e2ee.scope.deviceID, connectionEpoch: projection.connectionEpoch,
                expectedGatewayIdentity: gateway, maxPacketBytes: limit,
                voiceTransport: (try metadata.value("voice_transport", as: String.self)),
                callRejoinWindowS: (try metadata.value("call_rejoin_window_s", as: Int.self)))
        }
        return RealtimeBootstrapMapping(
            connectionDetails: AssistantConnectionDetails(
                serverURL: serverURL,
                roomName: roomAliases[0].value,
                participantToken: projection.livekit.participantToken,
                capabilities: AssistantMediaCapabilities(
                    publishableSources: sources,
                    canPublishData: grants.data.enabled
                )
            ),
            localBinding: localBinding,
            centralTransportBinding: centralBinding
        )
    }

    private func qualifyPublicBinding(_ binding: RealtimeEnrollmentBinding, aliases: [RealtimeTransportAlias],
        e2ee: RealtimeE2EEKeyEnvelope, credential: RealtimeCanonicalReference) throws -> RealtimeBootstrapLocalBinding {
        guard validReference(binding.realtimeSessionRef, expectedType: "RealtimeSession"),
              validReference(credential, expectedType: "DeviceCredential"),
              validReference(binding.deviceLeaseRef, expectedType: "DeviceLease"),
              !binding.continuityID.isEmpty, !binding.connectionEpoch.isEmpty,
              !aliases.isEmpty, aliases.allSatisfy(validAlias),
              aliases.filter({ $0.aliasType == "room" && $0.issuer == "livekit_cloud" && !$0.value.isEmpty }).count == 1 else {
            throw RealtimePublicControlAdapterError.invalidConnectionDetails
        }
        guard validAlias(e2ee.keyEnvelopeRef),
              e2ee.keyEnvelopeRef.aliasType == "key_envelope",
              e2ee.keyIndex >= 0,
              validDecimal(e2ee.keyGeneration),
              validReference(
                  e2ee.realtimeSessionRef,
                  expectedType: "RealtimeSession"
              ),
              e2ee.realtimeSessionRef == binding.realtimeSessionRef,
              !e2ee.continuityID.isEmpty,
              e2ee.continuityID == binding.continuityID,
              !e2ee.scope.deviceID.isEmpty,
              !e2ee.scope.channels.isEmpty,
              e2ee.scope.distributionMode ==
                  "application_controlled_envelope" else {
            throw RealtimePublicControlAdapterError.invalidConnectionDetails
        }

        return RealtimeBootstrapLocalBinding(realtimeSessionRef: binding.realtimeSessionRef,
            deviceLeaseRef: binding.deviceLeaseRef, continuityID: binding.continuityID,
            connectionEpoch: binding.connectionEpoch, transportAliases: aliases, e2eeKeyEnvelope: e2ee,
            recipientDeviceCredentialRef: credential)
    }

    enum BootstrapReadDisposition: Equatable, Sendable {
        /// Committed: the fact carries the binding of a session this device must stop.
        case sessionToStop
        /// Terminal without a stoppable session (never recorded, failed, indeterminate): nothing this device can
        /// stop; the gateway's one-session-per-device supersede is the only cleanup left.
        case nothingToStop
        /// Still executing (`in_flight`) or a status this client does not know: the outcome is open, so the
        /// pending bootstrap and its recovery duty stay until a later read settles it.
        case unresolved
    }

    /// Exhaustive classification of the gateway's historical read (`missing`, `in_flight`, `committed`, `failed`,
    /// `indeterminate`). Only a terminal answer releases the pending bootstrap.
    func classifyBootstrapRead(_ data: Data) throws -> BootstrapReadDisposition {
        let fact = try decode(BootstrapReadEnvelope.self, data)
        guard fact.operation == "bootstrap", fact.kind == "paios.public-operation.read.v1" else {
            throw AssistantBootstrapError.remoteStopUnconfirmed
        }
        switch fact.status {
        case "committed": return fact.errorCode == nil ? .sessionToStop : .nothingToStop
        case "missing", "failed", "indeterminate": return .nothingToStop
        default: return .unresolved
        }
    }

    func bootstrapReadLeftSessionToStop(_ data: Data) throws -> Bool {
        try classifyBootstrapRead(data) == .sessionToStop
    }

    /// A committed read fact carries the full binding the original bootstrap produced.
    func qualifyBootstrapRead(_ data: Data) throws -> RealtimeBootstrapLocalBinding {
        let fact = try decode(BootstrapReadEnvelope.self, data)
        guard fact.operation == "bootstrap", fact.kind == "paios.public-operation.read.v1",
              fact.status == "committed", fact.errorCode == nil, fact.outcome == nil,
              let session = fact.realtimeSessionRef, let lease = fact.deviceLeaseRef,
              let continuity = fact.continuityID, let epoch = fact.connectionEpoch,
              let credential = fact.credentialRef, let aliases = fact.aliases, let e2ee = fact.e2ee else {
            throw AssistantBootstrapError.remoteStopUnconfirmed
        }
        return try qualifyPublicBinding(RealtimeEnrollmentBinding(realtimeSessionRef: session, deviceLeaseRef: lease,
            continuityID: continuity, connectionEpoch: epoch), aliases: aliases, e2ee: e2ee, credential: credential)
    }

    func decodeHandoff(_ data: Data) throws -> RealtimeHandoffProjection {
        let envelope = try decode(HandoffEnvelope.self, data)
        guard envelope.request.operation == "handoff",
              envelope.terminalResult.operation == "handoff",
              envelope.terminalResult.status == "success" else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return envelope.terminalResult
    }

    func decodeHandoffTerminal(_ data: Data) throws
        -> RealtimeHandoffProjection {
        let terminal = try decode(RealtimeHandoffProjection.self, data)
        guard terminal.operation == "handoff",
              terminal.status == "success" else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return terminal
    }

    func decodeMediaStop(_ data: Data) throws -> RealtimeMediaStopProjection {
        let projection = try decode(RealtimeMediaStopProjection.self, data)
        guard projection.operation == "media_stop" else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return projection
    }

    func decodeCredentialRefresh(_ data: Data, expected request: Data?) throws
        -> RealtimeDeferredProjection {
        let projection = try decode(RealtimeDeferredProjection.self, data)
        _ = try qualifyDeferred(data, request: request,
            operation: "connected_credential_refresh", status: "credential_refreshed",
            matching: ["device_lease_ref", "transport_aliases"])
        let credential = try decode(RealtimeRefreshedCredential.self, data).transportCredential
        guard !credential.credential.isEmpty, credential.credential.utf8.count <= 32768,
              let expiry = RealtimeControlValidation.parseTimestamp(credential.expiresAt), expiry > Date(),
              validDecimal(credential.credentialGeneration) else {
            throw RealtimePublicControlAdapterError.malformedFixture
        }
        return projection
    }

    func mapRefreshedConnection(_ data: Data, requestData: Data,
                                existing: AssistantConnectionDetails,
                                binding: RealtimeBootstrapLocalBinding, callID: String? = nil) throws -> AssistantConnectionDetails {
        let response = try decode(CredentialRefreshWireResponse.self, data)
        let request = try decode(BoundControlWireRequest.self, requestData)
        let tuple = response.binding, credential = response.credential
        guard tuple.operation == "connected_credential_refresh", request.operation == tuple.operation,
              response.status == "credential_refreshed", !request.requestID.isEmpty, tuple.requestID == request.requestID,
              tuple.realtimeSessionRef == request.realtimeSessionRef, tuple.deviceLeaseRef == request.deviceLeaseRef,
              tuple.continuityID == request.continuityID, tuple.connectionEpoch == request.connectionEpoch,
              tuple.realtimeSessionRef == binding.realtimeSessionRef, tuple.deviceLeaseRef == binding.deviceLeaseRef,
              tuple.continuityID == binding.continuityID, tuple.connectionEpoch == binding.connectionEpoch,
              response.transportAliases == binding.transportAliases,
              binding.transportAliases.contains(where: { $0.aliasType == "room" && $0.value == existing.roomName }),
              !credential.credential.isEmpty, credential.credential.utf8.count <= 32_768,
              let expiry = RealtimeControlValidation.parseTimestamp(credential.expiresAt), expiry > Date(),
              !credential.generation.isEmpty, credential.generation.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw RealtimePublicControlAdapterError.staleBinding
        }
        var deadline: Date?
        if let rejoin = response.callRejoin {
            guard rejoin.callID == callID,
                  rejoin.deadline.range(of: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", options: .regularExpression) != nil,
                  let parsed = RealtimeControlValidation.parseTimestamp(rejoin.deadline) else {
                throw RealtimePublicControlAdapterError.staleBinding
            }
            deadline = parsed
        }
        return AssistantConnectionDetails(serverURL: existing.serverURL, roomName: existing.roomName,
            participantToken: credential.credential, capabilities: existing.capabilities, callRejoinDeadline: deadline)
    }

    func decodeE2EEResolve(_ data: Data, expected request: Data?) throws -> RealtimeDeferredProjection {
        guard let request else { throw RealtimePublicControlAdapterError.missingCanonicalBody }
        _ = try RealtimeE2EEHPKE.qualify(responseData: data, requestData: request, now: e2eeNow())
        return try decode(RealtimeDeferredProjection.self, data)
    }

    func decodeEndContinuity(_ data: Data, expected request: Data?) throws -> RealtimeDeferredProjection {
        let projection = try decode(RealtimeDeferredProjection.self, data)
        let (response, pending) = try qualifyDeferred(data, request: request,
            operation: "end_continuity", status: "success", matching: [])
        if response["device_lease_ref"] != nil || pending["device_lease_ref"] != nil {
            try requireEqual(response["device_lease_ref"], pending["device_lease_ref"])
        }
        try qualifyCommittedOutcome(response, request: pending)
        let facts = try wireObject(response["execution_facts"])
        guard ["not_applicable", "verified_closed"].contains(facts["closure_status"] as? String ?? "") else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return projection
    }

    func qualifyHandoff(_ data: Data, expected request: Data?) throws -> RealtimeHandoffProjection {
        let terminal = try decodeHandoffTerminal(data)
        let (response, pending) = try qualifyDeferred(data, request: request,
            operation: "handoff", status: "success", matching: ["from_device_id", "to_device_id"])
        try requireEqual(response["previous_device_lease_ref"], pending["current_device_lease_ref"])
        guard terminal.deviceLeaseRef != terminal.previousDeviceLeaseRef,
              validReference(terminal.deviceLeaseRef, expectedType: "DeviceLease"),
              validDecimal(terminal.leaseVersion), validDecimal(terminal.fencingToken) else {
            throw RealtimePublicControlAdapterError.staleBinding
        }
        let recorded = try qualifyCommittedOutcome(response, request: pending)
        try requireEqual(recorded["fencing_epoch"], response["fencing_token"])
        let fence = try wireObject(response["old_device_suppression_fence"])
        for key in ["from_device_id", "previous_device_lease_ref", "connection_epoch", "fencing_token"] {
            try requireEqual(fence[key], response[key])
        }
        try requireEqual(fence["new_device_lease_ref"], response["device_lease_ref"])
        let facts = try wireObject(response["execution_facts"])
        guard fence["state"] as? String == "old_device_suppressed",
              terminal.executionFacts.closureStatus == "verified_closed",
              terminal.executionFacts.deviceLeaseRelease == "released",
              (terminal.executionFacts.participantCleanup == nil || terminal.executionFacts.participantCleanup == "verified_absent"),
              (terminal.executionFacts.trackCleanup == nil || terminal.executionFacts.trackCleanup == "verified_absent"),
              (terminal.executionFacts.roomCleanup == nil || terminal.executionFacts.roomCleanup == "verified_absent"),
              let evidence = facts["evidence_refs"] as? [[String: Any]], !evidence.isEmpty else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return terminal
    }

    private func qualifyDeferred(_ data: Data, request: Data?, operation: String,
        status: String, matching: [String]) throws -> ([String: Any], [String: Any]) {
        guard let request else { throw RealtimePublicControlAdapterError.missingCanonicalBody }
        let response = try wireObject(JSONSerialization.jsonObject(with: data))
        let pending = try wireObject(JSONSerialization.jsonObject(with: request))
        guard response["operation"] as? String == operation, pending["operation"] as? String == operation,
              response["status"] as? String == status else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        for key in ["request_id", "realtime_session_ref", "continuity_id", "connection_epoch", "governance"] + matching {
            try requireEqual(response[key], pending[key])
        }
        return (response, pending)
    }

    @discardableResult
    private func qualifyCommittedOutcome(_ response: [String: Any], request: [String: Any]) throws -> [String: Any] {
        let outcome = try wireObject(response["operation_outcome"])
        let recorded = try wireObject(outcome["recorded_result_ref"])
        guard outcome["outcome_class"] as? String == "committed_success",
              recorded["outcome_class"] as? String == "committed_success",
              let fencing = recorded["fencing_epoch"] as? String, validDecimal(fencing),
              ["result_schema_id", "result_schema_version", "result_schema_sha256", "result_payload_sha256"].allSatisfy({
                  (recorded[$0] as? String)?.isEmpty == false
              }) else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        try requireEqual(recorded["idempotency_context"], request["idempotency_context"])
        return recorded
    }

    private func wireObject(_ value: Any?) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw RealtimePublicControlAdapterError.malformedFixture }
        return object
    }

    private func requireEqual(_ actual: Any?, _ expected: Any?) throws {
        guard let actual, let expected,
              NSDictionary(dictionary: ["value": actual]).isEqual(to: ["value": expected]) else {
            throw RealtimePublicControlAdapterError.staleBinding
        }
    }

    func decodeStopExpectation(_ data: Data) throws
        -> RealtimeStopExpectation {
        let request = try decode(BoundControlWireRequest.self, data)
        guard request.operation == "media_stop",
              !request.requestID.isEmpty,
              validReference(
                request.realtimeSessionRef,
                expectedType: "RealtimeSession"
              ),
              validReference(
                request.deviceLeaseRef,
                expectedType: "DeviceLease"
              ),
              !request.continuityID.isEmpty,
              !request.connectionEpoch.isEmpty else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return RealtimeStopExpectation(
            requestID: request.requestID,
            realtimeSessionRef: request.realtimeSessionRef,
            deviceLeaseRef: request.deviceLeaseRef,
            continuityID: request.continuityID,
            connectionEpoch: request.connectionEpoch
        )
    }

    func decodeStopConfirmation(
        _ data: Data,
        expected: RealtimeStopExpectation
    ) throws -> RealtimeStopConfirmation {
        let terminal = try decode(StopWireResponse.self, data).terminalResult
        guard terminal.operation == "media_stop", !terminal.requestID.isEmpty else {
            throw RealtimePublicControlAdapterError.unexpectedOperation
        }
        return RealtimeStopConfirmation(
            requestID: terminal.requestID,
            confirmed: terminal.status == "success"
                && terminal.requestID == expected.requestID
                && terminal.realtimeSessionRef == expected.realtimeSessionRef
                && terminal.deviceLeaseRef == expected.deviceLeaseRef
                && terminal.continuityID == expected.continuityID
                && terminal.connectionEpoch == expected.connectionEpoch
                && verifyCommittedStop(
                outcomeClass: terminal.operationOutcome.outcomeClass,
                closureStatus: terminal.executionFacts.closureStatus,
                deviceLeaseRelease: terminal.executionFacts.deviceLeaseRelease,
                participantCleanup: terminal.executionFacts.participantCleanup,
                trackCleanup: terminal.executionFacts.trackCleanup,
                roomCleanup: terminal.executionFacts.roomCleanup
            )
        )
    }

    func verifyCommittedStop(
        outcomeClass: String,
        closureStatus: String,
        deviceLeaseRelease: String,
        participantCleanup: String?,
        trackCleanup: String?,
        roomCleanup: String?
    ) -> Bool {
        outcomeClass == "committed_success"
            && closureStatus == "verified_closed"
            && deviceLeaseRelease == "released"
            && participantCleanup == "verified_absent"
            && trackCleanup == "verified_absent"
            && roomCleanup == "verified_absent"
    }

    private func validReference(_ reference: RealtimeCanonicalReference,
        expectedType: String) -> Bool {
        RealtimeControlValidation.validReference(reference, expectedType: expectedType, strictText: false)
    }

    private func validAlias(_ alias: RealtimeTransportAlias) -> Bool {
        !alias.aliasType.isEmpty && !alias.issuer.isEmpty && !alias.value.isEmpty
    }

    private func validDecimal(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return !bytes.isEmpty
            && bytes.first != 48
            && bytes.count <= 38
            && bytes.allSatisfy { (48...57).contains($0) }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch let error as RealtimePublicControlAdapterError {
            throw error
        } catch {
            throw RealtimePublicControlAdapterError.malformedFixture
        }
    }
}

private struct RealtimeProviderBindingSnapshot: Equatable, Sendable {
    let binding: RealtimeBootstrapLocalBinding
    let version: UInt64
    let bootstrapGeneration: UInt64
}

private struct RealtimeProviderStopToken: Equatable, Sendable {
    let sequence: UInt64
    let bindingVersion: UInt64
}

final class RealtimeE2EERecipientKeyManager: @unchecked Sendable {
    private let store: any E2EERecipientKeyStoring

    init(store: any E2EERecipientKeyStoring) {
        self.store = store
    }

    func registration(
        for context: RealtimeE2EERecipientRegistrationContext
    ) throws -> RealtimeE2EERecipientCredentialRegistration {
        guard !context.deviceID.isEmpty,
              context.deviceCredentialRef.refType == "DeviceCredential",
              !context.audience.aliasType.isEmpty,
              !context.audience.issuer.isEmpty,
              !context.audience.value.isEmpty,
              context.realtimeSessionRef.refType == "RealtimeSession",
              context.deviceLeaseRef.refType == "DeviceLease",
              !context.continuityID.isEmpty,
              !context.expiresAt.isEmpty else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        let privateKey = try store.loadOrCreateRecipientPrivateKey()
        let raw = privateKey.publicKey.rawRepresentation
        let digest = RealtimeE2EEHPKE.hex(SHA256.hash(data: raw))
        return RealtimeE2EERecipientCredentialRegistration(
            algorithm: "X25519",
            purpose: "hpke_recipient",
            publicKeyRaw: raw,
            publicKey: RealtimeE2EEHPKE.base64URL(raw),
            publicKeySha256: digest,
            deviceCredentialRef: context.deviceCredentialRef,
            audience: context.audience,
            deviceID: context.deviceID,
            realtimeSessionRef: context.realtimeSessionRef,
            deviceLeaseRef: context.deviceLeaseRef,
            continuityID: context.continuityID,
            expiresAt: context.expiresAt
        )
    }

    func registrationExport(
        now: Date = Date()
    ) throws -> RealtimeE2EERecipientRegistrationExport {
        let privateKey = try store.loadOrCreateRecipientPrivateKey()
        let raw = privateKey.publicKey.rawRepresentation
        return RealtimeE2EERecipientRegistrationExport(
            schema: RealtimeE2EERecipientRegistrationExport.schema,
            publicRaw32Base64URL: RealtimeEnrollmentDigest.base64URL(raw),
            publicSha256: RealtimeEnrollmentDigest.hex(raw),
            localSlotRefHash: RealtimeEnrollmentDigest.hex(
                Data(
                    (KeychainE2EERecipientKeyStore.service + "/" +
                        KeychainE2EERecipientKeyStore.account).utf8
                )
            ),
            createdAt: RealtimeEnrollmentTimestamp.string(now)
        )
    }

    func open(
        responseData: Data,
        requestData: Data,
        now: Date
    ) throws -> Data {
        let privateKey = try store.loadOrCreateRecipientPrivateKey()
        return try RealtimeE2EEHPKE.open(
            responseData: responseData,
            requestData: requestData,
            privateKey: privateKey,
            now: now
        )
    }
}

private enum RealtimeE2EEHPKE {
    private static let suiteName =
        "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM"
    private static let profileID = "paios-realtime-e2ee-hpke-framing"
    private static let domain = "realtime/e2ee"
    private static let version = "1.0.0"
    private static let operation = "realtime_e2ee_key_resolve"
    private static let frameMagic = Data("PAIOSKEY".utf8)

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    static func qualify(responseData: Data, requestData: Data, now: Date) throws
        -> (enc: Data, ciphertext: Data, info: Data, aad: Data, request: [String: Any]) {
        guard
            let response = try? object(
                JSONSerialization.jsonObject(with: responseData)
            ),
            let request = try? object(
                JSONSerialization.jsonObject(with: requestData)
            )
        else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }

        let expectedKeys = Set([
            "operation", "status", "request_id", "idempotency_context",
            "realtime_session_ref", "device_lease_ref", "continuity_id",
            "connection_epoch", "transport_aliases", "key_envelope_ref",
            "key_index", "key_generation", "device_id",
            "recipient_device_credential_ref", "participant_audience",
            "expires_at", "cipher_suite", "encapsulated_key", "ciphertext",
            "aad_sha256", "governance"
        ])
        guard Set(response.keys) == expectedKeys,
              string(response["operation"]) == operation,
              string(response["status"]) == "key_resolved",
              string(response["cipher_suite"]) == suiteName,
              let expiresAt = response["expires_at"] as? String,
              let expiry = RealtimeControlValidation.parseTimestamp(expiresAt), expiry > now,
              let aadHash = response["aad_sha256"] as? String,
              aadHash.range(
                  of: "^[0-9a-f]{64}$",
                  options: .regularExpression
              ) != nil else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }

        for key in [
            "request_id", "idempotency_context", "realtime_session_ref",
            "device_lease_ref", "continuity_id", "connection_epoch",
            "transport_aliases", "key_envelope_ref", "key_index",
            "key_generation", "device_id", "recipient_device_credential_ref",
            "participant_audience", "governance"
        ] {
            guard try stable(response[key]) == stable(request[key]) else {
                throw RealtimePublicControlAdapterError.staleBinding
            }
        }

        let enc = try decodeBase64URL(response["encapsulated_key"])
        let ciphertext = try decodeBase64URL(response["ciphertext"])
        guard enc.count == 32, ciphertext.count >= 16 else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }

        let info = try buildInfo(request)
        let aad = try buildAAD(request, expiresAt: expiresAt)
        guard hex(SHA256.hash(data: aad)) == aadHash else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }

        return (enc, ciphertext, info, aad, request)
    }

    static func open(
        responseData: Data,
        requestData: Data,
        privateKey: Curve25519.KeyAgreement.PrivateKey,
        now: Date
    ) throws -> Data {
        let (enc, ciphertext, info, aad, request) = try qualify(responseData: responseData, requestData: requestData, now: now)
        let publicKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: enc
        )
        let shared = try privateKey.sharedSecretFromKeyAgreement(
            with: publicKey
        )
        var dh = Data()
        shared.withUnsafeBytes { dh.append(contentsOf: $0) }
        let kemSuite = Data("KEM".utf8) + u16(0x0020)
        let kemPRK = labeledExtract(
            suiteID: kemSuite,
            salt: Data(),
            label: "eae_prk",
            input: dh
        )
        let kemContext = enc + privateKey.publicKey.rawRepresentation
        let sharedSecret = labeledExpand(
            suiteID: kemSuite,
            prk: kemPRK,
            label: "shared_secret",
            info: kemContext,
            outputByteCount: 32
        )

        let suiteID = Data("HPKE".utf8)
            + u16(0x0020) + u16(0x0001) + u16(0x0002)
        let pskIDHash = labeledExtract(
            suiteID: suiteID,
            salt: Data(),
            label: "psk_id_hash",
            input: Data()
        )
        let infoHash = labeledExtract(
            suiteID: suiteID,
            salt: Data(),
            label: "info_hash",
            input: info
        )
        let keyScheduleContext = Data([0]) + pskIDHash + infoHash
        let secret = labeledExtract(
            suiteID: suiteID,
            salt: sharedSecret,
            label: "secret",
            input: Data()
        )
        let key = labeledExpand(
            suiteID: suiteID,
            prk: secret,
            label: "key",
            info: keyScheduleContext,
            outputByteCount: 32
        )
        let nonce = labeledExpand(
            suiteID: suiteID,
            prk: secret,
            label: "base_nonce",
            info: keyScheduleContext,
            outputByteCount: 12
        )
        let sealed = try AES.GCM.SealedBox(
            nonce: try AES.GCM.Nonce(data: nonce),
            ciphertext: Data(ciphertext.dropLast(16)),
            tag: Data(ciphertext.suffix(16))
        )
        var opened = try AES.GCM.open(
            sealed,
            using: SymmetricKey(data: key),
            authenticating: aad
        )
        defer { opened.resetBytes(in: 0..<opened.count) }
        return try parseFrame(&opened, keyIndex: request["key_index"], generation: request["key_generation"])
    }

    private static func object(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any] else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        return value
    }

    private static func string(_ value: Any?) -> String? {
        value as? String
    }

    private static func stable(_ value: Any?) throws -> Data {
        guard let value else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        // JSONSerialization requires an array/object at the top level on
        // iOS. Wrap scalar binding fields only for canonical comparison;
        // the same representation is used for both sides and never sent.
        let jsonValue: Any = JSONSerialization.isValidJSONObject(value)
            ? value
            : [value]
        return try JSONSerialization.data(
            withJSONObject: jsonValue,
            options: [.sortedKeys]
        )
    }

    private static func decodeBase64URL(_ value: Any?) throws -> Data {
        guard let text = value as? String,
              !text.isEmpty,
              !text.contains("="),
              text.unicodeScalars.allSatisfy({
                  ($0.value >= 0x41 && $0.value <= 0x5a)
                      || ($0.value >= 0x61 && $0.value <= 0x7a)
                      || ($0.value >= 0x30 && $0.value <= 0x39)
                      || $0.value == 0x2d || $0.value == 0x5f
              }) else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        let padded = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let data = Data(base64Encoded: padded),
              base64URL(data) == text else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        return data
    }

    private static func u16(_ value: Int) -> Data {
        Data([UInt8((value >> 8) & 0xff), UInt8(value & 0xff)])
    }

    private static func lp(_ value: String) throws -> Data {
        let bytes = Data(value.utf8)
        guard bytes.count <= Int(UInt16.max) else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        return u16(bytes.count) + bytes
    }

    private static func appendLP(
        _ value: String,
        to data: inout Data
    ) throws {
        data.append(try lp(value))
    }

    private static func appendCount(
        _ count: Int,
        to data: inout Data
    ) throws {
        guard count <= Int(UInt16.max) else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        data.append(u16(count))
    }

    private static func ref(_ value: Any?) throws -> [String: Any] {
        try object(value)
    }

    private static func refBytes(_ value: Any?) throws -> Data {
        let value = try ref(value)
        guard
            let type = value["ref_type"] as? String,
            let id = value["ref_id"] as? String,
            let version = value["object_version"] as? String,
            let hash = value["canonical_payload_sha256"] as? String
        else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        let hashData = try hexBytes(hash, length: 32)
        var result = try lp(type)
        result.append(try uuidBytes(id))
        result.append(try lp(version))
        result.append(hashData)
        return result
    }

    private static func uuidBytes(_ value: String) throws -> Data {
        guard value.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: .regularExpression
        ) != nil,
        let uuid = UUID(uuidString: value) else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        let u = uuid.uuid
        return Data([
            u.0, u.1, u.2, u.3, u.4, u.5, u.6, u.7,
            u.8, u.9, u.10, u.11, u.12, u.13, u.14, u.15
        ])
    }

    private static func hexBytes(
        _ value: String,
        length: Int
    ) throws -> Data {
        guard value.count == length * 2,
              value.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil
        else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var data = Data()
        var index = value.startIndex
        for _ in 0..<length {
            let next = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<next], radix: 16) else {
                throw RealtimePublicControlAdapterError.e2eeOpenFailed
            }
            data.append(byte)
            index = next
        }
        return data
    }

    private static func aliasBytes(_ value: Any?) throws -> Data {
        let alias = try object(value)
        guard
            let type = alias["alias_type"] as? String,
            let issuer = alias["issuer"] as? String,
            let aliasValue = alias["value"] as? String else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var data = try lp(type) + lp(issuer) + lp(aliasValue)
        if let provider = alias["provider_id"] {
            data.append(1)
            guard let provider = provider as? String else {
                throw RealtimePublicControlAdapterError.e2eeOpenFailed
            }
            data.append(try uuidBytes(provider))
        } else {
            data.append(0)
        }
        return data
    }

    private static func aliasesBytes(_ value: Any?) throws -> Data {
        guard let aliases = value as? [[String: Any]] else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var data = Data()
        try appendCount(aliases.count, to: &data)
        for alias in aliases {
            data.append(try aliasBytes(alias))
        }
        return data
    }

    private static func presence(
        _ scope: [String: Any],
        _ key: String
    ) throws -> Data {
        guard let value = scope[key] else {
            return Data([0])
        }
        var result = Data([1])
        result.append(try uuidBytes(value as? String ?? ""))
        return result
    }

    private static func idempotencyBytes(_ value: Any?) throws -> Data {
        let context = try object(value)
        let scope = try object(context["idempotency_scope"])
        guard
            let owner = scope["owner_module"] as? String,
            let operation = scope["operation_kind"] as? String,
            let target = scope["target_object_type"] as? String,
            let key = context["idempotency_key"] as? String,
            let profile = context["idempotency_profile_id"] as? String,
            let version = context["idempotency_profile_version"] as? String,
            let profileHash = context["idempotency_profile_sha256"] as? String,
            let requestHash = context["idempotency_request_sha256"] as? String
        else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var result = try lp(owner)
        result.append(try lp(operation))
        result.append(try lp(target))
        result.append(try presence(scope, "user_id"))
        result.append(try presence(scope, "tenant_id"))
        result.append(try presence(scope, "target_object_id"))
        result.append(try lp(key))
        result.append(try lp(profile))
        result.append(try lp(version))
        result.append(try hexBytes(profileHash, length: 32))
        result.append(try hexBytes(requestHash, length: 32))
        return result
    }

    private static func orderedStrings(
        _ value: Any?,
        uuid: Bool
    ) throws -> Data {
        guard let values = value as? [String], !values.isEmpty else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var data = Data()
        try appendCount(values.count, to: &data)
        for item in values {
            if uuid { data.append(try uuidBytes(item)) }
            else { data.append(try lp(item)) }
        }
        return data
    }

    private static func governanceBytes(_ value: Any?) throws -> Data {
        let value = try object(value)
        return try orderedStrings(value["purpose_scopes"], uuid: false)
            + orderedStrings(value["consent_record_refs"], uuid: true)
            + orderedStrings(value["policy_decision_refs"], uuid: true)
            + orderedStrings(value["purpose_token_refs"], uuid: true)
            + orderedStrings(value["capability_grant_refs"], uuid: true)
    }

    private static func buildInfo(_ request: [String: Any]) throws -> Data {
        let session = try refBytes(request["realtime_session_ref"])
        let lease = try refBytes(request["device_lease_ref"])
        let continuity = try uuidBytes(request["continuity_id"] as? String ?? "")
        let epoch = request["connection_epoch"] as? String ?? ""
        let envelope = try aliasBytes(request["key_envelope_ref"])
        let credential = try refBytes(request["recipient_device_credential_ref"])
        let audience = try aliasBytes(request["participant_audience"])
        let keyIndex = String(request["key_index"] as? Int ?? -1)
        let keyGeneration = request["key_generation"] as? String ?? ""
        let deviceID = try uuidBytes(request["device_id"] as? String ?? "")
        var result = Data("PAIOS-RT-HPKE-INFO".utf8)
        result.append(try lp(profileID))
        result.append(try lp(domain))
        result.append(try lp(version))
        result.append(u16(0x0020))
        result.append(u16(0x0001))
        result.append(u16(0x0002))
        result.append(0)
        result.append(try lp(operation))
        result.append(session)
        result.append(lease)
        result.append(continuity)
        result.append(try lp(epoch))
        result.append(envelope)
        result.append(try lp(keyIndex))
        result.append(try lp(keyGeneration))
        result.append(deviceID)
        result.append(credential)
        result.append(audience)
        return result
    }

    private static func buildAAD(
        _ request: [String: Any],
        expiresAt: String
    ) throws -> Data {
        let session = try refBytes(request["realtime_session_ref"])
        let lease = try refBytes(request["device_lease_ref"])
        let continuity = try uuidBytes(request["continuity_id"] as? String ?? "")
        let epoch = request["connection_epoch"] as? String ?? ""
        let envelope = try aliasBytes(request["key_envelope_ref"])
        let credential = try refBytes(request["recipient_device_credential_ref"])
        let audience = try aliasBytes(request["participant_audience"])
        let requestID = request["request_id"] as? String ?? ""
        let aliases = try aliasesBytes(request["transport_aliases"])
        let keyIndex = String(request["key_index"] as? Int ?? -1)
        let keyGeneration = request["key_generation"] as? String ?? ""
        let deviceID = try uuidBytes(request["device_id"] as? String ?? "")
        let idempotency = try idempotencyBytes(request["idempotency_context"])
        let governance = try governanceBytes(request["governance"])
        var result = Data("PAIOS-RT-HPKE-AAD".utf8)
        result.append(try lp(profileID))
        result.append(try lp(domain))
        result.append(try lp(version))
        result.append(u16(0x0020))
        result.append(u16(0x0001))
        result.append(u16(0x0002))
        result.append(0)
        result.append(try lp(suiteName))
        result.append(try lp(operation))
        result.append(try lp("key_resolved"))
        result.append(try lp(requestID))
        result.append(idempotency)
        result.append(session)
        result.append(lease)
        result.append(continuity)
        result.append(try lp(epoch))
        result.append(aliases)
        result.append(envelope)
        result.append(try lp(keyIndex))
        result.append(try lp(keyGeneration))
        result.append(deviceID)
        result.append(credential)
        result.append(audience)
        result.append(try lp(expiresAt))
        result.append(governance)
        return result
    }

    private static func labeledExtract(
        suiteID: Data,
        salt: Data,
        label: String,
        input: Data
    ) -> Data {
        let labeled = Data("HPKE-v1".utf8) + suiteID + Data(label.utf8) + input
        let result = HKDF<SHA256>.extract(
            inputKeyMaterial: SymmetricKey(data: labeled),
            salt: salt
        )
        return result.withUnsafeBytes { Data($0) }
    }

    private static func labeledExpand(
        suiteID: Data,
        prk: Data,
        label: String,
        info: Data,
        outputByteCount: Int
    ) -> Data {
        let labeled = u16(outputByteCount)
            + Data("HPKE-v1".utf8) + suiteID + Data(label.utf8) + info
        let result = HKDF<SHA256>.expand(
            pseudoRandomKey: SymmetricKey(data: prk),
            info: labeled,
            outputByteCount: outputByteCount
        )
        return result.withUnsafeBytes { Data($0) }
    }

    private static func parseFrame(
        _ value: inout Data,
        keyIndex: Any?,
        generation: Any?
    ) throws -> Data {
        let index = try readLP(value, offset: 10)
        let generationText = generation as? String ?? ""
        guard value.prefix(8) == frameMagic,
              value.count >= 10,
              value[8] == 0,
              value[9] == 1,
              index.text == String(keyIndex as? Int ?? -1),
              index.offset <= value.count,
              let keyGeneration = try? readLP(value, offset: index.offset),
              keyGeneration.text == generationText,
              keyGeneration.offset + 32 == value.count else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        var result = Data(value[keyGeneration.offset..<value.count])
        value.resetBytes(in: 0..<value.count)
        return result
    }

    private static func readLP(
        _ value: Data,
        offset: Int
    ) throws -> (text: String, offset: Int) {
        guard offset + 2 <= value.count else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        let length = (Int(value[offset]) << 8) | Int(value[offset + 1])
        let start = offset + 2
        let end = start + length
        guard end <= value.count,
              let text = String(
                  data: value[start..<end],
                  encoding: .utf8
              ) else {
            throw RealtimePublicControlAdapterError.e2eeOpenFailed
        }
        return (text, end)
    }
}

protocol AssistantFormalWatchBindingProviding: Sendable {
    func currentFormalWatchOrigin() async throws -> CyclingWatchOriginBinding?
}

actor ProductionRealtimePublicControlProvider:
    AssistantBootstrapProviding,
    AssistantBootstrapInvalidating, AssistantFormalWatchBindingProviding, WatchCredentialProviding {
    static let requiredOrigin = RealtimeAPIOriginMigration.canonicalOrigin
    static let maximumCanonicalBodyBytes = 131_072
    private static let maximumResponseBytes = 131_072

    private let settingsStore: any SettingsStoring
    private let credentialStore: any CredentialStoring
    private let canonicalBodyProvider: any RealtimeCanonicalRequestBodyProviding
    private let session: URLSession
    private let originProbeNow: @Sendable () -> Date
    private var originProbe: Task<Void, Never>?
    private var originProbeScope: Data?
    private var originProbeFailures = 0
    private var nextOriginProbeAt = Date.distantPast
    private let bootstrapRecoveryWindow: Duration
    private let adapter: RealtimePublicControlAdapter
    private let recipientKeyManager: RealtimeE2EERecipientKeyManager

    private var bootstrapGeneration: UInt64 = 0
    private var inFlightBootstrapGeneration: UInt64?
    private var bindingVersion: UInt64 = 0
    private var retainedBinding: RealtimeProviderBindingSnapshot? {
        didSet { if retainedBinding != oldValue { notifyWatchCredentialAuthorityChanged() } }
    }
    private var retainedCentralTransportBinding: CentralTransportBinding?
    private var formalWatchOverrideSet = false
    private var formalWatchOverride: RealtimeFormalWatchBinding? {
        didSet { if formalWatchOverride != oldValue && !suppressWatchCredentialNotification { notifyWatchCredentialAuthorityChanged() } }
    }
    private var suppressWatchCredentialNotification = false
    private var watchCredentialObserver: (@Sendable () async -> Void)?
    func setWatchCredentialObserver(_ observer: @escaping @Sendable () async -> Void) {
        watchCredentialObserver = observer
        notifyWatchCredentialAuthorityChanged()
    }
    private func notifyWatchCredentialAuthorityChanged() {
        guard let observer = watchCredentialObserver else { return }
        Task { await observer() }
    }
    private var formalWatchRevision: UInt64 = 0
    private var formalWatchMutationPending = false {
        didSet { if formalWatchMutationPending != oldValue { notifyWatchCredentialAuthorityChanged() } }
    }
#if canImport(WatchConnectivity) && os(iOS)
    private var formalWatchChannel: WatchConnectivityPhoneAdapter?

    func bindWatchChannel(_ channel: WatchConnectivityPhoneAdapter) { formalWatchChannel = channel }
#endif
    private var stopSequence: UInt64 = 0
    private var activeStop: RealtimeProviderStopToken?
    private struct PendingStop: Codable {
        let context: AssistantStopContext
        let binding: RealtimeBootstrapLocalBinding
        let body: Data?
        let replayScope: Data?
        var bootstrapRequestBody: Data? = nil
        var origin: String? = nil
    }
    private struct PendingBootstrap: Codable {
        let operationID: String
        let requestBody: Data
        var origin: String? = nil
    }
    private var pendingBootstrap: PendingBootstrap?
    private var pendingStop: PendingStop?
    private let pendingStopDatabase: AssistantLocalOperationDatabase?
    private let requiresDurableStop: Bool
    private var pendingStopRestored = false

    init(
        settingsStore: any SettingsStoring,
        credentialStore: any CredentialStoring,
        canonicalBodyProvider: any RealtimeCanonicalRequestBodyProviding,
        session: URLSession? = nil,
        bootstrapRecoveryWindow: Duration = .seconds(60),
        originProbeNow: @escaping @Sendable () -> Date = { Date() },
        pendingStopDatabase: AssistantLocalOperationDatabase? = nil,
        requiresDurableStop: Bool = false,
        adapter: RealtimePublicControlAdapter = RealtimePublicControlAdapter(),
        recipientKeyStore: any E2EERecipientKeyStoring =
            KeychainE2EERecipientKeyStore()
    ) {
        self.pendingStopDatabase = pendingStopDatabase
        self.requiresDurableStop = requiresDurableStop
        self.settingsStore = settingsStore
        self.credentialStore = credentialStore
        self.canonicalBodyProvider = canonicalBodyProvider
        self.session = session ?? Self.makeSession()
        self.bootstrapRecoveryWindow = bootstrapRecoveryWindow
        self.originProbeNow = originProbeNow
        self.adapter = adapter
        self.recipientKeyManager = RealtimeE2EERecipientKeyManager(
            store: recipientKeyStore
        )
    }

    deinit { originProbe?.cancel() }

    static func glassesEnrollment(pairing: RealtimeDevicePairing, session: URLSession? = nil) async throws -> RealtimeGlassesEnrollment {
        try await terminalEnrollment(pairing: pairing, deviceClass: .glasses, session: session)
    }

    static func terminalEnrollment(pairing: RealtimeDevicePairing, deviceClass: RealtimeTerminalClass, session: URLSession? = nil) async throws -> RealtimeTerminalEnrollment {
        let origin = try EndpointResolver.canonicalRealtimeOrigin(from: pairing.origin)
        var request = URLRequest(url: URL(string: origin + "/v1/devices/\(deviceClass.rawValue)/enrollment")!)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 15
        request.setValue("Bearer " + pairing.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let transport = session ?? makeSession()
        defer { if session == nil { transport.finishTasksAndInvalidate() } }
        let (data, response) = try await boundedResponse(for: request, session: transport)
        guard let http = response as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        guard http.statusCode == 200 else { throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(http.statusCode, nil) }
        return try RealtimeTerminalEnrollment.decode(data, origin: origin, deviceClass: deviceClass)
    }

    func watchBindingCanResolve() -> Bool {
        retainedBinding != nil && !formalWatchMutationPending
    }

    func watchBindingIsCurrent() -> Bool {
        guard let current = retainedBinding?.binding, let formal = formalWatchOverride,
              !formalWatchMutationPending, formal.status == "active",
              formal.realtimeSessionRef == current.realtimeSessionRef,
              formal.iphone.deviceLeaseRef == current.deviceLeaseRef,
              let expiry = RealtimeControlValidation.parseTimestamp(formal.expiresAt), expiry > Date(),
              let paired = credentialStore as? PairedRealtimeCredentialStore,
              let bytes = try? paired.store.loadPairingData(),
              let pairing = try? RealtimeDevicePairing.decode(bytes),
              pairing.userID == formal.userId, pairing.deviceID == formal.iphone.deviceId,
              RealtimePairingSessionIdentity.shared.matches(CentralOwnerDataIdentity.pairing(pairing)) else { return false }
        return true
    }

    func watchCredential(action: WatchCredentialAction, requestID: String,
        prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        guard let snapshot = retainedBinding, !formalWatchMutationPending,
              let paired = credentialStore as? PairedRealtimeCredentialStore,
              let pairingData = try paired.store.loadPairingData() else { throw WatchCredentialError.staleAuthority }
        let pairing = try RealtimeDevicePairing.decode(pairingData)
        let initialRevision = formalWatchRevision
        do {
            let pair = try await readFormalWatchPairState(notifyCredentialAuthority: false)
            guard retainedBinding == snapshot, !formalWatchMutationPending,
                  try paired.store.loadPairingData() == pairingData else { throw WatchCredentialError.staleAuthority }
            guard pair.status == "active", !pair.requiresRebind else {
                try await prepare(nil)
                throw WatchCredentialError.staleAuthority
            }
            guard let formal = formalWatchOverride,
                  formal.userId == pairing.userID, formal.iphone.deviceId == pairing.deviceID,
                  retainedBinding == snapshot, formal.status == "active",
                  formal.iphone.deviceLeaseRef == snapshot.binding.deviceLeaseRef,
                  try paired.store.loadPairingData() == pairingData else { throw WatchCredentialError.staleAuthority }
            let revision = formalWatchRevision
            let scope = try JSONDecoder().decode(WatchBindingScope.self, from: JSONSerialization.data(withJSONObject: [
                "watch_device_id": formal.watch.deviceId, "pair_version": formal.pairVersion]))
            let authority = WatchCredentialAuthority(scope: scope, principal: pairing.userID,
                pairingIdentity: CentralOwnerDataIdentity.pairing(pairing))
            try await prepare(authority)
            let body = try WatchCredentialWire.request(action: action, binding: formal, requestID: requestID)
            var request = try await makeRequest(.watchBinding,
                context: RealtimeCanonicalRequestContext(operation: .watchBinding, localBinding: requestID), preservedBody: body)
            request.url = request.url!.appendingPathComponent("credential")
            defer { request.httpBody = nil; request.setValue(nil, forHTTPHeaderField: "Authorization") }
            guard retainedBinding == snapshot, formalWatchRevision == revision, formalWatchOverride == formal, !formalWatchMutationPending,
                  try paired.store.loadPairingData() == pairingData else { throw WatchCredentialError.staleAuthority }
            let reply = try await sendOnce(request)
            guard retainedBinding == snapshot, formalWatchRevision == revision, formalWatchOverride == formal,
                  !formalWatchMutationPending, try paired.store.loadPairingData() == pairingData else {
                throw WatchCredentialError.staleAuthority
            }
            let credential = try WatchCredentialWire.response(reply.data, action: action, binding: formal,
                server: try requestOrigin(reply.request)!, now: Date())
            acceptRoute(reply)
            return credential
        } catch {
            // A failed operation cannot extend a validated formal receipt beyond its own expiry.
            if let formal = formalWatchOverride, formalWatchRevision == initialRevision,
               retainedBinding == snapshot, !formalWatchMutationPending,
               formal.userId == pairing.userID, formal.iphone.deviceId == pairing.deviceID,
               formal.iphone.deviceLeaseRef == snapshot.binding.deviceLeaseRef,
               formal.realtimeSessionRef == snapshot.binding.realtimeSessionRef,
               let expiry = RealtimeControlValidation.parseTimestamp(formal.expiresAt), expiry <= Date(),
               try paired.store.loadPairingData() == pairingData {
                try await prepare(nil)
                throw WatchCredentialError.staleAuthority
            }
            throw error
        }
    }

    func currentFormalWatchOrigin() async throws -> CyclingWatchOriginBinding? {
        guard let snapshot = retainedBinding, !formalWatchMutationPending else { return nil }
        if !formalWatchOverrideSet { _ = try await readFormalWatchPairState() }
        guard let formal = formalWatchOverride, formal.status == "active",
              let expiry = RealtimeControlValidation.parseTimestamp(formal.expiresAt), expiry > Date(),
              formal.realtimeSessionRef == retainedBinding?.binding.realtimeSessionRef,
              formal.iphone.deviceLeaseRef == retainedBinding?.binding.deviceLeaseRef else { return nil }
#if canImport(WatchConnectivity) && os(iOS)
        guard let channel = formalWatchChannel,
              let observation = await channel.requestInstallationIdentity(nonce: UUID().uuidString.lowercased()),
              observation.localClientInstanceID == formal.installationId else { return nil }
#endif
        guard retainedBinding == snapshot, formalWatchOverride == formal, !formalWatchMutationPending else { return nil }
        return formal.origin
    }

    func readFormalWatchPairState(notifyCredentialAuthority: Bool = true) async throws -> RealtimeFormalWatchPairState {
        guard let snapshot = retainedBinding else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
        let revision = formalWatchRevision, current = snapshot.binding
        let binding = RealtimeEnrollmentBinding(realtimeSessionRef: current.realtimeSessionRef,
            deviceLeaseRef: current.deviceLeaseRef, continuityID: current.continuityID, connectionEpoch: current.connectionEpoch)
        let encoder = JSONEncoder()
        let body: [String: Any] = ["operation": "watch_binding",
            "realtime_session_ref": try JSONSerialization.jsonObject(with: encoder.encode(binding.realtimeSessionRef)),
            "iphone_device_lease_ref": try JSONSerialization.jsonObject(with: encoder.encode(binding.deviceLeaseRef))]
        var request = try await makeRequest(.watchBinding,
            context: RealtimeCanonicalRequestContext(operation: .watchBinding, localBinding: "watch-pair-read"),
            preservedBody: JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]))
        request.url = request.url!.appendingPathComponent("read")
        defer { request.httpBody = nil; request.setValue(nil, forHTTPHeaderField: "Authorization") }
        guard retainedBinding == snapshot else { throw RealtimePublicControlAdapterError.staleBinding }
        let reply = try await sendOnce(request)
        let data = reply.data
        guard retainedBinding == snapshot, revision == formalWatchRevision else { throw RealtimePublicControlAdapterError.staleBinding }
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(response.keys) == Set(["operation", "pair_state", "binding"]), response["operation"] as? String == "watch_binding",
              let rawPair = response["pair_state"] as? [String: Any], Set(rawPair.keys) == RealtimeFormalWatchPairState.wireFieldNames else {
            throw RealtimeControlValidationError.invalidEnvelope
        }
        let pair = try JSONDecoder().decode(RealtimeFormalWatchPairState.self, from: JSONSerialization.data(withJSONObject: rawPair))
        guard pair.pairVersion.range(of: "^(0|[1-9][0-9]{0,37})$", options: .regularExpression) != nil,
              ["absent", "active", "revoked"].contains(pair.status),
              pair.status == "absent" ? pair.pairVersion == "0" && !pair.requiresRebind : pair.pairVersion != "0",
              pair.status != "revoked" || pair.requiresRebind else { throw RealtimeControlValidationError.invalidEnvelope }
        let formal: RealtimeFormalWatchBinding?
        if let raw = response["binding"] as? [String: Any] {
            let receipt = try JSONDecoder().decode(RealtimeFormalWatchBinding.self, from: JSONSerialization.data(withJSONObject: raw))
            try RealtimeControlValidation.validateFormalWatch(receipt, raw: raw, binding: binding, now: Date())
            guard pair.status == "active", !pair.requiresRebind, pair.pairVersion == receipt.pairVersion else {
                throw RealtimeControlValidationError.invalidEnvelope
            }
            formal = receipt
        } else {
            guard response["binding"] is NSNull, pair.status != "active" || pair.requiresRebind else {
                throw RealtimeControlValidationError.invalidEnvelope
            }
            formal = nil
        }
        suppressWatchCredentialNotification = !notifyCredentialAuthority
        formalWatchOverride = formal
        suppressWatchCredentialNotification = false
        formalWatchOverrideSet = true
        acceptRoute(reply)
        return pair
    }

    // Called only for explicit user registration/replacement/revocation, never from metric delivery.
    func mutateFormalWatch(action: String, observedInstallationID: String?, expectedPairVersion: String,
        requestID: String, idempotencyKey: String) async throws -> RealtimeFormalWatchBinding {
        // The watch binds to the iPhone's live session and lease.
        guard ["register", "replace", "revoke"].contains(action), let snapshot = retainedBinding else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        let current = snapshot.binding
        let binding = RealtimeEnrollmentBinding(realtimeSessionRef: current.realtimeSessionRef,
            deviceLeaseRef: current.deviceLeaseRef, continuityID: current.continuityID, connectionEpoch: current.connectionEpoch)
        let encoder = JSONEncoder()
        let reference: (RealtimeCanonicalReference) throws -> Any = { try JSONSerialization.jsonObject(with: encoder.encode($0)) }
        var body: [String: Any] = ["operation": "watch_binding", "action": action, "request_id": requestID,
            "idempotency_key": idempotencyKey, "expected_pair_version": expectedPairVersion,
            "realtime_session_ref": try reference(binding.realtimeSessionRef),
            "iphone_device_lease_ref": try reference(binding.deviceLeaseRef)]
        if action != "revoke" {
            guard let observation = observedInstallationID else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
            body["installation_id"] = observation
            body["ttl_seconds"] = 600
        } else if observedInstallationID != nil { throw RealtimePublicControlAdapterError.missingCanonicalContext }
        let bytes = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        var request = try await makeRequest(.watchBinding, context: RealtimeCanonicalRequestContext(operation: .watchBinding, localBinding: requestID), preservedBody: bytes)
        defer { request.httpBody = nil; request.setValue(nil, forHTTPHeaderField: "Authorization") }
        guard retainedBinding == snapshot else { throw RealtimePublicControlAdapterError.staleBinding }
        let reply = try await sendOnce(request)
        let result = reply.data
        guard retainedBinding == snapshot else { throw RealtimePublicControlAdapterError.staleBinding }
        guard let response = try JSONSerialization.jsonObject(with: result) as? [String: Any], Set(response.keys) == Set(["operation", "binding"]),
              response["operation"] as? String == "watch_binding", let raw = response["binding"] as? [String: Any] else {
            throw RealtimeControlValidationError.invalidEnvelope
        }
        let formalBytes = try JSONSerialization.data(withJSONObject: raw)
        let formal = try JSONDecoder().decode(RealtimeFormalWatchBinding.self, from: formalBytes)
        try RealtimeControlValidation.validateFormalWatch(formal, raw: raw, binding: binding, now: Date(), allowRevoked: action == "revoke")
        guard raw["requestId"] as? String == requestID, raw["idempotencyKey"] as? String == idempotencyKey,
              formal.status == (action == "revoke" ? "revoked" : "active"),
              action == "revoke" || formal.installationId == observedInstallationID else { throw RealtimeControlValidationError.invalidEnvelope }
        formalWatchRevision &+= 1
        formalWatchOverride = formal
        formalWatchOverrideSet = true
        acceptRoute(reply)
        return formal
    }

    func revokeWatchFromUserAction() async throws -> RealtimeFormalWatchBinding {
        guard !formalWatchMutationPending else { throw RealtimePublicControlAdapterError.staleBinding }
        formalWatchMutationPending = true
        defer { formalWatchMutationPending = false }
        let pair = try await readFormalWatchPairState()
        guard pair.status == "active" else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
        let requestID = UUID().uuidString.lowercased()
        return try await mutateFormalWatch(action: "revoke", observedInstallationID: nil, expectedPairVersion: pair.pairVersion,
            requestID: requestID, idempotencyKey: requestID)
    }

#if canImport(WatchConnectivity) && os(iOS)
    func registerWatchFromUserAction(using channel: WatchConnectivityPhoneAdapter) async throws -> RealtimeFormalWatchBinding {
        guard !formalWatchMutationPending else { throw RealtimePublicControlAdapterError.staleBinding }
        formalWatchMutationPending = true
        defer { formalWatchMutationPending = false }
        let pair = try await readFormalWatchPairState()
        let requestID = UUID().uuidString.lowercased() // operation correlation, not identity
        return try await registerObservedWatch(using: channel, action: pair.status == "active" ? "replace" : "register",
            expectedPairVersion: pair.pairVersion, requestID: requestID, idempotencyKey: requestID, userInitiated: true)
    }

    func registerObservedWatch(using channel: WatchConnectivityPhoneAdapter, action: String, expectedPairVersion: String,
        requestID: String, idempotencyKey: String, userInitiated: Bool) async throws -> RealtimeFormalWatchBinding {
        guard userInitiated, action == "register" || action == "replace", let snapshot = retainedBinding else { throw RealtimePublicControlAdapterError.missingCanonicalContext }
        let nonce = UUID().uuidString.lowercased() // correlation only; never used as device identity
        guard let observation = await channel.requestInstallationIdentity(nonce: nonce, rebind: true), observation.nonce == nonce else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        guard retainedBinding == snapshot else { throw RealtimePublicControlAdapterError.staleBinding }
        return try await mutateFormalWatch(action: action, observedInstallationID: observation.localClientInstanceID,
            expectedPairVersion: expectedPairVersion, requestID: requestID, idempotencyKey: idempotencyKey)
    }
#endif

    func restorePendingStop() async throws -> AssistantStopContext? {
        guard !requiresDurableStop || pendingStopDatabase != nil else {
            throw AssistantBootstrapError.remoteStopUnconfirmed
        }
        if !pendingStopRestored || pendingBootstrap != nil || (pendingStop != nil && pendingStop?.body == nil) {
            if let replay = try pendingStopDatabase?.pendingStopReplay(kind: "bootstrap") {
                guard replay.payload.count <= Self.maximumCanonicalBodyBytes * 2 else { throw AssistantLocalOperationDatabaseError.corruptRow }
                let intent = try JSONDecoder().decode(PendingBootstrap.self, from: replay.payload)
                guard intent.operationID == replay.operationID,
                      (2...Self.maximumCanonicalBodyBytes).contains(intent.requestBody.count) else {
                    throw AssistantLocalOperationDatabaseError.corruptRow
                }
                pendingBootstrap = intent
                if inFlightBootstrapGeneration != nil { return pendingStop?.context }
                let binding: RealtimeBootstrapLocalBinding
                do {
                    let fact = try await readBootstrapFact(intent)
                    switch try adapter.classifyBootstrapRead(fact) {
                    case .unresolved:
                        pendingStopRestored = true
                        return pendingStop?.context
                    case .nothingToStop:
                        try pendingStopDatabase?.completeStopReplay(operationID: intent.operationID, kind: "bootstrap")
                        pendingBootstrap = nil
                        pendingStopRestored = false
                        return try await restorePendingStop()
                    case .sessionToStop:
                        binding = try adapter.qualifyBootstrapRead(fact)
                    }
                } catch RealtimePublicControlAdapterError.transportFailure,
                        RealtimePublicControlAdapterError.unexpectedHTTPStatus(_, _),
                        RealtimePublicControlAdapterError.invalidHTTPResponse,
                        RealtimePublicControlAdapterError.responseTooLarge,
                        RealtimePublicControlAdapterError.malformedFixture,
                        RealtimePublicControlAdapterError.invalidConnectionDetails,
                        AssistantBootstrapError.remoteStopUnconfirmed {
                    // A remote unknown is not damaged local storage. Keep its durable duty until accepted Start.
                    pendingStopRestored = true
                    return pendingStop?.context
                }
                try pendingStopDatabase?.supersedePendingControlAfterBootstrap(operationID: intent.operationID)
                pendingStop = nil
                let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: intent.operationID),
                    roomName: binding.transportAliases.first(where: { $0.aliasType == "room" })!.value,
                    reasonCode: "start_failed")
                bindingVersion += 1
                retainedBinding = RealtimeProviderBindingSnapshot(binding: binding,
                    version: bindingVersion, bootstrapGeneration: bootstrapGeneration)
                try preserveStopIntent(context, snapshot: retainedBinding!)
                pendingStopRestored = true
                return pendingStop?.context
            }
            if let replay = try pendingStopDatabase?.pendingStopReplay() {
                let data = replay.payload
                guard data.count <= Self.maximumCanonicalBodyBytes * 2 else {
                    throw AssistantLocalOperationDatabaseError.corruptRow
                }
                let pending = try JSONDecoder().decode(PendingStop.self, from: data)
                guard pending.context.operationID.rawValue == replay.operationID,
                      Self.validStopContext(pending.context, binding: pending.binding) else { throw AssistantLocalOperationDatabaseError.corruptRow }
                if let body = pending.body {
                    guard try adapter.decodeStopExpectation(body).matches(pending.binding) else { throw AssistantLocalOperationDatabaseError.corruptRow }
                } else {
                    guard pending.replayScope == nil else { throw AssistantLocalOperationDatabaseError.corruptRow }
                }
                pendingStop = pending
                pendingBootstrap = nil
                retainedBinding = RealtimeProviderBindingSnapshot(binding: pending.binding,
                    version: bindingVersion, bootstrapGeneration: bootstrapGeneration)
            }
            pendingStopRestored = true
        }
        return pendingStop?.context
    }

    private func readBootstrapFact(_ intent: PendingBootstrap) async throws -> Data {
        let generation = bootstrapGeneration
        let version = bindingVersion
        let bootstrap = try pendingStopDatabase?.pendingStopReplay(kind: "bootstrap")
        let kind = bootstrap == nil ? "stop" : "bootstrap"
        let before = try bootstrap ?? pendingStopDatabase?.pendingStopReplay()
        guard before?.operationID == intent.operationID else { throw RealtimePublicControlAdapterError.staleBinding }
        var request = try await makeRequest(.bootstrap,
            context: RealtimeCanonicalRequestContext(operation: .bootstrap, localBinding: intent.operationID),
            preservedBody: intent.requestBody, replayOrigin: intent.origin ?? pairedOrigin())
        request.url = request.url?.deletingLastPathComponent().appendingPathComponent("bootstrap/reconcile")
        defer { request.httpBody = nil; request.setValue(nil, forHTTPHeaderField: "Authorization") }
        let reply = try await sendOnce(request)
        let data = reply.data
        let after = try pendingStopDatabase?.pendingStopReplay(kind: kind)
        guard generation == bootstrapGeneration, version == bindingVersion,
              after?.operationID == before?.operationID, after?.payload == before?.payload else {
            throw RealtimePublicControlAdapterError.staleBinding
        }
        if try adapter.classifyBootstrapRead(data) == .sessionToStop { _ = try adapter.qualifyBootstrapRead(data) }
        acceptRoute(reply)
        return data
    }

    private func preserveStopIntent(_ context: AssistantStopContext,
        snapshot: RealtimeProviderBindingSnapshot) throws {
        guard Self.validStopContext(context, binding: snapshot.binding) else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        var pending: PendingStop
        if let existing = pendingStop {
            guard existing.context.operationID == context.operationID,
                  existing.context.roomName == context.roomName,
                  existing.context.reasonCode == context.reasonCode,
                  existing.binding == snapshot.binding else {
                throw RealtimePublicControlAdapterError.staleBinding
            }
            // Durable replay bytes are authoritative. Re-encoding decoded JSON can change its fingerprint.
            return
        } else {
            pending = PendingStop(context: context, binding: snapshot.binding,
                body: nil, replayScope: nil)
            pending.origin = try pendingBootstrap?.origin ?? pairedOrigin(original: false)
        }
        if let bootstrap = pendingBootstrap { pending.bootstrapRequestBody = bootstrap.requestBody }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let payload = try encoder.encode(pending)
        if let bootstrap = pendingBootstrap {
            guard bootstrap.operationID == context.operationID.rawValue else { throw RealtimePublicControlAdapterError.staleBinding }
            let replay = try pendingStopDatabase?.pendingStopReplay(kind: "bootstrap")
            guard pendingStopDatabase == nil || replay?.operationID == bootstrap.operationID else { throw RealtimePublicControlAdapterError.staleBinding }
            try pendingStopDatabase?.upgradeStopReplay(operationID: bootstrap.operationID,
                expectedPayload: replay!.payload, payload: payload, expectedKind: "bootstrap")
            pendingBootstrap = nil
        } else {
            try pendingStopDatabase?.preserveStopReplay(operationID: context.operationID.rawValue, payload: payload)
        }
        pendingStop = pending
    }

    private static func validStopContext(_ context: AssistantStopContext,
        binding: RealtimeBootstrapLocalBinding) -> Bool {
        (1...128).contains(context.operationID.rawValue.utf8.count)
            // Room names are the server's transport alias values (bounded at 512 by the gateway's alias authority).
            && (1...512).contains(context.roomName.utf8.count)
            && (1...128).contains(context.reasonCode.utf8.count)
            && binding.transportAliases.contains {
                $0.aliasType == "room" && $0.value == context.roomName
            }
    }

    func recipientRegistration(
        for context: RealtimeE2EERecipientRegistrationContext
    ) throws -> RealtimeE2EERecipientCredentialRegistration {
        try recipientKeyManager.registration(for: context)
    }

    func bootstrap(for intent: AssistantStartIntent) async throws
        -> AssistantConnectionDetails {
        guard intent.userInitiated else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        guard !Task.isCancelled else {
            throw RealtimePublicControlAdapterError.bootstrapCancelled
        }
        let generation = beginBootstrap()
        var validatedMapping: RealtimeBootstrapMapping?
        do {
            _ = try await restorePendingStop()
            try validateBootstrapCompletion(generation)
            var request = try await makeRequest(.bootstrap,
                context: RealtimeCanonicalRequestContext(operation: .bootstrap, localBinding: intent.operationID.rawValue))
            defer { request.httpBody = nil; request.setValue(nil, forHTTPHeaderField: "Authorization") }
            try validateBootstrapCompletion(generation)
            guard let body = request.httpBody else { throw RealtimePublicControlAdapterError.missingCanonicalBody }
            var admission = PendingBootstrap(operationID: intent.operationID.rawValue, requestBody: body)
            admission.origin = try requestOrigin(request)
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            pendingBootstrap = admission
            try pendingStopDatabase?.preserveStopReplay(operationID: admission.operationID,
                payload: encoder.encode(admission), kind: "bootstrap")
            let reply = try await sendOnce(request, retryConnectionLoss: true)
            let mapping = try adapter.mapBootstrap(reply.data)
            validatedMapping = mapping
            try validateBootstrapCompletion(generation)
            formalWatchOverride = nil
            formalWatchOverrideSet = false // a new session supersedes the prior watch-binding projection

            try pendingStopDatabase?.completeStopReplay(operationID: intent.operationID.rawValue, kind: "bootstrap", supersedingControl: true)
            pendingBootstrap = nil
            pendingStop = nil
            bindingVersion += 1
            retainedBinding = RealtimeProviderBindingSnapshot(
                binding: mapping.localBinding,
                version: bindingVersion,
                bootstrapGeneration: generation
            )
            retainedCentralTransportBinding = mapping.centralTransportBinding
            inFlightBootstrapGeneration = nil
            acceptRoute(reply)
            if reply.request.url == request.url { scheduleOriginDiscovery(reply, binding: mapping.localBinding) }
            return mapping.connectionDetails
        } catch {
            var failure = error
            if let mapping = validatedMapping,
               bootstrapGeneration == generation,
               inFlightBootstrapGeneration == generation {
                bindingVersion += 1
                let snapshot = RealtimeProviderBindingSnapshot(binding: mapping.localBinding,
                    version: bindingVersion, bootstrapGeneration: generation)
                retainedBinding = snapshot
                do {
                    try pendingStopDatabase?.supersedePendingControlAfterBootstrap(operationID: intent.operationID.rawValue)
                    pendingStop = nil
                    try preserveStopIntent(AssistantStopContext(operationID: intent.operationID,
                        roomName: mapping.connectionDetails.roomName, reasonCode: "start_failed"), snapshot: snapshot)
                } catch { failure = error }
            }
            if inFlightBootstrapGeneration == generation {
                inFlightBootstrapGeneration = nil
            }
            if Task.isCancelled {
                throw RealtimePublicControlAdapterError.bootstrapCancelled
            }
            throw failure
        }
    }

    func invalidatePendingBootstrap() {
        invalidatePendingBootstrapForStop()
    }

    func stop(_ context: AssistantStopContext) async throws
        -> AssistantRemoteStopResult {
        invalidatePendingBootstrapForStop()
        _ = try await restorePendingStop()
        guard activeStop == nil, let snapshot = retainedBinding else {
            return unconfirmedStopResult()
        }

        stopSequence += 1
        let stopToken = RealtimeProviderStopToken(
            sequence: stopSequence,
            bindingVersion: snapshot.version
        )
        activeStop = stopToken

        do {
            try preserveStopIntent(context, snapshot: snapshot)
            let preserved = pendingStop
            guard preserved == nil || preserved?.context.operationID.rawValue == context.operationID.rawValue else {
                return finishStop(stopToken, snapshot: snapshot, confirmation: nil)
            }
            var request = try await makeRequest(
                .mediaStop,
                context: RealtimeCanonicalRequestContext(
                    operation: .mediaStop,
                    localBinding: context.operationID.rawValue,
                    retainedBootstrapBinding: snapshot.binding
                ),
                preservedBody: preserved?.body,
                replayOrigin: preserved?.origin ?? pairedOrigin()
            )
            defer {
                request.setValue(nil, forHTTPHeaderField: "Authorization")
                request.httpBody = nil
            }
            guard isCurrentStop(stopToken, snapshot: snapshot),
                  let requestBody = request.httpBody else {
                return finishStop(
                    stopToken,
                    snapshot: snapshot,
                    confirmation: nil
                )
            }
            let expected = try adapter.decodeStopExpectation(requestBody)
            guard expected.matches(snapshot.binding),
                  Self.validStopContext(context, binding: snapshot.binding),
                  isCurrentStop(stopToken, snapshot: snapshot) else {
                return finishStop(
                    stopToken,
                    snapshot: snapshot,
                    confirmation: nil
                )
            }

            let scope = try canonicalBodyProvider.replayScope()
            guard pendingStopDatabase == nil || scope != nil,
                  preserved?.body == nil || preserved?.replayScope == scope else {
                return finishStop(stopToken, snapshot: snapshot, confirmation: nil)
            }
            var pending = PendingStop(context: context, binding: snapshot.binding,
                body: requestBody, replayScope: scope)
            pending.bootstrapRequestBody = preserved?.bootstrapRequestBody
            pending.origin = try requestOrigin(request)
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let payload = try encoder.encode(pending)
            if let preserved, preserved.body == nil {
                let replay = try pendingStopDatabase?.pendingStopReplay()
                guard pendingStopDatabase == nil || replay?.operationID == context.operationID.rawValue else { throw RealtimePublicControlAdapterError.staleBinding }
                try pendingStopDatabase?.upgradeStopReplay(operationID: context.operationID.rawValue,
                    expectedPayload: replay!.payload, payload: payload)
            } else if preserved == nil {
                try pendingStopDatabase?.preserveStopReplay(operationID: context.operationID.rawValue,
                    payload: payload)
            }
            pendingStop = pending
            let reply = try await sendOnce(request)
            let confirmation = try adapter.decodeStopConfirmation(
                reply.data,
                expected: expected
            )
            if confirmation.confirmed && isCurrentStop(stopToken, snapshot: snapshot) { acceptRoute(reply) }
            return finishStop(
                stopToken,
                snapshot: snapshot,
                confirmation: confirmation
            )
        } catch {
            return finishStop(
                stopToken,
                snapshot: snapshot,
                confirmation: nil
            )
        }
    }

    func reconnectDetails(_ existing: AssistantConnectionDetails, for intent: AssistantStartIntent, callID: String?) async throws -> AssistantConnectionDetails {
        guard let snapshot = retainedBinding else { throw AssistantCallRecoveryError.bindingRejected }
        let context = RealtimeCanonicalRequestContext(operation: .credentialRefresh,
            localBinding: intent.operationID.rawValue, retainedBootstrapBinding: snapshot.binding)
        do {
            let (reply, request) = try await executeBoundWithRequest(.credentialRefresh, context: context)
            try Task.checkCancellation()
            try validateBindingSnapshot(snapshot)
            let refreshed = try adapter.mapRefreshedConnection(reply.data, requestData: request, existing: existing, binding: snapshot.binding, callID: callID)
            acceptRoute(reply)
            return refreshed
        } catch let error as RealtimePublicControlAdapterError {
            if error.isPairingRevoked { throw error }
            if case .unexpectedHTTPStatus(_, "REALTIME_REFRESH_BINDING_UNKNOWN") = error { throw AssistantCallRecoveryError.bindingMissing }
            let goneCodes = ["SESSION_NOT_FOUND", "CONTINUITY_ENDED",
                "CONTINUITY_EXPIRED", "LEASE_EXPIRED", "LEASE_REVOKED", "LEASE_RELEASED"]
            if case .unexpectedHTTPStatus(_, let code) = error, let code, goneCodes.contains(code) {
                throw AssistantCallRecoveryError.bindingGone(code)
            }
            let terminalCodes = ["REALTIME_REFRESH_BINDING_CHANGED",
                "T11B_ADAPTER_CURRENT_BINDING_REQUIRED", "T11B_ADAPTER_CURRENT_BINDING_INVALID",
                "T11B_ADAPTER_CURRENT_BINDING_MISMATCH", "T11B_ADAPTER_REFRESH_BINDING_CHANGED",
                "SESSION_NOT_FOUND", "CONTINUITY_ENDED", "CONTINUITY_EXPIRED", "LEASE_EXPIRED",
                "LEASE_REVOKED", "LEASE_RELEASED", "LEASE_BINDING_INVALID", "TRANSPORT_NOT_CONNECTED", "TRANSPORT_BINDING_CONFLICT"]
            if case .unexpectedHTTPStatus(let status, let code) = error,
               status == 401 || status == 403 || code.map(terminalCodes.contains) == true { throw AssistantCallRecoveryError.bindingRejected }
            if [.staleBinding, .missingCanonicalContext, .missingBearerCredential, .invalidBearerCredential].contains(error) {
                throw AssistantCallRecoveryError.bindingRejected
            }
            throw error
        }
    }

    func refreshCredentials(
        context: RealtimeCanonicalRequestContext
    ) async throws -> RealtimeDeferredProjection {
        let data = try await executeBound(
            .credentialRefresh,
            context: context
        )
        let result = try adapter.decodeCredentialRefresh(data.data, expected: data.request.httpBody)
        acceptRoute(data)
        return result
    }

    func resolveE2EEKey(
        context: RealtimeCanonicalRequestContext
    ) async throws -> RealtimeDeferredProjection {
        let data = try await executeBound(.e2eeKeyResolve, context: context)
        // The typed projection deliberately excludes key material. This method
        // neither decrypts nor stores any key returned by the service.
        let result = try adapter.decodeE2EEResolve(data.data, expected: data.request.httpBody)
        acceptRoute(data)
        return result
    }

    func resolveE2EEContentKey(
        context: RealtimeCanonicalRequestContext
    ) async throws -> Data {
        let (response, requestBody) = try await executeBoundWithRequest(
            .e2eeKeyResolve,
            context: context
        )
        let key = try recipientKeyManager.open(
            responseData: response.data,
            requestData: requestBody,
            now: adapter.e2eeNow()
        )
        acceptRoute(response)
        return key
    }

    func handoff(
        context: RealtimeCanonicalRequestContext
    ) async throws -> RealtimeHandoffProjection {
        let data = try await executeBound(.handoff, context: context)
        let result = try adapter.qualifyHandoff(data.data, expected: data.request.httpBody)
        acceptRoute(data)
        return result
    }

    func endContinuity(
        context: RealtimeCanonicalRequestContext
    ) async throws -> RealtimeDeferredProjection {
        let data = try await executeBound(.endContinuity, context: context)
        let result = try adapter.decodeEndContinuity(data.data, expected: data.request.httpBody)
        acceptRoute(data)
        return result
    }

    func centralTransportBinding() async throws -> CentralTransportBinding? {
        guard pendingStop == nil, let central = retainedCentralTransportBinding,
              let snapshot = retainedBinding else { return nil }
        try validateBindingSnapshot(snapshot)
        let context = RealtimeCanonicalRequestContext(operation: .bootstrap,
            localBinding: "central-transport-binding", retainedBootstrapBinding: snapshot.binding)
        guard let bytes = try await canonicalBodyProvider.canonicalBody(for: .bootstrap, context: context),
              let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              request["device_id"] as? String == central.deviceID else { throw RealtimePublicControlAdapterError.staleBinding }
        try validateBindingSnapshot(snapshot)
        var qualified = central
        if let data = try (credentialStore as? PairedRealtimeCredentialStore)?.store.loadPairingData() {
            let pairing = try RealtimeDevicePairing.decode(data)
            guard pairing.deviceID == central.deviceID else { throw RealtimePublicControlAdapterError.staleBinding }
            // Legacy pairing schema is the phone enrollment; terminal enrollments name their class.
            qualified.deviceClass = pairing.deviceType ?? "iphone"
        }
        return qualified
    }

    func localBindingSnapshot() -> RealtimeBootstrapLocalBinding? {
        guard inFlightBootstrapGeneration == nil,
              activeStop == nil,
              let snapshot = retainedBinding,
              snapshot.bootstrapGeneration == bootstrapGeneration else {
            return nil
        }
        return snapshot.binding
    }

    private func beginBootstrap() -> UInt64 {
        bootstrapGeneration += 1
        inFlightBootstrapGeneration = bootstrapGeneration
        retainedBinding = nil
        retainedCentralTransportBinding = nil
        activeStop = nil
        return bootstrapGeneration
    }

    private func validateBootstrapCompletion(_ generation: UInt64) throws {
        guard !Task.isCancelled else {
            throw RealtimePublicControlAdapterError.bootstrapCancelled
        }
        guard bootstrapGeneration == generation,
              inFlightBootstrapGeneration == generation else {
            throw RealtimePublicControlAdapterError.bootstrapSuperseded
        }
    }

    private func invalidatePendingBootstrapForStop() {
        guard inFlightBootstrapGeneration != nil else {
            return
        }
        bootstrapGeneration += 1
        inFlightBootstrapGeneration = nil
    }

    private func currentBoundContext(
        _ operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) throws -> (
        RealtimeCanonicalRequestContext,
        RealtimeProviderBindingSnapshot
    ) {
        guard context.operation == operation,
              context.isPresent,
              inFlightBootstrapGeneration == nil,
              activeStop == nil,
              let snapshot = retainedBinding,
              snapshot.bootstrapGeneration == bootstrapGeneration,
              context.retainedBootstrapBinding == snapshot.binding else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        return (
            RealtimeCanonicalRequestContext(
                operation: operation,
                localBinding: context.localBinding,
                retainedBootstrapBinding: snapshot.binding
            ),
            snapshot
        )
    }

    private func validateBindingSnapshot(
        _ snapshot: RealtimeProviderBindingSnapshot
    ) throws {
        guard inFlightBootstrapGeneration == nil,
              activeStop == nil,
              retainedBinding == snapshot,
              snapshot.bootstrapGeneration == bootstrapGeneration else {
            throw RealtimePublicControlAdapterError.staleBinding
        }
    }

    private func isCurrentStop(
        _ token: RealtimeProviderStopToken,
        snapshot: RealtimeProviderBindingSnapshot
    ) -> Bool {
        activeStop == token
            && retainedBinding == snapshot
            && token.bindingVersion == snapshot.version
            && snapshot.bootstrapGeneration == bootstrapGeneration
    }

    private func finishStop(
        _ token: RealtimeProviderStopToken,
        snapshot: RealtimeProviderBindingSnapshot,
        confirmation: RealtimeStopConfirmation?
    ) -> AssistantRemoteStopResult {
        let isCurrent = isCurrentStop(token, snapshot: snapshot)
        var confirmed = isCurrent && confirmation?.confirmed == true
        if confirmed, let pendingStop {
            do { try pendingStopDatabase?.completeStopReplay(operationID: pendingStop.context.operationID.rawValue) }
            catch { confirmed = false }
        }
        if confirmed {
            retainedBinding = nil
            retainedCentralTransportBinding = nil
            pendingStop = nil
        }
        if activeStop == token {
            activeStop = nil
        }
        return AssistantRemoteStopResult(
            confirmed: confirmed,
            opaqueReference: confirmed ? confirmation?.requestID : nil
        )
    }

    private func unconfirmedStopResult() -> AssistantRemoteStopResult {
        AssistantRemoteStopResult(confirmed: false, opaqueReference: nil)
    }

    private func executeBound(
        _ operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> ControlReply {
        // Typed deferred controls retain the caller's canonical context but do
        // not require a local bootstrap binding. Content-key resolution uses
        // executeBoundWithRequest below, where the retained binding is required.
        var request = try await makeRequest(operation, context: context)
        defer {
            request.setValue(nil, forHTTPHeaderField: "Authorization")
            request.httpBody = nil
        }
        return try await sendOnce(request)
    }

    private func executeBoundWithRequest(
        _ operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> (ControlReply, Data) {
        let (boundContext, snapshot) = try currentBoundContext(
            operation,
            context: context
        )
        var request = try await makeRequest(operation, context: boundContext)
        guard let requestBody = request.httpBody else {
            throw RealtimePublicControlAdapterError.missingCanonicalBody
        }
        defer {
            request.setValue(nil, forHTTPHeaderField: "Authorization")
            request.httpBody = nil
        }
        try validateBindingSnapshot(snapshot)
        let data = try await sendOnce(request)
        try validateBindingSnapshot(snapshot)
        return (data, requestBody)
    }

    private func execute(
        _ operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext
    ) async throws -> ControlReply {
        var request = try await makeRequest(operation, context: context)
        defer {
            request.setValue(nil, forHTTPHeaderField: "Authorization")
            request.httpBody = nil
        }
        return try await sendOnce(request)
    }

    private func makeRequest(
        _ operation: RealtimePublicControlOperation,
        context: RealtimeCanonicalRequestContext,
        preservedBody: Data? = nil,
        replayOrigin: String? = nil
    ) async throws -> URLRequest {
        guard context.operation == operation,
              context.isPresent,
              operation != .mediaStop
                || context.retainedBootstrapBinding != nil else {
            throw RealtimePublicControlAdapterError.missingCanonicalContext
        }
        let candidateBody: Data?
        if let preservedBody {
            candidateBody = preservedBody
        } else {
            candidateBody = try await canonicalBodyProvider.canonicalBody(
                for: operation, context: context
            )
        }
        guard let body = candidateBody, body.count >= 2 else {
            throw RealtimePublicControlAdapterError.missingCanonicalBody
        }
        guard body.count <= Self.maximumCanonicalBodyBytes else {
            throw RealtimePublicControlAdapterError.canonicalBodyTooLarge
        }

        let settings: AppSettings
        do {
            settings = try await settingsStore.loadSettings()
        } catch {
            throw RealtimePublicControlAdapterError.invalidPublicOrigin
        }

        let origin: String
        do {
            let pairedData = try (credentialStore as? PairedRealtimeCredentialStore)?.store.loadPairingData()
            resetOriginDiscovery(ifChanged: pairedData)
            let paired = try pairedData.map(RealtimeDevicePairing.decode)
            origin = try replayOrigin ?? paired?.origin ?? EndpointResolver.canonicalRealtimeOrigin(from:
                EndpointResolver.destinationOrigin(from: settings.endpoint))
        } catch {
            throw RealtimePublicControlAdapterError.invalidPublicOrigin
        }

        let absolute = origin + operation.path
        guard let url = URL(string: absolute),
              let components = URLComponents(
                url: url,
                resolvingAgainstBaseURL: false
              ),
              url.absoluteString == absolute,
              components.scheme == "https",
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath == operation.path,
              components.query == nil,
              components.fragment == nil else {
            throw RealtimePublicControlAdapterError.invalidEndpointURL
        }

        let token: String
        do {
            let candidate = try credentialStore.apiToken(for: origin)
            guard let candidate else {
                throw RealtimePublicControlAdapterError.missingBearerCredential
            }
            token = candidate
        } catch let error as RealtimePublicControlAdapterError {
            throw error
        } catch {
            throw RealtimePublicControlAdapterError.missingBearerCredential
        }
        guard Self.validBearerToken(token) else {
            throw RealtimePublicControlAdapterError.invalidBearerCredential
        }

        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: operation == .bootstrap ? 30 : 15
        )
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.httpBody = body
        request.setValue(
            "application/json; charset=utf-8",
            forHTTPHeaderField: "Content-Type"
        )
        request.setValue(
            String(body.count),
            forHTTPHeaderField: "Content-Length"
        )
        request.setValue(
            "Bearer \(token)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(nil, forHTTPHeaderField: "Transfer-Encoding")
        request.setValue(nil, forHTTPHeaderField: "Idempotency-Key")
        return request
    }

    private struct ControlReply {
        let data: Data
        let request: URLRequest
        let pairingData: Data?
    }

    private static func boundedResponse(for request: URLRequest, session: URLSession) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request, delegate: RealtimeNoRedirectDelegate())
        defer { bytes.task.cancel() }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximumResponseBytes else { throw RealtimePublicControlAdapterError.responseTooLarge }
            data.append(byte)
        }
        return (data, response)
    }

    private func sendOnce(_ request: URLRequest, retryConnectionLoss: Bool = false) async throws -> ControlReply {
        let before = try? (credentialStore as? PairedRealtimeCredentialStore)?.store.loadPairingData()
        let deadline = ContinuousClock.now.advanced(by: bootstrapRecoveryWindow)
        var current = request
        var alternateAvailable = true // One alternate for this logical operation, including every retry.
        while true {
            let result: (Data, URLResponse)
            do { result = try await Self.boundedResponse(for: current, session: session) }
            catch let error as URLError where Self.canFallback(error) {
                if alternateAvailable, let alternate = try alternateRequest(current, pairingData: before) {
                    current = alternate
                    alternateAvailable = false
                    continue
                }
                if alternateAvailable && retryConnectionLoss && (error.code == .networkConnectionLost || error.code == .timedOut)
                    && ContinuousClock.now < deadline {
                    try await Task.sleep(nanoseconds: 500_000_000)
                    continue
                }
                throw RealtimePublicControlAdapterError.transportFailure
            } catch RealtimePublicControlAdapterError.responseTooLarge {
                throw RealtimePublicControlAdapterError.responseTooLarge
            } catch { throw RealtimePublicControlAdapterError.transportFailure }
            guard let response = result.1 as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
            if current.url?.path == RealtimePublicControlOperation.credentialRefresh.path,
               let object = try? JSONSerialization.jsonObject(with: result.0) as? [String: Any] {
                let terminal = object["terminal_result"] as? [String: Any] ?? object
                if terminal["operation"] as? String == RealtimePublicControlOperation.credentialRefresh.rawValue,
                   let status = terminal["status"] as? String, ["expired", "revoked", "rejected"].contains(status) {
                    throw AssistantCallRecoveryError.bindingRejected
                }
            }
            if (500...599).contains(response.statusCode), alternateAvailable,
               let alternate = try alternateRequest(current, pairingData: before) {
                current = alternate
                alternateAvailable = false
                continue
            }
            guard response.statusCode == 200 else {
                if current.url?.path == "/v1/realtime/watch-binding/credential" {
                    throw try WatchCredentialWire.failure(result.0)
                }
                let code = Self.sanitizedServerErrorCode(from: result.0)
#if DEBUG
                print("PAIOS_PUBLIC_CONTROL_HTTP_ERROR status=\(response.statusCode) code=\(code ?? "UNKNOWN")")
#endif
                throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(response.statusCode, code)
            }
            return ControlReply(data: result.0, request: current, pairingData: before)
        }
    }

    private func pairedOrigin(original: Bool = true) throws -> String? {
        try (credentialStore as? PairedRealtimeCredentialStore)?.store.loadPairingData().map {
            let pairing = try RealtimeDevicePairing.decode($0)
            return original ? pairing.originalOrigin : pairing.origin
        }
    }

    private func requestOrigin(_ request: URLRequest) throws -> String? {
        guard let url = request.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = ""
        guard let origin = parts.string else { throw RealtimePublicControlAdapterError.invalidPublicOrigin }
        return try EndpointResolver.canonicalRealtimeOrigin(from: origin)
    }

    private func resetOriginDiscovery(ifChanged data: Data?) {
        guard originProbeScope != data else { return }
        originProbe?.cancel()
        originProbe = nil
        originProbeScope = data
        originProbeFailures = 0
        nextOriginProbeAt = .distantPast
    }

    private func scheduleOriginDiscovery(_ reply: ControlReply, binding: RealtimeBootstrapLocalBinding) {
        guard let credentials = credentialStore as? PairedRealtimeCredentialStore,
              let before = reply.pairingData,
              (try? RealtimeAPIOriginMigration.announcedOrigin(reply.data)) == RealtimeAPIOriginMigration.canonicalOrigin,
              (try? requestOrigin(reply.request)) == RealtimeAPIOriginMigration.legacyOrigin,
              let pairing = try? RealtimeDevicePairing.decode(before), pairing.origin == RealtimeAPIOriginMigration.legacyOrigin else { return }
        resetOriginDiscovery(ifChanged: before)
        guard originProbe == nil, originProbeNow() >= nextOriginProbeAt else { return }
        var proof = reply.request
        proof.url = URL(string: RealtimeAPIOriginMigration.canonicalOrigin + "/v1/realtime/bootstrap/reconcile")!
        proof.timeoutInterval = 5
        let transport = session, adapter = adapter, proofRequest = proof
        originProbe = Task.detached { [weak self] in
            var succeeded = false
            do {
                let (bytes, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
                    group.addTask { try await Self.boundedResponse(for: proofRequest, session: transport) }
                    group.addTask { try await Task.sleep(for: .seconds(5)); throw URLError(.timedOut) }
                    defer { group.cancelAll() }
                    return try await group.next()!
                }
                try Task.checkCancellation()
                if let http = response as? HTTPURLResponse, http.statusCode == 200,
                   try adapter.qualifyBootstrapRead(bytes) == binding {
                    let migrated = try RealtimeAPIOriginMigration.migrated(pairing)
                    succeeded = try credentials.store.replacePairingData(JSONEncoder().encode(migrated), ifCurrent: before)
                }
            } catch { /* An optional proof never changes the accepted foreground session. */ }
            await self?.finishOriginDiscovery(before: before, succeeded: succeeded)
        }
    }

    private func finishOriginDiscovery(before: Data, succeeded: Bool) {
        guard originProbeScope == before else { return }
        originProbe = nil
        originProbeFailures = succeeded ? 0 : min(originProbeFailures + 1, 7)
        nextOriginProbeAt = originProbeNow().addingTimeInterval(succeeded ? 0 : min(300, 5 * pow(2, Double(originProbeFailures - 1))))
    }

    private static func canFallback(_ error: URLError) -> Bool {
        [.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet,
         .networkConnectionLost, .timedOut, .secureConnectionFailed,
         .serverCertificateUntrusted, .serverCertificateHasBadDate].contains(error.code)
    }

    /// Called only after the existing operation owner has accepted its complete response contract.
    private func acceptRoute(_ reply: ControlReply) {
        guard let credentials = credentialStore as? PairedRealtimeCredentialStore, let before = reply.pairingData else { return }
        do {
            var pairing = try RealtimeDevicePairing.decode(before)
            guard pairing.fallbackOrigin == RealtimeAPIOriginMigration.legacyOrigin,
                  reply.request.value(forHTTPHeaderField: "Authorization") == "Bearer " + pairing.token,
                  let origin = try requestOrigin(reply.request) else { return }
            let successes = origin == RealtimeAPIOriginMigration.canonicalOrigin && reply.request.url?.path == RealtimePublicControlOperation.bootstrap.path ? 2 : pairing.canonicalSuccesses
            guard pairing.origin != origin || pairing.canonicalSuccesses != successes else { return }
            pairing.origin = origin
            pairing.canonicalSuccesses = successes
            _ = try credentials.store.replacePairingData(JSONEncoder().encode(pairing), ifCurrent: before)
        } catch { /* A route persistence failure does not discard a qualified authenticated response. */ }
    }

    private func alternateRequest(_ request: URLRequest, pairingData: Data?) throws -> URLRequest? {
        guard let bytes = pairingData else { return nil }
        let pairing = try RealtimeDevicePairing.decode(bytes)
        guard pairing.fallbackOrigin == RealtimeAPIOriginMigration.legacyOrigin,
              let origin = try requestOrigin(request),
              origin == RealtimeAPIOriginMigration.legacyOrigin,
              request.value(forHTTPHeaderField: "Authorization") == "Bearer " + pairing.token else { return nil }
        var alternate = request
        let target = RealtimeAPIOriginMigration.canonicalOrigin
        alternate.url = URL(string: request.url!.absoluteString.replacingOccurrences(of: origin, with: target, options: .anchored))
        return alternate
    }

    static func sanitizedServerErrorCode(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              dictionary.count == 1,
              let code = dictionary["error"] as? String,
              (1...64).contains(code.utf8.count),
              let first = code.utf8.first,
              (65...90).contains(Int(first)),
              code.utf8.dropFirst().allSatisfy({ byte in
                  (65...90).contains(Int(byte))
                      || (48...57).contains(Int(byte))
                      || byte == 0x5F
              }) else {
            return nil
        }
        return code
    }

    private static func validBearerToken(_ token: String) -> Bool {
        guard (16...8_192).contains(token.utf8.count) else {
            return false
        }
        return token.unicodeScalars.allSatisfy { scalar in
            scalar.value != 0x2C
                && !CharacterSet.whitespacesAndNewlines.contains(scalar)
                && !CharacterSet.controlCharacters.contains(scalar)
        }
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 60
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}
final class RealtimeNoRedirectDelegate:
    NSObject,
    URLSessionTaskDelegate,
    @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        _ = session
        _ = task
        _ = response
        _ = request
        completionHandler(nil)
    }
}



private struct BootstrapWireKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private struct BootstrapWireEnvelope: Decodable {
    let projection: RealtimeBootstrapProjection
    let mediaGrants: BootstrapMediaGrants
    let credentialRef: RealtimeCanonicalReference
    private enum CodingKeys: String, CodingKey {
        case mediaGrants = "media_grants"
        case credentialRef = "recipient_device_credential_ref"
    }
    init(from decoder: Decoder) throws {
        projection = try RealtimeBootstrapProjection(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mediaGrants = try container.decode(BootstrapMediaGrants.self, forKey: .mediaGrants)
        credentialRef = try container.decode(RealtimeCanonicalReference.self, forKey: .credentialRef)
    }
}

private struct BootstrapMediaGrants: Decodable {
    let audio: BootstrapMediaGrant
    let video: BootstrapMediaGrant
    let data: BootstrapMediaGrant
}

private struct BootstrapMediaGrant: Decodable {
    let enabled: Bool
}

private struct HandoffEnvelope: Decodable {
    let request: HandoffRequest
    let terminalResult: RealtimeHandoffProjection

    private enum CodingKeys: String, CodingKey {
        case request
        case terminalResult = "terminal_result"
    }
}

private struct HandoffRequest: Decodable {
    let operation: String
}

private struct BoundControlWireRequest: Decodable {
    let operation: String
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String

    private enum CodingKeys: String, CodingKey {
        case operation
        case requestID = "request_id"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
    }
}

private struct CredentialRefreshWireResponse: Decodable {
    let binding: BoundControlWireRequest
    let status: String
    let transportAliases: [RealtimeTransportAlias]
    let credential: Credential
    let callRejoin: CallRejoin?
    struct CallRejoin: Decodable {
        let callID: String
        let deadline: String
        enum CodingKeys: String, CodingKey {
            case callID = "call_id"
            case deadline = "rejoin_deadline"
        }
    }
    struct Credential: Decodable {
        let credential: String
        let expiresAt: String
        let generation: String
        enum CodingKeys: String, CodingKey {
            case credential
            case expiresAt = "expires_at"
            case generation = "credential_generation"
        }
    }
    enum CodingKeys: String, CodingKey {
        case status
        case transportAliases = "transport_aliases"
        case credential = "transport_credential"
        case callRejoin = "call_rejoin"
    }
    init(from decoder: Decoder) throws {
        binding = try BoundControlWireRequest(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        transportAliases = try container.decode([RealtimeTransportAlias].self, forKey: .transportAliases)
        credential = try container.decode(Credential.self, forKey: .credential)
        callRejoin = try container.decodeIfPresent(CallRejoin.self, forKey: .callRejoin)
    }
}

private struct StopWireResponse: Decodable {
    let terminalResult: StopTerminalResult

    private enum CodingKeys: String, CodingKey {
        case terminalResult = "terminal_result"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.terminalResult) {
            terminalResult = try container.decode(
                StopTerminalResult.self,
                forKey: .terminalResult
            )
        } else {
            terminalResult = try StopTerminalResult(from: decoder)
        }
    }
}

private struct StopTerminalResult: Decodable {
    let operation: String
    let status: String
    let requestID: String
    let realtimeSessionRef: RealtimeCanonicalReference
    let deviceLeaseRef: RealtimeCanonicalReference
    let continuityID: String
    let connectionEpoch: String
    let operationOutcome: RealtimeOperationOutcome
    let executionFacts: RealtimeExecutionFacts

    private enum CodingKeys: String, CodingKey {
        case operation
        case status
        case requestID = "request_id"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
        case operationOutcome = "operation_outcome"
        case executionFacts = "execution_facts"
    }
}

private struct BootstrapReadEnvelope: Decodable {
    let operation: String
    let kind: String
    let status: String
    let outcome: String?
    let errorCode: String?
    let realtimeSessionRef: RealtimeCanonicalReference?
    let deviceLeaseRef: RealtimeCanonicalReference?
    let continuityID: String?
    let connectionEpoch: String?
    let credentialRef: RealtimeCanonicalReference?
    let aliases: [RealtimeTransportAlias]?
    let e2ee: RealtimeE2EEKeyEnvelope?
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case operation, kind, status, outcome
        case errorCode = "error_code"
        case realtimeSessionRef = "realtime_session_ref"
        case deviceLeaseRef = "device_lease_ref"
        case continuityID = "continuity_id"
        case connectionEpoch = "connection_epoch"
        case credentialRef = "recipient_device_credential_ref"
        case aliases = "transport_aliases"
        case e2ee = "e2ee_key_envelope"
    }
    init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: BootstrapWireKey.self)
        guard Set(all.allKeys.map(\.stringValue)).isSubset(of: Set(CodingKeys.allCases.map(\.rawValue))) else {
            throw RealtimeControlValidationError.invalidEnvelope
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        operation = try c.decode(String.self, forKey: .operation)
        kind = try c.decode(String.self, forKey: .kind)
        status = try c.decode(String.self, forKey: .status)
        outcome = try c.decodeIfPresent(String.self, forKey: .outcome)
        errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
        realtimeSessionRef = try c.decodeIfPresent(RealtimeCanonicalReference.self, forKey: .realtimeSessionRef)
        deviceLeaseRef = try c.decodeIfPresent(RealtimeCanonicalReference.self, forKey: .deviceLeaseRef)
        continuityID = try c.decodeIfPresent(String.self, forKey: .continuityID)
        connectionEpoch = try c.decodeIfPresent(String.self, forKey: .connectionEpoch)
        credentialRef = try c.decodeIfPresent(RealtimeCanonicalReference.self, forKey: .credentialRef)
        aliases = try c.decodeIfPresent([RealtimeTransportAlias].self, forKey: .aliases)
        e2ee = try c.decodeIfPresent(RealtimeE2EEKeyEnvelope.self, forKey: .e2ee)
    }
}
