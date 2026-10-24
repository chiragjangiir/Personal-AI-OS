import Foundation

enum EndpointResolver {
    static let ingestPath = "/v1/healthkit/ingest"
    static let readinessPath = "/readyz"
    static let statusPath = "/v1/healthkit/status"

    static func ingestURL(from configuredValue: String) throws -> URL {
        let trimmed = configuredValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let url = URL(string: trimmed),
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            let host = components.host,
            !host.isEmpty,
            isAllowed(scheme: scheme, host: host),
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil
        else {
            throw ExporterError.invalidEndpoint
        }

        let path = components.percentEncodedPath
        guard path.isEmpty || path == "/" || path == ingestPath else {
            throw ExporterError.invalidEndpoint
        }
        components.path = ingestPath
        guard let result = components.url else {
            throw ExporterError.invalidEndpoint
        }
        return result
    }

    private static func isAllowed(scheme: String, host: String) -> Bool {
        if scheme == "https" {
            return true
        }
#if DEBUG
        return scheme == "http" && isLocalTestHost(host)
#else
        return false
#endif
    }

    private static func isLocalTestHost(_ host: String) -> Bool {
        let lowercased = host.lowercased()
        let normalized = lowercased.hasPrefix("[") && lowercased.hasSuffix("]")
            ? String(lowercased.dropFirst().dropLast())
            : lowercased
        if normalized == "localhost"
            || normalized.hasSuffix(".local")
            || normalized == "::1"
            || normalized.hasPrefix("fe80:")
            || normalized.hasPrefix("fc")
            || normalized.hasPrefix("fd") {
            return true
        }

        let octets = normalized.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else {
            return false
        }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
    }

    static func destinationHost(from configuredValue: String) throws -> String {
        let url = try ingestURL(from: configuredValue)
        guard let host = url.host else {
            throw ExporterError.invalidEndpoint
        }
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }

    static func canonicalRealtimeOrigin(from value: String) throws -> String {
        guard let parts = URLComponents(string: value), parts.scheme == "https",
              parts.host == parts.host?.lowercased(),
              parts.port.map({ (1...65535).contains($0) }) ?? true,
              try destinationOrigin(from: value) == value else { throw ExporterError.invalidEndpoint }
        return value
    }

    static func destinationOrigin(from configuredValue: String) throws -> String {
        let url = try ingestURL(from: configuredValue)
        guard var components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ) else {
            throw ExporterError.invalidEndpoint
        }
        components.scheme = components.scheme?.lowercased()
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let origin = components.string else {
            throw ExporterError.invalidEndpoint
        }
        return origin
    }

    static func readinessURL(from ingestURL: URL) throws -> URL {
        try endpointURL(from: ingestURL, path: readinessPath)
    }

    static func statusURL(from ingestURL: URL) throws -> URL {
        try endpointURL(from: ingestURL, path: statusPath)
    }

    private static func endpointURL(from ingestURL: URL, path: String) throws -> URL {
        guard var components = URLComponents(
            url: ingestURL,
            resolvingAgainstBaseURL: false
        ) else {
            throw ExporterError.invalidEndpoint
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        guard let result = components.url else {
            throw ExporterError.invalidEndpoint
        }
        return result
    }
}

protocol BackendDataStatusFetching: Sendable {
    func fetchStatus(at ingestEndpoint: URL, token: String) async throws
        -> BackendDataStatusSnapshot
}

final class BackendDataStatusClient: BackendDataStatusFetching, @unchecked Sendable {
    private static let maximumResponseBytes = 64_000
    private let session: URLSession

    init(session: URLSession = BackendDataStatusClient.makeSession()) {
        self.session = session
    }

    func fetchStatus(
        at ingestEndpoint: URL,
        token: String
    ) async throws -> BackendDataStatusSnapshot {
        guard !token.isEmpty, !token.contains("\n"), !token.contains("\r") else {
            throw ExporterError.missingToken
        }
        var request = URLRequest(
            url: try EndpointResolver.statusURL(from: ingestEndpoint)
        )
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw MessageError(message: "状态接口返回了非 HTTP 响应。")
            }
            guard data.count <= Self.maximumResponseBytes else {
                throw MessageError(message: "状态接口响应超过安全上限。")
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw MessageError(
                    message: "状态接口返回 HTTP \(httpResponse.statusCode)。"
                )
            }
            let snapshot: BackendDataStatusSnapshot
            do {
                snapshot = try JSONDecoder.exporter.decode(
                    BackendDataStatusSnapshot.self,
                    from: data
                )
            } catch {
                throw MessageError(message: "状态接口返回的响应无效。")
            }
            guard snapshot.schemaVersion == 1 else {
                throw MessageError(message: "状态接口使用了不受支持的数据结构版本。")
            }
            return snapshot
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        }
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

protocol BackendAvailabilityChecking: Sendable {
    func isBackendAvailable(at ingestEndpoint: URL) async throws -> Bool
}

