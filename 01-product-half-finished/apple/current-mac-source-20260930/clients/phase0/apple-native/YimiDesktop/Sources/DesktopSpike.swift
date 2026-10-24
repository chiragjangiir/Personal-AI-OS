import CryptoKit
import Darwin
import Foundation

struct SpikeFiles: RealtimeDevicePairingStoring, DeviceIdentityStoring, SettingsStoring, E2EERecipientKeyStoring {
    let data: Data
    let pairing: RealtimeDevicePairing
    let recipient: Data
    init(pairingPath: String, keyPath: String) throws {
        data = try Self.read(pairingPath); pairing = try RealtimeDevicePairing.decode(data)
        recipient = try Self.read(keyPath)
        guard recipient.count == 32, pairing.origin != RealtimeAPIOriginMigration.legacyOrigin,
              URL(string: pairing.origin)?.host != URL(string: RealtimeAPIOriginMigration.canonicalOrigin)?.host else { throw CentralTextError.unavailable }
    }
    static func read(_ path: String) throws -> Data {
        let stat = try FileManager.default.attributesOfItem(atPath: path)
        guard path.hasPrefix("/"), stat[.type] as? FileAttributeType == .typeRegular,
              (stat[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let permissions = stat[.posixPermissions] as? NSNumber, permissions.intValue & 0o077 == 0 else { throw CentralTextError.unavailable }
        return try Data(contentsOf: URL(fileURLWithPath: path))
    }
    func loadPairingData() throws -> Data? { data }
    func replacePairingData(_ data: Data) throws { throw CentralTextError.unavailable }
    func deviceID() throws -> UUID { UUID(uuidString: pairing.deviceID)! }
    func loadSettings() async throws -> AppSettings { AppSettings(endpoint: pairing.origin) }
    func saveSettings(_ settings: AppSettings) async throws { throw CentralTextError.unavailable }
    func loadConsent() async throws -> ConsentReceipt? { nil }
    func saveConsent(_ receipt: ConsentReceipt?) async throws { throw CentralTextError.unavailable }
    func loadOrCreateRecipientPrivateKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipient)
    }
}

@MainActor final class SpikeSensors: AssistantLocationProviding, MediaPermissionProviding {
    func authorizationStatus() -> AssistantPermissionStatus { .unavailable }
    func requestWhenInUseAuthorization(userInitiated: Bool) async throws -> AssistantPermissionStatus { throw CentralTextError.unavailable }
    func requestOneShot(userInitiated: Bool) async throws -> AssistantLocationObservation { throw CentralTextError.unavailable }
    func snapshot() async -> AssistantMediaPermissionSnapshot { .init(camera: .unavailable, microphone: .unavailable) }
    func authorize(source: AssistantMediaSource, userInitiated: Bool) async throws -> AssistantPermissionStatus { throw CentralTextError.unavailable }
}

final class SpikeMeter: @unchecked Sendable {
    let start = ProcessInfo.processInfo.systemUptime
    private let lock = NSLock()
    private var seen = Set<String>()
    func mark(_ name: String) {
        lock.withLock { if seen.insert(name).inserted {
            print("status=\(name) elapsed_ms=\(Int((ProcessInfo.processInfo.systemUptime - start) * 1000))")
        } }
    }
    func rss(_ name: String) throws {
        var info = mach_task_basic_info(), count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { throw CentralTextError.unavailable }
        print("status=\(name) rss_bytes=\(info.resident_size)")
    }
}

@MainActor func runDesktopSpike(_ options: [String: String]) async throws {
    guard let pairingPath = options["--pairing"], let keyPath = options["--recipient-key"] else { throw CentralTextError.unavailable }
    let files = try SpikeFiles(pairingPath: pairingPath, keyPath: keyPath), meter = SpikeMeter(), promptID = RealtimeUUIDv7.make()
    let control = ProductionRealtimePublicControlProvider(settingsStore: files, credentialStore: PairedRealtimeCredentialStore(store: files, identity: files),
        canonicalBodyProvider: PairedRealtimeRequestBodyProvider(store: files), recipientKeyStore: files)
    let transport = LiveKitSessionAdapter(roomOperator: SystemLiveKitRoomOperator(encryptionProvider: ProductionLiveKitEncryptionOptionsProvider(control: control)))
    let sensors = SpikeSensors(), updates = AsyncStream<AssistantCentralTextConsumer>.makeStream(bufferingPolicy: .bufferingNewest(64))
    let session = AssistantSessionCoordinator(bootstrapProvider: control, realtime: transport, mediaPermissions: sensors,
        locationService: sensors, receipts: AppleReceiptStore(), careIdentity: { (CentralOwnerDataIdentity.pairing(files.pairing), files.pairing.deviceID) })
    await session.setObserver { snapshot in
        switch snapshot.state {
        case .bootstrapping: meter.mark("bootstrap")
        case .active(true): meter.mark("e2ee_active")
        default: break
        }
    }
    await session.setCentralTextObserver { updates.continuation.yield($0) }
    try meter.rss("idle")
    let deadline = Task { try await Task.sleep(for: .seconds(180)); updates.continuation.finish(); _ = await session.stop(reasonCode: "spike_timeout") }
    defer { deadline.cancel(); updates.continuation.finish() }
    do {
        try await session.start(AssistantStartIntent(userInitiated: true))
        guard await session.snapshot() == .active(encryptionActive: true) else { throw LiveKitSessionError.e2eeUnavailable }
        try meter.rss("connected")
        try await session.submitPrompt(AssistantPromptEnvelope(promptID: promptID, text: options["--prompt"] ?? "请只回复已连接，不要调用工具。"))
        let observed = ISO8601DateFormatter()
        observed.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var rendered: CentralTextPresentation?, acknowledged = false
        for await consumer in updates.stream where consumer.eventID == promptID {
            if let presentation = consumer.presentation, presentation != rendered {
                meter.mark("first_token"); if presentation.isFinal { meter.mark("final") }
                try await session.centralTextConsumed(presentation, observedAt: observed.string(from: Date()))
                rendered = presentation
                continue
            }
            if consumer.ackConfirmed, let rendered, rendered.isFinal, consumer.presentation == rendered { acknowledged = true; meter.mark("rendered_ack"); break }
        }
        guard acknowledged, rendered?.isFinal == true else { throw CentralTextError.unavailable }
        guard await session.stop(reasonCode: "spike_complete").confirmed else { throw AssistantBootstrapError.remoteStopUnconfirmed }
        meter.mark("complete")
    } catch { _ = await session.stop(reasonCode: "spike_failed"); throw error }
}
