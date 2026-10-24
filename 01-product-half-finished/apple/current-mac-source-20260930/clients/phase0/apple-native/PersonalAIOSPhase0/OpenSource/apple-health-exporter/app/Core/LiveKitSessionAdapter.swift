import Foundation
import AVFoundation
import LiveKit
import AVFAudio

struct AssistantVideoTrackUpdate: @unchecked Sendable {
    let localVideoTrack: VideoTrack?
    let remoteVideoTrack: VideoTrack?

    static let cleared = AssistantVideoTrackUpdate(
        localVideoTrack: nil,
        remoteVideoTrack: nil
    )
}

typealias AssistantVideoTrackObserver =
    @MainActor @Sendable (AssistantVideoTrackUpdate) -> Void

struct AssistantRealtimeConnectRequest: Sendable {
    let details: AssistantConnectionDetails
    let intent: AssistantStartIntent
    let autoSubscribe: Bool
    let centralBinding: CentralTransportBinding?
    let retainsLogicalCall: Bool
    let rejoinDeadline: Date?

    init(
        details: AssistantConnectionDetails,
        intent: AssistantStartIntent,
        autoSubscribe: Bool = true,
        centralBinding: CentralTransportBinding? = nil,
        retainsLogicalCall: Bool = false,
        rejoinDeadline: Date? = nil
    ) {
        self.details = details
        self.intent = intent
        self.autoSubscribe = autoSubscribe
        self.centralBinding = centralBinding
        self.retainsLogicalCall = retainsLogicalCall
        self.rejoinDeadline = rejoinDeadline
    }
}

enum AssistantCyclingControlAction: String, Codable, Equatable, Sendable {
    case start
    case stop
}

enum AssistantCyclingControlCommandError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case invalidVersion
    case invalidKind
    case invalidEnvelope
}

/// Closed app-local command accepted only from the encrypted data channel of
/// the currently connected room. It deliberately carries no authority,
/// identity, token, or session fields.
struct AssistantCyclingControlCommand: Codable, Equatable, Sendable {
    static let topic = "paios.cycling.control.local.v1"
    static let currentVersion = 1
    static let currentKind = "cycling_control"

    let version: Int
    let kind: String
    let action: AssistantCyclingControlAction
    let requestID: String
    let sequence: UInt64
    let workoutID: String?

    init(
        version: Int = AssistantCyclingControlCommand.currentVersion,
        kind: String = AssistantCyclingControlCommand.currentKind,
        action: AssistantCyclingControlAction,
        requestID: String,
        sequence: UInt64,
        workoutID: String? = nil
    ) {
        self.version = version
        self.kind = kind
        self.action = action
        self.requestID = requestID
        self.sequence = sequence
        self.workoutID = workoutID
    }

    func encodedStrict() throws -> Data {
        try validate()
        return try JSONEncoder().encode(self)
    }

    static func decodeStrict(_ data: Data) throws
        -> AssistantCyclingControlCommand {
        guard !data.isEmpty, data.count <= 4_096,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            throw AssistantCyclingControlCommandError.malformed
        }
        let allowed = Set([
            "version", "kind", "action", "request_id", "sequence", "workout_id"
        ])
        for key in dictionary.keys where !allowed.contains(key) {
            throw AssistantCyclingControlCommandError.unsupportedKey(key)
        }
        guard Set(dictionary.keys).isSuperset(of: allowed.subtracting(["workout_id"])) else {
            throw AssistantCyclingControlCommandError.malformed
        }
        let command: AssistantCyclingControlCommand
        do {
            command = try JSONDecoder().decode(
                AssistantCyclingControlCommand.self,
                from: data
            )
        } catch {
            throw AssistantCyclingControlCommandError.malformed
        }
        try command.validate()
        return command
    }

    static func admit(
        data: Data,
        topic: String,
        isEncrypted: Bool,
        hasRemoteParticipant: Bool,
        isCurrentConnectedRoom: Bool
    ) -> AssistantCyclingControlCommand? {
        guard topic == Self.topic,
              isEncrypted,
              hasRemoteParticipant,
              isCurrentConnectedRoom
        else {
            return nil
        }
        return try? decodeStrict(data)
    }

    private func validate() throws {
        guard version == Self.currentVersion else {
            throw AssistantCyclingControlCommandError.invalidVersion
        }
        guard kind == Self.currentKind else {
            throw AssistantCyclingControlCommandError.invalidKind
        }
        if let workoutID, workoutID.isEmpty { throw AssistantCyclingControlCommandError.invalidEnvelope }
        let bytes = Array(requestID.utf8)
        guard sequence > 0,
              (1...128).contains(bytes.count),
              let first = bytes.first,
              Self.isAlphaNumeric(first),
              bytes.dropFirst().allSatisfy({
                  Self.isAlphaNumeric($0)
                      || $0 == 45 || $0 == 46 || $0 == 58 || $0 == 95
              })
        else {
            throw AssistantCyclingControlCommandError.invalidEnvelope
        }
    }

    private static func isAlphaNumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte)
            || (65...90).contains(byte)
            || (97...122).contains(byte)
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case kind
        case action
        case requestID = "request_id"
        case sequence
        case workoutID = "workout_id"
    }
}

enum AssistantRealtimeEvent: Equatable, Sendable {
    case connected
    case reconnecting
    case callRejoinBudget(Date)
    case resuming
    case reconnected
    case disconnected(errorCode: String?)
    case encryptionPreparing
    case encryptionActive
    case encryptionFailed
    case result(AssistantResultEnvelope)
    case centralText(CentralTextPacket)
    case callAudioPlaying(callID: String, playing: Bool)
    case centralVoice(CentralVoicePlayback)
    case centralVoiceFinished(CentralVoicePlayback, Bool)
    case centralVoiceFailed(CentralTextPacket)
    case cyclingControl(AssistantCyclingControlCommand)
}

enum AssistantPromptEnvelopeError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case invalidEnvelope
    case packetTooLarge
}

/// The app-local prompt wire is intentionally independent of the Phase 0
/// health envelope. Room membership and the already authenticated terminal
/// token supply identity; no session, lease, bearer, or governance fields are
/// copied into this packet.
struct AssistantPromptEnvelope: Codable, Equatable, Sendable {
    static let topic = "paios.assistant.prompt.local.v1"
    static let reliable = true
    static let maxPromptBytes = 8_192
    static let maxWireBytes = 12_288

    let promptID: String
    let text: String
    let attachments: [CentralAttachment]

    init(promptID: String, text: String, attachments: [CentralAttachment] = []) {
        self.attachments = attachments
        self.promptID = promptID
        self.text = text.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
    }

    private enum CodingKeys: String, CodingKey {
        case promptID = "prompt_id"
        case text, attachments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            promptID: try container.decode(String.self, forKey: .promptID),
            text: try container.decode(String.self, forKey: .text),
            attachments: try container.decodeIfPresent([CentralAttachment].self, forKey: .attachments) ?? []
        )
        guard isWellFormed else {
            throw AssistantPromptEnvelopeError.invalidEnvelope
        }
    }

    func encode(to encoder: Encoder) throws {
        guard isWellFormed else {
            throw AssistantPromptEnvelopeError.invalidEnvelope
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(promptID, forKey: .promptID)
        try container.encode(text, forKey: .text)
        if !attachments.isEmpty { try container.encode(attachments, forKey: .attachments) }
    }

    func encodedStrict() throws -> Data {
        guard isWellFormed else {
            throw AssistantPromptEnvelopeError.invalidEnvelope
        }
        let data = try JSONEncoder().encode(self)
        guard data.count <= Self.maxWireBytes else {
            throw AssistantPromptEnvelopeError.packetTooLarge
        }
        return data
    }

    static func decodeStrict(_ data: Data) throws -> AssistantPromptEnvelope {
        guard data.count <= Self.maxWireBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            throw AssistantPromptEnvelopeError.malformed
        }
        let allowed = Set(["prompt_id", "text", "attachments"])
        let keys = Set(dictionary.keys)
        guard keys.isSubset(of: allowed) else {
            let unsupported = keys.subtracting(allowed).sorted().first
                ?? "unknown"
            throw AssistantPromptEnvelopeError.unsupportedKey(unsupported)
        }
        guard keys.isSuperset(of: ["prompt_id", "text"]) else {
            throw AssistantPromptEnvelopeError.malformed
        }
        do {
            return try JSONDecoder().decode(
                AssistantPromptEnvelope.self,
                from: data
            )
        } catch let error as AssistantPromptEnvelopeError {
            throw error
        } catch {
            throw AssistantPromptEnvelopeError.malformed
        }
    }

    var isWellFormed: Bool {
        let idBytes = Array(promptID.utf8)
        guard (1...64).contains(idBytes.count),
              UUID(uuidString: promptID) != nil
        else {
            return false
        }
        let textBytes = Array(text.utf8)
        return (1...Self.maxPromptBytes).contains(textBytes.count)
            && !text.isEmpty
    }
}

protocol AssistantRealtimeDataPublishing: Sendable {
    func publish(_ event: AssistantRealtimeDataEvent) async throws
}

protocol AssistantRealtimePromptPublishing: Sendable {
    func publishPrompt(_ prompt: AssistantPromptEnvelope) async throws
}

enum AssistantRealtimeDataOrigin: Equatable, Sendable {
    case appleWatch(CyclingWatchOriginBinding)
    case iphone
}

struct AssistantRealtimeDataSequence: Equatable, Sendable {
    let streamID: String
    let number: UInt64
    let previousEventID: String?
}

enum AssistantWorkoutMetricItem: Equatable, Sendable {
    case heartRate(Double)
    case activeEnergy(Double)
    case distance(Double)
    case elapsedTime(Double)
    case cadence(Double)
}

struct AssistantCyclingWorkoutPayload: Equatable, Sendable {
    let workoutID: String
    let observedAt: Date
    let metrics: [AssistantWorkoutMetricItem]
}

struct AssistantCyclingLocationPayload: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyM: Double
    let observedAt: Date
}

enum AssistantRealtimeDataPayload: Equatable, Sendable {
    case workout(AssistantCyclingWorkoutPayload)
    case location(AssistantCyclingLocationPayload)
}

/// A contract event without any self-asserted iPhone/session identity. The
/// joined LiveKit room supplies that binding before this value can be encoded.
struct AssistantRealtimeDataEvent: Equatable, Sendable {
    static let schemaVersion = "phase0-demo/0.4"
    static let topic = "paios.phase0.demo.event"
    static let reliable = true
    static let destinationIdentities: [String] = []

    let eventID: String
    let traceID: String
    let occurredAt: Date
    let expiresAt: Date
    let origin: AssistantRealtimeDataOrigin
    let sequence: AssistantRealtimeDataSequence
    let idempotencyKey: String
    let payload: AssistantRealtimeDataPayload

    fileprivate var eventType: String {
        switch payload {
        case .workout:
            return "paios.phase0.demo.workout.metric"
        case .location:
            return "paios.phase0.demo.location.observed"
        }
    }

    func encoded(for binding: AssistantLiveKitDataBinding) throws -> Data {
        try AssistantPhase0DataContract.encode(self, binding: binding)
    }
}

/// Exact, current-room identity used by the encoder. Construction is
/// fail-closed and happens before serialization.
struct AssistantLiveKitDataBinding: Equatable, Sendable {
    let sessionID: String
    let relayDeviceID: String
    let relayClientInstanceID: String
    let connectionID: String
    let centralBinding: CentralTransportBinding?

