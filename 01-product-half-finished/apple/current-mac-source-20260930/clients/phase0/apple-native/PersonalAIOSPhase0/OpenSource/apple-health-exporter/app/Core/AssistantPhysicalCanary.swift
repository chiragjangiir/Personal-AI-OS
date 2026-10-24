import Darwin
import Foundation
import LiveKit
import OSLog

#if DEBUG
enum PhysicalCanaryInputKey {
    static let serverURL = "PAIOS_PHYSICAL_CANARY_SERVER_URL"
    static let participantToken =
        "PAIOS_PHYSICAL_CANARY_PARTICIPANT_TOKEN"
    static let e2eeKeyBase64 =
        "PAIOS_PHYSICAL_CANARY_E2EE_KEY_BASE64"
    static let watchDeviceID =
        "PAIOS_PHYSICAL_CANARY_WATCH_DEVICE_ID"
    static let watchClientInstanceID =
        "PAIOS_PHYSICAL_CANARY_WATCH_CLIENT_INSTANCE_ID"
    static let watchDeviceClass =
        "PAIOS_PHYSICAL_CANARY_WATCH_DEVICE_CLASS"

    static let all = [
        serverURL,
        participantToken,
        e2eeKeyBase64,
        watchDeviceID,
        watchClientInstanceID,
        watchDeviceClass
    ]
}

enum PhysicalCanaryInputError: Error, Equatable, Sendable {
    case missingInputCount(Int)
    case invalidInputCount(Int)

    var countOnlyCode: String {
        switch self {
        case .missingInputCount(let count):
            return "physical_canary_missing_input_count_\(count)"
        case .invalidInputCount(let count):
            return "physical_canary_invalid_input_count_\(count)"
        }
    }
}

enum PhysicalCanaryProtectedInputFile {
    typealias FilePolicy = (URL, FileManager) throws -> Void

    static let maximumByteCount = 131_072
    static let relativePath =
        "Application Support/PersonalAIOS/PhysicalCanary/" +
        "physical-canary-inputs.v1.json"

    private enum PolicyError: Error {
        case rejected
    }

    static func consumeFromApplicationContainer(
        fileManager: FileManager = .default
    ) -> Result<PhysicalCanaryConfiguration, PhysicalCanaryInputError> {
        guard let libraryURL = fileManager.urls(
            for: .libraryDirectory,
            in: .userDomainMask
        ).first else {
            return .failure(
                .missingInputCount(PhysicalCanaryInputKey.all.count)
            )
        }
        return consume(
            at: libraryURL.appendingPathComponent(relativePath),
            fileManager: fileManager
        )
    }

    static func consume(
        at fileURL: URL,
        fileManager: FileManager = .default
    ) -> Result<PhysicalCanaryConfiguration, PhysicalCanaryInputError> {
        consume(
            at: fileURL,
            fileManager: fileManager,
            applyAndVerifyPolicy: applyAndVerifyPolicy
        )
    }

    static func consume(
        at fileURL: URL,
        fileManager: FileManager,
        applyAndVerifyPolicy: FilePolicy
    ) -> Result<PhysicalCanaryConfiguration, PhysicalCanaryInputError> {
        defer {
            try? fileManager.removeItem(at: fileURL)
        }

        do {
            let initialValues = try fileURL.resourceValues(
                forKeys: [
                    .isRegularFileKey,
                    .isSymbolicLinkKey,
                    .fileSizeKey
                ]
            )
            guard initialValues.isRegularFile == true,
                  initialValues.isSymbolicLink != true,
                  let fileSize = initialValues.fileSize,
                  (0...maximumByteCount).contains(fileSize)
            else {
                return .failure(.invalidInputCount(1))
            }

            try applyAndVerifyPolicy(fileURL, fileManager)
            let data = try Data(contentsOf: fileURL)
            guard data.count <= maximumByteCount,
                  let object = try JSONSerialization.jsonObject(with: data)
                    as? [String: Any],
                  Set(object.keys) == Set(PhysicalCanaryInputKey.all),
                  object.values.allSatisfy({ $0 is String })
            else {
                return .failure(.invalidInputCount(1))
            }

            let environment = object.reduce(into: [String: String]()) {
                values, entry in
                values[entry.key] = entry.value as? String
            }
            return PhysicalCanaryConfiguration.parse(
                environment: environment
            )
        } catch {
            if fileManager.fileExists(atPath: fileURL.path) {
                return .failure(.invalidInputCount(1))
            }
            return .failure(
                .missingInputCount(PhysicalCanaryInputKey.all.count)
            )
        }
    }

    private static func applyAndVerifyPolicy(
        _ fileURL: URL,
        _ fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [
                .protectionKey: FileProtectionType.complete,
                .posixPermissions: NSNumber(value: 0o600)
            ],
            ofItemAtPath: fileURL.path
        )

