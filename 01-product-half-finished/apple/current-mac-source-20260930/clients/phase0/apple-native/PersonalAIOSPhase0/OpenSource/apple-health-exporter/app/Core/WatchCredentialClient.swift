import Foundation

enum WatchCredentialAction: String, Sendable { case issue, refresh, revoke }
enum WatchCredentialError: Error, Equatable {
    case invalidResponse, rejected(String), staleAuthority
}
struct WatchCredentialAuthority: Sendable, Equatable {
    let scope: WatchBindingScope
    let principal: String
    let pairingIdentity: String
}

protocol WatchCredentialProviding: Sendable {
    func watchCredential(action: WatchCredentialAction, requestID: String,
                         prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential?
}

// Frozen HTTP conversion only. The existing provider owns authority and transport.
enum WatchCredentialWire {
    static func request(action: WatchCredentialAction, binding: RealtimeFormalWatchBinding, requestID: String) throws -> Data {
        guard UUID(uuidString: requestID) != nil else { throw WatchCredentialError.invalidResponse }
        return try JSONSerialization.data(withJSONObject: ["action": action.rawValue,
            "watch_device_id": binding.watch.deviceId, "installation_id": binding.installationId,
            "expected_pair_version": binding.pairVersion, "request_id": requestID], options: [.sortedKeys])
    }

    static func failure(_ data: Data) throws -> WatchCredentialError {
        let reasons: Set<String> = ["invalid_request", "credential_missing", "credential_invalid", "credential_expired",
            "credential_revoked", "watch_unregistered", "watch_scope_denied", "pair_version_conflict", "request_conflict", "service_unavailable"]
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(body.keys) == ["status", "reason"], body["status"] as? String == "failed",
              let reason = body["reason"] as? String, reasons.contains(reason) else { throw WatchCredentialError.invalidResponse }
        return .rejected(reason)
    }

    static func response(_ data: Data, action: WatchCredentialAction, binding: RealtimeFormalWatchBinding,
                         server: String, now: Date) throws -> WatchCredential? {
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = body["status"] as? String else { throw WatchCredentialError.invalidResponse }
        if status == "failed" {
            throw try failure(data)
        }
        let base: Set<String> = ["status", "watch_device_id", "installation_id", "pair_version"]
        guard let watchID = body["watch_device_id"] as? String, watchID == binding.watch.deviceId,
              let pairVersion = body["pair_version"] as? String, pairVersion == binding.pairVersion,
              body["installation_id"] as? String == binding.installationId else { throw WatchCredentialError.invalidResponse }
        if action == .revoke {
            guard status == "revoked", Set(body.keys) == base else { throw WatchCredentialError.invalidResponse }
            return nil
        }
        guard status == "credential", Set(body.keys) == base.union(["token", "expires_at"]),
              let token = body["token"] as? String, !token.isEmpty,
              let expires = body["expires_at"] as? String,
              let expiry = RealtimeControlValidation.parseTimestamp(expires),
              let bindingExpiry = RealtimeControlValidation.parseTimestamp(binding.expiresAt),
              expiry > now, expiry <= min(bindingExpiry, now.addingTimeInterval(7 * 24 * 3600)) else {
            throw WatchCredentialError.invalidResponse
        }
        let credential = WatchCredential(version: 1, kind: "watch_credential", token: token, expires_at: expires, server: server,
            scope: WatchBindingScope(watch_device_id: watchID, pair_version: pairVersion))
        return try JSONDecoder().decode(WatchCredential.self, from: JSONEncoder().encode(credential))
    }
}