    init(
        joinedRoomName: String?,
        expectedRoomName: String,
        roomSID: String?,
        participantIdentity: String?,
        participantAttributes: [String: String],
        bootstrapCanPublishData: Bool,
        runtimeCanPublishData: Bool,
        roomIsConnected: Bool,
        centralBinding: CentralTransportBinding? = nil
    ) throws {
        guard roomIsConnected else {
            throw LiveKitSessionError.notConnected
        }
        guard bootstrapCanPublishData, runtimeCanPublishData else {
            throw LiveKitSessionError.dataNotGranted
        }
        self.centralBinding = centralBinding
        if let centralBinding {
            // Central bootstrap carries an opaque room alias; the signed token selects the SFU room.
            guard let joinedRoomName,
                  let roomSID, let participantIdentity, !participantIdentity.isEmpty,
                  participantIdentity.utf8.count <= 200,
                  UUID(uuidString: centralBinding.deviceID) != nil,
                  !centralBinding.sessionID.isEmpty, !centralBinding.connectionEpoch.isEmpty,
                  !centralBinding.expectedGatewayIdentity.isEmpty,
                  centralBinding.maxPacketBytes > 0 else {
                throw LiveKitSessionError.invalidPublisherBinding
            }
            self.sessionID = joinedRoomName
            self.relayDeviceID = centralBinding.deviceID
            // Watch relay JSON has no primary client-instance field. RTC identity is not a T02 client reference.
            self.relayClientInstanceID = ""
            self.connectionID = roomSID.lowercased()
            return
        }
        guard
            let joinedRoomName,
            joinedRoomName == expectedRoomName,
            let roomSID,
            let participantIdentity,
            let deviceID = participantAttributes["device_id"],
            let clientInstanceID =
                participantAttributes["client_instance_id"],
            participantAttributes["device_class"] == "iphone",
            participantAttributes["schema_version"] ==
                AssistantRealtimeDataEvent.schemaVersion,
            participantIdentity == deviceID,
            AssistantPhase0DataContract.isScopedID(joinedRoomName),
            AssistantPhase0DataContract.isScopedID(deviceID),
            AssistantPhase0DataContract.isScopedID(clientInstanceID)
        else {
            throw LiveKitSessionError.invalidPublisherBinding
        }

        let normalizedRoomSID = roomSID.lowercased()
        guard AssistantPhase0DataContract.isScopedID(normalizedRoomSID) else {
            throw LiveKitSessionError.invalidPublisherBinding
        }
        self.sessionID = joinedRoomName
        self.relayDeviceID = deviceID
        self.relayClientInstanceID = clientInstanceID
        self.connectionID = normalizedRoomSID
    }
}

private enum AssistantPhase0DataContract {
    static func isScopedID(_ value: String) -> Bool {
        value.range(of: "^[a-z][a-z0-9_-]{2,63}\\z", options: .regularExpression) != nil
    }

    static func encode(_ event: AssistantRealtimeDataEvent, binding: AssistantLiveKitDataBinding) throws -> Data {
        guard UUID(uuidString: event.eventID) != nil,
              UUID(uuidString: event.traceID) != nil,
              event.expiresAt > event.occurredAt,
              event.idempotencyKey.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}\\z", options: .regularExpression) != nil,
              isScopedID(event.sequence.streamID), event.sequence.number > 0 else {
            throw LiveKitSessionError.invalidDataEvent
        }
        if event.sequence.number == 1 {
            guard event.sequence.previousEventID == nil else { throw LiveKitSessionError.invalidDataEvent }
        } else {
            guard let previous = event.sequence.previousEventID, UUID(uuidString: previous) != nil else {
                throw LiveKitSessionError.invalidDataEvent
            }
        }
        let origin: [String: Any]
        let payload: [String: Any]
        switch (event.origin, event.payload) {
        case (.appleWatch(let watch), .workout(let workout)):
            guard watch.deviceID != binding.relayDeviceID else {
                throw LiveKitSessionError.invalidPublisherBinding
            }
            guard workout.observedAt == event.occurredAt,
                  isScopedID(workout.workoutID), (1...8).contains(workout.metrics.count) else {
                throw LiveKitSessionError.invalidDataEvent
            }
            origin = [
                "device_id": watch.deviceID,
                "device_class": "apple_watch",
                "client_instance_id": watch.clientInstanceID,
                "relay": ["device_id": binding.relayDeviceID, "device_class": "iphone", "transport": "watch_connectivity"]
            ]
            var seen = Set<String>()
            let metrics = try workout.metrics.map { metric -> [String: Any] in
                let name: String
                let value: Double
                let unit: String
                let range: ClosedRange<Double>
                switch metric {
                case .heartRate(let candidate):
                    (name, value, unit, range) = ("heart_rate", candidate, "bpm", 20...260)
                case .activeEnergy(let candidate):
                    (name, value, unit, range) = ("active_energy", candidate, "kcal", 0...Double.greatestFiniteMagnitude)
                case .distance(let candidate):
                    (name, value, unit, range) = ("distance", candidate, "m", 0...Double.greatestFiniteMagnitude)
                case .elapsedTime(let candidate):
                    (name, value, unit, range) = ("elapsed_time", candidate, "s", 0...Double.greatestFiniteMagnitude)
                case .cadence(let candidate):
                    (name, value, unit, range) = ("cadence", candidate, "spm", 0...300)
                }
                guard value.isFinite, range.contains(value), seen.insert(name).inserted else {
                    throw LiveKitSessionError.invalidDataEvent
                }
                return ["name": name, "value": value, "unit": unit]
            }
            payload = [
                "workout_id": workout.workoutID,
                "workout_kind": "cycling",
                "observed_at": timestamp(workout.observedAt),
                "metrics": metrics
            ]
        case (.iphone, .location(let location)):
            guard binding.centralBinding == nil,
                  location.observedAt == event.occurredAt,
                  location.latitude.isFinite, (-90...90).contains(location.latitude),
                  location.longitude.isFinite, (-180...180).contains(location.longitude),
                  location.accuracyM.isFinite, (0...100_000).contains(location.accuracyM) else {
                throw LiveKitSessionError.invalidDataEvent
            }
            origin = [
                "device_id": binding.relayDeviceID,
                "device_class": "iphone",
                "client_instance_id": binding.relayClientInstanceID
            ]
            payload = [
                "latitude": location.latitude,
                "longitude": location.longitude,
                "accuracy_m": location.accuracyM,
                "activity": "cycling",
                "observed_at": timestamp(location.observedAt),
                "authorization_mode": "foreground"
            ]
        default:
            throw LiveKitSessionError.invalidDataEvent
        }
        var sequence: [String: Any] = ["stream_id": event.sequence.streamID, "number": event.sequence.number]
        if let previous = event.sequence.previousEventID {
            sequence["previous_event_id"] = previous
        }
        let envelope: [String: Any] = [
            "schema_version": AssistantRealtimeDataEvent.schemaVersion,
            "event_type": event.eventType,
            "event_id": event.eventID.lowercased(),
            "session_id": binding.sessionID,
            "trace_id": event.traceID.lowercased(),
            "occurred_at": timestamp(event.occurredAt),
            "expires_at": timestamp(event.expiresAt),
            "origin": origin,
            "connection": ["id": binding.connectionID, "epoch": 0, "state": "connected"],
            "sequence": sequence,
            "idempotency_key": event.idempotencyKey,
            "payload": payload
        ]
        let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes])
        guard data.count <= min(15_000, binding.centralBinding?.maxPacketBytes ?? 15_000) else {
            throw LiveKitSessionError.invalidDataEvent
        }
        return data
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

enum LiveKitSessionError: LocalizedError, Equatable, Sendable {
    case invalidServerURL
    case emptyCredential
    case e2eeUnavailable
    case mediaNotGranted(AssistantMediaSource)
    case mediaWasNotUserInitiated
    case notConnected
    case eventQueueOverflow
    case superseded
    case dataNotGranted
    case invalidPublisherBinding
    case invalidDataEvent

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "LiveKit Cloud 地址必须使用 wss。"
        case .emptyCredential:
            return "LiveKit 连接材料不完整。"
        case .e2eeUnavailable:
            return "E2EE key provider 未就绪；会话已拒绝连接。"
        case .mediaNotGranted(let source):
            return "服务端未授权发布 \(source.rawValue)。"
        case .mediaWasNotUserInitiated:
            return "媒体采集只能由明确的用户操作启用。"
        case .notConnected:
            return "LiveKit 房间尚未连接。"
        case .eventQueueOverflow:
            return "LiveKit 回调队列超限，连接已中断。"
        case .superseded:
            return "LiveKit 连接尝试已被停止或替代。"
        case .dataNotGranted:
            return "服务端或当前参与者未授权发布数据。"
        case .invalidPublisherBinding:
            return "当前 LiveKit 房间与 iPhone 发布身份不匹配。"
        case .invalidDataEvent:
            return "Phase 0 数据事件未通过本地闭合校验。"
        }
    }
}

protocol AssistantRealtimeTransporting: Sendable {
    func connect(
        _ request: AssistantRealtimeConnectRequest,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws
    /// A microphone off unpublishes its track, so the device stops recording; `keepPublished` (inside a call) mutes it
    /// and leaves it published, so unmute resumes the same capture. A camera off mutes (the SDK stops its capture).
    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool
    ) async throws
    func stop() async
    func setCallRejoinDeadline(_ announced: Date?, callActive: Bool) async
    func setCallPlaybackID(_ id: String?) async
}
extension AssistantRealtimeTransporting {
    func setCallRejoinDeadline(_ announced: Date?, callActive: Bool) async {}
    func setCallPlaybackID(_ id: String?) async {}
}

protocol LiveKitRoomOperating: Sendable {
    func connect(
        _ request: AssistantRealtimeConnectRequest,
        attemptID: UInt64,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws
    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool,
        attemptID: UInt64
    ) async throws
    func currentDataBinding(attemptID: UInt64) async throws -> AssistantLiveKitDataBinding
    func publishData(
        _ data: Data,
        binding: AssistantLiveKitDataBinding,
        attemptID: UInt64
    ) async throws
    func publishTextData(_ data: Data, binding: CentralTransportBinding?, attemptID: UInt64) async throws
    func prepareCentralVoice(eventID: String?, attemptID: UInt64) async throws
    func observeCentralVoice(eventIDs: Set<String>, attemptID: UInt64) async throws
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding, attemptID: UInt64) async throws
    func setCaptureMuted(_ muted: Bool, attemptID: UInt64) async throws
    func setCallPlaybackID(_ id: String?, attemptID: UInt64) async
    func stop(attemptID: UInt64) async
}

protocol AssistantCentralTextPublishing: Sendable {
    func publishCentralTextData(_ data: Data, binding: CentralTransportBinding) async throws
    func prepareCentralVoice(eventID: String?) async throws
    func observeCentralVoice(eventIDs: Set<String>) async throws
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding) async throws
    /// Mutes the published microphone track without unpublishing it (the echo guard while 依米's own reply plays).
    func setCaptureMuted(_ muted: Bool) async throws
}
// Existing text-only fakes retain their data path; an attempted voice use cannot silently pass.
extension LiveKitRoomOperating {
    func setCallPlaybackID(_ id: String?, attemptID: UInt64) async {}
    func observeCentralVoice(eventIDs: Set<String>, attemptID: UInt64) async throws { if !eventIDs.isEmpty { throw CentralTextError.unavailable } }
    func prepareCentralVoice(eventID: String?, attemptID: UInt64) async throws { if eventID != nil { throw CentralTextError.unavailable } }
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding, attemptID: UInt64) async throws { throw CentralTextError.unavailable }
    func setCaptureMuted(_ muted: Bool, attemptID: UInt64) async throws { throw CentralTextError.unavailable }
}
extension AssistantCentralTextPublishing {
    func observeCentralVoice(eventIDs: Set<String>) async throws { if !eventIDs.isEmpty { throw CentralTextError.unavailable } }
    func prepareCentralVoice(eventID: String?) async throws { if eventID != nil { throw CentralTextError.unavailable } }
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding) async throws { throw CentralTextError.unavailable }
    func setCaptureMuted(_ muted: Bool) async throws { throw CentralTextError.unavailable }
}

