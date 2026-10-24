import Foundation

// Local typed seams only. These types are not the canonical T01/T11B wire contract.
struct AssistantOperationID: Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String = UUID().uuidString.lowercased()) {
        self.rawValue = rawValue
    }
}

enum AssistantMediaSource: String, CaseIterable, Hashable, Sendable {
    case microphone
    case camera
}

struct AssistantMediaCapabilities: Equatable, Sendable {
    let publishableSources: Set<AssistantMediaSource>
    let canPublishData: Bool

    static let none = AssistantMediaCapabilities(
        publishableSources: [],
        canPublishData: false
    )

    func allows(_ source: AssistantMediaSource) -> Bool {
        publishableSources.contains(source)
    }
}

struct AssistantStartIntent: Equatable, Sendable {
    let operationID: AssistantOperationID
    let microphoneEnabled: Bool
    let cameraEnabled: Bool
    let locationEnabled: Bool
    let userInitiated: Bool

    init(
        operationID: AssistantOperationID = AssistantOperationID(),
        microphoneEnabled: Bool = false,
        cameraEnabled: Bool = false,
        locationEnabled: Bool = false,
        userInitiated: Bool
    ) {
        self.operationID = operationID
        self.microphoneEnabled = microphoneEnabled
        self.cameraEnabled = cameraEnabled
        self.locationEnabled = locationEnabled
        self.userInitiated = userInitiated
    }
}

struct AssistantConnectionDetails: Sendable {
    let serverURL: URL
    let roomName: String
    let participantToken: String
    let capabilities: AssistantMediaCapabilities
    let callRejoinDeadline: Date?

    init(
        serverURL: URL,
        roomName: String,
        participantToken: String,
        capabilities: AssistantMediaCapabilities,
        callRejoinDeadline: Date? = nil
    ) {
        self.serverURL = serverURL
        self.roomName = roomName
        self.participantToken = participantToken
        self.capabilities = capabilities
        self.callRejoinDeadline = callRejoinDeadline
    }
}

struct AssistantStopContext: Codable, Sendable {
    let operationID: AssistantOperationID
    let roomName: String
    let reasonCode: String
}

struct AssistantRemoteStopResult: Equatable, Sendable {
    let confirmed: Bool
    let opaqueReference: String?
}

enum AssistantBootstrapError: LocalizedError, Equatable, Sendable {
    case notConfigured
    case invalidConnectionDetails
    case remoteStopUnconfirmed

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Cloud bootstrap 尚未配置。"
        case .invalidConnectionDetails:
            return "Bootstrap 返回了不可用的连接材料。"
        case .remoteStopUnconfirmed:
            return "本地媒体已清理，但远端 Stop 尚未确认。"
        }
    }
}

enum AssistantCallRecoveryError: Error, Equatable, Sendable {
    case expired
    case bindingRejected
    case bindingMissing // Runtime transport is absent; exact-binding media_stop must establish closure.
    case bindingGone(String) // Server authority proved the original binding cannot own a call.
}
enum AssistantCallRejoinBudget {
    static func deadline(_ announced: Date?) -> Date? { announced?.addingTimeInterval(2) }
}

protocol AssistantBootstrapProviding: Sendable {
    func bootstrap(for intent: AssistantStartIntent) async throws
        -> AssistantConnectionDetails
    func reconnectDetails(_ existing: AssistantConnectionDetails, for intent: AssistantStartIntent, callID: String?) async throws -> AssistantConnectionDetails
    func stop(_ context: AssistantStopContext) async throws
        -> AssistantRemoteStopResult
    func restorePendingStop() async throws -> AssistantStopContext?
    func centralTransportBinding() async throws -> CentralTransportBinding?
}

extension AssistantBootstrapProviding {
    func reconnectDetails(_ existing: AssistantConnectionDetails, for intent: AssistantStartIntent, callID: String?) async throws -> AssistantConnectionDetails { existing }
    func reconnectDetails(_ existing: AssistantConnectionDetails, for intent: AssistantStartIntent) async throws -> AssistantConnectionDetails {
        try await reconnectDetails(existing, for: intent, callID: nil)
    }
    func restorePendingStop() async throws -> AssistantStopContext? { nil }
    func centralTransportBinding() async throws -> CentralTransportBinding? { nil }
}

actor UnconfiguredAssistantBootstrapProvider: AssistantBootstrapProviding {
    func bootstrap(for intent: AssistantStartIntent) async throws
        -> AssistantConnectionDetails {
        throw AssistantBootstrapError.notConfigured
    }

    func stop(_ context: AssistantStopContext) async throws
        -> AssistantRemoteStopResult {
        throw AssistantBootstrapError.notConfigured
    }
}
