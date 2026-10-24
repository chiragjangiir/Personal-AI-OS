import Foundation

enum WatchAssistantAction: String, Codable, Equatable, Sendable {
    case requestVoiceSession = "request_voice_session"
    case stopCurrentSession = "stop_current_session"
    case cardAnswer = "card_answer"
    case errandStop = "errand_stop"
    case careSafe = "care_safe"
    case stateRequest = "state_request"
    case credentialRefresh = "credential_refresh"
}

enum WatchAssistantPacketError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case duplicateOrOutOfOrder
}

struct WatchAssistantPacket: Codable, Equatable, Sendable {
    let action: WatchAssistantAction
    let requestID: String
    let sequence: UInt64

    init(action: WatchAssistantAction, requestID: String, sequence: UInt64) {
        self.action = action
        self.requestID = requestID
        self.sequence = sequence
    }

    func encodedStrict() throws -> Data {
        try JSONEncoder().encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> WatchAssistantPacket {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw WatchAssistantPacketError.malformed
        }
        let allowed = Set(["action", "requestID", "sequence"])
        for key in dictionary.keys where !allowed.contains(key) {
            throw WatchAssistantPacketError.unsupportedKey(key)
        }
        do {
            return try JSONDecoder().decode(WatchAssistantPacket.self, from: data)
        } catch {
            throw WatchAssistantPacketError.malformed
        }
    }
}

enum WatchCyclingMetricEnvelopeError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case invalidVersion
    case invalidKind
    case invalidEnvelope
}

enum WatchCyclingWorkoutState: String, Codable, Equatable, Sendable {
    case started
    case ended
    case failed
}

enum WatchCyclingWorkoutOrigin: String, Codable, Equatable, Sendable {
    case phone
    case watch
}

/// Closed, local-only WatchConnectivity payload for the latest cycling
/// telemetry. It is intentionally separate from WatchLocalEnvelope so metric
/// delivery can never be interpreted as an assistant request or acknowledgement.
struct WatchCyclingMetricEnvelope: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let currentKind = "watch_cycling_metric"

    let version: Int
    let kind: String
    let sequence: UInt64
    let observedAt: Date
    let workoutID: String
    let heartRateBPM: Double?
    let activeEnergyKcal: Double?
    let distanceM: Double?
    let elapsedS: Double
    let cadenceSPM: Double?
    let cyclingSpeedMPS: Double?
    let heartRateSampleAt: Date?
    let cadenceSampleAt: Date?
    let cyclingSpeedSampleAt: Date?
    let workoutState: WatchCyclingWorkoutState?
    let workoutOrigin: WatchCyclingWorkoutOrigin?

    init(
        version: Int = WatchCyclingMetricEnvelope.currentVersion,
        kind: String = WatchCyclingMetricEnvelope.currentKind,
        sequence: UInt64,
        observedAt: Date,
        workoutID: String,
        heartRateBPM: Double?,
        activeEnergyKcal: Double?,
        distanceM: Double?,
        elapsedS: Double,
        cadenceSPM: Double?,
        cyclingSpeedMPS: Double?,
        workoutState: WatchCyclingWorkoutState? = nil,
        workoutOrigin: WatchCyclingWorkoutOrigin? = nil,
        heartRateSampleAt: Date? = nil,
        cadenceSampleAt: Date? = nil,
        cyclingSpeedSampleAt: Date? = nil
    ) {
        self.version = version
        self.kind = kind
        self.sequence = sequence
        self.observedAt = observedAt
        self.workoutID = workoutID
        self.heartRateBPM = heartRateBPM
        self.activeEnergyKcal = activeEnergyKcal
        self.distanceM = distanceM
        self.elapsedS = elapsedS
        self.cadenceSPM = cadenceSPM
        self.cyclingSpeedMPS = cyclingSpeedMPS
        self.heartRateSampleAt = heartRateSampleAt
        self.cadenceSampleAt = cadenceSampleAt
        self.cyclingSpeedSampleAt = cyclingSpeedSampleAt
        self.workoutState = workoutState
        self.workoutOrigin = workoutOrigin
    }

    func encodedStrict() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var value = encoder.singleValueContainer(); try value.encode(formatter.string(from: date))
        }
        return try encoder.encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> WatchCyclingMetricEnvelope {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw WatchCyclingMetricEnvelopeError.malformed
        }

        let allowed = Set([
            "version", "kind", "sequence", "observedAt", "workoutID",
            "heart_rate_bpm", "active_energy_kcal", "distance_m", "elapsed_s",
            "cadence_spm", "cycling_speed_mps", "workout_state", "workout_origin",
            "heart_rate_sample_at", "cadence_sample_at", "cycling_speed_sample_at"
        ])
        for key in dictionary.keys where !allowed.contains(key) {
            throw WatchCyclingMetricEnvelopeError.unsupportedKey(key)
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = value.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
            guard let date = formatter.date(from: value) else { throw WatchCyclingMetricEnvelopeError.malformed }
            return date
        }
        let envelope: WatchCyclingMetricEnvelope
        do {
            envelope = try decoder.decode(
                WatchCyclingMetricEnvelope.self,
                from: data
            )
        } catch {
            throw WatchCyclingMetricEnvelopeError.malformed
        }
        try envelope.validate()
        return envelope
    }

    private func validate() throws {
        guard version == Self.currentVersion else {
            throw WatchCyclingMetricEnvelopeError.invalidVersion
        }
        guard kind == Self.currentKind else {
            throw WatchCyclingMetricEnvelopeError.invalidKind
        }
        guard sequence > 0,
              !workoutID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              observedAt.timeIntervalSince1970.isFinite,
              elapsedS.isFinite,
              elapsedS >= 0,
              Self.isFiniteNonNegative(heartRateBPM),
              Self.isFiniteNonNegative(activeEnergyKcal),
              Self.isFiniteNonNegative(distanceM),
              Self.isFiniteNonNegative(cadenceSPM),
              Self.isFiniteNonNegative(cyclingSpeedMPS),
              validHeartSample(),
              validSample(cadenceSampleAt, value: cadenceSPM),
              validSample(cyclingSpeedSampleAt, value: cyclingSpeedMPS) else {
            throw WatchCyclingMetricEnvelopeError.invalidEnvelope
        }
    }

    static let freshnessInterval: TimeInterval = 5

    static func isFresh(_ sampleAt: Date, at date: Date) -> Bool {
        let age = date.timeIntervalSince(sampleAt)
        return age.isFinite && age >= 0 && age <= freshnessInterval
    }

    private func validHeartSample() -> Bool {
        guard let heartRateSampleAt else { return true }
        return heartRateBPM != nil && heartRateSampleAt.timeIntervalSince1970.isFinite && heartRateSampleAt <= observedAt
    }

    private func validSample(_ sampleAt: Date?, value: Double?) -> Bool {
        guard let sampleAt else { return true } // Version 1 packets originally omitted sample dates.
        return value != nil && Self.isFresh(sampleAt, at: observedAt)
    }

    private static func isFiniteNonNegative(_ value: Double?) -> Bool {
        guard let value else { return true }
        return value.isFinite && value >= 0
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case kind
        case sequence
        case observedAt
        case workoutID
        case heartRateBPM = "heart_rate_bpm"
        case activeEnergyKcal = "active_energy_kcal"
        case distanceM = "distance_m"
        case elapsedS = "elapsed_s"
        case cadenceSPM = "cadence_spm"
        case cyclingSpeedMPS = "cycling_speed_mps"
        case heartRateSampleAt = "heart_rate_sample_at"
        case cadenceSampleAt = "cadence_sample_at"
        case cyclingSpeedSampleAt = "cycling_speed_sample_at"
        case workoutState = "workout_state"
        case workoutOrigin = "workout_origin"
    }
}

