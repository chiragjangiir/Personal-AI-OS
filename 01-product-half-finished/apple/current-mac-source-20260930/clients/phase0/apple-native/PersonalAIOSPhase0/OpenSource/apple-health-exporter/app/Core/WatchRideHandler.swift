import Foundation

private final class WatchCyclingControlReplyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation:
        CheckedContinuation<AssistantWatchControlDeliveryStatus, Never>?

    init(
        _ continuation:
            CheckedContinuation<AssistantWatchControlDeliveryStatus, Never>
    ) {
        self.continuation = continuation
    }

    func finish(_ status: AssistantWatchControlDeliveryStatus) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: status)
    }
}

/// In-memory monotonic sequence gate for live metrics. Application-context
/// delivery and realtime message delivery share this gate so a duplicate or
/// out-of-order payload can never invoke the injected handler twice.
actor WatchCyclingMetricSequenceLedger {
    private var lastSequence: UInt64 = 0
    private var lastLifecycleSequence: UInt64 = 0

    func accept(_ envelope: WatchCyclingMetricEnvelope) -> Bool {
        if envelope.workoutState != nil {
            guard envelope.sequence > lastLifecycleSequence else { return false }
            lastLifecycleSequence = envelope.sequence
            return true
        }
        guard envelope.sequence > 0, envelope.sequence > lastSequence else {
            return false
        }
        lastSequence = envelope.sequence
        return true
    }

    func clear() {
        lastSequence = 0
        lastLifecycleSequence = 0
    }
}


final class WatchRideHandler: @unchecked Sendable {
    typealias MetricHandler = @Sendable (WatchCyclingMetricEnvelope) async -> Void
    private let sender: any WatchPhoneConnectivitySending
    private let metricLedger: WatchCyclingMetricSequenceLedger
    private let metricHandler: MetricHandler
    private let controlSequenceLock = NSLock()
    private var controlSequence: WatchSenderSequence
    init(sender: any WatchPhoneConnectivitySending, ledger: WatchCyclingMetricSequenceLedger,
         handler: @escaping MetricHandler, sequence: WatchSenderSequence) {
        self.sender = sender; metricLedger = ledger; metricHandler = handler; controlSequence = sequence
    }
    func clear() async { await metricLedger.clear() }
    func recoverWorkout(context: [String: Any], scope: WatchBindingScope, receive: @escaping @Sendable (Data) -> Void) {
        if let data = context[WatchCyclingWorkoutSnapshot.contextKey] as? Data,
           let snapshot = try? WatchCyclingWorkoutSnapshot.decodeStrict(data),
           snapshot.scope == scope, snapshot.metric.workoutState == .ended { receive(data) }
        queryCurrentWorkout(scope: scope, receive: receive)
    }
    func queryCurrentWorkout(scope: WatchBindingScope, receive: @escaping @Sendable (Data) -> Void) {
        guard sender.isActivated, sender.isReachable,
              let binding = try? JSONEncoder().encode(scope) else { return }
        let nonce = UUID().uuidString.lowercased()
        sender.sendMessage([WatchCyclingWorkoutSnapshot.queryKey: nonce, "scope": binding], replyHandler: { reply in
            guard Set(reply.keys) == [WatchCyclingWorkoutSnapshot.queryKey, WatchCyclingWorkoutSnapshot.contextKey],
                  reply[WatchCyclingWorkoutSnapshot.queryKey] as? String == nonce,
                  let data = reply[WatchCyclingWorkoutSnapshot.contextKey] as? Data,
                  let snapshot = try? WatchCyclingWorkoutSnapshot.decodeStrict(data), snapshot.scope == scope else { return }
            receive(data)
        }, errorHandler: { _ in })
    }

    func sendCyclingControl(
        _ command: AssistantCyclingControlCommand
    ) async -> AssistantWatchControlDeliveryStatus {
        // Gateway commands and phone-owned stops share one outgoing Watch sequence.
        guard sender.isActivated
        else {
            return .unreachable
        }
        guard let sequence = controlSequenceLock.withLock({ controlSequence.next() }) else { return .rejected }
        let command = AssistantCyclingControlCommand(action: command.action, requestID: command.requestID, sequence: sequence, workoutID: command.workoutID)
        guard let data = try? command.encodedStrict() else { return .rejected }
        if !sender.isReachable {
            if command.action == .stop, command.workoutID != nil { sender.enqueueUserInfo(["payload": data]) }
            return .unreachable
        }

        return await withCheckedContinuation { continuation in
            let gate = WatchCyclingControlReplyGate(continuation)
            sender.sendMessage(
                ["payload": data],
                replyHandler: { reply in
                    guard let replyData = reply["payload"] as? Data,
                          let acknowledgement = try?
                            WatchCyclingControlAcknowledgement.decodeStrict(
                                replyData
                            ),
                          acknowledgement.matches(command)
                    else {
                        gate.finish(.rejected)
                        return
                    }
                    switch acknowledgement.status {
                    case .accepted:
                        gate.finish(.accepted)
                    case .duplicate:
                        gate.finish(.duplicate)
                    case .rejected:
                        gate.finish(.rejected)
                    }
                },
                errorHandler: { _ in
                    if command.action == .stop, command.workoutID != nil { self.sender.enqueueUserInfo(["payload": data]) }
                    gate.finish(.unreachable)
                }
            )
        }
    }
    func processMetricIfPresent(_ data: Data?) async -> Bool {
        guard let data else {
            return false
        }
        if let metric = try? WatchCyclingMetricEnvelope.decodeStrict(data) {
            guard await metricLedger.accept(metric) else { return true }
            await metricHandler(metric)
            return true
        }

        // A payload that declares the metric kind is metric traffic even when
        // malformed. Ignore it as metric traffic instead of feeding it into
        // the assistant request/ack decoder.
        guard Self.declaresCyclingMetricKind(data) else { return false }
        return true
    }

    static func declaresCyclingMetricKind(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              dictionary["kind"] as? String == WatchCyclingMetricEnvelope.currentKind
        else {
            return false
        }
        return true
    }
}
