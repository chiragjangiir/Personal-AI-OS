import Foundation

enum WatchLocalRequestDisposition: Equatable, Sendable {
    case new
    case duplicate
    case conflict
    case stale
}

/// Bounded, in-memory deduplication for local Watch requests. It is not a
/// durable operation ledger and must never be used as proof of server work.
actor WatchLocalRequestLedger {
    private struct Entry: Sendable {
        let action: WatchAssistantAction
        let args: WatchYimiActionArguments?
    }

    private let capacity: Int
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var lastSequence: UInt64 = 0

    init(capacity: Int = 128) {
        self.capacity = max(1, capacity)
    }

    func classify(_ packet: WatchAssistantPacket) -> WatchLocalRequestDisposition {
        classify(action: packet.action, requestID: packet.requestID, sequence: packet.sequence, args: nil)
    }
    func classify(_ request: WatchLocalEnvelope) -> WatchLocalRequestDisposition {
        guard let action = request.action else { return .stale }
        return classify(action: action, requestID: request.requestID, sequence: request.sequence, args: request.args)
    }
    private func classify(action: WatchAssistantAction, requestID: String, sequence: UInt64,
                          args: WatchYimiActionArguments?) -> WatchLocalRequestDisposition {
        guard !requestID.isEmpty, sequence > 0 else {
            return .stale
        }

        if let existing = entries[requestID] {
            return existing.action == action && existing.args == args ? .duplicate : .conflict
        }

        guard sequence > lastSequence else {
            return .stale
        }

        lastSequence = sequence
        entries[requestID] = Entry(action: action, args: args)
        order.append(requestID)
        trimIfNeeded()
        return .new
    }

    func clear() {
        entries.removeAll(keepingCapacity: true)
        order.removeAll(keepingCapacity: true)
        lastSequence = 0
    }

    private func trimIfNeeded() {
        while order.count > capacity {
            let evicted = order.removeFirst()
            entries.removeValue(forKey: evicted)
        }
    }
}

/// Captures delegate arrival order synchronously, then executes the existing
/// async delivery bodies one at a time without blocking a WCSession callback.
final class WatchLocalAsyncDeliveryChain: @unchecked Sendable {
    typealias Operation = @Sendable () async -> Void

    private let lock = NSLock()
    private var tail: Task<Void, Never>?

    func enqueue(_ operation: @escaping Operation) {
        lock.lock()
        let previous = tail
        let next = Task {
            if let previous {
                await previous.value
            }
            await operation()
        }
        tail = next
        lock.unlock()
    }

    func waitUntilIdle() async {
        let pending = currentTail()
        await pending?.value
    }

    private func currentTail() -> Task<Void, Never>? {
        lock.lock()
        defer { lock.unlock() }
        return tail
    }
}