// Initial SDK join failures belong to the shared connect attempt, not the established room lifecycle.
private final class LiveKitConnectEventRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var joined = false
    private let handler: @Sendable (AssistantRealtimeEvent) -> Void
    init(_ handler: @escaping @Sendable (AssistantRealtimeEvent) -> Void) { self.handler = handler }
    func complete() { lock.withLock { joined = true } }
    func receive(_ event: AssistantRealtimeEvent) {
        if case .disconnected = event, !lock.withLock({ joined }) { return }
        handler(event)
    }
}

actor LiveKitSessionAdapter: AssistantRealtimeTransporting,
    AssistantRealtimeDataPublishing,
    AssistantRealtimePromptPublishing, AssistantCentralTextPublishing {
    /// The binding's gateway left its room. Not refresh-recoverable: only a fresh bootstrap brings a gateway back.
    nonisolated static let gatewayLeftCode = "gateway_left"

    nonisolated static func isRecoverableDisconnection(_ code: String?) -> Bool {
        guard let code else { return true }
        return ["network", "realtime_event_queue_overflow", "desktop_stream_failed", "reconnect_timeout"].contains(code)
    }

    nonisolated static func isTransientConnectionFailure(_ error: Error) -> Bool {
        if let error = error as? LiveKitError { return error.type == .network || error.type == .timedOut }
        if let error = error as? URLError {
            return [.networkConnectionLost, .notConnectedToInternet, .timedOut, .cannotConnectToHost].contains(error.code)
        }
        guard let error = error as? LiveKitSessionError else { return false }
        return error == .notConnected || error == .eventQueueOverflow
    }

    private let roomOperator: any LiveKitRoomOperating
    private var connected = false
    private var roomEventIngress: AssistantRealtimeEventIngress?
    private var roomEventTask: Task<Void, Never>?
    private var nextAttemptID: UInt64 = 0
    private var activeAttemptID: UInt64?
    private var readyBinding: CentralTransportBinding?
    private var centralReady = false
    private var readyPacket: CentralTextPacket?
    private var readyForwarded = false
    private var encryptionReleased = false
    private var readyGeneration: UInt64 = 0
    private var roomGeneration: UInt64 = 0
    private var readyError: Error?
    private var frozenRejoinDeadline: Date?
    private var callActive = false
    private var callRecoveryDeadline: Date? { AssistantCallRejoinBudget.deadline(frozenRejoinDeadline) }
    private var readyDeadline: Task<Void, Never>?
    private var readyWaiters: [UUID: (continuation: CheckedContinuation<Void, Error>, bounded: Bool)] = [:]
    private var pendingEncryptionActive = false
    private var eventHandler: (@Sendable (AssistantRealtimeEvent) -> Void)?

    init(roomOperator: any LiveKitRoomOperating) {
        self.roomOperator = roomOperator
    }

    func connect(
        _ request: AssistantRealtimeConnectRequest,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws {
        guard
            request.details.serverURL.scheme?.lowercased() == "wss",
            request.details.serverURL.host != nil
        else {
            throw LiveKitSessionError.invalidServerURL
        }
        guard
            !request.details.roomName.isEmpty,
            !request.details.participantToken.isEmpty
        else {
            throw LiveKitSessionError.emptyCredential
        }
        guard request.intent.userInitiated else {
            throw LiveKitSessionError.mediaWasNotUserInitiated
        }
        if request.intent.cameraEnabled {
            guard request.details.capabilities.allows(.camera) else {
                throw LiveKitSessionError.mediaNotGranted(.camera)
            }
        }
        if request.intent.microphoneEnabled {
            guard request.details.capabilities.allows(.microphone) else {
                throw LiveKitSessionError.mediaNotGranted(.microphone)
            }
        }

        let previousAttemptID = activeAttemptID
        nextAttemptID &+= 1
        let attemptID = nextAttemptID
        resetCentralReady(error: LiveKitSessionError.superseded)
        activeAttemptID = attemptID
        connected = false
        readyBinding = request.centralBinding
        readyError = nil
        frozenRejoinDeadline = request.rejoinDeadline
        callActive = request.retainsLogicalCall
        let relay = LiveKitConnectEventRelay(events)
        eventHandler = { relay.receive($0) }

        let deadline = ContinuousClock.now.advanced(by: .seconds(60))
        if !request.retainsLogicalCall || callRecoveryDeadline != nil { beginCentralReadyDeadline(deadline: deadline) }
        do {
            // The session owner may reacquire after SDK exhaustion. Retire the old room first.
            if let previousAttemptID { await roomOperator.stop(attemptID: previousAttemptID) }
            try Task.checkCancellation()
            guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
            while true {
                if let deadline = callRecoveryDeadline, deadline <= Date() { throw AssistantCallRecoveryError.expired }
                roomGeneration &+= 1
                let roomID = roomGeneration
                do {
                    // One consumer preserves SDK callback order across the actor boundary.
                    let ingress = AssistantRealtimeEventIngress()
                    let consumer = Task { [weak self] in
                        for await event in ingress.stream {
                            ingress.didDequeue(event)
                            if ingress.takeOverflow() {
                                await self?.failRoomEventOverflow(attemptID: attemptID, roomID: roomID, relay: relay)
                                ingress.close()
                                return
                            }
                            await self?.receive(event, attemptID: attemptID, roomID: roomID, relay: relay)
                        }
                    }
                    roomEventIngress?.close()
                    roomEventTask?.cancel()
                    roomEventIngress = ingress
                    roomEventTask = consumer
                    try await roomOperator.connect(request, attemptID: attemptID, events: { event in
                        if request.centralBinding == nil { relay.receive(event) }
                        else { ingress.yield(event) }
                    })
                    try Task.checkCancellation()
                    guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
                    connected = true
                    releaseCentralReady()
                    if readyBinding != nil {
                        try await waitForCentralReady(attemptID: attemptID, bounded: !request.retainsLogicalCall)
                        guard connected, centralReady, readyError == nil else { throw LiveKitSessionError.notConnected }
                    }
                    break
                } catch {
                    try Task.checkCancellation()
                    let sdkFailure = error as? LiveKitError
                    if sdkFailure?.type == .network || sdkFailure?.type == .timedOut || (error as? LiveKitSessionError) == .notConnected {
                        freezeCallRecoveryBudget()
                    }
                    if let deadline = callRecoveryDeadline, deadline <= Date() { throw AssistantCallRecoveryError.expired }
                    let sdkError = error as? LiveKitError
                    let retrySDK = sdkError?.type == .timedOut || sdkError?.type == .network
                    let retryCallReady = request.retainsLogicalCall && (error as? LiveKitSessionError) == .notConnected
                    guard (request.retainsLogicalCall || ContinuousClock.now < deadline), retrySDK || retryCallReady else { throw error }
                    guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
                    connected = false
                    roomGeneration &+= 1
                    resetCentralReady(error: CentralTextError.contextChanged())
                    readyError = nil
                    if !request.retainsLogicalCall || callRecoveryDeadline != nil { beginCentralReadyDeadline(deadline: deadline) }
                    await roomOperator.stop(attemptID: attemptID)
                    let pause = min(0.5, callRecoveryDeadline?.timeIntervalSinceNow ?? 0.5)
                    try await Task.sleep(nanoseconds: UInt64(max(0, pause) * 1_000_000_000))
                    try Task.checkCancellation()
                    guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
                }
            }
            try Task.checkCancellation()
            guard activeAttemptID == attemptID else {
                throw LiveKitSessionError.superseded
            }
            relay.complete()
        } catch {
            let superseded = activeAttemptID != attemptID
            if activeAttemptID == attemptID {
                roomEventIngress?.close(); roomEventIngress = nil
                roomEventTask?.cancel(); roomEventTask = nil
                resetCentralReady(error: error)
                connected = false
                activeAttemptID = nil
            }
            await roomOperator.stop(attemptID: attemptID)
            try Task.checkCancellation()
            if superseded {
                throw LiveKitSessionError.superseded
            }
            throw error
        }
    }

    private func failRoomEventOverflow(attemptID: UInt64, roomID: UInt64, relay: LiveKitConnectEventRelay) async {
        guard activeAttemptID == attemptID, roomGeneration == roomID else { return }
        roomGeneration &+= 1
        connected = false
        resetCentralReady(error: LiveKitSessionError.eventQueueOverflow)
        relay.receive(.disconnected(errorCode: "realtime_event_queue_overflow"))
        await roomOperator.stop(attemptID: attemptID)
    }

    private func receive(_ event: AssistantRealtimeEvent, attemptID: UInt64, roomID: UInt64, relay: LiveKitConnectEventRelay) {
        guard activeAttemptID == attemptID, roomGeneration == roomID else { return }
        if readyBinding != nil {
            switch event {
            case .centralText(let packet) where (try? packet.fields.value("operation", as: String.self)) == "ready":
                guard (try? packet.fields.value("session_id", as: String.self)) == readyBinding?.sessionID,
                      readyError == nil else { return }
                guard !centralReady else { return }
                readyPacket = packet
                centralReady = true
                releaseCentralReady()
                return
            case .encryptionActive:
                pendingEncryptionActive = true
                releaseCentralReady()
                return
            case .reconnecting, .resuming:
                freezeCallRecoveryBudget()
                let retained = event == .resuming && centralReady
                let retainedPacket = retained ? readyPacket : nil
                resetCentralReady(error: CentralTextError.contextChanged(), preservingCallWaiters: true)
                connected = false
                centralReady = retained; readyPacket = retainedPacket; readyError = nil
                beginCentralReadyDeadline()
            case .reconnected:
                connected = true
                // Recovery must precede the readiness that it releases.
                relay.receive(event)
                releaseCentralReady()
                return
            case .disconnected:
                freezeCallRecoveryBudget()
                resetCentralReady(error: LiveKitSessionError.notConnected)
                connected = false
            default: break
            }
        }
        relay.receive(event)
    }

    private func freezeCallRecoveryBudget() {
        guard callActive, frozenRejoinDeadline == nil, let window = readyBinding?.callRejoinWindowS else { return }
        let deadline = Date().addingTimeInterval(TimeInterval(window))
        frozenRejoinDeadline = deadline
        eventHandler?(.callRejoinBudget(deadline))
    }

    func setCallPlaybackID(_ id: String?) async {
        guard let attemptID = activeAttemptID else { return }
        await roomOperator.setCallPlaybackID(id, attemptID: attemptID)
    }

    func setCallRejoinDeadline(_ announced: Date?, callActive: Bool) {
        self.callActive = callActive
        frozenRejoinDeadline = announced
        if !connected || !centralReady { beginCentralReadyDeadline() }
    }

    private func beginCentralReadyDeadline(deadline: ContinuousClock.Instant = ContinuousClock.now.advanced(by: .seconds(60))) {
        guard readyBinding != nil else { return }
        readyDeadline?.cancel()
        let generation = readyGeneration
        let recoveryDeadline = callRecoveryDeadline
        let effective = recoveryDeadline.map { min(deadline, ContinuousClock.now.advanced(by: .seconds(max(0, $0.timeIntervalSinceNow)))) } ?? deadline
        readyDeadline = Task { [weak self] in
            do { try await ContinuousClock().sleep(until: effective) } catch { return }
            await self?.expireCentralReady(generation: generation, recoveryDeadline: recoveryDeadline)
        }
    }

    private func expireCentralReady(generation: UInt64, recoveryDeadline: Date?) async {
        guard readyGeneration == generation, callRecoveryDeadline == recoveryDeadline, !(connected && centralReady && encryptionReleased) else { return }
        readyDeadline = nil
        if !callActive {
            // The accepted control connection has no call lease. Its readiness timeout is a connection loss,
            // even when no send is waiting and the SDK never reports a disconnect. The coordinator owns recovery.
            roomGeneration &+= 1
            connected = false
            resetCentralReady(error: LiveKitError(.timedOut))
            eventHandler?(.disconnected(errorCode: "reconnect_timeout"))
            return
        }
        let callExpired = recoveryDeadline.map { $0 <= Date() } ?? false
        if callExpired { readyError = AssistantCallRecoveryError.expired; connected = false }
        let expired = readyWaiters.filter { callExpired || $0.value.bounded }
        for (id, waiter) in expired {
            readyWaiters.removeValue(forKey: id)
            waiter.continuation.resume(throwing: callExpired ? AssistantCallRecoveryError.expired : LiveKitError(.timedOut))
        }
        if callExpired, let attemptID = activeAttemptID { await roomOperator.stop(attemptID: attemptID) }
        else if let recoveryDeadline {
            beginCentralReadyDeadline(deadline: ContinuousClock.now.advanced(by: .seconds(max(0, recoveryDeadline.timeIntervalSinceNow))))
        }
        // Bound individual operations. The SDK still owns recovery and can deliver readiness later.
    }

    private func releaseCentralReady() {
        guard connected, centralReady, readyError == nil else { return }
        if pendingEncryptionActive {
            pendingEncryptionActive = false
            encryptionReleased = true
            eventHandler?(.encryptionActive)
        }
        guard encryptionReleased else { return }
        readyDeadline?.cancel(); readyDeadline = nil
        frozenRejoinDeadline = nil
        let waiters = readyWaiters; readyWaiters.removeAll()
        waiters.values.forEach { $0.continuation.resume() }
        if !readyForwarded, let readyPacket {
            readyForwarded = true
            eventHandler?(.centralText(readyPacket))
        }
    }

    private func resetCentralReady(error: Error, preservingCallWaiters: Bool = false) {
        readyDeadline?.cancel(); readyDeadline = nil
        readyGeneration &+= 1
        centralReady = false; readyError = error; pendingEncryptionActive = false
        readyPacket = nil; readyForwarded = false; encryptionReleased = false
        let waiters = readyWaiters.filter { !preservingCallWaiters || $0.value.bounded }
        for (id, waiter) in waiters {
            readyWaiters.removeValue(forKey: id)
            waiter.continuation.resume(throwing: error)
        }
    }

    private func waitForCentralReady(attemptID: UInt64, bounded: Bool = true) async throws {
        guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
        if let readyError { throw readyError }
        if connected && centralReady && encryptionReleased { return }
        if bounded, readyDeadline == nil { beginCentralReadyDeadline() }
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { readyWaiters[id] = ($0, bounded) }
        } onCancel: {
            Task { await self.cancelCentralReadyWait(id) }
        }
    }

    private func cancelCentralReadyWait(_ id: UUID) {
        readyWaiters.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
    }

    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool = false
    ) async throws {
        guard connected, let attemptID = activeAttemptID else {
            throw LiveKitSessionError.notConnected
        }
        guard userInitiated else {
            throw LiveKitSessionError.mediaWasNotUserInitiated
        }
        let roomID = roomGeneration
        try await roomOperator.setMedia(
            source: source,
            enabled: enabled,
            userInitiated: userInitiated,
            keepPublished: keepPublished,
            attemptID: attemptID
        )
        guard activeAttemptID == attemptID, roomGeneration == roomID, connected else { throw LiveKitSessionError.superseded }
    }

    func publish(_ event: AssistantRealtimeDataEvent) async throws {
        guard let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        let generation = readyGeneration
        if readyBinding != nil { try await waitForCentralReady(attemptID: attemptID) }
        try Task.checkCancellation()
        guard connected, activeAttemptID == attemptID, readyGeneration == generation else {
            throw LiveKitSessionError.notConnected
        }
        let binding = try await roomOperator.currentDataBinding(attemptID: attemptID)
        let data = try event.encoded(for: binding)
        try Task.checkCancellation()
        guard connected, activeAttemptID == attemptID, readyGeneration == generation else {
            throw CentralTextError.contextChanged()
        }
        try await roomOperator.publishData(data, binding: binding, attemptID: attemptID)
    }

    func publishPrompt(_ prompt: AssistantPromptEnvelope) async throws {
        guard connected, let attemptID = activeAttemptID else {
            throw LiveKitSessionError.notConnected
        }
        let data = try prompt.encodedStrict()
        try await roomOperator.publishTextData(data, binding: nil, attemptID: attemptID)
    }

    func observeCentralVoice(eventIDs: Set<String>) async throws {
        guard connected, let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        try await roomOperator.observeCentralVoice(eventIDs: eventIDs, attemptID: attemptID)
    }
    func prepareCentralVoice(eventID: String?) async throws {
        guard connected, let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        try await roomOperator.prepareCentralVoice(eventID: eventID, attemptID: attemptID)
    }
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding) async throws {
        guard connected, let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        try await roomOperator.playCentralVoice(playback, binding: binding, attemptID: attemptID)
    }
    func publishCentralTextData(_ data: Data, binding: CentralTransportBinding) async throws {
        guard let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        guard readyBinding == binding else { throw CentralTextError.contextChanged() }
        let generation = readyGeneration
        try await waitForCentralReady(attemptID: attemptID)
        try Task.checkCancellation()
        guard connected, activeAttemptID == attemptID, readyGeneration == generation,
              readyBinding == binding else { throw CentralTextError.contextChanged() }
        try await roomOperator.publishTextData(data, binding: binding, attemptID: attemptID)
    }
    func setCaptureMuted(_ muted: Bool) async throws {
        guard connected, let attemptID = activeAttemptID else { throw LiveKitSessionError.notConnected }
        try await roomOperator.setCaptureMuted(muted, attemptID: attemptID)
    }

    func stop() async {
        let attemptID = activeAttemptID
        roomEventIngress?.close(); roomEventIngress = nil
        roomEventTask?.cancel(); roomEventTask = nil
        resetCentralReady(error: LiveKitSessionError.superseded)
        readyBinding = nil; eventHandler = nil; frozenRejoinDeadline = nil; callActive = false
        connected = false
        activeAttemptID = nil
        guard let attemptID else {
            return
        }
        await roomOperator.stop(attemptID: attemptID)
    }
}

