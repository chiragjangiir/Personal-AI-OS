import Foundation
import WatchConnectivity

extension WatchCyclingMetricEnvelope {
    init(snapshot: WatchCyclingMetricSnapshot, sequence: UInt64, workoutState: WatchCyclingWorkoutState? = nil) {
        self.init(
            sequence: sequence,
            observedAt: snapshot.observedAt,
            workoutID: snapshot.workoutID,
            heartRateBPM: snapshot.heartRateBPM,
            activeEnergyKcal: snapshot.activeEnergyKcal,
            distanceM: snapshot.distanceM,
            elapsedS: snapshot.elapsedS,
            cadenceSPM: snapshot.cadenceSPM,
            cyclingSpeedMPS: snapshot.cyclingSpeedMPS,
            workoutState: workoutState,
            workoutOrigin: snapshot.workoutOrigin,
            heartRateSampleAt: snapshot.heartRateSampleAt,
            cadenceSampleAt: snapshot.cadenceSampleAt,
            cyclingSpeedSampleAt: snapshot.cyclingSpeedSampleAt
        )
    }
}


enum WatchCyclingControlAction: String, Codable, Equatable, Sendable {
    case start
    case stop
}

enum WatchCyclingControlCommandError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case invalidVersion
    case invalidKind
    case invalidEnvelope
}

