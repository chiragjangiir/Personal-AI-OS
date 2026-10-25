import AppKit
import CryptoKit
import DesktopKit
import XCTest

final class DesktopUIRenderingTests: XCTestCase {
    @MainActor
    func testAndroidSettingsStatesRenderOffline() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yimi-phone-ui-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root.appendingPathComponent("state"))
        let secrets = RenderingPairingSecrets()
        let pairing = try DesktopPairingController(store: DesktopPairingStore(pairingStore: secrets, recipientStore: secrets))
        let configured = ProcessInfo.processInfo.environment["YIMI_ANDROID_UI_EXPORT_DIR"]
            ?? ProcessInfo.processInfo.environment["TEST_RUNNER_YIMI_ANDROID_UI_EXPORT_DIR"]
        let output = configured.map { URL(fileURLWithPath: $0) } ?? root.appendingPathComponent("renders")
        let windowsBefore = NSApp?.windows.count ?? 0
        for (name, state, enabled, error) in [
            ("stopped", AndroidHostStatus.State.stopped, true, nil as String?),
            ("not-installed", .notInstalled, false, nil),
            ("starting", .starting, true, nil),
            ("running", .running, true, nil),
            ("disabled", .stopped, false, nil),
            ("network-error", .stopped, true, "安卓手机还没联网：网络或代理尚未就绪。")
        ] {
            let files = try DesktopUIRenderer.export(model: model, pairing: pairing, directory: output,
                variant: name, screens: ["settings-设备", "settings-phone"],
                androidStatus: AndroidHostStatus(state: state, error: error), androidEnabled: enabled)
            XCTAssertEqual(files.count, 4)
            for file in files {
                let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: file)))
                XCTAssertGreaterThan(distinctSamples(image), 3, file.lastPathComponent)
            }
        }
        XCTAssertEqual(NSApp?.windows.count ?? 0, windowsBefore)
        XCTAssertEqual(secrets.keyRequests, 0)
        XCTAssertNil(model.androidHost)
        print("Android Settings headless export: " + output.path)
    }

    @MainActor
    func testApprovedV1ScreensRenderWithoutWindowsOrPermissions() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yimi-ui-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root.appendingPathComponent("state"))
        let secrets = RenderingPairingSecrets()
        let controller = try DesktopPairingController(store: DesktopPairingStore(pairingStore: secrets, recipientStore: secrets))
        let attachment = root.appendingPathComponent("报价单.pdf")
        try Data("UI fixture".utf8).write(to: attachment)
        try await model.composer.attach([attachment], via: .drag)
        let deviceID = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [deviceID], policyDecisionRefs: [deviceID], purposeTokenRefs: [deviceID], capabilityGrantRefs: [deviceID])
        let artifact = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: deviceID, userID: "01900000-0000-7000-8000-000000000002", token: "rendering-fixture-token-00000000", governance: governance, media: ["data", "audio"], pairedAt: "2026-10-15T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools", "microphone", "notifications"])
        let paired = try RealtimeDevicePairing.decode(JSONEncoder().encode(artifact))
        model.pairing = paired
        model.terminals = try JSONDecoder().decode([CentralTerminal].self, from: Data(#"[{"device_id":"01900000-0000-7000-8000-000000000001","device_class":"mac","label":"示例用户的 MacBook Pro","paired_at":"2026-10-15T00:00:00Z","connected":true,"self":true,"paused":false},{"device_id":"01900000-0000-7000-8000-000000000003","device_class":"iphone","label":"示例用户的 iPhone","paired_at":"2026-10-15T00:00:00Z","connected":true,"self":false},{"device_id":"01900000-0000-7000-8000-000000000004","device_class":"glasses","label":"眼镜","paired_at":"2026-10-15T00:00:00Z","connected":false,"self":false}]"#.utf8))
        model.connected = true; model.connectionLabel = "已连接 · 测试环境"
        model.timeline = [
            YimiItem(id: "owner", kind: .me, text: "把 9 月发票整理成表格。", date: Date(), attachments: [CentralTimelineAttachment(name: "发票.pdf", kind: "pdf", size: 4096)]),
            YimiItem(id: "reply", kind: .her, text: "整理好了，汇总表放在文稿 / 依米。", date: Date())
        ]
        let progress = try AssistantCentralTextWire.decode(Data(#"{"schema_version":"paios.central.text-envelope.v1","operation":"errand_progress","session_id":"ui-test","errands":[{"job_id":"job-012345abcdef","title":"整理 9 月发票","app":"desktop","state":"running","started_at":"2026-10-15T21:40:00.000Z","step":3,"max_steps":12}]}"#.utf8))
        model.errands = try (progress.fields.value("errands", as: [CentralBody].self) ?? []).map(CentralErrand.init)
        model.confirmations = [CentralPendingConfirmation(confirmation_id: "trash", kind: "native_approval", text: "第一次移到废纸篓前，等你在手机上确认。", expires_in_ms: 240000, answer_on: "phone")]
        model.folders = [AuthorizedFolder(id: "/home/example/Downloads", label: "下载", write: true), AuthorizedFolder(id: "/home/example/Documents/依米", label: "文稿 / 依米", write: true)]
        let resultFile = root.appendingPathComponent("9 月发票汇总.xlsx")
        try Data("UI result fixture".utf8).write(to: resultFile)
        model.grants = await model.desktop.grants()
        model.auditEntries = [
            AuditEntry(id: "granted", at: Date().addingTimeInterval(-60), tool: "file_grant", toolClass: "grant", names: ["报价单.pdf"], count: 1, decision: "allowed", result: "ok", errorCode: nil, undo: .grant, undoneAt: nil, reveal: nil),
            AuditEntry(id: "saved", at: Date(), tool: "save_from_workshop", toolClass: "transfer", names: ["9 月发票汇总.xlsx"], count: 1, decision: "allowed", result: "ok", errorCode: nil, undo: .create, undoneAt: nil, reveal: resultFile),
            AuditEntry(id: "denied", at: Date().addingTimeInterval(-90), tool: "read_text_file", toolClass: "read", names: [".env"], count: 1, decision: "denied", result: "error", errorCode: "GUARD_SENSITIVE_PATH", undo: nil, undoneAt: nil, reveal: nil)
        ]
        let exportPath = ProcessInfo.processInfo.environment["YIMI_UI_EXPORT_DIR"] ?? ProcessInfo.processInfo.environment["TEST_RUNNER_YIMI_UI_EXPORT_DIR"]
        let output = exportPath.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? root.appendingPathComponent("renders")
        print("Headless UI export: " + output.path)
        let windowsBefore = NSApp?.windows.count ?? 0
        var files = try DesktopUIRenderer.export(model: model, pairing: controller, directory: output)
        let variants: [(String, String, Set<PauseReason>, Bool)] = [
            ("offline", "未连接 · 正在重新连接", [], false),
            ("paused", "已连接 · 测试环境", [.manual], true),
            ("revoked", "这台电脑已解除配对", [], false)
        ]
        for (name, label, reasons, connected) in variants {
            model.connectionLabel = label; model.connected = connected
            model.pause = PauseState(reasons: reasons)
            if name == "revoked" { model.timeline = []; model.confirmations = []; model.errands = []; model.pairing = nil; model.terminals = [] }
            files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output, variant: name, screens: ["chat", "menu"])
        }
        model.pairing = paired; model.connected = true; model.connectionLabel = "已连接 · 测试环境"; model.listening = true
        files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output, variant: "ptt", screens: ["chat", "voice-hud"])
        model.listening = false; model.voiceFeedback = "已发给依米"
        files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output, variant: "ptt-ended", screens: ["voice-hud"])
        model.voiceFeedback = "没听清，再说一次"
        files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output, variant: "ptt-silence", screens: ["voice-hud"])
        let connectedScreens = ["chat", "menu", "unpair", "activity", "settings-通用", "settings-她的样子",
                                "settings-权限", "settings-文件夹", "settings-设备", "settings-模型与密钥", "settings-隐私", "settings-微信与隐私"]
            + (0..<4).map { "onboarding-\($0)" }
        let screenVariants = connectedScreens.map { "connected-" + $0 }
            + ["offline", "paused", "revoked"].flatMap { variant in ["chat", "menu"].map { variant + "-" + $0 } }
            + ["ptt-chat", "ptt-voice-hud", "ptt-ended-voice-hud", "ptt-silence-voice-hud"]
        let expectedFiles = screenVariants.flatMap { screen in ["light", "dark"].map { screen + "-" + $0 + ".png" } }
        XCTAssertEqual(files.count, 52)
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), Set(expectedFiles))
        for file in files {
            let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: file)))
            XCTAssertGreaterThan(image.pixelsWide, 600); XCTAssertGreaterThan(image.pixelsHigh, 100)
            XCTAssertGreaterThan(distinctSamples(image), 3, "Blank content export: " + file.lastPathComponent)
            if file.lastPathComponent.hasPrefix("connected-chat") {
                XCTAssertGreaterThan(distinctSamples(image, middleOnly: true), 3, "Chat timeline was not rendered")
            }
        }
        XCTAssertEqual(NSApp?.windows.count ?? 0, windowsBefore)
        XCTAssertEqual(secrets.keyRequests, 0)

    }
    private func distinctSamples(_ image: NSBitmapImageRep, middleOnly: Bool = false) -> Int {
        var colors = Set<UInt32>()
        let lower = middleOnly ? image.pixelsHigh / 4 : 0
        let upper = middleOnly ? image.pixelsHigh * 2 / 3 : image.pixelsHigh
        for y in stride(from: lower, to: upper, by: max(1, image.pixelsHigh / 90)) {
            for x in stride(from: 0, to: image.pixelsWide, by: max(1, image.pixelsWide / 90)) {
                if let color = image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
                    colors.insert(UInt32(color.redComponent * 255) << 16 | UInt32(color.greenComponent * 255) << 8 | UInt32(color.blueComponent * 255))
                }
            }
        }
        return colors.count
    }
}

private final class RenderingPairingSecrets: DesktopPairingPersisting, DesktopRecipientKeyPersisting, @unchecked Sendable {
    private(set) var keyRequests = 0
    func loadPairingData() throws -> Data? { nil }
    func replacePairingData(_ data: Data) throws { }
    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool { false }
    func removePairing() throws { }
    func loadOrCreateRecipientPrivateKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        keyRequests += 1; throw CocoaError(.featureUnsupported)
    }
    func removeRecipientPrivateKey() throws { }
}