/// Latest state from the paired Watch, delivered separately from queued telemetry.
struct WatchCyclingWorkoutSnapshot: Equatable, Sendable {
    static let contextKey = "cycling_workout"
    static let queryKey = "cycling_workout_query"
    let startedAt: Date
    let metric: WatchCyclingMetricEnvelope
    let scope: WatchBindingScope

    static func queryReply(_ message: [String: Any], context: [String: Any], scope: WatchBindingScope?) -> [String: Any]? {
        guard message[queryKey] != nil else { return nil }
        guard Set(message.keys) == [queryKey, "scope"],
              let nonce = message[queryKey] as? String, UUID(uuidString: nonce) != nil,
              let binding = message["scope"] as? Data,
              let requested = try? JSONDecoder().decode(WatchBindingScope.self, from: binding), requested == scope,
              let data = context[contextKey] as? Data,
              let snapshot = try? decodeStrict(data), snapshot.scope == requested else { return [:] }
        return [queryKey: nonce, contextKey: data]
    }

    func encodedStrict() throws -> Data {
        guard startedAt.timeIntervalSince1970.isFinite, startedAt <= metric.observedAt,
              metric.workoutState == .started || metric.workoutState == .ended else {
            throw WatchCyclingMetricEnvelopeError.invalidEnvelope
        }
        let payload = try JSONSerialization.jsonObject(with: metric.encodedStrict())
        return try JSONSerialization.data(withJSONObject: ["started_at": startedAt.timeIntervalSince1970, "metric": payload,
            "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(scope))])
    }
    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= 8192,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["started_at", "metric", "scope"],
              let binding = object["scope"] as? [String: Any],
              let seconds = object["started_at"] as? Double,
              let payload = object["metric"] as? [String: Any] else {
            throw WatchCyclingMetricEnvelopeError.malformed
        }
        let snapshot = Self(startedAt: Date(timeIntervalSince1970: seconds),
            metric: try WatchCyclingMetricEnvelope.decodeStrict(JSONSerialization.data(withJSONObject: payload)),
            scope: try JSONDecoder().decode(WatchBindingScope.self, from: JSONSerialization.data(withJSONObject: binding)))
        _ = try snapshot.encodedStrict()
        return snapshot
    }
}

/// Monotonic sender sequence for Watch → iPhone requests and metrics that survives a Watch-only restart or
/// reinstall. The iPhone dedups each stream against one high-water mark for its whole process, so a Watch that
/// restarted at 1 had every request and metric refused until it passed the old mark. Each value is above the last
/// persisted one and at least the wall clock in milliseconds, so a restarted (or reinstalled) Watch continues
/// above anything it sent before, while a replayed old packet still falls below the mark.
struct WatchSenderSequence {
    private let defaults: UserDefaults?
    private let key: String
    private let clock: (() -> Date)?
    private var last: UInt64

    /// `defaults` nil keeps the counter in memory; `clock` nil disables the wall-clock floor (tests).
    init(key: String, defaults: UserDefaults? = .standard, clock: (() -> Date)? = { Date() }) {
        self.key = key
        self.defaults = defaults
        self.clock = clock
        last = (defaults?.object(forKey: key) as? NSNumber)?.uint64Value ?? 0
    }

    mutating func next() -> UInt64? {
        guard last < UInt64.max else { return nil }
        var value = last + 1
        if let clock {
            let milliseconds = (clock().timeIntervalSince1970 * 1_000).rounded(.down)
            if milliseconds.isFinite, milliseconds > 0, milliseconds < 9_007_199_254_740_992 {
                value = max(value, UInt64(milliseconds))
            }
        }
        last = value
        defaults?.set(NSNumber(value: value), forKey: key)
        return value
    }
}
