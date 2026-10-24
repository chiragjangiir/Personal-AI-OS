#if canImport(WatchConnectivity)
import CryptoKit
import Foundation
@testable import HealthKitExporter
#if DEBUG && os(iOS)
enum PhysicalCanaryPreworkoutExportError: Error, Equatable, Sendable {
    case missingInput
    case malformedInput
    case invalidInput
    case watchUnavailable
    case keychainUnavailable
    case persistenceFailed
}

enum PhysicalCanaryPreworkoutStatusCode: String, Codable, Sendable {
    case started
    case missingInput = "missing_input"
    case malformedInput = "malformed_input"
    case invalidInput = "invalid_input"
    case watchUnavailable = "watch_unavailable"
    case keychainUnavailable = "keychain_unavailable"
    case persistenceFailed = "persistence_failed"
    case success
}

struct PhysicalCanaryPreworkoutObservationExporter: Sendable {
    static let launchArgument = "--paios-physical-canary-preworkout-export"
    static let requestSchema = "paios.apple-physical-preworkout-request.v1"
    static let observationSchema =
        "paios.apple-physical-preworkout-observation.v1"
    static let statusSchema = "paios.apple-physical-preworkout-status.v1"
    static let secureRegistrationRequestSchema =
        "paios.apple-secure-registration-request.v1"
    static let secureRegistrationResponseSchema =
        "paios.apple-secure-registration-response.v1"

    private let credentialStore: any CredentialStoring
    private let fileManager: FileManager
    private let rootURL: URL?
    private let now: @Sendable () -> Date

    init(
        credentialStore: any CredentialStoring = KeychainCredentialStore(),
        fileManager: FileManager = .default,
        rootURL: URL? = nil,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.credentialStore = credentialStore
        self.fileManager = fileManager
        self.rootURL = rootURL
        self.now = now
    }

    func runWithProtectedStatus(
        using adapter: WatchConnectivityPhoneAdapter
    ) async {
        defer { adapter.closeInstallationIdentityChannel() }
        if secureRegistrationRequestExists() {
            try? exportSecureRegistration()
            return
        }
        try? writeStatus(.started)
        do {
            try await export(using: adapter)
            try? writeStatus(.success)
        } catch {
            try? writeStatus(Self.statusCode(for: error))
        }
    }

