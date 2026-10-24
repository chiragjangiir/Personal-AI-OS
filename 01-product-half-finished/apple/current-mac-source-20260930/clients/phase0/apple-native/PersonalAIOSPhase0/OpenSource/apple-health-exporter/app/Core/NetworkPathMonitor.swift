import Foundation
import Network

enum AssistantNetworkStatus: String, Equatable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

struct AssistantNetworkPathState: Equatable, Sendable {
    let status: AssistantNetworkStatus
    let isExpensive: Bool
    let isConstrained: Bool
    let usesWiFi: Bool
    let usesCellular: Bool
}

enum AssistantNetworkTransition: Equatable, Sendable {
    case becameSatisfied
    case becameUnsatisfied
    case interfaceChanged
    case changed
    case unchanged
}

protocol AssistantNetworkPathMonitoring: Sendable {
    func updates() -> AsyncStream<AssistantNetworkPathState>
    func cancel()
}

final class NetworkPathMonitor: AssistantNetworkPathMonitoring,
    @unchecked Sendable {
    private let monitor: NWPathMonitor
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var continuation:
        AsyncStream<AssistantNetworkPathState>.Continuation?
    private var started = false

    init(
        monitor: NWPathMonitor = NWPathMonitor(),
        queue: DispatchQueue = DispatchQueue(
            label: "ai.paios.personal.assistant.network-path"
        )
    ) {
        self.monitor = monitor
        self.queue = queue
    }

    func updates() -> AsyncStream<AssistantNetworkPathState> {
        AsyncStream { continuation in
            lock.lock()
            self.continuation = continuation
            let shouldStart = !started
            started = true
            lock.unlock()

            monitor.pathUpdateHandler = { [weak self] path in
                self?.yield(path)
            }
            continuation.onTermination = { [weak self] _ in
                self?.cancel()
            }
            if shouldStart {
                monitor.start(queue: queue)
            }
        }
    }

    func cancel() {
        lock.lock()
        continuation?.finish()
        continuation = nil
        let shouldCancel = started
        started = false
        lock.unlock()
        if shouldCancel {
            monitor.cancel()
        }
    }

    private func yield(_ path: NWPath) {
        let state = AssistantNetworkPathState(
            status: Self.map(path.status),
            isExpensive: path.isExpensive,
            isConstrained: path.isConstrained,
            usesWiFi: path.usesInterfaceType(.wifi),
            usesCellular: path.usesInterfaceType(.cellular)
        )
        lock.lock()
        let target = continuation
        lock.unlock()
        target?.yield(state)
    }

    static func transition(
        from old: AssistantNetworkPathState?,
        to new: AssistantNetworkPathState
    ) -> AssistantNetworkTransition {
        guard let old else {
            return new.status == .satisfied
                ? .becameSatisfied
                : .becameUnsatisfied
        }
        guard old != new else {
            return .unchanged
        }
        if old.status != .satisfied, new.status == .satisfied {
            return .becameSatisfied
        }
        if old.status == .satisfied, new.status != .satisfied {
            return .becameUnsatisfied
        }
        if old.usesWiFi != new.usesWiFi
            || old.usesCellular != new.usesCellular
        {
            return .interfaceChanged
        }
        return .changed
    }

    static func map(_ status: NWPath.Status) -> AssistantNetworkStatus {
        switch status {
        case .satisfied: return .satisfied
        case .unsatisfied: return .unsatisfied
        case .requiresConnection: return .requiresConnection
        @unknown default: return .unsatisfied
        }
    }
}