        var mutableURL = fileURL
        var backupValues = URLResourceValues()
        backupValues.isExcludedFromBackup = true
        try mutableURL.setResourceValues(backupValues)

        let attributes = try fileManager.attributesOfItem(
            atPath: fileURL.path
        )
        let protectionValue = attributes[.protectionKey]
        let protectionRawValue: String?
        if let protection = protectionValue as? FileProtectionType {
            protectionRawValue = protection.rawValue
        } else {
            protectionRawValue = protectionValue as? String
        }
        let permissions = attributes[.posixPermissions] as? NSNumber
        let verifiedValues = try fileURL.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        )
        guard protectionRawValue == FileProtectionType.complete.rawValue,
              permissions?.intValue == 0o600,
              verifiedValues.isExcludedFromBackup == true
        else {
            throw PolicyError.rejected
        }
    }
}

struct PhysicalCanaryConfiguration: Equatable, Sendable {
    private struct TokenProjection: Sendable {
        let roomName: String
        let participantDeviceID: String
    }

    let serverURL: URL
    let participantToken: String
    let roomName: String
    let e2eeKeyData: Data
    let watchBinding: CyclingWatchOriginBinding

    static func parse(
        environment: [String: String]
    ) -> Result<PhysicalCanaryConfiguration, PhysicalCanaryInputError> {
        let missingCount = PhysicalCanaryInputKey.all.reduce(0) {
            count, key in
            guard let value = environment[key], !value.isEmpty else {
                return count + 1
            }
            return count
        }
        guard missingCount == 0 else {
            return .failure(.missingInputCount(missingCount))
        }

        let serverValue = environment[PhysicalCanaryInputKey.serverURL]!
        let tokenValue =
            environment[PhysicalCanaryInputKey.participantToken]!
        let e2eeValue =
            environment[PhysicalCanaryInputKey.e2eeKeyBase64]!
        let watchDeviceID =
            environment[PhysicalCanaryInputKey.watchDeviceID]!
        let watchClientInstanceID =
            environment[PhysicalCanaryInputKey.watchClientInstanceID]!
        let watchDeviceClass =
            environment[PhysicalCanaryInputKey.watchDeviceClass]!

        let serverURL = URL(string: serverValue).flatMap { candidate in
            candidate.scheme?.lowercased() == "wss"
                && candidate.host != nil ? candidate : nil
        }
        let tokenProjection = tokenProjection(from: tokenValue)
        let e2eeKeyData = Data(base64Encoded: e2eeValue).flatMap {
            $0.count == 32 ? $0 : nil
        }
        let watchBinding = CyclingWatchOriginBinding(
            serverAuthoritativeDeviceID: watchDeviceID,
            serverAuthoritativeClientInstanceID: watchClientInstanceID,
            serverAuthoritativeDeviceClass: watchDeviceClass
        )

        let invalidCount = [
            serverURL == nil,
            tokenProjection == nil,
            e2eeKeyData == nil,
            watchBinding == nil,
            watchBinding?.deviceID == tokenProjection?.participantDeviceID
        ].filter { $0 }.count
        guard invalidCount == 0,
              let serverURL,
              let tokenProjection,
              let e2eeKeyData,
              let watchBinding
        else {
            return .failure(.invalidInputCount(invalidCount))
        }

        return .success(
            PhysicalCanaryConfiguration(
                serverURL: serverURL,
                participantToken: tokenValue,
                roomName: tokenProjection.roomName,
                e2eeKeyData: e2eeKeyData,
                watchBinding: watchBinding
            )
        )
    }

    private static func tokenProjection(
        from token: String
    ) -> TokenProjection? {
        guard (16...32_768).contains(token.utf8.count),
              token.unicodeScalars.allSatisfy({
                  (0x21...0x7E).contains($0.value)
              })
        else {
            return nil
        }
        let segments = token.split(
            separator: ".",
            omittingEmptySubsequences: false
        )
        guard segments.count == 3,
              segments.allSatisfy({ !$0.isEmpty }),
              let payload = decodeBase64URL(String(segments[1])),
              let object = try? JSONSerialization.jsonObject(with: payload)
                as? [String: Any],
              let video = object["video"] as? [String: Any],
              video["roomJoin"] as? Bool == true,
              video["canPublishData"] as? Bool == true,
              let roomName = video["room"] as? String,
              isScopedID(roomName),
              let participantDeviceID = object["sub"] as? String,
              isScopedID(participantDeviceID),
              let attributes = object["attributes"] as? [String: Any],
              attributes["schema_version"] as? String ==
                AssistantRealtimeDataEvent.schemaVersion,
              attributes["device_id"] as? String == participantDeviceID,
              attributes["device_class"] as? String == "iphone",
              let clientInstanceID =
                attributes["client_instance_id"] as? String,
              isScopedID(clientInstanceID)
        else {
            return nil
        }
        return TokenProjection(
            roomName: roomName,
            participantDeviceID: participantDeviceID
        )
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.utf8.count % 4
        if remainder != 0 {
            normalized += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: normalized)
    }