    func exportSecureRegistration() throws {
        var wroteResponse = false
        defer {
            if !wroteResponse {
                try? removeSecureRegistrationResponse()
            }
        }

        let inputURL = try secureRegistrationRequestURL()
        let data: Data
        do {
            data = try Data(contentsOf: inputURL, options: [.mappedIfSafe])
        } catch {
            throw PhysicalCanaryPreworkoutExportError.malformedInput
        }
        guard data.count <= 8_192,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set([
                "schema", "request_nonce", "request_sha256"
              ]),
              let request = try? JSONDecoder().decode(
                SecureRegistrationRequest.self,
                from: data
              )
        else { throw PhysicalCanaryPreworkoutExportError.malformedInput }
        try request.validate()

        let localClientInstanceID: String
        let apiToken: String?
        do {
            localClientInstanceID = try credentialStore.deviceID()
                .uuidString.lowercased()
            apiToken = try credentialStore.apiToken()
        } catch {
            throw PhysicalCanaryPreworkoutExportError.keychainUnavailable
        }

        let response = SecureRegistrationResponse(
            schema: Self.secureRegistrationResponseSchema,
            requestNonce: request.requestNonce,
            requestSHA256: request.requestSHA256,
            observedAt: now(),
            localClientInstanceID: localClientInstanceID,
            localClientSource: "existing_keychain_device_id",
            apiTokenPresent: apiToken != nil,
            apiTokenSHA256: apiToken.map {
                Self.sha256Hex(Data($0.utf8))
            },
            credentialService: "ai.paios.personal.phase0",
            credentialAccount: "api-token"
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        var output = try encoder.encode(response)
        output.append(0x0A)
        let outputURL = try secureRegistrationResponseURL()
        do {
            try fileManager.createDirectory(
                at: outputURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try output.write(
                to: outputURL,
                options: [.atomic, .completeFileProtection]
            )
            try fileManager.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: outputURL.path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var protectedURL = outputURL
            try protectedURL.setResourceValues(values)
        } catch {
            try? fileManager.removeItem(at: outputURL)
            throw PhysicalCanaryPreworkoutExportError.persistenceFailed
        }
        wroteResponse = true
    }

    static func statusCode(for error: Error)
        -> PhysicalCanaryPreworkoutStatusCode {
        guard let error = error as? PhysicalCanaryPreworkoutExportError else {
            return .persistenceFailed
        }
        switch error {
        case .missingInput: return .missingInput
        case .malformedInput: return .malformedInput
        case .invalidInput: return .invalidInput
        case .watchUnavailable: return .watchUnavailable
        case .keychainUnavailable: return .keychainUnavailable
        case .persistenceFailed: return .persistenceFailed
        }
    }

    func export(using adapter: WatchConnectivityPhoneAdapter) async throws {
        let inputURL = try requestURL()
        guard fileManager.fileExists(atPath: inputURL.path) else {
            throw PhysicalCanaryPreworkoutExportError.missingInput
        }
        let data = try Data(contentsOf: inputURL, options: [.mappedIfSafe])
        guard data.count <= 8_192,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set([
                "schema", "manifest_sha256", "iphone", "watch"
              ]),
              let input = try? JSONDecoder().decode(Request.self, from: data)
        else { throw PhysicalCanaryPreworkoutExportError.malformedInput }
        try input.validate()

        let nonce = UUID().uuidString.lowercased()
        guard let watch = await adapter.requestInstallationIdentity(
            nonce: nonce
        ), watch.nonce == nonce else {
            throw PhysicalCanaryPreworkoutExportError.watchUnavailable
        }
        let iphoneID: String
        do {
            iphoneID = try credentialStore.deviceID().uuidString.lowercased()
        } catch {
            throw PhysicalCanaryPreworkoutExportError.keychainUnavailable
        }

        let normalized = [
            input.iphone.coreDeviceID.lowercased(), iphoneID,
            input.watch.coreDeviceID.lowercased(),
            watch.localClientInstanceID.lowercased()
        ]
        guard Self.areDistinctRFCUUIDs(normalized) else {
            throw PhysicalCanaryPreworkoutExportError.invalidInput
        }

        let observation = Observation(
            schema: Self.observationSchema,
            manifestSHA256: input.manifestSHA256,
            observedAt: now(),
            iphone: .init(
                coreDeviceID: normalized[0],
                launchReceiptSHA256: input.iphone.launchReceiptSHA256,
                localClientInstanceID: normalized[1],
                localClientSource: "existing_keychain_device_id"
            ),
            watch: .init(
                coreDeviceID: normalized[2],
                launchReceiptSHA256: input.watch.launchReceiptSHA256,
                localClientInstanceID: normalized[3],
                localClientSource: watch.localClientSource
            )
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        var output = try encoder.encode(observation)
        output.append(0x0A)
        let outputURL = try outputURL()
        do {
            try fileManager.createDirectory(
                at: outputURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try output.write(
                to: outputURL,
                options: [.atomic, .completeFileProtection]
            )
            try fileManager.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: outputURL.path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var protectedURL = outputURL
            try protectedURL.setResourceValues(values)
        } catch {
            try? fileManager.removeItem(at: outputURL)
            throw PhysicalCanaryPreworkoutExportError.persistenceFailed
        }
    }

    static func requestURL(fileManager: FileManager = .default) throws -> URL {
        try baseURL(fileManager: fileManager)
            .appendingPathComponent("preworkout-request.v1.json")
    }

    static func outputURL(fileManager: FileManager = .default) throws -> URL {
        try baseURL(fileManager: fileManager)
            .appendingPathComponent("preworkout-observation.v1.json")
    }

    static func statusURL(fileManager: FileManager = .default) throws -> URL {
        try baseURL(fileManager: fileManager)
            .appendingPathComponent("preworkout-export.status.v1.json")
    }

    static func secureRegistrationRequestURL(
        fileManager: FileManager = .default
    ) throws -> URL {
        try baseURL(fileManager: fileManager)
            .appendingPathComponent("secure-registration-request.v1.json")
    }

    static func secureRegistrationResponseURL(
        fileManager: FileManager = .default
    ) throws -> URL {
        try baseURL(fileManager: fileManager)
            .appendingPathComponent("secure-registration-response.v1.json")
    }

    private static func baseURL(fileManager: FileManager) throws -> URL {
        guard let root = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { throw PhysicalCanaryPreworkoutExportError.persistenceFailed }
        return root.appendingPathComponent(
            "PersonalAIOS/PhysicalCanary",
            isDirectory: true
        )
    }

    private func requestURL() throws -> URL {
        if let rootURL {
            return rootURL.appendingPathComponent(
                "preworkout-request.v1.json"
            )
        }
        return try Self.requestURL(fileManager: fileManager)
    }

    private func outputURL() throws -> URL {
        if let rootURL {
            return rootURL.appendingPathComponent(
                "preworkout-observation.v1.json"
            )
        }
        return try Self.outputURL(fileManager: fileManager)
    }

    private func statusURL() throws -> URL {
        if let rootURL {
            return rootURL.appendingPathComponent(
                "preworkout-export.status.v1.json"
            )
        }
        return try Self.statusURL(fileManager: fileManager)
    }

    private func secureRegistrationRequestURL() throws -> URL {
        if let rootURL {
            return rootURL.appendingPathComponent(
                "secure-registration-request.v1.json"
            )
        }
        return try Self.secureRegistrationRequestURL(fileManager: fileManager)
    }

    private func secureRegistrationResponseURL() throws -> URL {
        if let rootURL {
            return rootURL.appendingPathComponent(
                "secure-registration-response.v1.json"
            )
        }
        return try Self.secureRegistrationResponseURL(fileManager: fileManager)
    }

    private func secureRegistrationRequestExists() -> Bool {
        guard let url = try? secureRegistrationRequestURL() else { return false }
        return fileManager.fileExists(atPath: url.path)
    }

    private func removeSecureRegistrationResponse() throws {
        let url = try secureRegistrationResponseURL()
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private func writeStatus(
        _ code: PhysicalCanaryPreworkoutStatusCode
    ) throws {
        let status = Status(
            schema: Self.statusSchema,
            status: code
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data = try encoder.encode(status)
        data.append(0x0A)
        let url = try statusURL()
        do {
            try fileManager.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtection]
            )
            try fileManager.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: url.path
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var protectedURL = url
            try protectedURL.setResourceValues(values)
        } catch {
            try? fileManager.removeItem(at: url)
            throw PhysicalCanaryPreworkoutExportError.persistenceFailed
        }
    }

    private static func isRFCUUID(_ value: String) -> Bool {
        WatchInstallationIdentityRequest.isCanonicalUUID(value)
    }

    static func areDistinctRFCUUIDs(_ values: [String]) -> Bool {
        let normalized = values.map { $0.lowercased() }
        return normalized.allSatisfy(isRFCUUID)
            && Set(normalized).count == normalized.count
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }

    private static func secureRegistrationRequestSHA256(
        nonce: String
    ) -> String {
        let canonical = Data(
            "{\"request_nonce\":\"\(nonce)\",\"schema\":\"\(Self.secureRegistrationRequestSchema)\"}".utf8
        )
        return sha256Hex(canonical)
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    struct Request: Codable, Equatable, Sendable {
        let schema: String
        let manifestSHA256: String
        let iphone: Binding
        let watch: Binding

        func validate() throws {
            guard schema == PhysicalCanaryPreworkoutObservationExporter
                    .requestSchema,
                  PhysicalCanaryPreworkoutObservationExporter.isSHA256(
                    manifestSHA256
                  ) else {
                throw PhysicalCanaryPreworkoutExportError.invalidInput
            }
            try iphone.validate()
            try watch.validate()
        }

        private enum CodingKeys: String, CodingKey {
            case schema
            case manifestSHA256 = "manifest_sha256"
            case iphone
            case watch
        }
    }

    struct Binding: Codable, Equatable, Sendable {
        let coreDeviceID: String
        let launchReceiptSHA256: String

        func validate() throws {
            guard PhysicalCanaryPreworkoutObservationExporter.isRFCUUID(
                    coreDeviceID.lowercased()
                  ),
                  PhysicalCanaryPreworkoutObservationExporter.isSHA256(
                    launchReceiptSHA256
                  ) else {
                throw PhysicalCanaryPreworkoutExportError.invalidInput
            }
        }

        private enum CodingKeys: String, CodingKey {
            case coreDeviceID = "core_device_id"
            case launchReceiptSHA256 = "launch_receipt_sha256"
        }
    }

    struct Observation: Codable, Equatable, Sendable {
        let schema: String
        let manifestSHA256: String
        let observedAt: Date
        let iphone: ObservationBinding
        let watch: ObservationBinding

        private enum CodingKeys: String, CodingKey {
            case schema
            case manifestSHA256 = "manifest_sha256"
            case observedAt = "observed_at"
            case iphone
            case watch
        }
    }

    struct ObservationBinding: Codable, Equatable, Sendable {
        let coreDeviceID: String
        let launchReceiptSHA256: String
        let localClientInstanceID: String
        let localClientSource: String

        private enum CodingKeys: String, CodingKey {
            case coreDeviceID = "core_device_id"
            case launchReceiptSHA256 = "launch_receipt_sha256"
            case localClientInstanceID = "local_client_instance_id"
            case localClientSource = "local_client_source"
        }
    }

    struct Status: Codable, Equatable, Sendable {
        let schema: String
        let status: PhysicalCanaryPreworkoutStatusCode
    }

    struct SecureRegistrationRequest: Codable, Equatable, Sendable {
        let schema: String
        let requestNonce: String
        let requestSHA256: String

        func validate() throws {
            guard schema == PhysicalCanaryPreworkoutObservationExporter
                    .secureRegistrationRequestSchema,
                  PhysicalCanaryPreworkoutObservationExporter.isRFCUUID(
                    requestNonce
                  ),
                  PhysicalCanaryPreworkoutObservationExporter.isSHA256(
                    requestSHA256
                  ),
                  requestSHA256 ==
                    PhysicalCanaryPreworkoutObservationExporter
                        .secureRegistrationRequestSHA256(nonce: requestNonce)
            else {
                throw PhysicalCanaryPreworkoutExportError.invalidInput
            }
        }

        private enum CodingKeys: String, CodingKey {
            case schema
            case requestNonce = "request_nonce"
            case requestSHA256 = "request_sha256"
        }
    }

    struct SecureRegistrationResponse: Codable, Equatable, Sendable {
        let schema: String
        let requestNonce: String
        let requestSHA256: String
        let observedAt: Date
        let localClientInstanceID: String
        let localClientSource: String
        let apiTokenPresent: Bool
        let apiTokenSHA256: String?
        let credentialService: String
        let credentialAccount: String

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(schema, forKey: .schema)
            try container.encode(requestNonce, forKey: .requestNonce)
            try container.encode(requestSHA256, forKey: .requestSHA256)
            try container.encode(observedAt, forKey: .observedAt)
            try container.encode(
                localClientInstanceID,
                forKey: .localClientInstanceID
            )
            try container.encode(localClientSource, forKey: .localClientSource)
            try container.encode(apiTokenPresent, forKey: .apiTokenPresent)
            if let apiTokenSHA256 {
                try container.encode(apiTokenSHA256, forKey: .apiTokenSHA256)
            } else {
                try container.encodeNil(forKey: .apiTokenSHA256)
            }
            try container.encode(credentialService, forKey: .credentialService)
            try container.encode(credentialAccount, forKey: .credentialAccount)
        }

        private enum CodingKeys: String, CodingKey {
            case schema
            case requestNonce = "request_nonce"
            case requestSHA256 = "request_sha256"
            case observedAt = "observed_at"
            case localClientInstanceID = "local_client_instance_id"
            case localClientSource = "local_client_source"
            case apiTokenPresent = "api_token_present"
            case apiTokenSHA256 = "api_token_sha256"
            case credentialService = "credential_service"
            case credentialAccount = "credential_account"
        }
    }
}
#endif
#endif
