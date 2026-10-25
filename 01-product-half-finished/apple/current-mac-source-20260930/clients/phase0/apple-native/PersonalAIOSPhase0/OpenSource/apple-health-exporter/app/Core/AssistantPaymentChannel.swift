import Foundation

enum AssistantPaymentEvent: Sendable {
    case attached(CentralTransportBinding)
    case detached
    case failed
    case output(CentralTextPacket)
}

enum AssistantPaymentChannelError: Error {
    case detached, timeout, duplicateID, invalidRequest
    case notDispatched(Error)
}

/// Cancellation and the publisher handoff share one atomic boundary.
final class AssistantPaymentDispatch: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var began = false
    func begin() throws {
        try lock.withLock {
            guard !cancelled else { throw AssistantPaymentChannelError.notDispatched(CancellationError()) }
            began = true
        }
    }
    func cancel() -> Bool {
        lock.withLock { cancelled = true; return began }
    }
}

/// Payment correlation follows the encrypted attachment, independently of chat and call ownership.
actor AssistantPaymentChannel {
    typealias Sender = @Sendable (Data, CentralTransportBinding, AssistantPaymentDispatch) async throws -> Void
    private struct Pending {
        let operation: String
        let token: UUID
        let continuation: CheckedContinuation<CentralTextPacket, Error>
        let timeout: Task<Void, Never>
        let dispatchState: AssistantPaymentDispatch
        var dispatch: Task<Void, Never>?
    }
    private var binding: CentralTransportBinding?
    private var sender: Sender?
    private var observer: (@Sendable (AssistantPaymentEvent) -> Void)?
    private var pending: [String: Pending] = [:]
    private var ownerObserver: (@Sendable (AssistantPaymentEvent) -> Void)?
    private var modelSettingsObserver: (@Sendable (AssistantPaymentEvent) -> Void)?
    func setModelSettingsObserver(_ observer: @escaping @Sendable (AssistantPaymentEvent) -> Void) {
        modelSettingsObserver = observer
        observer(binding.map(AssistantPaymentEvent.attached) ?? .detached)
    }
    func setOwnerObserver(_ observer: @escaping @Sendable (AssistantPaymentEvent) -> Void) {
        ownerObserver = observer
        observer(binding.map(AssistantPaymentEvent.attached) ?? .detached)
    }
    private var usedIDs: Set<String> = []
    private var presenceState = "locked"

    func setObserver(_ observer: (@Sendable (AssistantPaymentEvent) -> Void)?) {
        self.observer = observer
        if let binding { observer?(.attached(binding)) } else { observer?(.detached) }
    }

    func attach(binding: CentralTransportBinding, send: @escaping Sender) async {
        guard self.binding != binding else { return }
        detach()
        self.binding = binding
        sender = send
        observer?(.attached(binding))
        ownerObserver?(.attached(binding))
        modelSettingsObserver?(.attached(binding))
        do { try await presence(presenceState) }
        catch { if self.binding == binding { detach(); observer?(.failed) } }
    }

    func detach() {
        let wasAttached = binding != nil
        binding = nil
        sender = nil
        usedIDs.removeAll()
        let abandoned = pending.values
        pending.removeAll()
        for request in abandoned {
            request.timeout.cancel()
            request.dispatch?.cancel()
            request.continuation.resume(throwing: failure(AssistantPaymentChannelError.detached, dispatched: request.dispatchState.cancel()))
        }
        if wasAttached { observer?(.detached); ownerObserver?(.detached); modelSettingsObserver?(.detached) }
    }

    func presence(_ state: String) async throws {
        let bytes = try AssistantCentralTextWire.encode("phone_presence", fields: ["state": state])
        presenceState = state
        guard let binding, binding.deviceClass == "iphone", let sender else { return }
        try await sender(bytes, binding, AssistantPaymentDispatch())
        guard self.binding == binding else { throw AssistantPaymentChannelError.detached }
    }

    func request(_ bytes: Data, id: String, timeout: TimeInterval) async throws -> CentralTextPacket {
        guard let binding, let sender else { throw AssistantPaymentChannelError.notDispatched(AssistantPaymentChannelError.detached) }
        guard timeout.isFinite, timeout > 0, timeout < Double(UInt64.max) / 1_000_000_000,
              let fields = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let operation = fields["operation"] as? String,
              (fields["request_id"] as? String ?? fields["control_id"] as? String) == id else {
            throw AssistantPaymentChannelError.notDispatched(AssistantPaymentChannelError.invalidRequest)
        }
        let replies = ["payment_challenge_get": "payment_challenge", "payment_settings_get": "payment_settings",
                       "payment_records_get": "payment_records", "payment_record_get": "payment_record"]
        let response = operation.hasPrefix("model_settings_") ? "model_settings_receipt"
            : operation.hasPrefix("owner_override_") ? "owner_override_status" : (replies[operation] ?? "payment_receipt")
        guard usedIDs.insert(id).inserted else { throw AssistantPaymentChannelError.notDispatched(AssistantPaymentChannelError.duplicateID) }
        let token = UUID()
        let dispatchState = AssistantPaymentDispatch()
        return try await withTaskCancellationHandler {
            if Task.isCancelled { throw AssistantPaymentChannelError.notDispatched(CancellationError()) }
            return try await withCheckedThrowingContinuation { continuation in
                let expiry = Task {
                    do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) }
                    catch { return }
                    self.finish(id, token: token, error: AssistantPaymentChannelError.timeout)
                }
                pending[id] = Pending(operation: response, token: token, continuation: continuation, timeout: expiry, dispatchState: dispatchState)
                pending[id]?.dispatch = Task {
                    guard self.binding == binding, pending[id]?.token == token else { return }
                    do {
                        try Task.checkCancellation()
                        try await sender(bytes, binding, dispatchState)
                    }
                    catch { self.finish(id, token: token, error: error) }
                }
            }
        } onCancel: {
            _ = dispatchState.cancel()
            Task { await self.finish(id, token: token, error: CancellationError()) }
        }
    }

    /// Correlates owner controls on the same encrypted attachment. Wrong sessions never reach observers.
    func accept(_ packet: CentralTextPacket) -> Bool {
        guard let operation = try? packet.fields.value("operation", as: String.self),
              (operation.hasPrefix("payment_") || operation == "owner_override_status" || operation.hasPrefix("model_settings_")) else { return false }
        guard let binding, (try? packet.fields.value("session_id", as: String.self)) == binding.sessionID else { return true }
        let id = (try? packet.fields.value("request_id", as: String.self))
            ?? (try? packet.fields.value("control_id", as: String.self))
        if let id, let request = pending[id], request.operation == operation {
            pending.removeValue(forKey: id)
            request.timeout.cancel()
            request.continuation.resume(returning: packet)
        }
        if operation.hasPrefix("model_settings_") { modelSettingsObserver?(.output(packet)) }
        else if operation == "owner_override_status" { ownerObserver?(.output(packet)) }
        else { observer?(.output(packet)) }
        return true
    }

    private func finish(_ id: String, token: UUID, error: Error) {
        guard let request = pending[id], request.token == token else { return }
        pending.removeValue(forKey: id)
        request.timeout.cancel()
        request.dispatch?.cancel()
        request.continuation.resume(throwing: failure(error, dispatched: request.dispatchState.cancel()))
    }

    private func failure(_ error: Error, dispatched: Bool) -> Error {
        if case AssistantPaymentChannelError.notDispatched = error { return error }
        return dispatched ? error : AssistantPaymentChannelError.notDispatched(error)
    }
}
