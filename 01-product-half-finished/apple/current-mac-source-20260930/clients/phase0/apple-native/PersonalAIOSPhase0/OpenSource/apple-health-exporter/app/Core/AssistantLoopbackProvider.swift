import Foundation

struct AssistantLoopbackProvider: AssistantBootstrapProviding {
    func bootstrap(
        for intent: AssistantStartIntent
    ) async throws -> AssistantConnectionDetails {
#if DEBUG
        guard intent.userInitiated else {
            throw AssistantBootstrapError.notConfigured
        }
        return AssistantConnectionDetails(
            serverURL: URL(string: "wss://loopback.invalid")!,
            roomName: "debug-loopback-room",
            participantToken: "debug-loopback-token",
            capabilities: AssistantMediaCapabilities(
                publishableSources: [.microphone, .camera],
                canPublishData: true
            )
        )
#else
        throw AssistantBootstrapError.notConfigured
#endif
    }

    func stop(
        _ context: AssistantStopContext
    ) async throws -> AssistantRemoteStopResult {
#if DEBUG
        AssistantRemoteStopResult(
            confirmed: true,
            opaqueReference: "debug-loopback-stop"
        )
#else
        throw AssistantBootstrapError.notConfigured
#endif
    }
}

actor AssistantLoopbackRealtimeTransport: AssistantRealtimeTransporting {
    private var connected = false
    private var sessionEpoch: UInt64 = 0
    private var events: (@Sendable (AssistantRealtimeEvent) -> Void)?

    func connect(
        _ request: AssistantRealtimeConnectRequest,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws {
#if DEBUG
        guard request.intent.userInitiated else {
            throw LiveKitSessionError.mediaWasNotUserInitiated
        }
        sessionEpoch &+= 1
        // The stream remains unique per local session, while the wire frame
        // carries no local session or connection epoch fields.
        let streamID = "debug-loopback-stream-" + String(sessionEpoch)
        self.events = events
        connected = true
        events(.encryptionPreparing)
        events(.connected)
        events(.encryptionActive)

        let partial = AssistantResultEnvelope(
            streamID: streamID,
            sequence: 1,
            text: "Loopback is listening",
            isFinal: false
        )
        let final = AssistantResultEnvelope(
            streamID: streamID,
            sequence: 2,
            text: "Loopback reply ready",
            isFinal: true
        )
        events(.result(partial))
        events(.result(final))
#else
        throw LiveKitSessionError.e2eeUnavailable
#endif
    }

    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool
    ) async throws {
#if DEBUG
        guard connected else {
            throw LiveKitSessionError.notConnected
        }
        guard userInitiated else {
            throw LiveKitSessionError.mediaWasNotUserInitiated
        }
        _ = source
        _ = enabled
#else
        throw LiveKitSessionError.e2eeUnavailable
#endif
    }

    func stop() async {
        connected = false
        events = nil
    }

    func emit(_ event: AssistantRealtimeEvent) {
        events?(event)
    }
}
