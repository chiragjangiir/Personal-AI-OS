import Foundation
import Combine
import ImageIO

/// The only messages exchanged by the local Watch/iPhone seam.
///
/// These values describe local interaction state only. They are deliberately
/// not session identifiers, operation results, delivery receipts, or shared
/// canonical contract fields.
enum WatchLocalMessageKind: String, Codable, Equatable, Sendable {
    case request
    case acknowledgement
}

enum WatchLocalAckStatus: String, Codable, Equatable, Sendable {
    case accepted
    case duplicate
    case conflict
    case rejected
    case unknown
}

enum WatchLocalEnvelopeError: Error, Equatable, Sendable {
    case malformed
    case unsupportedKey(String)
    case invalidRequest
    case invalidAcknowledgement
}

struct WatchLocalEnvelope: Codable, Equatable, Sendable {
    let version: Int?
    let args: WatchYimiActionArguments?
    let kind: WatchLocalMessageKind
    let action: WatchAssistantAction?
    let requestID: String
    let sequence: UInt64
    let status: WatchLocalAckStatus?
    let detail: String?

    init(
        kind: WatchLocalMessageKind,
        action: WatchAssistantAction?,
        requestID: String,
        sequence: UInt64,
        status: WatchLocalAckStatus? = nil,
        detail: String? = nil,
        version: Int? = nil,
        args: WatchYimiActionArguments? = nil
    ) {
        self.version = version
        self.args = args
        self.kind = kind
        self.action = action
        self.requestID = requestID
        self.sequence = sequence
        self.status = status
        self.detail = detail
    }

    init(request packet: WatchAssistantPacket) {
        self.init(
            kind: .request,
            action: packet.action,
            requestID: packet.requestID,
            sequence: packet.sequence
        )
    }

    static func acknowledgement(
        for packet: WatchAssistantPacket,
        status: WatchLocalAckStatus,
        detail: String? = nil
    ) -> WatchLocalEnvelope {
        WatchLocalEnvelope(
            kind: .acknowledgement,
            action: packet.action,
            requestID: packet.requestID,
            sequence: packet.sequence,
            status: status,
            detail: detail
        )
    }

    /// A transport-level response for a payload that cannot be decoded as a
    /// request. It has no operation meaning and is never treated as a
    /// successful request by either client.
    static var malformedAcknowledgement: WatchLocalEnvelope {
        WatchLocalEnvelope(
            kind: .acknowledgement,
            action: nil,
            requestID: "malformed",
            sequence: 0,
            status: .rejected,
            detail: "malformed_payload"
        )
    }

    func encodedStrict() throws -> Data {
        try validate()
        return try JSONEncoder().encode(self)
    }

    private enum Key: String, CodingKey, CaseIterable {
        case version, args, kind, action, requestID, sequence, status, detail
    }
    private struct AnyKey: CodingKey {
        let stringValue: String; var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: AnyKey.self)
        for key in raw.allKeys where Key(rawValue: key.stringValue) == nil {
            throw WatchLocalEnvelopeError.unsupportedKey(key.stringValue)
        }
        let f = try decoder.container(keyedBy: Key.self)
        version = try f.decodeIfPresent(Int.self, forKey: .version)
        args = try f.decodeIfPresent(WatchYimiActionArguments.self, forKey: .args)
        kind = try f.decode(WatchLocalMessageKind.self, forKey: .kind)
        action = try f.decodeIfPresent(WatchAssistantAction.self, forKey: .action)
        requestID = try f.decode(String.self, forKey: .requestID)
        sequence = try f.decode(UInt64.self, forKey: .sequence)
        status = try f.decodeIfPresent(WatchLocalAckStatus.self, forKey: .status)
        detail = try f.decodeIfPresent(String.self, forKey: .detail)
        try validate()
    }
    static func decodeStrict(_ data: Data) throws -> WatchLocalEnvelope {
        try JSONDecoder().decode(Self.self, from: data)
    }
    private func validate() throws {
        guard !requestID.isEmpty else { throw WatchLocalEnvelopeError.malformed }
        let yimi = action.map { $0 != .requestVoiceSession && $0 != .stopCurrentSession } ?? false
        if yimi {
            guard version == 1 else { throw WatchLocalEnvelopeError.invalidRequest }
        } else if version != nil || args != nil { throw WatchLocalEnvelopeError.invalidRequest }
        switch kind {
        case .request:
            guard let action, status == nil, sequence > 0 else { throw WatchLocalEnvelopeError.invalidRequest }
            if yimi {
                guard let args else { throw WatchLocalEnvelopeError.invalidRequest }
                try args.validate(for: action)
            }
        case .acknowledgement:
            guard status != nil, sequence == 0 || action != nil, args == nil else {
                throw WatchLocalEnvelopeError.invalidAcknowledgement
            }
        }
    }
}

