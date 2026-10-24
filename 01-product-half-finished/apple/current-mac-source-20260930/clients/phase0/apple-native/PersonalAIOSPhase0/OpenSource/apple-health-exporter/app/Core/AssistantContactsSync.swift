import CryptoKit
import Foundation

/// Per-pair snapshot state. Pending bytes are durable before publish; baseline changes only after Mac ACK.
actor AssistantContactsSync {
    struct Pending: Codable, Sendable {
        let controlID: String
        let bytes: Data
        let contacts: [AssistantContact]
        let deleted: [String]
        var batch: CentralOwnerDataBatch {
            .init(operation: "contacts_batch", bytes: bytes, controlID: controlID, stored: contacts.count, deleted: deleted.count)
        }
    }
    struct State: Codable { var enabled = false; var baseline: [String: String] = [:]; var pending: Pending?; var recoveryIDs: [String] = [] }
    enum Outcome: Sendable { case complete(limited: Bool), busy }
    typealias Sender = @Sendable (CentralOwnerDataBatch) async throws -> Void
    private let source: any AssistantContactsReading
    private let directory: URL
    private var running = false
    private var generation: UInt64 = 0
    init(source: any AssistantContactsReading = SystemAssistantContactsSource(), directory: URL = AssistantContactsSync.defaultDirectory()) {
        self.source = source; self.directory = directory
    }
    static func defaultDirectory() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("owner-data/contacts", isDirectory: true)
    }
    func invalidateSnapshot() { generation &+= 1 }
    func isEnabled(identity: String) throws -> Bool { try load(identity).enabled }
    func setEnabled(_ enabled: Bool, identity: String) async throws {
        if enabled { try await source.requestAccess() }
        var state = try load(identity); state.enabled = enabled
        try save(state, identity); generation &+= 1
    }
    /// Enumerate before replay. A revoked visible card must not be resent from an old durable pending packet.
    /// If pending values changed, replace its body and control id. Its affected ids remain explicit until ACK.
    func sync(identity: String, maximumBytes: Int, send: @escaping Sender) async throws -> Outcome {
        guard try isEnabled(identity: identity) else { throw CancellationError() }
        if running { return .busy }
        running = true; defer { running = false }
        let version = generation
        let snapshot = try await source.snapshot()
        try check(identity, version)
        var visible: [String: AssistantContact] = [:]
        for card in snapshot.contacts {
            try card.validate()
            guard visible.updateValue(card, forKey: card.id) == nil else { throw AssistantContactsFailure.duplicateID }
        }
        var state = try load(identity)
        if state.pending != nil || !state.recoveryIDs.isEmpty {
            let pending = state.pending
            let affected = Set(state.recoveryIDs + (pending?.contacts.map(\.id) ?? []) + (pending?.deleted ?? [])).sorted()
            let cards = affected.compactMap { visible[$0] }
            let deleted = affected.filter { visible[$0] == nil }
            if let pending, state.recoveryIDs.isEmpty, cards == pending.contacts, deleted == pending.deleted, pending.bytes.count <= maximumBytes {
                try await source.verifyAccess(limited: snapshot.limited)
                try await send(pending.batch); try check(identity, version)
                try apply(cards: cards, deleted: deleted, state: &state)
                state.pending = nil; try save(state, identity)
            } else {
                // Every possibly committed id survives until its current value or deletion receives an ACK.
                state.recoveryIDs = affected; state.pending = nil; try save(state, identity)
                for packet in try packets(cards: cards, deleted: deleted, maximumBytes: maximumBytes) {
                    try check(identity, version)
                    state.pending = packet; try save(state, identity)
                    try await source.verifyAccess(limited: snapshot.limited)
                    try await send(packet.batch); try check(identity, version)
                    try apply(cards: packet.contacts, deleted: packet.deleted, state: &state)
                    let confirmed = Set(packet.contacts.map(\.id) + packet.deleted)
                    state.recoveryIDs.removeAll { confirmed.contains($0) }
                    state.pending = nil; try save(state, identity)
                }
            }
        }
        let changed = try visible.values.filter { try state.baseline[$0.id] != fingerprint($0) }.sorted { $0.id < $1.id }
        let deleted = state.baseline.keys.filter { visible[$0] == nil }.sorted()
        // An empty initial snapshot receives a real durable ACK too.
        for packet in try packets(cards: changed, deleted: deleted, maximumBytes: maximumBytes) {
            try check(identity, version)
            state.pending = packet; try save(state, identity)
            try await source.verifyAccess(limited: snapshot.limited)
            try await send(packet.batch); try check(identity, version)
            try apply(cards: packet.contacts, deleted: packet.deleted, state: &state)
            state.pending = nil; try save(state, identity)
        }
        return .complete(limited: snapshot.limited)
    }
    private func check(_ identity: String, _ version: UInt64) throws {
        try Task.checkCancellation()
        guard generation == version, try load(identity).enabled else { throw CancellationError() }
    }
    private func load(_ identity: String) throws -> State {
        let url = directory.appendingPathComponent(identity + ".json")
        guard FileManager.default.fileExists(atPath: url.path) else { return State() }
        return try JSONDecoder().decode(State.self, from: Data(contentsOf: url))
    }
    private func save(_ state: State, _ identity: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(identity + ".json")
        var options: Data.WritingOptions = [.atomic]
#if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
#endif
        try JSONEncoder().encode(state).write(to: url, options: options)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func fingerprint(_ card: AssistantContact) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(card)).map { String(format: "%02x", $0) }.joined()
    }
    private func apply(cards: [AssistantContact], deleted: [String], state: inout State) throws {
        for card in cards { state.baseline[card.id] = try fingerprint(card) }
        for id in deleted { state.baseline.removeValue(forKey: id) }
    }
    /// Greedy packing uses the canonical encoder's limit and the live binding's limit. No field is truncated.
    func packets(cards: [AssistantContact], deleted: [String], maximumBytes: Int) throws -> [Pending] {
        var result: [Pending] = []; var cardIndex = 0; var deleteIndex = 0
        repeat {
            let controlID = "contacts-" + UUID().uuidString.lowercased()
            var selected: [AssistantContact] = []; var removed: [String] = []
            func bytes() throws -> Data {
                let encoder = JSONEncoder()
                let records = try JSONSerialization.jsonObject(with: encoder.encode(selected))
                return try AssistantCentralTextWire.encode("contacts_batch", fields: ["control_id": controlID, "contacts": records, "deleted": removed])
            }
            while cardIndex < cards.count, selected.count < 16 {
                try cards[cardIndex].validate(); selected.append(cards[cardIndex])
                if (try? bytes().count).map({ $0 <= maximumBytes }) != true {
                    selected.removeLast()
                    if selected.isEmpty { throw AssistantContactsFailure.packetTooLarge }; break
                }
                cardIndex += 1
            }
            while deleteIndex < deleted.count, removed.count < 128 {
                removed.append(deleted[deleteIndex])
                if (try? bytes().count).map({ $0 <= maximumBytes }) != true {
                    removed.removeLast()
                    if selected.isEmpty && removed.isEmpty { throw AssistantContactsFailure.packetTooLarge }; break
                }
                deleteIndex += 1
            }
            result.append(.init(controlID: controlID, bytes: try bytes(), contacts: selected, deleted: removed))
        } while cardIndex < cards.count || deleteIndex < deleted.count
        return result
    }
}