struct WatchCyclingControlCommand: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let currentKind = "cycling_control"

    let version: Int
    let kind: String
    let action: WatchCyclingControlAction
    let requestID: String
    let sequence: UInt64
    let workoutID: String?

    init(
        version: Int = WatchCyclingControlCommand.currentVersion,
        kind: String = WatchCyclingControlCommand.currentKind,
        action: WatchCyclingControlAction,
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
        -> WatchCyclingControlCommand {
        guard !data.isEmpty, data.count <= 4_096,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            throw WatchCyclingControlCommandError.malformed
        }
        let required = Set([
            "version", "kind", "action", "request_id", "sequence"
        ])
        let allowed = required.union(["workout_id"])
        for key in dictionary.keys where !allowed.contains(key) {
            throw WatchCyclingControlCommandError.unsupportedKey(key)
        }
        guard required.isSubset(of: Set(dictionary.keys)) else {
            throw WatchCyclingControlCommandError.malformed
        }
        let command: WatchCyclingControlCommand
        do {
            command = try JSONDecoder().decode(
                WatchCyclingControlCommand.self,
                from: data
            )
        } catch {
            throw WatchCyclingControlCommandError.malformed
        }
        try command.validate()
        return command
    }

    static func declaresKind(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            return false
        }
        return dictionary["kind"] as? String == currentKind
    }

    private func validate() throws {
        guard version == Self.currentVersion else {
            throw WatchCyclingControlCommandError.invalidVersion
        }
        guard kind == Self.currentKind else {
            throw WatchCyclingControlCommandError.invalidKind
        }
        let bytes = Array(requestID.utf8)
        guard workoutID.map({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) ?? true,
              sequence > 0,
              (1...128).contains(bytes.count),
              let first = bytes.first,
              Self.isAlphaNumeric(first),
              bytes.dropFirst().allSatisfy({
                  Self.isAlphaNumeric($0)
                      || $0 == 45 || $0 == 46 || $0 == 58 || $0 == 95
              })
        else {
            throw WatchCyclingControlCommandError.invalidEnvelope
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

enum WatchCyclingControlDisposition {
    case new
    case duplicate
    case conflict
    case stale
}

struct WatchCyclingControlLedger {
    private struct Entry {
        let action: WatchCyclingControlAction
        let sequence: UInt64
        let workoutID: String?
    }

    private var lastSequence: UInt64 = 0
    private var entries: [String: Entry] = [:]

    mutating func classify(
        _ command: WatchCyclingControlCommand
    ) -> WatchCyclingControlDisposition {
        if let entry = entries[command.requestID] {
            return entry.action == command.action
                && entry.sequence == command.sequence
                && entry.workoutID == command.workoutID
                ? .duplicate : .conflict
        }
        guard command.sequence > lastSequence else {
            return .stale
        }
        entries[command.requestID] = Entry(
            action: command.action,
            sequence: command.sequence,
            workoutID: command.workoutID
        )
        lastSequence = command.sequence
        return .new
    }
}

@MainActor
protocol WatchCyclingWorkoutControlling: AnyObject {
    func startCyclingWorkout() async throws
    func stopCyclingWorkout(workoutID: String?) -> Bool
}

extension WatchWorkoutCoordinator: WatchCyclingWorkoutControlling {
    func startCyclingWorkout() async throws {
        try await startWorkout(fromPhone: true)
    }

    func stopCyclingWorkout(workoutID: String?) -> Bool {
        stopWorkout(ifMatching: workoutID)
    }
}
@MainActor
final class WatchRideHandler {
    private weak var controller: (any WatchCyclingWorkoutControlling)?
    private var ledger = WatchCyclingControlLedger()
    private var sequence: WatchSenderSequence
    private var latestSequence: UInt64?
    private var currentWorkout: (id: String, startedAt: Date)?
    private var latestWorkoutSnapshot: Data?
    var workoutSnapshotContext: [String: Any] {
        latestWorkoutSnapshot.map { [WatchCyclingWorkoutSnapshot.contextKey: $0] } ?? [:]
    }
    var publishWorkoutSnapshot: ((Data) -> Void)?
    var workoutScope: (() -> WatchBindingScope?)?
    var send: ((Data, Bool, UInt64) -> Void)?
    init(controller: (any WatchCyclingWorkoutControlling)?, defaults: UserDefaults?, clock: (() -> Date)?) {
        self.controller = controller
        sequence = WatchSenderSequence(key: "paios.watch.metric-sequence.v1", defaults: defaults, clock: clock)
    }
    func isLatest(_ value: UInt64) -> Bool { latestSequence == value }
    func metrics(_ snapshot: WatchCyclingMetricSnapshot, state: WatchCyclingWorkoutState?) -> UInt64? {
        guard let value = sequence.next(),
              let data = try? WatchCyclingMetricEnvelope(snapshot: snapshot, sequence: value, workoutState: state).encodedStrict() else { return nil }
        latestSequence = value
        if state == .failed, let data = latestWorkoutSnapshot,
           (try? WatchCyclingWorkoutSnapshot.decodeStrict(data))?.metric.workoutID == snapshot.workoutID {
            latestWorkoutSnapshot = nil; currentWorkout = nil
        }
        if state == .started { currentWorkout = (snapshot.workoutID, snapshot.observedAt) }
        if let currentWorkout, currentWorkout.id == snapshot.workoutID, state != .failed {
            let metric = WatchCyclingMetricEnvelope(snapshot: snapshot, sequence: value, workoutState: state == .ended ? .ended : .started)
            if let scope = workoutScope?(),
               let bytes = try? WatchCyclingWorkoutSnapshot(startedAt: currentWorkout.startedAt, metric: metric, scope: scope).encodedStrict() {
                latestWorkoutSnapshot = bytes
                publishWorkoutSnapshot?(bytes)
            }
            if state == .ended { self.currentWorkout = nil }
        }
        send?(data, state != nil, value)
        return value
    }
    func receive(_ data: Data) async -> Data? {
        guard let command = try? WatchCyclingControlCommand.decodeStrict(data) else { return nil }
        let status: WatchCyclingControlAckStatus
        switch ledger.classify(command) {
        case .duplicate: status = .duplicate
        case .conflict, .stale: status = .rejected
        case .new:
            guard let controller else { return try? WatchCyclingControlAcknowledgement(command: command, status: .rejected).encodedStrict() }
            switch command.action {
            case .start:
                do { try await controller.startCyclingWorkout(); status = .accepted }
                catch { status = .rejected }
            case .stop: status = controller.stopCyclingWorkout(workoutID: command.workoutID) ? .accepted : .rejected
            }
        }
        return try? WatchCyclingControlAcknowledgement(command: command, status: status).encodedStrict()
    }
}
