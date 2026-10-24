import Combine
import CryptoKit
import Foundation
import Security

protocol DesktopPairingPersisting: RealtimeDevicePairingStoring { func removePairing() throws }
protocol DesktopRecipientKeyPersisting: E2EERecipientKeyStoring { func removeRecipientPrivateKey() throws }
extension KeychainRealtimeDevicePairingStore: DesktopPairingPersisting {}
extension KeychainE2EERecipientKeyStore: DesktopRecipientKeyPersisting {}

/// A7.2: use Core's file-based login Keychain seam and its code-signature ACL.
/// This process cache avoids Keychain reads while the screen is locked.
final class DesktopPairingStore: RealtimeDevicePairingStoring, E2EERecipientKeyStoring, @unchecked Sendable {
    private let pairings: any DesktopPairingPersisting
    private let recipients: any DesktopRecipientKeyPersisting
    private let lock = NSLock()
    private var pairingData: Data?
    private var recipient: Curve25519.KeyAgreement.PrivateKey?

    init(pairingStore: any DesktopPairingPersisting = KeychainRealtimeDevicePairingStore(accessibility: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, dataProtectionKeychain: false),
         recipientStore: any DesktopRecipientKeyPersisting = KeychainE2EERecipientKeyStore(accessibility: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, dataProtectionKeychain: false)) throws {
        pairings = pairingStore
        recipients = recipientStore
        pairingData = try pairings.loadPairingData()
        if let pairingData {
            guard try RealtimeDevicePairing.decode(pairingData).deviceType == "mac" else { throw RealtimeDevicePairingError.invalidPairing }
            recipient = try recipients.loadOrCreateRecipientPrivateKey()
        }
    }

    func loadPairingData() throws -> Data? { lock.withLock { pairingData } }
    func loadOrCreateRecipientPrivateKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        try lock.withLock {
            if let recipient { return recipient }
            let key = try recipients.loadOrCreateRecipientPrivateKey()
            recipient = key
            return key
        }
    }
    func replacePairingData(_ data: Data) throws {
        try lock.withLock {
            guard try RealtimeDevicePairing.decode(data).deviceType == "mac" else { throw RealtimeDevicePairingError.invalidPairing }
            try pairings.replacePairingData(data)
            pairingData = data
        }
    }
    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool {
        try lock.withLock {
            guard pairingData == expected else { return false }
            guard try RealtimeDevicePairing.decode(data).deviceType == "mac" else { throw RealtimeDevicePairingError.invalidPairing }
            try pairings.replacePairingData(data)
            pairingData = data
            return true
        }
    }
    func clear() throws {
        try lock.withLock {
            try pairings.removePairing()
            pairingData = nil
            recipient = nil
            try recipients.removeRecipientPrivateKey()
        }
    }
}

enum DesktopPairingError: LocalizedError {
    case rejected(Int)
    case invalidCode
    var errorDescription: String? {
        switch self {
        case .rejected(403): return "二维码已失效 · 回到 Mac 刷新"
        case .rejected: return "连接失败 · 请检查网络，并回到 Mac 刷新二维码。"
        case .invalidCode: return "二维码已失效 · 回到 Mac 刷新"
        }
    }
}

@MainActor
final class DesktopPairingController: ObservableObject {
    @Published private(set) var pairing: RealtimeDevicePairing?
    @Published private(set) var isPairing = false
    @Published private(set) var qrData: Data?
    @Published private(set) var qrExpiresAt: Date?
    @Published private(set) var qrStatus: String?
    private var qrGeneration = UUID()
    @Published private(set) var errorMessage: String?
    let computerName = String((Host.current().localizedName ?? "Mac").unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(64))
    let store: DesktopPairingStore
    private let session: URLSession
    private let ownerUnlockEnabled: Bool

    init(store: DesktopPairingStore, session: URLSession = ProductionRealtimePublicControlProvider.makeSession(), ownerUnlockEnabled: Bool = false) throws {
        self.store = store
        self.session = session
        self.ownerUnlockEnabled = ownerUnlockEnabled
        pairing = try store.loadPairingData().map(RealtimeDevicePairing.decode)
    }