/// A deliberately small queued hint. The iPhone may observe it, but receipt
/// of a hint is not permission to claim that a request was executed.
struct WatchLocalTransferHint: Codable, Equatable, Sendable {
    let kind: String
    let action: WatchAssistantAction
    let requestID: String
    let sequence: UInt64

    init(packet: WatchAssistantPacket) {
        self.kind = "watch_request_hint"
        self.action = packet.action
        self.requestID = packet.requestID
        self.sequence = packet.sequence
    }

    func encodedStrict() throws -> Data {
        try JSONEncoder().encode(self)
    }

    static func decodeStrict(_ data: Data) throws -> WatchLocalTransferHint {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw WatchLocalEnvelopeError.malformed
        }
        let allowed = Set(["kind", "action", "requestID", "sequence"])
        for key in dictionary.keys where !allowed.contains(key) {
            throw WatchLocalEnvelopeError.unsupportedKey(key)
        }

        let hint: WatchLocalTransferHint
        do {
            hint = try JSONDecoder().decode(
                WatchLocalTransferHint.self,
                from: data
            )
        } catch {
            throw WatchLocalEnvelopeError.malformed
        }
        guard hint.kind == "watch_request_hint",
              !hint.requestID.isEmpty,
              hint.sequence > 0 else {
            throw WatchLocalEnvelopeError.invalidRequest
        }
        return hint
    }
}


/// The display projection of the authenticated server profile on avatar-enabled Apple targets.
struct CentralAvatarProfile: Codable, Equatable, Sendable {
    struct Focus: Codable, Equatable, Sendable { let x: Double; let y: Double }
    let version: Int
    let look_id: String
    let style: String
    let image_url: URL
    let focus: Focus
    let updated_at: String

    func validate() throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: updated_at)
        formatter.formatOptions = [.withInternetDateTime]
        guard version >= 1, !look_id.isEmpty, !style.isEmpty,
              image_url.scheme?.lowercased() == "https", image_url.host != nil,
              image_url.user == nil, image_url.password == nil,
              (0...1).contains(focus.x), (0...1).contains(focus.y),
              fractional != nil || formatter.date(from: updated_at) != nil else {
            throw CocoaError(.coderInvalidValue)
        }
    }
}

private final class AvatarImageRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// One owner-scoped display cache. In-flight images can never replace a newer snapshot.
@MainActor
final class YimiAvatarStore: ObservableObject {
    static let shared = YimiAvatarStore()
    @Published private(set) var profile: CentralAvatarProfile?
    @Published private(set) var loadedVersion: Int?
    @Published private(set) var imageData: Data?
    @Published private(set) var error: String?
    private var identity: String?
    var pairingIdentity: String? { identity }
    private var task: Task<Void, Never>?
    private var requestedVersion: Int?
    private var requestedProfile: CentralAvatarProfile?
    private var eventID: UUID?
    private var generation = UUID()
    private var projectionSequence: UInt64?
    private struct Cache: Codable { let profile: CentralAvatarProfile?; let image: Data?; var projectionSequence: UInt64? = nil; var loadedVersion: Int? = nil }
    private var cacheURL: URL? {
        guard let identity else { return nil }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("yimi-avatar-" + identity + ".json")
    }

