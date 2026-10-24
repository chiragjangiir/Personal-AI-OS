import Foundation
import WatchConnectivity

protocol WatchInstallationIdentityStoring: Sendable {
    func loadOrCreate() throws -> WatchInstallationIdentity
}

final class UserDefaultsWatchInstallationIdentityStore:
    WatchInstallationIdentityStoring,
    @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "paios.watch.installation-identity.v1"
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadOrCreate() throws -> WatchInstallationIdentity {
        lock.lock()
        defer { lock.unlock() }
        if let existing = defaults.string(forKey: key) {
            guard WatchInstallationIdentityRequest.isCanonicalUUID(existing)
            else { throw WatchInstallationIdentityEnvelopeError.invalidEnvelope }
            return WatchInstallationIdentity(
                id: existing,
                source: "existing_watch_install_identity"
            )
        }
        let created = UUID().uuidString.lowercased()
        guard WatchInstallationIdentityRequest.isCanonicalUUID(created) else {
            throw WatchInstallationIdentityEnvelopeError.invalidEnvelope
        }
        defaults.set(created, forKey: key)
        guard defaults.string(forKey: key) == created else {
            throw WatchInstallationIdentityEnvelopeError.invalidEnvelope
        }
        return WatchInstallationIdentity(
            id: created,
            source: "app_installation_uuid_v1"
        )
    }
}

enum WatchInstallationIdentityPublishEvent: String, Equatable, Sendable {
    case activationFailed = "activation_failed"
    case identityFailed = "identity_failed"
    case attempted
    case succeeded
    case failed
    case skippedCurrent = "skipped_current"
}

struct WatchInstallationIdentityPublishDiagnostic: Equatable, Sendable {
    let event: WatchInstallationIdentityPublishEvent
    let activationState: Int
    let errorClass: String?
}

@MainActor
final class WatchIdentityHandler {
    private let store: any WatchInstallationIdentityStoring
    private var payload: Data?
    private var published = false
    private var attempts = 0
    var diagnostic: @Sendable (WatchInstallationIdentityPublishDiagnostic) -> Void = { _ in }
    init(store: any WatchInstallationIdentityStoring) { self.store = store }
    func reply(_ data: Data) -> Data? {
        guard let request = try? WatchInstallationIdentityRequest.decodeStrict(data),
              let identity = try? store.loadOrCreate() else { return nil }
        return try? WatchInstallationIdentityReply(request: request, identity: identity).encodedStrict()
    }
    func publish(activation: WCSessionActivationState, error: Error?, context: [String: Any], write: (Data) throws -> Void) {
        func emit(_ event: WatchInstallationIdentityPublishEvent, _ error: Error? = nil) {
            diagnostic(.init(event: event, activationState: activation.rawValue, errorClass: error.map { String(describing: type(of: $0)) }))
        }
        guard error == nil, activation == .activated else { emit(.activationFailed, error); return }
        let data: Data
        do {
            if let payload { data = payload }
            else { data = try WatchInstallationIdentityObservation(identity: store.loadOrCreate()).encodedStrict(); payload = data }
        } catch { emit(.identityFailed, error); return }
        if published, context["payload"] as? Data == data { emit(.skippedCurrent); return }
        guard attempts < 2 else { return }
        attempts += 1
        emit(.attempted)
        do { try write(data); published = true; emit(.succeeded) }
        catch { emit(.failed, error) }
    }
}
