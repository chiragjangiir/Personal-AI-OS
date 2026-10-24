import Foundation

// The phone owns renewal and publication. Scope comes only from the server-backed provider.
actor WatchCredentialLifecycle {
    typealias Delivery = @Sendable (WatchCredentialAuthority?, WatchCredential?) async throws -> Void
    private let provider: any WatchCredentialProviding
    private let deliver: Delivery
    private let onFailure: @Sendable (Error) async -> Void
    private let now: @Sendable () -> Date
    private var authority: WatchCredentialAuthority?
    private var resolved = false
    private var credential: WatchCredential?
    private var generation: UInt64 = 0
    private var renewal: Task<Void, Never>?
    private var publication: Task<Void, Error>?
    private var mutation: Task<WatchCredential?, Error>?

    init(provider: any WatchCredentialProviding, deliver: @escaping Delivery,
         onFailure: @escaping @Sendable (Error) async -> Void = { _ in },
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider
        self.deliver = deliver
        self.onFailure = onFailure
        self.now = now
    }

    deinit { renewal?.cancel() }

    func synchronize() async { await replace(action: credential == nil ? .issue : .refresh) }
    func refresh() async { await replace(action: .refresh) }

    private func begin() -> UInt64 {
        generation &+= 1
        renewal?.cancel()
        renewal = nil
        return generation
    }

    // Publication tasks form a serial chain across actor reentrancy/MainActor hops.
    private func publish(_ authority: WatchCredentialAuthority?, _ value: WatchCredential?) async throws {
        let previous = publication, delivery = deliver
        let next = Task {
            _ = await previous?.result
            try await delivery(authority, value)
        }
        publication = next
        try await next.value
    }

    private func prepare(_ value: WatchCredentialAuthority?, expected: UInt64) async throws {
        guard isCurrent(expected) else { throw WatchCredentialError.staleAuthority }
        if !resolved || value != authority {
            authority = value
            resolved = false
            credential = nil
            try await publish(value, nil)
            guard isCurrent(expected) else { throw WatchCredentialError.staleAuthority }
            resolved = true
        }
        guard isCurrent(expected) else { throw WatchCredentialError.staleAuthority }
    }

    private func request(_ action: WatchCredentialAction, expected: UInt64) async throws -> WatchCredential? {
        let previous = mutation, provider = provider
        let next = Task { [weak self] in
            _ = await previous?.result
            guard await self?.isCurrent(expected) == true else { throw WatchCredentialError.staleAuthority }
            return try await provider.watchCredential(action: action, requestID: UUID().uuidString.lowercased()) { [weak self] authority in
                guard let self else { throw WatchCredentialError.staleAuthority }
                try await self.prepare(authority, expected: expected)
            }
        }
        mutation = next
        return try await next.value
    }

    private func isCurrent(_ expected: UInt64) -> Bool { generation == expected }

    // A confirmed formal-binding revoke resolves the scope to unregistered.
    func invalidate() async {
        let expected = begin()
        authority = nil
        resolved = false
        credential = nil
        do {
            try await publish(nil, nil)
            guard isCurrent(expected) else { return }
            resolved = true
        } catch { await onFailure(error) }
    }

    // A disconnected or not-yet-resolved local authority cannot declare a binding revoked.
    func suspend() async {
        _ = begin()
        credential = nil
        guard resolved else { return }
        do { try await publish(authority, nil) } catch { await onFailure(error) }
    }

    // Revoking a token does not revoke the formal watch binding.
    func revoke() async {
        let expected = begin()
        credential = nil
        if resolved {
            do { try await publish(authority, nil) } catch { await onFailure(error) }
        }
        guard isCurrent(expected) else { return }
        do { _ = try await request(.revoke, expected: expected) }
        catch {
            guard isCurrent(expected) else { return }
            await onFailure(error)
        }
    }

    private func replace(action: WatchCredentialAction) async {
        let previousAuthority = authority
        let previousExpiry = credential.flatMap { RealtimeControlValidation.parseTimestamp($0.expires_at) }
        let expected = begin()
        do {
            guard let value = try await request(action, expected: expected),
                  let expiry = RealtimeControlValidation.parseTimestamp(value.expires_at), expiry > now() else {
                throw WatchCredentialError.invalidResponse
            }
            guard isCurrent(expected) else { return }
            guard resolved, value.scope == authority?.scope else { throw WatchCredentialError.staleAuthority }
            try await publish(authority, value)
            guard isCurrent(expected) else { return }
            credential = value
            let remaining = expiry.timeIntervalSince(now())
            let capped = action == .refresh && authority == previousAuthority && previousExpiry.map { expiry <= $0 } == true
            let delay = capped ? remaining : max(0, remaining - min(60, remaining / 5))
            renewal = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard !Task.isCancelled else { return }
                await self?.renew(expected: expected)
            }
        } catch {
            guard isCurrent(expected) else { return }
            let hadCredential = credential != nil
            credential = nil
            if hadCredential {
                do { try await publish(authority, nil) } catch { await onFailure(error) }
            }
            await onFailure(error)
        }
    }

    private func renew(expected: UInt64) async {
        guard isCurrent(expected) else { return }
        await replace(action: .refresh)
    }
}