protocol LiveKitEncryptionOptionsProviding: Sendable {
    // Implementations unwrap key material outside this adapter and return only
    // an SDK provider. They must never log or persist plaintext key bytes.
    func makeEncryptionOptions(
        for request: AssistantRealtimeConnectRequest
    ) async throws -> EncryptionOptions
}

struct UnavailableLiveKitEncryptionOptionsProvider:
    LiveKitEncryptionOptionsProviding {
    func makeEncryptionOptions(
        for request: AssistantRealtimeConnectRequest
    ) async throws -> EncryptionOptions {
        _ = request
        throw LiveKitSessionError.e2eeUnavailable
    }

    func makeEncryptionOptions() async throws -> EncryptionOptions {
        throw LiveKitSessionError.e2eeUnavailable
    }
}

final class ProductionLiveKitEncryptionOptionsProvider:
    LiveKitEncryptionOptionsProviding,
    @unchecked Sendable {
    private let control: ProductionRealtimePublicControlProvider

    init(control: ProductionRealtimePublicControlProvider) {
        self.control = control
    }

    func makeEncryptionOptions(
        for request: AssistantRealtimeConnectRequest
    ) async throws -> EncryptionOptions {
        guard request.intent.userInitiated else {
            throw LiveKitSessionError.e2eeUnavailable
        }
        let binding = await control.localBindingSnapshot()
        guard let binding else {
            throw LiveKitSessionError.e2eeUnavailable
        }
        let context = RealtimeCanonicalRequestContext(
            operation: .e2eeKeyResolve,
            localBinding: request.intent.operationID.rawValue,
            retainedBootstrapBinding: binding
        )
        var key = try await control.resolveE2EEContentKey(
            context: context
        )
        defer { key.resetBytes(in: 0..<key.count) }
        let keyProvider = BaseKeyProvider(isSharedKey: true)
        keyProvider.setKey(keyData: key)
        return EncryptionOptions(
            keyProvider: keyProvider,
            encryptionType: .gcm
        )
    }

    func makeEncryptionOptions() async throws -> EncryptionOptions {
        throw LiveKitSessionError.e2eeUnavailable
    }
}

typealias AssistantByteStreamContext = (current: @Sendable () -> Bool, progress: @Sendable () -> Void)