    private static func registrationCapabilities(ownerUnlockEnabled: Bool) -> [String] {
        ["display", "speaker", "microphone", "camera", "notifications", "chat_ui", "desktop_tools"] + (ownerUnlockEnabled ? ["owner_unlock"] : [])
    }
    static func registration(publicKey: RealtimeE2EERecipientRegistrationExport, label: String? = Host.current().localizedName, ownerUnlockEnabled: Bool = false) -> [String: Any] {
        var body: [String: Any] = [
            "public_raw32_base64url": publicKey.publicRaw32Base64URL,
            "public_sha256": publicKey.publicSha256,
            "device_type": "mac",
            "capabilities": registrationCapabilities(ownerUnlockEnabled: ownerUnlockEnabled)
        ]
        if let label, !label.isEmpty, label.count <= 64, label.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) {
            body["label"] = label
        }
        return body
    }

    func declareCapabilities() async throws -> RealtimeDevicePairing {
        guard let original = try store.loadPairingData() else { throw RealtimeDevicePairingError.unavailable }
        let current = try RealtimeDevicePairing.decode(original)
        var request = URLRequest(url: URL(string: current.origin + "/v1/terminals/capabilities")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(current.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["capabilities": Self.registrationCapabilities(ownerUnlockEnabled: ownerUnlockEnabled)])
        let (bytes, response) = try await session.bytes(for: request, delegate: RealtimeNoRedirectDelegate())
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 16_384 else { throw RealtimePublicControlAdapterError.responseTooLarge }
            data.append(byte)
        }
        guard response.statusCode == 200 else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(response.statusCode, error?["error"] as? String)
        }
        guard let grant = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(grant.keys) == ["governance", "media", "capabilities"],
              var artifact = try JSONSerialization.jsonObject(with: original) as? [String: Any] else {
            throw RealtimeDevicePairingError.invalidPairing
        }
        for field in ["governance", "media", "capabilities"] { artifact[field] = grant[field] }
        let updated = try JSONSerialization.data(withJSONObject: artifact)
        let declared = try RealtimeDevicePairing.decode(updated)
        guard try store.loadPairingData() == original else { throw RealtimeDevicePairingError.unavailable }
        if declared != current {
            guard try store.replacePairingData(updated, ifCurrent: original) else { throw RealtimeDevicePairingError.unavailable }
        }
        if pairing != declared { pairing = declared }
        return declared
    }

    func pair(code: String) async {
        guard !isPairing, pairing == nil else { return }
        isPairing = true
        errorMessage = nil
        defer { isPairing = false }
        do {
            let data = Data(code.utf8)
            guard data.count <= 4096,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
                  let origin = object["origin"], let token = object["token"],
                  let url = URL(string: origin + "/v1/devices/mac/enrollment/exchange") else { throw DesktopPairingError.invalidCode }
            do { _ = try RealtimeTerminalEnrollment.decode(data, origin: origin, deviceClass: .mac) }
            catch { throw DesktopPairingError.invalidCode }
            let publicKey = try RealtimeE2EERecipientKeyManager(store: store).registrationExport()
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 30
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token, "registration": Self.registration(publicKey: publicKey, ownerUnlockEnabled: ownerUnlockEnabled)])
            let (bytes, response) = try await session.bytes(for: request, delegate: RealtimeNoRedirectDelegate())
            defer { bytes.task.cancel() }
            guard let response = response as? HTTPURLResponse else { throw DesktopPairingError.invalidCode }
            guard response.statusCode == 200 else { throw DesktopPairingError.rejected(response.statusCode) }
            var responseData = Data()
            for try await byte in bytes {
                guard responseData.count < 16_384 else { throw RealtimeDevicePairingError.invalidPairing }
                responseData.append(byte)
            }
            guard let artifactObject = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                  Set(artifactObject.keys) == Set(["schema", "origin", "device_id", "user_id", "token", "governance", "media", "paired_at", "device_type", "capabilities"]) else { throw RealtimeDevicePairingError.invalidPairing }
            let artifact = try RealtimeDevicePairing.decode(responseData)
            guard artifact.deviceType == "mac", artifact.origin == origin,
                  artifact.capabilities.map(Set.init) == Set(Self.registrationCapabilities(ownerUnlockEnabled: ownerUnlockEnabled)),
                  Set(artifact.media) == Set(["data", "audio", "video"]) else { throw RealtimeDevicePairingError.invalidPairing }
            try store.replacePairingData(responseData)
            pairing = artifact
        } catch {
            errorMessage = DesktopUserFacingError.message(error)
        }
    }

    /// Caller also clears its timeline cache and last_seq, retaining audit and guard settings.
    func clearPairing() throws {
        cancelQRPairing()
        try store.clear()
        pairing = nil
        errorMessage = "这台电脑已解除配对"
    }
}

extension DesktopPairingController {
    /// Called from a view task: cancellation hides the QR and stops polling.
    func beginQRPairing(origin: String) async {
        guard !isPairing, pairing == nil else { return }
        let generation = UUID()
        qrGeneration = generation
        isPairing = true; errorMessage = nil; qrStatus = "正在生成二维码"
        defer {
            if qrGeneration == generation {
                isPairing = false; qrData = nil; qrExpiresAt = nil
            }
        }
        do {
            let publicKey = try RealtimeE2EERecipientKeyManager(store: store).registrationExport()
            let request = try await RealtimeMacPairingAPI.create(origin: origin, registration: Self.registration(publicKey: publicKey, label: computerName, ownerUnlockEnabled: ownerUnlockEnabled), session: session)
            try Task.checkCancellation()
            guard qrGeneration == generation else { return }
            qrData = request.qr.data; qrExpiresAt = request.qr.expiresAt
            qrStatus = "等待 iPhone 确认这台 Mac"
            while request.qr.expiresAt > Date() {
                try Task.checkCancellation()
                guard qrGeneration == generation else { return }
                if let data = try await RealtimeMacPairingAPI.exchange(request, session: session) {
                    try Task.checkCancellation()
                    guard qrGeneration == generation, pairing == nil else { return }
                    let artifact = try RealtimeDevicePairing.decode(data)
                    guard artifact.origin == origin, artifact.deviceType == "mac",
                          Set(artifact.capabilities ?? []) == Set(Self.registration(publicKey: publicKey, ownerUnlockEnabled: ownerUnlockEnabled)["capabilities"] as? [String] ?? []),
                          Set(artifact.media) == ["data", "audio", "video"] else { throw RealtimeDevicePairingError.invalidPairing }
                    try store.replacePairingData(data)
                    pairing = artifact; qrStatus = "已连接你的 Mac"
                    return
                }
                try await Task.sleep(for: .seconds(2))
            }
            qrStatus = "二维码已失效 · 回到 Mac 刷新"
        } catch is CancellationError {
            if qrGeneration == generation { qrStatus = "已取消" }
        } catch {
            if qrGeneration == generation { errorMessage = DesktopUserFacingError.message(error); qrStatus = "连接失败 · 重试" }
        }
    }

    func cancelQRPairing() {
        qrGeneration = UUID()
        qrData = nil; qrExpiresAt = nil; qrStatus = "已取消"; isPairing = false
    }
}
