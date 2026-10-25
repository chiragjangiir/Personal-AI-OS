import AppKit
import DesktopKit
import SwiftUI
import XCTest

@MainActor final class DesktopWeChatPreviewTests: XCTestCase {
    private func pairing() -> RealtimeDevicePairing {
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id],
            policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        return RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id,
            userID: "01900000-0000-7000-8000-000000000002", token: "test-pairing-token-00000000", governance: governance,
            media: ["data"], pairedAt: "2026-10-15T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "notifications"])
    }
    func testReceiptMustMatchDurableBatchBeforeAcknowledgement() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WeChatReceiptProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); WeChatReceiptProtocol.handler = nil }
        let preview = try DesktopWeChatPreview(file: root.appendingPathComponent("inbox.json"), session: session)
        let batch = try JSONDecoder().decode(WeChatPreviewBatch.self, from: Data(#"{"batch_id":"fixture-batch","previews":[{"id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","chat":"林可","subtitle":"","body":"明天下午几点见？","delivered_at":"2026-10-20T12:34:56.000Z"}]}"#.utf8))
        let pairing = pairing()
        for (status, batchID) in [(202, "fixture-batch"), (202, "wrong-batch"), (409, "fixture-batch")] {
            WeChatReceiptProtocol.handler = { request in
                XCTAssertEqual(request.url?.absoluteString, "https://example.test/v1/mac/wechat/previews")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + pairing.token)
                return (status, try JSONSerialization.data(withJSONObject: ["schema": "paios.wechat-previews-response.v1",
                    "batch_id": batchID, "accepted_ids": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]))
            }
            do {
                try await preview.upload(batch, pairing: pairing)
                XCTAssertEqual(status, 202); XCTAssertEqual(batchID, batch.batch_id)
            } catch { XCTAssertTrue(status != 202 || batchID != batch.batch_id) }
        }
    }
    func testPreviewSettingsAndChatRenderWithoutPresentingWindowsOrDeviceInput() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root.appendingPathComponent("state"))
        model.pairing = pairing(); model.connected = true; model.connectionLabel = "已连接 · 离线夹具"
        let configured = ProcessInfo.processInfo.environment["YIMI_WECHAT_UI_EXPORT_DIR"]
            ?? ProcessInfo.processInfo.environment["TEST_RUNNER_YIMI_WECHAT_UI_EXPORT_DIR"]
        let output = configured.map { URL(fileURLWithPath: $0) } ?? root.appendingPathComponent("renders")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let application = NSApplication.shared
        let visibleBefore = Set(application.windows.filter(\.isVisible).map(\.windowNumber))
        let keyBefore = application.keyWindow?.windowNumber, mainBefore = application.mainWindow?.windowNumber
        let activeBefore = application.isActive
        for enabled in [false, true] {
            try await model.wechatPreview.configure(enabled: enabled, names: enabled ? "林可\n工作讨论群" : "", owner: pairing().userID)
            for scheme in [ColorScheme.light, .dark] {
                let name = "wechat-\(enabled ? "enabled" : "off")-\(scheme == .light ? "light" : "dark").png"
                let data = try DesktopUIRenderer.png(DesktopSettingsView(model: model, renderingPane: .wechat),
                    size: CGSize(width: 650, height: 560), scheme: scheme)
                try data.write(to: output.appendingPathComponent(name))
                XCTAssertGreaterThan(data.count, 10_000)
            }
        }
        model.timeline = [
            YimiItem(id: "wechat-fixture", kind: .her, text: "微信原通知预览｜林可：明天下午几点见？我都可以。", date: Date(), via: "proactive"),
            YimiItem(id: "wechat-reply-fixture", kind: .her, text: "摘要\n林可问明天下午几点见。通知预览可能不完整。\n\n回复草稿 · 未发送\n我确认一下明天的安排，稍后告诉你具体时间。", date: Date(), via: "proactive")
        ]
        for scheme in [ColorScheme.light, .dark] {
            let data = try DesktopUIRenderer.png(DesktopChatView(model: model), size: CGSize(width: 500, height: 760), scheme: scheme)
            try data.write(to: output.appendingPathComponent("wechat-summary-draft-\(scheme == .light ? "light" : "dark").png"))
            XCTAssertGreaterThan(data.count, 10_000)
        }
        let windows = application.windows
        print("WeChat renderer windows: " + windows.map { "\(NSStringFromClass(type(of: $0))) visible=\($0.isVisible) key=\($0.isKeyWindow) main=\($0.isMainWindow)" }.joined(separator: "; "))
        XCTAssertEqual(Set(windows.filter(\.isVisible).map(\.windowNumber)), visibleBefore)
        XCTAssertEqual(application.keyWindow?.windowNumber, keyBefore)
        XCTAssertEqual(application.mainWindow?.windowNumber, mainBefore)
        XCTAssertEqual(application.isActive, activeBefore)
    }
}

private final class WeChatReceiptProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
