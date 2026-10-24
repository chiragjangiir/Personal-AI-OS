import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// HTTP conversion only. Turn state and resend decisions belong to WatchTalkState.
enum WatchTalkHTTP {
    enum Reply: Equatable { case heard(String), working, replied(String), failed(WatchTalkFailure) }
    enum WireError: Error { case invalidCredential, invalidAudio, invalidResponse }

    static func request(_ action: WatchTalkState.Request, credential: WatchCredential) throws -> URLRequest {
        guard let base = URL(string: credential.server), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil else { throw WireError.invalidCredential }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.query = nil
        components.fragment = nil
        let path: String
        switch action {
        case .upload: path = "/v1/watch/utterances"
        case .poll(let id): path = "/v1/watch/turns/\(id.uuidString.lowercased())"
        }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + ([components.path, path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))].filter { !$0.isEmpty }.joined(separator: "/"))
        if case .poll = action { components.queryItems = [URLQueryItem(name: "wait", value: "25")] }
        guard let url = components.url else { throw WireError.invalidCredential }
        var request = URLRequest(url: url)
        request.timeoutInterval = 40
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        switch action {
        case .upload(let audio):
            guard audio.scope == credential.scope else { throw WireError.invalidCredential }
            guard !audio.bytes.isEmpty, audio.bytes.count <= 1_000_000,
                  (1...30_000).contains(audio.durationMilliseconds) else { throw WireError.invalidAudio }
            request.httpMethod = "POST"
            request.httpBody = audio.bytes
            let headers = ["X-Watch-Turn-ID": audio.id.uuidString.lowercased(), "X-Watch-Codec": "aac_lc",
                           "X-Watch-Sample-Rate-Hz": "16000", "X-Watch-Channels": "1",
                           "X-Watch-Duration-Ms": String(audio.durationMilliseconds), "Content-Type": "audio/mp4"]
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        case .poll: request.httpMethod = "GET"
        }
        return request
    }

    static func decode(_ data: Data, statusCode: Int, action: WatchTalkState.Request) throws -> Reply {
        guard let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = fields["status"] as? String else { throw WireError.invalidResponse }
        let id: UUID
        let polling: Bool
        switch action {
        case .upload(let audio): id = audio.id; polling = false
        case .poll(let value): id = value; polling = true
        }
        if let value = fields["turn_id"] {
            guard let text = value as? String, UUID(uuidString: text) == id else { throw WireError.invalidResponse }
        } else if status != "failed" { throw WireError.invalidResponse }
        let keys = Set(fields.keys)
        if status == "failed" {
            guard keys == ["status", "reason"] || keys == ["status", "reason", "turn_id"],
                  let raw = fields["reason"] as? String, let reason = WatchTalkFailure(rawValue: raw) else { throw WireError.invalidResponse }
            let codes: [WatchTalkFailure: Int] = [.invalid_request: 400, .credential_missing: 401, .credential_invalid: 401,
                .credential_expired: 401, .credential_revoked: 403, .watch_unregistered: 403, .watch_scope_denied: 403,
                .audio_too_large: 413, .audio_too_long: 413, .audio_invalid: 422, .codec_unsupported: 415,
                .not_heard: 422, .turn_conflict: 409, .turn_not_found: 404, .busy: 429,
                .service_unavailable: 503, .processing_failed: 502]
            guard codes[reason] == statusCode else { throw WireError.invalidResponse }
            return .failed(reason)
        }
        guard statusCode == 200 else { throw WireError.invalidResponse }
        if polling && status == "working" && keys == ["status", "turn_id"] { return .working }
        let key = polling ? "text" : "heard"
        guard status == (polling ? "replied" : "heard"), keys == ["status", "turn_id", key],
              let text = fields[key] as? String, !text.isEmpty else { throw WireError.invalidResponse }
        return polling ? .replied(text) : .heard(text)
    }
}