    func bind(_ identity: String?) {
        guard self.identity != identity else { return }
        let previousCache = cacheURL
        task?.cancel(); generation = UUID(); requestedProfile = nil; eventID = nil
        profile = nil; imageData = nil; loadedVersion = nil; requestedVersion = nil; error = nil; projectionSequence = nil
        self.identity = identity
        if let previousCache, FileManager.default.fileExists(atPath: previousCache.path) {
            do { try FileManager.default.removeItem(at: previousCache) }
            catch { self.error = "旧头像缓存未清除：" + error.localizedDescription }
        }
        guard let url = cacheURL, FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let cache = try JSONDecoder().decode(Cache.self, from: Data(contentsOf: url))
            try cache.profile?.validate()
            if let image = cache.image {
                guard let source = CGImageSourceCreateWithData(image as CFData, nil), CGImageSourceCreateImageAtIndex(source, 0, nil) != nil else { throw CocoaError(.fileReadCorruptFile) }
            }
            profile = cache.profile; requestedProfile = cache.profile; imageData = cache.image; projectionSequence = cache.projectionSequence
            loadedVersion = cache.profile != nil && cache.image == nil ? nil : cache.loadedVersion ?? cache.profile?.version; requestedVersion = loadedVersion
        } catch { self.error = "头像缓存无法读取：" + error.localizedDescription }
    }

    func accept(_ incoming: CentralAvatarProfile?, ownerIdentity: String?, eventID: UUID, profileVersion: Int? = nil) {
        guard let identity, identity == ownerIdentity, self.eventID != eventID else { return }
        self.eventID = eventID
        let revision = profileVersion ?? incoming?.version ?? 0
        if revision < (requestedVersion ?? 0) { return }
        if error == nil, loadedVersion == revision, incoming == profile, incoming == nil || imageData != nil { return }
        task?.cancel(); generation = UUID()
        let request = generation
        requestedProfile = incoming; requestedVersion = revision; error = nil
        guard let incoming else { loadedVersion = nil; profile = nil; imageData = nil; if persist(version: revision) { loadedVersion = revision }; return }
        task = Task {
            do {
                let data = try await Self.download(incoming)
                guard !Task.isCancelled, generation == request else { return }
                loadedVersion = nil; profile = incoming; imageData = data; if persist(version: revision) { loadedVersion = revision }
            } catch {
                guard !Task.isCancelled, generation == request else { return }
                self.error = "头像无法载入：" + error.localizedDescription
            }
        }
    }

    nonisolated private static func download(_ incoming: CentralAvatarProfile) async throws -> Data {
        try incoming.validate()
        return try await downloadImage(incoming.image_url)
    }

    nonisolated static func downloadImage(_ url: URL) async throws -> Data {
        guard url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let session = URLSession(configuration: .ephemeral, delegate: AvatarImageRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(from: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url?.scheme?.lowercased() == "https",
              response.expectedContentLength <= 5_242_880,
              response.mimeType?.hasPrefix("image/") == true else { throw CocoaError(.fileReadCorruptFile) }
        var data = Data()
        for try await byte in bytes {
            if data.count % 32_768 == 0 { try Task.checkCancellation() }
            guard data.count < 5_242_880 else { throw CocoaError(.fileReadTooLarge) }
            data.append(byte)
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, Double(width) * Double(height) <= 24_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1600
              ] as CFDictionary) else { throw CocoaError(.fileReadCorruptFile) }
        let encoded = NSMutableData()
        let type = [CGImageAlphaInfo.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo) ? "public.png" : "public.jpeg"
        guard let destination = CGImageDestinationCreateWithData(encoded, type as CFString, 1, nil) else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
        return encoded as Data
    }

    /// The paired phone supplies an already validated, bounded image; save before acknowledging it.
    func applyPhoneProjection(_ projection: WatchAppearanceProjection) throws {
        try projection.profile?.validate()
        if let image = projection.image {
            guard image.count <= 65_536, let source = CGImageSourceCreateWithData(image as CFData, nil),
                  CGImageSourceCreateImageAtIndex(source, 0, nil) != nil else {
                throw CocoaError(.fileReadCorruptFile)
            }
        }
        guard projection.profile == nil || projection.image != nil else { throw CocoaError(.coderInvalidValue) }
        let owner = projection.scope.watch_device_id + ":" + projection.scope.pair_version
        bind(owner)
        guard projection.sequence > 0, projection.sequence >= (projectionSequence ?? 0) else { throw CocoaError(.coderInvalidValue) }
        guard let url = cacheURL else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(Cache(profile: projection.profile, image: projection.image, projectionSequence: projection.sequence, loadedVersion: projection.profileVersion ?? projection.profile?.version ?? 0)).write(to: url, options: .atomic)
        projectionSequence = projection.sequence
        profile = projection.profile; requestedProfile = projection.profile; imageData = projection.image; error = nil
        loadedVersion = projection.profileVersion ?? projection.profile?.version ?? 0; requestedVersion = loadedVersion
    }

    private func persist(version: Int) -> Bool {
        guard let url = cacheURL else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Cache(profile: profile, image: imageData, loadedVersion: version)).write(to: url, options: .atomic)
            return true
        } catch { self.error = "头像缓存未保存：" + error.localizedDescription; return false }
    }
}


/// Additive WatchConnectivity context. Older clients ignore this key and retain their v1 state contract.
struct WatchAppearanceProjection: Codable, Equatable, Sendable {
    let projectionID: UUID
    let sequence: UInt64
    let scope: WatchBindingScope
    let profile: CentralAvatarProfile?
    let image: Data?
    let profileVersion: Int?

    init(projectionID: UUID, sequence: UInt64, scope: WatchBindingScope,
         profile: CentralAvatarProfile?, image: Data?, profileVersion: Int? = nil) {
        self.projectionID = projectionID; self.sequence = sequence; self.scope = scope
        self.profile = profile; self.image = image; self.profileVersion = profileVersion
    }
}
struct WatchAppearanceReceipt: Codable, Equatable, Sendable {
    let projectionID: UUID
    let scope: WatchBindingScope
    let profileVersion: Int?
    let appliedAt: Date
}
