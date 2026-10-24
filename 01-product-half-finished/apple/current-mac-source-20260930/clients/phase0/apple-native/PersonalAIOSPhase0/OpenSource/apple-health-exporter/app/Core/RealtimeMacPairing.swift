import Foundation

enum RealtimeMacPairingError: Error { case expired }

/// Public QR identifies a pending request; the poll credential never leaves the Mac.
struct RealtimeMacPairingQR: Sendable {
    static let schema = "paios.mac-pairing-request.v1"
    let origin: String
    let nonce: String
    let publicKeySHA256: String
    let expiresAt: Date
    let data: Data

    static func decode(_ data: Data, origin: String, now: Date = Date()) throws -> Self {
        guard data.count <= 4096,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
              Set(object.keys) == ["schema", "origin", "nonce", "expires_at", "public_key_sha256"],
              object["schema"] == schema, object["origin"] == origin,
              try EndpointResolver.canonicalRealtimeOrigin(from: origin) == origin,
              let nonce = object["nonce"], nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let digest = object["public_key_sha256"], digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let timestamp = object["expires_at"] else { throw RealtimeDevicePairingError.invalidPairing }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: timestamp)
        formatter.formatOptions = [.withInternetDateTime]
        guard let expiry = fractional ?? formatter.date(from: timestamp) else { throw RealtimeDevicePairingError.invalidPairing }
        guard expiry > now else { throw RealtimeMacPairingError.expired }
        return Self(origin: origin, nonce: nonce, publicKeySHA256: digest, expiresAt: expiry, data: data)
    }
}

struct RealtimeMacPairingRequest: Sendable {
    let qr: RealtimeMacPairingQR
    let pollToken: String
}

struct RealtimeMacPairingPreview: Decodable, Sendable {
    enum Status: String, Decodable { case pending, approved, connected }
    let label: String
    let status: Status
    let public_key_sha256: String
    let expires_at: String

    static func decode(_ data: Data, qr: RealtimeMacPairingQR, now: Date = Date()) throws -> Self {
        let preview = try JSONDecoder().decode(Self.self, from: data)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: preview.expires_at)
        formatter.formatOptions = [.withInternetDateTime]
        guard preview.public_key_sha256 == qr.publicKeySHA256,
              let expiry = fractional ?? formatter.date(from: preview.expires_at),
              preview.status == .connected || expiry == qr.expiresAt,
              !preview.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              preview.label.count <= 200 else { throw RealtimeDevicePairingError.invalidPairing }
        guard expiry > now else { throw RealtimeMacPairingError.expired }
        return preview
    }
}

enum RealtimeMacPairingAPI {
    static func create(origin: String, registration: [String: Any], session: URLSession) async throws -> RealtimeMacPairingRequest {
        let data = try await post(origin: origin, action: "request", body: ["registration": registration], session: session)
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: String],
              let token = object.removeValue(forKey: "poll_token"),
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw RealtimeDevicePairingError.invalidPairing
        }
        let qr = try RealtimeMacPairingQR.decode(JSONSerialization.data(withJSONObject: object), origin: origin)
        guard qr.publicKeySHA256 == registration["public_sha256"] as? String else { throw RealtimeDevicePairingError.invalidPairing }
        return RealtimeMacPairingRequest(qr: qr, pollToken: token)
    }

    /// nil means the owner has not approved yet. A successful response consumes the request.
    static func exchange(_ request: RealtimeMacPairingRequest, session: URLSession) async throws -> Data? {
        let data = try await post(origin: request.qr.origin, action: "exchange",
                                  body: ["nonce": request.qr.nonce, "poll_token": request.pollToken], session: session)
        if let object = try JSONSerialization.jsonObject(with: data) as? [String: String], object["status"] == "pending" {
            guard Set(object.keys) == ["status", "expires_at"] else { throw RealtimeDevicePairingError.invalidPairing }
            return nil
        }
        return data
    }

    static func preview(_ qr: RealtimeMacPairingQR, pairing: RealtimeDevicePairing, session: URLSession? = nil) async throws -> RealtimeMacPairingPreview {
        guard pairing.deviceType == nil, qr.origin == pairing.origin else { throw RealtimeDevicePairingError.invalidPairing }
        let transport = session ?? ProductionRealtimePublicControlProvider.makeSession()
        defer { if session == nil { transport.finishTasksAndInvalidate() } }
        let data = try await post(origin: pairing.origin, action: "preview", body: ["nonce": qr.nonce], token: pairing.token, session: transport)
        return try RealtimeMacPairingPreview.decode(data, qr: qr)
    }

    /// The caller verifies the owner locally before this explicit approval. Server checks paired owner authority.
    static func approve(_ qr: RealtimeMacPairingQR, pairing: RealtimeDevicePairing, ownerProof: [String: Any], session: URLSession? = nil) async throws {
        guard pairing.deviceType == nil, qr.origin == pairing.origin, qr.expiresAt > Date() else {
            throw RealtimeDevicePairingError.invalidPairing
        }
        let transport = session ?? ProductionRealtimePublicControlProvider.makeSession()
        defer { if session == nil { transport.finishTasksAndInvalidate() } }
        let data = try await post(origin: pairing.origin, action: "approve", body: ["nonce": qr.nonce, "owner_proof": ownerProof],
                           token: pairing.token, session: transport)
        guard let receipt = try JSONSerialization.jsonObject(with: data) as? [String: String],
              receipt == ["status": "approved"] else { throw RealtimeDevicePairingError.invalidPairing }
    }

    private static func post(origin: String, action: String, body: [String: Any], token: String? = nil, session: URLSession) async throws -> Data {
        guard try EndpointResolver.canonicalRealtimeOrigin(from: origin) == origin,
              let url = URL(string: origin + "/v1/devices/mac/pairing/" + action) else { throw RealtimeDevicePairingError.invalidPairing }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: request, delegate: RealtimeNoRedirectDelegate())
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        if http.statusCode == 410 { throw RealtimeMacPairingError.expired }
        guard http.statusCode == 200 else { throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(http.statusCode, nil) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 16_384 else { throw RealtimeDevicePairingError.invalidPairing }
            data.append(byte)
        }
        return data
    }
}