    private static func isScopedID(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (3...64).contains(bytes.count),
              let first = bytes.first,
              (97...122).contains(first)
        else {
            return false
        }
        return bytes.dropFirst().allSatisfy {
            (97...122).contains($0)
                || (48...57).contains($0)
                || $0 == 45
                || $0 == 95
        }
    }
}

struct PhysicalCanaryDiagnosticCounts: Equatable, Sendable {
    var configurationAdmitted = 0
    var missingInputs = 0
    var invalidInputs = 0
    var bootstrapConsumed = 0
    var e2eeConsumed = 0
    var duplicateConsumeRejected = 0
}

final class PhysicalCanaryDiagnostics: @unchecked Sendable {
    enum Event {
        case configurationAdmitted
        case missingInputs(Int)
        case invalidInputs(Int)
        case bootstrapConsumed
        case e2eeConsumed
        case duplicateConsumeRejected
    }

    private static let logger = Logger(
        subsystem: "ai.paios.personal",
        category: "physical_canary"
    )
    private let lock = NSLock()
    private var counts = PhysicalCanaryDiagnosticCounts()

    func record(_ event: Event) {
        lock.lock()
        switch event {
        case .configurationAdmitted:
            counts.configurationAdmitted += 1
        case .missingInputs(let count):
            counts.missingInputs += count
        case .invalidInputs(let count):
            counts.invalidInputs += count
        case .bootstrapConsumed:
            counts.bootstrapConsumed += 1
        case .e2eeConsumed:
            counts.e2eeConsumed += 1
        case .duplicateConsumeRejected:
            counts.duplicateConsumeRejected += 1
        }
        let snapshot = counts
        lock.unlock()

        Self.logger.notice(
            "physical_canary_counts config=\(snapshot.configurationAdmitted, privacy: .public) missing=\(snapshot.missingInputs, privacy: .public) invalid=\(snapshot.invalidInputs, privacy: .public) bootstrap=\(snapshot.bootstrapConsumed, privacy: .public) e2ee=\(snapshot.e2eeConsumed, privacy: .public) duplicate=\(snapshot.duplicateConsumeRejected, privacy: .public)"
        )
    }

    func snapshot() -> PhysicalCanaryDiagnosticCounts {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }
}

actor PhysicalCanaryBootstrapProvider:
    AssistantBootstrapProviding,
    AssistantBootstrapInvalidating {
    private var details: AssistantConnectionDetails?
    private let diagnostics: PhysicalCanaryDiagnostics

    init(
        configuration: PhysicalCanaryConfiguration,
        diagnostics: PhysicalCanaryDiagnostics
    ) {
        self.details = AssistantConnectionDetails(
            serverURL: configuration.serverURL,
            roomName: configuration.roomName,
            participantToken: configuration.participantToken,
            capabilities: AssistantMediaCapabilities(
                publishableSources: [],
                canPublishData: true
            )
        )
        self.diagnostics = diagnostics
    }

    func bootstrap(for intent: AssistantStartIntent) async throws
        -> AssistantConnectionDetails {
        guard intent.userInitiated else {
            throw AssistantBootstrapError.notConfigured
        }
        try Task.checkCancellation()
        guard let details else {
            diagnostics.record(.duplicateConsumeRejected)
            throw AssistantBootstrapError.notConfigured
        }
        self.details = nil
        diagnostics.record(.bootstrapConsumed)
        return details
    }

    func invalidatePendingBootstrap() {
        details = nil
    }

    func stop(_ context: AssistantStopContext) async throws
        -> AssistantRemoteStopResult {
        AssistantRemoteStopResult(
            confirmed: false,
            opaqueReference: nil
        )
    }
}

actor PhysicalCanaryEncryptionProvider:
    LiveKitEncryptionOptionsProviding {
    private var keyData: Data?
    private let diagnostics: PhysicalCanaryDiagnostics

    init(
        keyData: Data,
        diagnostics: PhysicalCanaryDiagnostics
    ) {
        self.keyData = keyData
        self.diagnostics = diagnostics
    }

    func makeEncryptionOptions(
        for request: AssistantRealtimeConnectRequest
    ) async throws -> EncryptionOptions {
        _ = request
        return try await makeEncryptionOptions()
    }

    func makeEncryptionOptions() async throws -> EncryptionOptions {
        guard var keyData else {
            diagnostics.record(.duplicateConsumeRejected)
            throw LiveKitSessionError.e2eeUnavailable
        }
        self.keyData = nil
        defer {
            keyData.resetBytes(in: 0..<keyData.count)
        }
        let keyProvider = BaseKeyProvider(isSharedKey: true)
        keyProvider.setKey(keyData: keyData)
        diagnostics.record(.e2eeConsumed)
        return EncryptionOptions(
            keyProvider: keyProvider,
            encryptionType: .gcm
        )
    }
}

#endif