final class SystemLiveKitRoomOperator: NSObject, LiveKitRoomOperating,
    RoomDelegate, AVAudioPlayerDelegate, @unchecked Sendable {
    private let encryptionProvider: any LiveKitEncryptionOptionsProviding
    private let reconnectedDataEncryptionVerifier: @Sendable (Room) -> Bool
    private let lock = NSLock()
    private var room: Room?
    private var byteEpoch: UInt64 = 0
    private var byteStreams: (topics: [String], reset: @Sendable () -> Void, receive: @Sendable (String, ByteStreamReader, AssistantByteStreamContext) async throws -> Void)?
    private var eventHandler:
        (@Sendable (AssistantRealtimeEvent) -> Void)?
    private let videoTrackObserver: AssistantVideoTrackObserver?
    private let cameraActivation: @Sendable (LocalParticipant, LocalVideoTrack, Bool) async throws -> Void
    private var localVideoTrack: VideoTrack?
    private var remoteVideoTrack: VideoTrack?
    private var remoteVideoPublicationSID: String?
    private var remoteVideoParticipantIdentity: String?
    private var bootstrapCapabilities = AssistantMediaCapabilities.none
    private var bootstrapRoomName: String?
    private var centralBinding: CentralTransportBinding?
    private var callPlaybackRetirement = CallPlaybackRetirement()
    private var playingCallTracks = Set<String>()
    private var playbackStatusCallID: String?
    private var playbackObservers: [String: (RemoteAudioTrack, AssistantCallPlaybackObserver)] = [:]
    private var nextAttemptID: UInt64 = 0
    private var activeAttemptID: UInt64?
    private var voiceGeneration: UInt64 = 0
    private var voiceEventIDs: Set<String> = []
    private var voiceReaders: [UUID: Task<Void, Never>] = [:]
    private var voiceReader: Task<Void, Never>?
    private var voiceReadID: UUID?
    private var voicePlayback: CentralVoicePlayback?
    private var voicePlayer: AVAudioPlayer?
    private var voiceSession: SessionRequirementHandle?

    init(
        encryptionProvider: any LiveKitEncryptionOptionsProviding,
        videoTrackObserver: AssistantVideoTrackObserver? = nil,
        cameraActivation: @escaping @Sendable (LocalParticipant, LocalVideoTrack, Bool) async throws -> Void = { participant, track, reusing in
            if reusing { _ = try await participant.setCamera(enabled: true) }
            else { _ = try await participant.publish(videoTrack: track) }
        },
        reconnectedDataEncryptionVerifier: @escaping @Sendable (Room) -> Bool = {
            $0.connectionState == .connected
                && SystemLiveKitRoomOperator.isDataChannelEncryptionActive($0.e2eeManager)
        }
    ) {
        self.reconnectedDataEncryptionVerifier = reconnectedDataEncryptionVerifier
        self.encryptionProvider = encryptionProvider
        self.videoTrackObserver = videoTrackObserver
        self.cameraActivation = cameraActivation
    }

    func connect(
        _ request: AssistantRealtimeConnectRequest,
        attemptID: UInt64,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws {
        try beginAttempt(
            attemptID: attemptID,
            events: events,
            capabilities: request.details.capabilities,
            roomName: request.details.roomName,
            centralBinding: request.centralBinding
        )

        let encryptionOptions: EncryptionOptions
        do {
            encryptionOptions = try await
                encryptionProvider.makeEncryptionOptions(for: request)
        } catch {
            guard isCurrentAttempt(attemptID) else {
                throw LiveKitSessionError.superseded
            }
            emit(.encryptionFailed, attemptID: attemptID)
            await stopIfCurrentAttempt(attemptID)
            throw LiveKitSessionError.e2eeUnavailable
        }

        guard isCurrentAttempt(attemptID) else {
            throw LiveKitSessionError.superseded
        }
        emit(.encryptionPreparing, attemptID: attemptID)

        let autoSubscribe = request.autoSubscribe
        let connectOptions = ConnectOptions(
            autoSubscribe: autoSubscribe,
            socketConnectTimeoutInterval: 20,
            primaryTransportConnectTimeout: 20,
            publisherTransportConnectTimeout: 20,
            enableMicrophone: false
        )
        let roomOptions = RoomOptions(
            stopLocalTrackOnUnpublish: true,
            suspendLocalVideoTracksInBackground: true,
            encryptionOptions: encryptionOptions
        )
        let newRoom = Room(
            delegate: self,
            connectOptions: connectOptions,
            roomOptions: roomOptions
        )

        guard attachRoom(newRoom, attemptID: attemptID) else {
            throw LiveKitSessionError.superseded
        }

        do {
            // Register stream handlers before connecting so the first result
            // cannot race handler installation.
            try await newRoom.registerTextStreamHandler(
                for: AssistantResultEnvelope.topic
            ) { [weak self, weak newRoom] reader, participantIdentity in
                let text = try await reader.readAll()
                guard
                    let data = text.data(using: .utf8),
                    let room = newRoom,
                    !participantIdentity.stringValue.isEmpty
                else {
                    return
                }
                self?.emitResult(
                    data: data,
                    encryptionType: reader.info.encryptionType,
                    from: room,
                    senderIdentity: participantIdentity.stringValue
                )
            }

            if request.centralBinding != nil {
                try await newRoom.registerTextStreamHandler(for: AssistantCentralTextWire.outputTopic) { [weak self, weak newRoom] reader, sender in
                    guard let self, let room = newRoom,
                          let binding = self.lock.withLock({ self.centralBinding }),
                          sender.stringValue == binding.expectedGatewayIdentity,
                          reader.info.encryptionType != .none,
                          self.isCurrentConnectedEncryptedDataRoom(room) else { return }
                    // Node sendText omits totalLength; bound its actual UTF-8 chunks before retaining them.
                    var data = Data()
                    for try await chunk in reader {
                        guard chunk.utf8.count <= binding.maxPacketBytes - data.count else { return }
                        data.append(contentsOf: chunk.utf8)
                    }
                    guard let packet = Self.centralPacket(data, binding: binding, sender: sender.stringValue, requiredOperation: "ready",
                            encrypted: reader.info.encryptionType != .none,
                            current: self.isCurrentConnectedEncryptedDataRoom(room)) else { return }
                    _ = self.emit(.centralText(packet), from: room)
                }
            }

            if request.centralBinding?.voiceTransport == AssistantCentralTextWire.voiceTransport {
                try await newRoom.registerByteStreamHandler(for: AssistantCentralTextWire.voiceTopic) { [weak self, weak newRoom] reader, sender in
                    guard let self, let room = newRoom else { return }
                    await self.receiveCentralVoice(reader, sender: sender.stringValue, from: room)
                }
            }
            if request.centralBinding != nil { try await registerCentralByteStreams(in: newRoom, attemptID: attemptID) }
            try await newRoom.connect(
                url: request.details.serverURL.absoluteString,
                token: request.details.participantToken
            )
            guard isCurrentAttempt(attemptID) else {
                await stopRoom(newRoom)
                throw LiveKitSessionError.superseded
            }
            guard Self.isDataChannelEncryptionActive(newRoom.e2eeManager) else {
                emit(.encryptionFailed, from: newRoom)
                await stopIfCurrentAttempt(attemptID)
                throw LiveKitSessionError.e2eeUnavailable
            }
            emit(.encryptionActive, from: newRoom)
            guard isCurrentAttempt(attemptID) else {
                await stopRoom(newRoom)
                throw LiveKitSessionError.superseded
            }
        } catch {
            if isCurrentAttempt(attemptID) {
                await stopIfCurrentAttempt(attemptID)
            } else {
                await stopRoom(newRoom)
            }
            throw error
        }
    }

    func registerCentralByteStreams(in newRoom: Room, attemptID: UInt64) async throws {
        guard let streams = lock.withLock({ byteStreams }) else { return }
        for topic in streams.topics {
            try await newRoom.registerByteStreamHandler(for: topic) { [weak self, weak newRoom] reader, sender in
                do {
                    guard let self, let room = newRoom else { throw CancellationError() }
                    let epoch = self.lock.withLock { self.byteEpoch }
                    guard Self.acceptsCentralSender(binding: self.lock.withLock({ self.centralBinding }), sender: sender.stringValue,
                        encrypted: reader.info.encryptionType != .none, current: self.isCurrentConnectedEncryptedDataRoom(room)) else { throw CentralTextError.unavailable }
                    try await self.withCentralByteDeadline(attempt: attemptID, epoch: epoch, seconds: topic == "paios.desktop.mcp.v1" ? 30 : 180) { progress in
                        try await streams.receive(topic, reader, (current: { [weak self, weak room] in
                            guard let self, let room else { return false }
                            return self.lock.withLock({ self.byteEpoch == epoch }) && self.isCurrentConnectedEncryptedDataRoom(room)
                        }, progress: progress))
                    }
                } catch {
                    withUnsafeCurrentTask { $0?.cancel() }
                    var iterator = reader.makeAsyncIterator()
                    _ = try? await iterator.next()
                    throw error
                }
            }
        }
    }

    // The session remains the only sender/E2EE authority for extension byte streams.
    var pairedDeviceID: String? { lock.withLock { activeAttemptID == nil ? nil : centralBinding?.deviceID } }
    func configureByteStreams(topics: [String], reset: @escaping @Sendable () -> Void = {}, receive: @escaping @Sendable (String, ByteStreamReader, AssistantByteStreamContext) async throws -> Void) {
        lock.withLock { byteEpoch &+= 1; byteStreams = (topics, reset, receive) }
    }

    func captureRequestedFrame(frameID: String, camera: String) async throws {
        let track = try lock.withLock { () throws -> LocalVideoTrack in
            guard let track = localVideoTrack as? LocalVideoTrack else { throw CentralTextError.unavailable }
            return track
        }
        guard let capturer = track.capturer as? CameraCapturer else { throw CentralTextError.unavailable }
        let position: AVCaptureDevice.Position = camera == "back" ? .back : .front
        if capturer.position != position { try await capturer.set(cameraPosition: position) }
        let jpeg = try await AssistantCameraJPEG.capture(track, position: position)
        let metadata: [String: Any] = ["frame_id": frameID, "captured_at": ISO8601.utc.string(from: Date()),
                                       "trigger": "user_request", "worn": false, "private_paused": false]
        let frame = String(decoding: try JSONSerialization.data(withJSONObject: metadata), as: UTF8.self)
        var offset = 0
        try await sendCentralBytes(topic: "paios.assistant.camera.v1", mime: "image/jpeg", attributes: ["frame": frame], size: jpeg.count) {
            guard offset < jpeg.count else { return nil }
            let end = min(offset + 32_768, jpeg.count)
            defer { offset = end }
            return jpeg.subdata(in: offset..<end)
        }
    }

    private func withCentralByteDeadline(attempt: UInt64, epoch: UInt64, seconds: TimeInterval, _ operation: (@escaping @Sendable () -> Void) async throws -> Void) async throws {
        guard lock.withLock({ activeAttemptID == attempt && byteEpoch == epoch }) else { throw LiveKitSessionError.superseded }
        let timer = DispatchSource.makeTimerSource(), deadline = DispatchTime.now() + seconds
        timer.schedule(deadline: .now() + 10)
        timer.setEventHandler { [weak self] in Task { await self?.stopIfCurrentAttempt(attempt, expectedByteEpoch: epoch) } }
        timer.resume(); defer { timer.cancel() }
        do {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                try await operation { timer.schedule(deadline: min(deadline, .now() + 10)) }
                try Task.checkCancellation()
            } onCancel: { Task { await self.stopIfCurrentAttempt(attempt, expectedByteEpoch: epoch) } }
        } catch where !(error is CancellationError) { await stopIfCurrentAttempt(attempt, expectedByteEpoch: epoch); throw error }
    }
    func sendCentralBytes(topic: String, mime: String, attributes: [String: String], size: Int,
                          next: @escaping () throws -> Data?) async throws {
        let (attempt, epoch) = lock.withLock { (activeAttemptID, byteEpoch) }
        guard let attempt else { throw LiveKitSessionError.notConnected }
        let snapshot = try validatedDataRoom(expectedBinding: nil, attemptID: attempt)
        guard let binding = snapshot.binding.centralBinding else { throw CentralTextError.unavailable }
        let upload: (@escaping @Sendable () -> Void) async throws -> Void = { progress in
            try Task.checkCancellation()
            let writer = try await snapshot.room.localParticipant.streamBytes(options: StreamByteOptions(topic: topic,
                attributes: attributes, destinationIdentities: [.init(from: binding.expectedGatewayIdentity)], mimeType: mime, totalSize: size))
            do {
                while true {
                    let chunk = try next()
                    try Task.checkCancellation()
                    guard self.lock.withLock({ self.byteEpoch == epoch }) else { throw LiveKitSessionError.superseded }
                    _ = try self.validatedDataRoom(expectedBinding: snapshot.binding, attemptID: attempt)
                    guard let chunk, !chunk.isEmpty else { break }
                    try await writer.write(chunk); progress()
                }
                try await writer.close()
                guard !(await writer.isOpen) else { throw CentralTextError.unavailable }
            } catch {
                if topic == "paios.assistant.camera.v1" { try await writer.close(reason: "camera_capture_stopped") }
                throw error
            }
        }
        if topic == "paios.assistant.camera.v1" {
            // The camera request owns its deadline. Ending its photo stream must keep the call room alive.
            try await upload({})
        } else {
            try await withCentralByteDeadline(attempt: attempt, epoch: epoch,
                seconds: topic == "paios.desktop.mcp.v1" ? 30 : 180, upload)
        }
    }

    func currentDataBinding(attemptID: UInt64) async throws -> AssistantLiveKitDataBinding {
        try validatedDataRoom(expectedBinding: nil, attemptID: attemptID).binding
    }

    // A muted publication keeps its track (and the platform voice processing on it); unmuting resumes the same capture.
    func setCaptureMuted(_ muted: Bool, attemptID: UInt64) async throws {
        let currentRoom = try lock.withLock {
            guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
            guard let room else { throw LiveKitSessionError.notConnected }
            return room
        }
        guard let publication = currentRoom.localParticipant.localAudioTracks.first else { throw CentralTextError.unavailable }
        if muted { try await publication.mute() } else { try await publication.unmute() }
    }

    func publishData(
        _ data: Data,
        binding: AssistantLiveKitDataBinding,
        attemptID: UInt64
    ) async throws {
        guard !data.isEmpty, data.count <= min(15_000, binding.centralBinding?.maxPacketBytes ?? 15_000) else {
            throw LiveKitSessionError.invalidDataEvent
        }
        let snapshot = try validatedDataRoom(expectedBinding: binding, attemptID: attemptID)
        // Formal observations target the current gateway; legacy events retain room broadcast.
        try await snapshot.room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(
                destinationIdentities: binding.centralBinding.map { [Participant.Identity(from: $0.expectedGatewayIdentity)] } ?? [],
                topic: AssistantRealtimeDataEvent.topic,
                reliable: true
            )
        )
    }

    func publishTextData(_ data: Data, binding: CentralTransportBinding?, attemptID: UInt64) async throws {
        let budget = binding.map { min(8_192, $0.maxPacketBytes) } ?? AssistantPromptEnvelope.maxWireBytes
        guard !data.isEmpty, data.count <= budget,
              lock.withLock({ centralBinding == binding }) else { throw CentralTextError.contextChanged() }
        let current = try validatedPromptRoom(attemptID: attemptID)
        let destinations = binding.map { [Participant.Identity(from: $0.expectedGatewayIdentity)] } ?? []
        try await current.localParticipant.publish(data: data, options: DataPublishOptions(
            destinationIdentities: destinations,
            topic: binding == nil ? AssistantPromptEnvelope.topic : AssistantCentralTextWire.inputTopic,
            reliable: true))
    }

    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool = false,
        attemptID: UInt64
    ) async throws {
        guard userInitiated else {
            throw LiveKitSessionError.mediaWasNotUserInitiated
        }

        lock.lock()
        guard activeAttemptID == attemptID else { lock.unlock(); throw LiveKitSessionError.superseded }
        let currentRoom = room
        let bootstrapAllows = bootstrapCapabilities.allows(source)
        lock.unlock()

        guard let currentRoom else {
            throw LiveKitSessionError.notConnected
        }
        guard !enabled || bootstrapAllows else {
            throw LiveKitSessionError.mediaNotGranted(source)
        }
        if enabled {
            try Self.requireRuntimeGrant(
                source,
                permissions: currentRoom.localParticipant.permissions
            )
        }

        switch source {
        case .camera:
            if enabled {
                let publication = currentRoom.localParticipant.firstCameraPublication
                let track: LocalVideoTrack
                if let publication {
                    guard let existing = publication.track as? LocalVideoTrack else { throw LiveKitError(.invalidState) }
                    track = existing
                } else { track = await LocalVideoTrack.createCameraTrack() }
                guard isCurrentAttempt(attemptID) else { throw LiveKitSessionError.superseded }
                // SDK publish/unmute starts this same capture. Render its frames without waiting for server ACK.
                updateLocalVideoTrack(track, from: currentRoom)
                do {
                    try await cameraActivation(currentRoom.localParticipant, track, publication != nil)
                    guard isCurrentAttempt(attemptID) else { throw LiveKitSessionError.superseded }
                } catch {
                    updateLocalVideoTrack(nil, from: currentRoom)
                    try await track.stop()
                    throw error
                }
            } else {
                _ = try await currentRoom.localParticipant.setCamera(enabled: false)
                updateLocalVideoTrack(nil, from: currentRoom)
            }
        case .microphone:
            // The SDK's own off only mutes a microphone: the track stays published and the audio device keeps
            // recording. Unpublishing is what stops the capture (and the gateway's subscription).
            if enabled || keepPublished {
                try await currentRoom.localParticipant.setMicrophone(enabled: enabled)
            } else if let publication = currentRoom.localParticipant.localAudioTracks.first(where: { $0.source == .microphone }) {
                try await currentRoom.localParticipant.unpublish(publication: publication)
            }
        }
    }

    private func receiveCentralVoice(_ reader: ByteStreamReader, sender: String, from room: Room) async {
        var failurePacket: CentralTextPacket?
        do {
        guard let binding = lock.withLock({ centralBinding }), reader.info.attributes.count == 1,
              let encoded = reader.info.attributes["out"], let data = encoded.data(using: .utf8),
              let packet = Self.centralPacket(data, binding: binding, sender: sender,
                encrypted: reader.info.encryptionType != .none, current: isCurrentConnectedEncryptedDataRoom(room)),
              (try packet.fields.value("operation", as: String.self)) == "voice_chunk",
              let chunk = (try packet.fields.value("chunk", as: CentralBody.self)), let audio = (try chunk.value("audio", as: CentralBody.self)),
              reader.info.totalLength == (try audio.value("bytes", as: Int.self)), reader.info.mimeType == (try audio.value("mime", as: String.self)) else { return }
        failurePacket = packet
        guard let sourceEventID = try packet.fields.value("event_id", as: String.self) else { return }
        let id = UUID()
        lock.lock()
        guard voiceReaders.count < 1024, self.room === room,
              voiceEventIDs.contains(sourceEventID) else { lock.unlock(); return }
        let generation = voiceGeneration, previous = voiceReader
        let task = Task { [weak self] in
            await previous?.value
            do {
                try Task.checkCancellation()
                let resource = try await CentralVoiceFile.receive(reader, audio: audio)
                guard let self else { resource.remove(); return }
                do { try resource.validate(chunk: chunk) } catch { resource.remove(); throw error }
                let playback = CentralVoicePlayback(packet: packet, resource: resource)
                let admitted = self.lock.withLock { () -> Bool in
                    guard self.voiceGeneration == generation && self.room === room && self.voiceEventIDs.contains(sourceEventID) else { return false }
                    return true
                }
                guard admitted else { resource.remove(); return }
                if !self.emit(.centralVoice(playback), from: room) { resource.remove() }
            } catch {
                guard let self, self.lock.withLock({ self.voiceGeneration == generation && self.room === room }) else { return }
                self.emit(.centralVoiceFailed(packet), from: room)
            }
        }
        voiceReadID = id; voiceReader = task; voiceReaders[id] = task
        lock.unlock()
        await task.value
        lock.withLock {
            voiceReaders.removeValue(forKey: id)
            if voiceReadID == id { voiceReader = nil; voiceReadID = nil }
        }
        } catch {
            if let packet = failurePacket { emit(.centralVoiceFailed(packet), from: room) }
        }
    }
    private func invalidateCentralVoice(attemptID: UInt64) throws -> (UInt64, UUID?, Task<Void, Never>?) {
        lock.lock()
        guard activeAttemptID == attemptID else { lock.unlock(); throw LiveKitSessionError.superseded }
        voiceGeneration &+= 1; voiceEventIDs = []
        let generation = voiceGeneration, id = voiceReadID, reader = voiceReader
        let readers = Array(voiceReaders.values)
        let player = voicePlayer, session = voiceSession, playback = voicePlayback
        voicePlayer = nil; voiceSession = nil; voicePlayback = nil
        lock.unlock()
        readers.forEach { $0.cancel() }; player?.stop()
        try? session?.release(); playback?.resource.remove()
        return (generation, id, reader)
    }
    func observeCentralVoice(eventIDs: Set<String>, attemptID: UInt64) async throws {
        try lock.withLock {
            guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
            voiceEventIDs.formUnion(eventIDs)
        }
    }
    func prepareCentralVoice(eventID: String?, attemptID: UInt64) async throws {
        let (generation, id, reader) = try invalidateCentralVoice(attemptID: attemptID)
        await reader?.value
        try lock.withLock {
            guard activeAttemptID == attemptID, voiceGeneration == generation else { throw CentralTextError.contextChanged() }
            if voiceReadID == id { voiceReader = nil; voiceReadID = nil }
            if eventID != nil {
                guard room != nil,
                      centralBinding?.voiceTransport == AssistantCentralTextWire.voiceTransport else { throw CentralTextError.unavailable }
            }
            voiceEventIDs = Set(eventID.map { [$0] } ?? [])
        }
    }
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding, attemptID: UInt64) async throws {
        _ = try validatedPromptRoom(attemptID: attemptID)
        try lock.withLock {
            guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
            guard centralBinding == binding,
                  voiceEventIDs.contains((try playback.packet.fields.value("event_id", as: String.self)) ?? ""),
                  voicePlayer == nil else { throw CentralTextError.contextChanged() }
            let session = try AudioManager.shared.acquireSessionRequirement(.playbackOnly)
            do {
                let player = try AVAudioPlayer(contentsOf: playback.resource.file)
                #if os(macOS)
                let output = AudioManager.shared.outputDevice
                player.currentDevice = output.isDefault ? nil : output.deviceId
                #endif
                voicePlayback = playback; voiceSession = session; voicePlayer = player; player.delegate = self
                guard player.play() else { throw CentralTextError.unavailable }
            } catch {
                voicePlayback = nil; voicePlayer = nil; voiceSession = nil; try? session.release(); throw error
            }
        }
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        lock.lock()
        guard voicePlayer === player, let playback = voicePlayback, let room else { lock.unlock(); return }
        let session = voiceSession
        voicePlayer = nil; voiceSession = nil; voicePlayback = nil
        lock.unlock()
        try? session?.release(); playback.resource.remove()
        emit(.centralVoiceFinished(playback, flag), from: room)
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        audioPlayerDidFinishPlaying(player, successfully: false)
    }

    func stop(attemptID: UInt64) async {
        await stopIfCurrentAttempt(attemptID)
    }

    @discardableResult
    func beginAttempt(
        attemptID: UInt64,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void,
        capabilities: AssistantMediaCapabilities,
        roomName: String,
        centralBinding: CentralTransportBinding? = nil
    ) throws -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        guard attemptID >= nextAttemptID else { throw LiveKitSessionError.superseded }
        nextAttemptID = attemptID
        activeAttemptID = attemptID
        eventHandler = events
        bootstrapCapabilities = capabilities
        bootstrapRoomName = roomName
        self.centralBinding = centralBinding
        callPlaybackRetirement = CallPlaybackRetirement()
        return nextAttemptID
    }

    // Shared connection lifecycle seam: adopted rooms must belong to the
    // active attempt. Delegate events can never adopt a stale room.
    func attachRoom(_ newRoom: Room, attemptID: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard activeAttemptID == attemptID else { return false }
        room = newRoom
        return true
    }

    private func validatedDataRoom(
        expectedBinding: AssistantLiveKitDataBinding?,
        attemptID: UInt64
    ) throws -> (room: Room, binding: AssistantLiveKitDataBinding) {
        lock.lock()
        guard activeAttemptID == attemptID else { lock.unlock(); throw LiveKitSessionError.superseded }
        let currentRoom = room
        let expectedRoomName = bootstrapRoomName
        let central = centralBinding
        let bootstrapCanPublishData =
            bootstrapCapabilities.canPublishData
        lock.unlock()

        guard let currentRoom, let expectedRoomName else {
            throw LiveKitSessionError.notConnected
        }
        if central != nil && !Self.isDataChannelEncryptionActive(currentRoom.e2eeManager) { throw LiveKitSessionError.e2eeUnavailable }
        let participant = currentRoom.localParticipant
        let binding = try AssistantLiveKitDataBinding(
            joinedRoomName: currentRoom.name,
            expectedRoomName: expectedRoomName,
            roomSID: currentRoom.sid?.stringValue,
            participantIdentity: participant.identity?.stringValue,
            participantAttributes: participant.attributes,
            bootstrapCanPublishData: bootstrapCanPublishData,
            runtimeCanPublishData:
                participant.permissions.canPublishData,
            roomIsConnected: currentRoom.connectionState == .connected,
            centralBinding: central
        )
        if let expectedBinding, expectedBinding != binding {
            throw LiveKitSessionError.invalidPublisherBinding
        }
        return (currentRoom, binding)
    }

    private func validatedPromptRoom(attemptID: UInt64) throws -> Room {
        lock.lock()
        guard activeAttemptID == attemptID else { lock.unlock(); throw LiveKitSessionError.superseded }
        let currentRoom = room
        let bootstrapCanPublishData =
            bootstrapCapabilities.canPublishData
        lock.unlock()

        guard let currentRoom,
              currentRoom.connectionState == .connected
        else {
            throw LiveKitSessionError.notConnected
        }
        guard bootstrapCanPublishData,
              currentRoom.localParticipant.permissions.canPublishData
        else {
            throw LiveKitSessionError.dataNotGranted
        }
        guard Self.isDataChannelEncryptionActive(currentRoom.e2eeManager)
        else {
            throw LiveKitSessionError.e2eeUnavailable
        }
        return currentRoom
    }

    private func isCurrentAttempt(_ attemptID: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeAttemptID == attemptID
    }

    private struct DetachedRoom {
        let room: Room
        let reader: Task<Void, Never>?
        let events: (@Sendable (AssistantRealtimeEvent) -> Void)?
    }

    private func detachCurrentRoom(
        expectedAttemptID: UInt64? = nil,
        expectedRoom: Room? = nil,
        expectedByteEpoch: UInt64? = nil
    ) -> DetachedRoom? {
        lock.lock()
        if let expectedByteEpoch, byteEpoch != expectedByteEpoch {
            lock.unlock(); return nil
        }
        if let expectedAttemptID, activeAttemptID != expectedAttemptID {
            lock.unlock()
            return nil
        }
        let currentRoom = room
        if let expectedRoom, currentRoom !== expectedRoom {
            lock.unlock()
            return nil
        }
        voiceGeneration &+= 1; voiceEventIDs = []
        let stoppedReader = voiceReader
        voiceReaders.values.forEach { $0.cancel() }
        voiceReaders = [:]; voiceReader = nil; voiceReadID = nil
        let stoppedPlayer = voicePlayer, stoppedSession = voiceSession, stoppedPlayback = voicePlayback
        voicePlayer = nil; voiceSession = nil; voicePlayback = nil
        let stoppedObservers = Array(playbackObservers.values)
        playbackObservers.removeAll(); playingCallTracks.removeAll(); playbackStatusCallID = nil
        let observer = videoTrackObserver, events = eventHandler
        byteEpoch &+= 1
        room = nil
        eventHandler = nil
        bootstrapCapabilities = .none
        bootstrapRoomName = nil
        activeAttemptID = nil
        localVideoTrack = nil
        remoteVideoTrack = nil
        remoteVideoPublicationSID = nil
        remoteVideoParticipantIdentity = nil
        lock.unlock()

        for (track, renderer) in stoppedObservers { track.remove(audioRenderer: renderer); renderer.stop() }
        stoppedPlayer?.stop(); try? stoppedSession?.release(); stoppedPlayback?.resource.remove()
        notifyVideoTracks(
            observer: observer,
            localVideoTrack: nil,
            remoteVideoTrack: nil
        )
        return currentRoom.map { DetachedRoom(room: $0, reader: stoppedReader, events: events) }
    }

    private func stopIfCurrentAttempt(_ attemptID: UInt64, expectedByteEpoch: UInt64? = nil) async {
        guard let currentRoom = detachCurrentRoom(
            expectedAttemptID: attemptID, expectedByteEpoch: expectedByteEpoch
        ) else {
            return
        }
        if expectedByteEpoch != nil { currentRoom.events?(.disconnected(errorCode: "desktop_stream_failed")) }
        await stopRoom(currentRoom.room, reader: currentRoom.reader)
    }

    private func stopIfCurrentRoom(_ callbackRoom: Room) async {
        guard let currentRoom = detachCurrentRoom(
            expectedRoom: callbackRoom
        ) else {
            return
        }
        await stopRoom(currentRoom.room, reader: currentRoom.reader)
    }

    private func stopRoom(_ room: Room, reader: Task<Void, Never>? = nil) async {
        await room.localParticipant.unpublishAll()
        await room.disconnect()
        await reader?.value
    }

    private func emit(
        _ event: AssistantRealtimeEvent,
        attemptID: UInt64
    ) {
        lock.lock()
        guard
            activeAttemptID == attemptID,
            let handler = eventHandler
        else {
            lock.unlock()
            return
        }
        lock.unlock()
        handler(event)
    }

    @discardableResult
    private func emit(
        _ event: AssistantRealtimeEvent,
        from callbackRoom: Room
    ) -> Bool {
        lock.lock()
        guard
            let currentRoom = room,
            currentRoom === callbackRoom,
            let handler = eventHandler
        else {
            lock.unlock()
            return false
        }
        lock.unlock()
        handler(event)
        return true
    }

    private func updateLocalVideoTrack(
        _ track: VideoTrack?,
        from callbackRoom: Room
    ) {
        lock.lock()
        guard let currentRoom = room, currentRoom === callbackRoom else {
            lock.unlock()
            return
        }
        localVideoTrack = track
        let observer = videoTrackObserver
        let remote = remoteVideoTrack
        lock.unlock()
        notifyVideoTracks(
            observer: observer,
            localVideoTrack: track,
            remoteVideoTrack: remote
        )
    }

    private func updateRemoteVideoTrack(
        _ track: VideoTrack?,
        publicationSID: String,
        participantIdentity: String?,
        from callbackRoom: Room
    ) {
        lock.lock()
        guard let currentRoom = room, currentRoom === callbackRoom else {
            lock.unlock()
            return
        }
        // Keep the avatar selected if another participant publishes video.
        // A retired publication must not clear its replacement.
        if track == nil {
            guard remoteVideoPublicationSID == publicationSID else {
                lock.unlock()
                return
            }
        } else if remoteVideoParticipantIdentity == "yimi-avatar",
                  participantIdentity != "yimi-avatar" {
            lock.unlock()
            return
        }
        remoteVideoTrack = track
        remoteVideoPublicationSID = track == nil ? nil : publicationSID
        remoteVideoParticipantIdentity = track == nil ? nil : participantIdentity
        let observer = videoTrackObserver
        let local = localVideoTrack
        lock.unlock()
        notifyVideoTracks(
            observer: observer,
            localVideoTrack: local,
            remoteVideoTrack: track
        )
    }

    private func clearVideoTracks(from callbackRoom: Room) {
        lock.lock()
        guard let currentRoom = room, currentRoom === callbackRoom else {
            lock.unlock()
            return
        }
        localVideoTrack = nil
        remoteVideoTrack = nil
        remoteVideoPublicationSID = nil
        remoteVideoParticipantIdentity = nil
        let observer = videoTrackObserver
        lock.unlock()
        notifyVideoTracks(
            observer: observer,
            localVideoTrack: nil,
            remoteVideoTrack: nil
        )
    }

    private func notifyVideoTracks(
        observer: AssistantVideoTrackObserver?,
        localVideoTrack: VideoTrack?,
        remoteVideoTrack: VideoTrack?
    ) {
        guard let observer else {
            return
        }
        let update = AssistantVideoTrackUpdate(
            localVideoTrack: localVideoTrack,
            remoteVideoTrack: remoteVideoTrack
        )
        Task { @MainActor in
            observer(update)
        }
    }

    private func emitResult(
        data: Data,
        encryptionType: EncryptionType,
        from room: Room,
        senderIdentity: String? = nil
    ) {
        guard encryptionType != .none,
              isCurrentConnectedEncryptedDataRoom(room),
              senderIdentity.map({ !$0.isEmpty }) ?? true
        else {
            failClosed(for: room)
            return
        }
        guard let envelope = AssistantResultEnvelope.decode(data) else {
            return
        }
        _ = emit(.result(envelope), from: room)
    }

    /// The Swift SDK names a user packet's sender only from the deprecated inner identity, which Rust-SDK senders (the
    /// gateway) leave empty. Without a named sender, the gateway must be the sole remote granted data publication by
    /// the server. Media-only participants hold the encryption key but cannot publish data.
    static func centralPacket(_ data: Data, binding: CentralTransportBinding?,
        sender: String?, remotes: [(identity: String, canPublishData: Bool)] = [], requiredOperation: String? = nil,
        encrypted: Bool, current: Bool) -> CentralTextPacket? {
        guard acceptsCentralSender(binding: binding, sender: sender, remotes: remotes, encrypted: encrypted, current: current),
              let binding, data.count <= binding.maxPacketBytes else { return nil }
        guard let packet = try? AssistantCentralTextWire.decode(data),
              requiredOperation == nil || (try? packet.fields.value("operation", as: String.self)) == requiredOperation,
              (try? packet.fields.value("operation", as: String.self)) != "ready"
                || (sender == binding.expectedGatewayIdentity
                    && (try? packet.fields.value("session_id", as: String.self)) == binding.sessionID) else { return nil }
        return packet
    }

    static func acceptsCentralSender(binding: CentralTransportBinding?, sender: String?,
        remotes: [(identity: String, canPublishData: Bool)] = [], encrypted: Bool, current: Bool) -> Bool {
        guard encrypted, current, let binding else { return false }
        return (sender.map { [$0] } ?? remotes.filter { $0.canPublishData }.map(\.identity)) == [binding.expectedGatewayIdentity]
    }

    private func isCurrentConnectedEncryptedDataRoom(
        _ callbackRoom: Room
    ) -> Bool {
        lock.lock()
        let isCurrent = room === callbackRoom
            && activeAttemptID != nil
        lock.unlock()
        guard isCurrent,
              callbackRoom.connectionState == .connected,
              Self.isDataChannelEncryptionActive(callbackRoom.e2eeManager)
        else {
            return false
        }
        return true
    }

    static func isDataChannelEncryptionActive(
        _ manager: E2EEManager?
    ) -> Bool {
        guard let manager else {
            return false
        }
        return manager.isDataChannelEncryptionEnabled
            && manager.frameEncryptionType != EncryptionType.none
    }

    private func failClosed(for callbackRoom: Room) {
        guard emit(.encryptionFailed, from: callbackRoom) else {
            return
        }
        Task { [weak self] in
            await self?.stopIfCurrentRoom(callbackRoom)
        }
    }

    private static func requireRuntimeGrant(
        _ source: AssistantMediaSource,
        permissions: ParticipantPermissions
    ) throws {
        guard permissions.canPublish else {
            throw LiveKitSessionError.mediaNotGranted(source)
        }
        let liveKitSource: Track.Source =
            source == .camera ? .camera : .microphone
        let allowed = permissions.canPublishSources
        guard allowed.isEmpty || allowed.contains(liveKitSource.rawValue) else {
            throw LiveKitSessionError.mediaNotGranted(source)
        }
    }

    func roomDidConnect(_ room: Room) {
        emit(.connected, from: room)
    }

    func room(
        _ room: Room,
        didStartReconnectWithMode reconnectMode: ReconnectMode
    ) {
        guard let attemptID = lock.withLock({ self.room === room ? activeAttemptID : nil }) else { return }
        lock.withLock {
            byteEpoch &+= 1
            byteStreams?.reset()
        }
        _ = try? invalidateCentralVoice(attemptID: attemptID)
        emit(reconnectMode == .quick ? .resuming : .reconnecting, from: room)
    }

    func room(_ room: Room, didUpdateReconnectMode reconnectMode: ReconnectMode) {
        // A quick resume can escalate to a fresh server connection without another didStart callback.
        if reconnectMode == .full { emit(.reconnecting, from: room) }
    }

    func room(
        _ room: Room,
        didCompleteReconnectWithMode reconnectMode: ReconnectMode
    ) {
        lock.lock()
        let generation = activeAttemptID
        let isCurrent = self.room === room && generation != nil
        lock.unlock()
        guard isCurrent else { return }

        // A data-only room has no track encryption callback to restore active.
        let encrypted = reconnectedDataEncryptionVerifier(room)
        lock.lock()
        let stillCurrent = self.room === room && activeAttemptID == generation
        lock.unlock()
        guard stillCurrent else { return }
        guard encrypted else {
            failClosed(for: room)
            return
        }
        // A full reconnect rebuilds the participant list; a gateway that left meanwhile is never reported as leaving.
        guard !leaveIfGatewayGone(room) else { return }
        guard emit(.reconnected, from: room) else { return }
        emit(.encryptionActive, from: room)
    }

    func room(
        _ room: Room,
        didDisconnectWithError error: LiveKitError?
    ) {
        clearVideoTracks(from: room)
        emit(
            .disconnected(errorCode: error == nil ? nil : "network"),
            from: room
        )
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        guard let identity = participant.identity?.stringValue,
              identity == lock.withLock({ self.room === room ? centralBinding?.expectedGatewayIdentity : nil }) else { return }
        leaveIfGatewayGone(room)
    }

    /// The gateway is this room's only peer: once it is gone the room is lost, and the client leaves it at once.
    /// SDK-wide teardowns (our disconnect, a full reconnect) report every participant while still listing it; only a
    /// connected room that no longer lists the gateway has lost it. Detaching first fences every later callback.
    @discardableResult
    private func leaveIfGatewayGone(_ callbackRoom: Room) -> Bool {
        guard let gateway = lock.withLock({ room === callbackRoom ? centralBinding?.expectedGatewayIdentity : nil }),
              callbackRoom.connectionState == .connected,
              callbackRoom.remoteParticipants[Participant.Identity(from: gateway)] == nil,
              let lost = detachCurrentRoom(expectedRoom: callbackRoom) else { return false }
        lost.events?(.disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode))
        let (lostRoom, reader) = (lost.room, lost.reader)
        Task { await self.stopRoom(lostRoom, reader: reader) }
        return true
    }

    func room(
        _ room: Room,
        participant: LocalParticipant,
        didPublishTrack publication: LocalTrackPublication
    ) {
        guard publication.kind == .video, !publication.isMuted,
              let track = publication.track as? VideoTrack
        else {
            return
        }
        updateLocalVideoTrack(track, from: room)
    }

    func room(
        _ room: Room,
        participant: LocalParticipant,
        didUnpublishTrack publication: LocalTrackPublication
    ) {
        guard publication.kind == .video else {
            return
        }
        updateLocalVideoTrack(nil, from: room)
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant,
        didPublishTrack publication: RemoteTrackPublication
    ) {
        // A remote publish callback may precede subscription and have no
        // attached track. The subscribe callback below is authoritative.
        guard publication.kind == .video,
              let track = publication.track as? VideoTrack
        else {
            return
        }
        updateRemoteVideoTrack(
            track,
            publicationSID: publication.sid.stringValue,
            participantIdentity: participant.identity?.stringValue,
            from: room
        )
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant,
        didUnpublishTrack publication: RemoteTrackPublication
    ) {
        guard publication.kind == .video else {
            return
        }
        updateRemoteVideoTrack(
            nil,
            publicationSID: publication.sid.stringValue,
            participantIdentity: participant.identity?.stringValue,
            from: room
        )
    }

    func setCallPlaybackID(_ id: String?, attemptID: UInt64) async {
        let changed = lock.withLock { () -> (Room, [(RemoteAudioTrack, AssistantCallPlaybackObserver)])? in
            guard activeAttemptID == attemptID, let room, playbackStatusCallID != id else { return nil }
            playbackStatusCallID = id; playingCallTracks.removeAll()
            let old = Array(playbackObservers.values); playbackObservers.removeAll()
            return (room, old)
        }
        guard let (room, removed) = changed else { return }
        for (track, observer) in removed { track.remove(audioRenderer: observer); observer.stop() }
        updateCallPlaybackVolume(room); updateCallPlaybackObservers(room)
    }

    private func reportCallPlayback(_ callID: String, sid: String, playing: Bool, room: Room) {
        let changed = lock.withLock { () -> Bool? in
            guard self.room === room, playbackStatusCallID == callID else { return nil }
            let prior = !playingCallTracks.isEmpty
            if playing {
                guard playbackObservers[sid] != nil else { return nil }
                playingCallTracks.insert(sid)
            } else { playingCallTracks.remove(sid) }
            let current = !playingCallTracks.isEmpty
            return prior == current ? nil : current
        }
        if let changed { _ = emit(.callAudioPlaying(callID: callID, playing: changed), from: room) }
    }

    private func updateCallPlaybackObservers(_ room: Room) {
        lock.withLock {
            guard self.room === room else { return }
            let publications = room.remoteParticipants.values.filter {
                $0.identity?.stringValue == centralBinding?.expectedGatewayIdentity
            }.flatMap { $0.trackPublications.values }
            let eligible = publications.filter {
                playbackStatusCallID != nil && $0.kind == .audio && !callPlaybackRetirement.retiredSIDs.contains($0.sid.stringValue)
            }
            let live = Set(eligible.map { $0.sid.stringValue })
            for sid in Array(playbackObservers.keys) where !live.contains(sid) {
                if let (track, observer) = playbackObservers.removeValue(forKey: sid) {
                    track.remove(audioRenderer: observer); observer.stop()
                }
            }
            guard let callID = playbackStatusCallID else { return }
            for publication in eligible where playbackObservers[publication.sid.stringValue] == nil {
                guard let track = publication.track as? RemoteAudioTrack else { continue }
                let sid = publication.sid.stringValue
                let observer = AssistantCallPlaybackObserver { [weak self, weak room] playing in
                    guard let self, let room else { return }
                    self.reportCallPlayback(callID, sid: sid, playing: playing, room: room)
                }
                playbackObservers[publication.sid.stringValue] = (track, observer)
                track.add(audioRenderer: observer)
            }
        }
    }

    private func updateCallPlaybackVolume(_ room: Room) {
        lock.withLock {
            guard self.room === room else { return }
            let publications = room.remoteParticipants.values.flatMap { $0.trackPublications.values }
            for publication in publications where callPlaybackRetirement.retiredSIDs.contains(publication.sid.stringValue) {
                (publication.track as? RemoteAudioTrack)?.volume = 0
            }
            // Receiver sources (and their volume) survive SID changes. Restore live sources last, including after late resets.
            for publication in publications where !callPlaybackRetirement.retiredSIDs.contains(publication.sid.stringValue) {
                (publication.track as? RemoteAudioTrack)?.volume = playbackStatusCallID == nil ? 0 : 1
            }
        }
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant,
        didSubscribeTrack publication: RemoteTrackPublication
    ) {
        if publication.kind == .audio { updateCallPlaybackVolume(room); updateCallPlaybackObservers(room) }
        guard publication.kind == .video,
              let track = publication.track as? VideoTrack
        else {
            return
        }
        updateRemoteVideoTrack(
            track,
            publicationSID: publication.sid.stringValue,
            participantIdentity: participant.identity?.stringValue,
            from: room
        )
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant,
        didUnsubscribeTrack publication: RemoteTrackPublication
    ) {
        if publication.kind == .audio {
            let observer = lock.withLock { playbackObservers.removeValue(forKey: publication.sid.stringValue) }
            if let (track, renderer) = observer { track.remove(audioRenderer: renderer); renderer.stop() }
        }
        guard publication.kind == .video else {
            return
        }
        updateRemoteVideoTrack(
            nil,
            publicationSID: publication.sid.stringValue,
            participantIdentity: participant.identity?.stringValue,
            from: room
        )
    }

    func room(
        _ room: Room,
        trackPublication: TrackPublication,
        didUpdateE2EEState state: E2EEState
    ) {
        switch state {
        case .new:
            emit(.encryptionPreparing, from: room)
        case .ok, .key_ratcheted:
            emit(.encryptionActive, from: room)
        case .missing_key, .encryption_failed, .decryption_failed,
             .internal_error:
            failClosed(for: room)
        @unknown default:
            failClosed(for: room)
        }
    }

    func room(
        _ room: Room,
        participant: RemoteParticipant?,
        didReceiveData data: Data,
        forTopic topic: String,
        encryptionType: EncryptionType
    ) {
        if topic == AssistantCentralTextWire.outputTopic {
            let binding = lock.withLock({ centralBinding })
            let current = isCurrentConnectedEncryptedDataRoom(room)
            guard let packet = Self.centralPacket(data, binding: binding,
                sender: participant?.identity?.stringValue,
                remotes: room.remoteParticipants.values.map { ($0.identity?.stringValue ?? "", $0.permissions.canPublishData) },
                encrypted: encryptionType != .none, current: current) else {
                #if DEBUG
                let decodes = (try? AssistantCentralTextWire.decode(data)) != nil
                print("PAIOS_CENTRAL_PACKET_DROPPED encrypted=\(encryptionType != .none) type=\(encryptionType.rawValue) current=\(current) binding=\(binding != nil) "
                    + "sender_match=\(participant?.identity?.stringValue == binding?.expectedGatewayIdentity) participant=\(participant != nil) "
                    + "sender=\(String((participant?.identity?.stringValue ?? "nil").prefix(14))) expected=\(String((binding?.expectedGatewayIdentity ?? "nil").prefix(14))) "
                    + "remotes=\(room.remoteParticipants.keys.map { String($0.stringValue.prefix(10)) }) bytes=\(data.count) decodes=\(decodes)")
                #endif
                return
            }
            // The ready handshake is admitted only from the authenticated text-stream path.
            guard (try? packet.fields.value("operation", as: String.self)) != "ready" else { return }
            let retiredSID: String? = lock.withLock {
                guard let binding, self.room === room else { return nil }
                return try? callPlaybackRetirement.accept(packet, sessionID: binding.sessionID)
            }
            if retiredSID != nil { updateCallPlaybackVolume(room); updateCallPlaybackObservers(room) }
            _ = emit(.centralText(packet), from: room)
            return
        }
        if topic == AssistantCyclingControlCommand.topic {
            guard let command = AssistantCyclingControlCommand.admit(
                data: data,
                topic: topic,
                isEncrypted: encryptionType != .none,
                hasRemoteParticipant: participant != nil,
                isCurrentConnectedRoom:
                    isCurrentConnectedEncryptedDataRoom(room)
            ) else {
                return
            }
            _ = emit(
                .cyclingControl(command),
                from: room
            )
            return
        }
        guard topic == AssistantResultEnvelope.topic else {
            return
        }
        guard participant != nil,
              isCurrentConnectedEncryptedDataRoom(room)
        else {
            return
        }
        emitResult(
            data: data,
            encryptionType: encryptionType,
            from: room
        )
    }

    func room(
        _ room: Room,
        didFailToDecryptDataWithEror error: LiveKitError
    ) {
        failClosed(for: room)
    }
}

extension SystemLiveKitRoomOperator: AssistantCameraRequestTransport {}
extension LiveKitSessionAdapter: AssistantCameraRequestTransport {
    func captureRequestedFrame(frameID: String, camera: String) async throws {
        guard let cameraTransport = roomOperator as? any AssistantCameraRequestTransport else { throw CentralTextError.unavailable }
        try await cameraTransport.captureRequestedFrame(frameID: frameID, camera: camera)
    }
}