final class BackendAvailabilityClient: BackendAvailabilityChecking, @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession = BackendAvailabilityClient.makeSession()) {
        self.session = session
    }

    func isBackendAvailable(at ingestEndpoint: URL) async throws -> Bool {
        var request = URLRequest(
            url: try EndpointResolver.readinessURL(from: ingestEndpoint)
        )
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return false
            }
            return (200..<300).contains(httpResponse.statusCode)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return false
        }
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

protocol Uploading: Sendable {
    func upload(
        _ item: OutboxItem,
        endpoint: URL,
        token: String,
        now: Date
    ) async -> UploadDisposition
}

final class UploadClient: Uploading, @unchecked Sendable {
    static let maximumPayloadBytes = 1_000_000
    private static let maximumResponseBytes = 64_000

    private struct Acceptance: Decodable {
        let batchId: UUID
    }

    private let session: URLSession

    init(session: URLSession = UploadClient.makeSession()) {
        self.session = session
    }

    func upload(
        _ item: OutboxItem,
        endpoint: URL,
        token: String,
        now: Date
    ) async -> UploadDisposition {
        guard item.payload.count <= Self.maximumPayloadBytes else {
            return .permanent(
                message: ExporterError.payloadTooLarge(Self.maximumPayloadBytes)
                    .localizedDescription
            )
        }
        guard !token.isEmpty, !token.contains("\n"), !token.contains("\r") else {
            return .permanent(message: ExporterError.missingToken.localizedDescription)
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.httpBody = item.payload
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(item.batchId.uuidString, forHTTPHeaderField: "Idempotency-Key")

        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return .permanent(message: "上传接口返回了非 HTTP 响应。")
            }
            if data.count > Self.maximumResponseBytes {
                return .permanent(message: "上传接口响应超过安全上限。")
            }

            if (200..<300).contains(httpResponse.statusCode) {
                guard
                    let acceptance = try? JSONDecoder().decode(Acceptance.self, from: data),
                    acceptance.batchId == item.batchId
                else {
                    return .permanent(message: ExporterError.responseMismatch.localizedDescription)
                }
                return .accepted
            }

            let statusMessage = "服务器返回 HTTP \(httpResponse.statusCode)。"
            if httpResponse.statusCode == 408
                || httpResponse.statusCode == 429
                || (500..<600).contains(httpResponse.statusCode) {
                let retryAfter = RetryAfterParser.interval(
                    from: httpResponse.value(forHTTPHeaderField: "Retry-After"),
                    now: now
                )
                return .retryable(message: statusMessage, retryAfter: retryAfter)
            }
            if (400..<500).contains(httpResponse.statusCode) {
                return .permanent(message: statusMessage)
            }
            return .retryable(message: statusMessage, retryAfter: nil)
        } catch {
            if error is CancellationError {
                return .retryable(message: "上传已取消。", retryAfter: nil)
            }
            return .retryable(
                message: "网络请求失败：\(UserFacingError.message(for: error))",
                retryAfter: nil
            )
        }
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }
}

enum RetryAfterParser {
    static func interval(from value: String?, now: Date) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        if let seconds = TimeInterval(value), seconds >= 0 {
            return seconds
        }

        for format in [
            "EEE',' dd MMM yyyy HH':'mm':'ss z",
            "EEEE',' dd-MMM-yy HH':'mm':'ss z",
            "EEE MMM d HH':'mm':'ss yyyy"
        ] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = format
            if let date = formatter.date(from: value) {
                return max(0, date.timeIntervalSince(now))
            }
        }
        return nil
    }
}

struct RetryPolicy: Sendable {
    let baseDelay: TimeInterval
    let maximumBackoff: TimeInterval

    init(
        baseDelay: TimeInterval = 2,
        maximumBackoff: TimeInterval = 3_600
    ) {
        self.baseDelay = baseDelay
        self.maximumBackoff = maximumBackoff
    }

    func delay(
        afterAttempt attempt: Int,
        retryAfter: TimeInterval?,
        jitterUnit: Double
    ) -> TimeInterval {
        let exponent = min(max(attempt, 0), 20)
        let exponential = min(maximumBackoff, baseDelay * pow(2, Double(exponent)))
        let normalizedJitter = min(max(jitterUnit, 0), 1)
        let jittered = exponential * (0.75 + normalizedJitter * 0.5)
        let serverDelay = max(retryAfter ?? 0, 0)
        return max(jittered, serverDelay)
    }
}

enum Redactor {
    static func redact(
        _ message: String,
        token: String?,
        endpoint: URL?
    ) -> String {
        var result = message
        if let token, !token.isEmpty {
            result = result.replacingOccurrences(of: token, with: "<令牌已脱敏>")
        }
        result = result.replacingOccurrences(
            of: #"(?i)Bearer\s+[^\s,;]+"#,
            with: "Bearer <令牌已脱敏>",
            options: .regularExpression
        )
        if let endpoint {
            result = result.replacingOccurrences(
                of: endpoint.absoluteString,
                with: "\(endpoint.scheme ?? "https")://\(endpoint.host ?? "<主机已脱敏>")/<路径已脱敏>"
            )
        }
        return String(result.prefix(512))
    }
}
