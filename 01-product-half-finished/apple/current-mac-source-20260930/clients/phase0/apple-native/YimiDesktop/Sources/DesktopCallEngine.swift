import Foundation
import LiveKit

/// Desktop controls share the iPhone coordinator's call, media holders and turn fences.
/// No call state or transport is retained here.
@MainActor
final class DesktopCallEngine {
    let coordinator: AssistantSessionCoordinator

    init(coordinator: AssistantSessionCoordinator) { self.coordinator = coordinator }

    /// Video means the owner's camera. Vidu remains an independent, explicitly selected output.
    @discardableResult
    func start(video: Bool) async throws -> Bool {
        // LiveKit's default capture requests platform AEC and noise suppression on macOS too.
        try AudioManager.shared.setPlatformVoiceProcessingAllowed(true)
        return try await coordinator.startCall(video: false, camera: video,
                                               startIntent: AssistantStartIntent(userInitiated: true), location: nil)
    }

    func setCamera(_ enabled: Bool) async throws {
        try await coordinator.setCallCamera(enabled)
    }

    func setMuted(_ muted: Bool) async throws {
        if muted { await coordinator.releaseMedia(.microphone, for: .call) }
        else { try await coordinator.acquireMedia(.microphone, for: .call) }
    }

    func setAvatar(_ enabled: Bool) async throws {
        try await coordinator.setCallVideo(enabled)
    }

    func setConversationMode(_ mode: CallConversationMode) async throws {
        try await coordinator.setCallConversationMode(mode)
    }

    func resendConversationMode() async throws {
        try await coordinator.resendCallConversationMode()
    }

    func retryThinking() async throws {
        try await coordinator.retryCallThinking()
    }

    func end() async throws { try await coordinator.endCall(reason: "button") }

    @discardableResult
    func stop() async -> AssistantRemoteStopResult {
        await coordinator.stop(reasonCode: "user_stop")
    }
}
