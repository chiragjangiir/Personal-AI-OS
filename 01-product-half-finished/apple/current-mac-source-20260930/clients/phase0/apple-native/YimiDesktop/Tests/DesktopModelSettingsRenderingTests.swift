import AppKit
import Combine
import SwiftUI
import XCTest

final class DesktopModelSettingsRenderingTests: XCTestCase {
    @MainActor
    func testAuthorizationAndActivationScreensRenderWithoutWindows() async throws {
        let windows = NSApp?.windows.count ?? 0
        for (name, authorized, status) in [
            ("unauthorized", false, "effective"), ("pending", true, "pending"),
            ("effective", true, "effective"), ("failed", true, "failed")
        ] {
            let fixture = ModelSettingsRenderingServer(authorized: authorized, status: status)
            let model = try await connected(fixture)
            XCTAssertEqual(model.authorized, authorized)
            XCTAssertEqual(model.snapshot?.groups["brain"]?.status, status)
            if status == "failed" { XCTAssertEqual(model.snapshot?.activationText, "应用失败，仍用原设置") }
            try render(DesktopModelSettingsView(model: model, onPublishKey: {}), name: name, size: CGSize(width: 760, height: 1400))
        }
        XCTAssertEqual(NSApp?.windows.count ?? 0, windows)
    }

    @MainActor
    func testPagedFrozenConfirmationRendersCompleteDiff() async throws {
        let fixture = ModelSettingsRenderingServer(authorized: true, status: "effective")
        let model = try await connected(fixture)
        let role = try XCTUnwrap(model.snapshot?.roles.first)
        await model.prepareRoutes(roles: [role], summary: "渲染冻结确认")
        let review = try XCTUnwrap(model.review)
        XCTAssertTrue(review.complete)
        XCTAssertEqual(review.pageCount, 2)
        XCTAssertEqual(review.after.providers.count, 1)
        XCTAssertEqual(review.after.roles.count, 1)
        XCTAssertEqual(review.after.credentials.count, 1)
        XCTAssertTrue(review.changes.contains { $0.after.contains("render-model-v2") })
        XCTAssertTrue(review.payloadText.contains("render-model-v2"))
        let windows = NSApp?.windows.count ?? 0
        try render(DesktopModelSettingsReviewView(model: model, review: review), name: "frozen-paged", size: CGSize(width: 720, height: 780))
        XCTAssertEqual(NSApp?.windows.count ?? 0, windows)
        XCTAssertFalse(fixture.operations.contains("model_settings_commit"))
    }

    @MainActor
    private func connected(_ fixture: ModelSettingsRenderingServer) async throws -> AssistantModelSettingsModel {
        let model = AssistantModelSettingsModel(sender: { data, id, _ in try fixture.reply(data, id: id) })
        let finished = expectation(description: "server settings read")
        let observation = model.$busy.dropFirst().filter { !$0 }.prefix(1).sink { _ in finished.fulfill() }
        model.receive(.attached(CentralTransportBinding(sessionID: "rendering", deviceID: "render-mac", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, deviceClass: "mac")))
        await fulfillment(of: [finished], timeout: 3)
        withExtendedLifetime(observation) {}
        XCTAssertNil(model.error)
        XCTAssertNotNil(model.snapshot)
        return model
    }

    @MainActor
    private func render<V: View>(_ view: V, name: String, size: CGSize) throws {
        for scheme in [ColorScheme.light, .dark] {
            try renderVariant(view, name: name + (scheme == .light ? "-light" : "-dark"), size: size, scheme: scheme)
        }
    }

    @MainActor
    private func renderVariant<V: View>(_ view: V, name: String, size: CGSize, scheme: ColorScheme) throws {
        let renderer = ImageRenderer(content: view.frame(width: size.width, height: size.height)
            .environment(\.colorScheme, scheme).environment(\.desktopRendering, true))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.nsImage)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        XCTAssertEqual(bitmap.pixelsWide, Int(size.width))
        XCTAssertEqual(bitmap.pixelsHigh, Int(size.height))
        var samples = Set<String>(), middle = Set<String>()
        for x in stride(from: 0, to: bitmap.pixelsWide, by: 11) {
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: 13) {
                if let color = bitmap.colorAt(x: x, y: y) {
                    samples.insert(color.description)
                    if y >= bitmap.pixelsHigh / 4, y < bitmap.pixelsHigh * 3 / 4 { middle.insert(color.description) }
                }
            }
        }
        XCTAssertGreaterThan(samples.count, 3, "Blank settings snapshot: " + name)
        XCTAssertGreaterThan(middle.count, 3, "Settings content was not rendered: " + name)
        if let path = ProcessInfo.processInfo.environment["YIMI_MODEL_SETTINGS_UI_EXPORT_DIR"]
            ?? ProcessInfo.processInfo.environment["TEST_RUNNER_YIMI_MODEL_SETTINGS_UI_EXPORT_DIR"] {
            let directory = URL(fileURLWithPath: path, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: directory.appendingPathComponent(name + ".png"))
        }
    }
}

@MainActor
private final class ModelSettingsRenderingServer {
    let authorized: Bool
    let status: String
    var operations: [String] = []
    init(authorized: Bool, status: String) { self.authorized = authorized; self.status = status }

    func reply(_ data: Data, id: String) throws -> CentralTextPacket {
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let operation = try XCTUnwrap(input["operation"] as? String)
        operations.append(operation)
        let request = input["request"] as? [String: Any] ?? [:]
        var response: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_receipt",
            "session_id": "rendering", "control_id": id, "ok": true]
        switch operation {
        case "model_settings_read":
            response["result"] = page(frozen: request["draft_id"] != nil, offset: request["offset"] as? Int ?? 0)
        case "model_settings_watch":
            var group: [String: Any] = ["desired": 1, "effective": status == "effective" ? 1 : 0, "status": status]
            if status == "failed" { group["error"] = "示例激活失败" }
            response["result"] = ["environment_id": "render", "desired": 1, "groups": ["brain": group]]
        case "model_settings_challenge":
            if authorized { response["result"] = ["nonce": String(repeating: "A", count: 43), "expires_in_ms": 300000] }
            else { response["ok"] = false; response["error_code"] = "MODEL_SETTINGS_MAC_UNAUTHORIZED" }
        case "model_settings_draft":
            response["result"] = ["draft_id": "render-draft", "action": "commit", "principal_id": "render-owner",
                "expected_revision": 1, "change_sha256": String(repeating: "a", count: 64),
                "expires_at_ms": Date().addingTimeInterval(300).timeIntervalSince1970 * 1000]
        default: XCTFail("Unexpected settings operation: " + operation); throw CentralTextError.invalidPacket
        }
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: response))
    }

    private func page(frozen: Bool, offset: Int) -> [String: Any] {
        let provider: [String: Any] = ["id": "render-provider", "display_name": "示例服务商", "wire_protocol": "chat_completions",
            "base_url": "https://models.example.test/v1", "credential_ref": "render-key"]
        let role: [String: Any] = ["id": "brain", "profile": "owner", "provider_ref": "render-provider",
            "model_id": frozen ? "render-model-v2" : "render-model", "parameters": ["temperature": 0.5],
            "ordered_fallbacks": [], "activation_boundary": "brain_idle"]
        let credential: [String: Any] = ["credential_ref": "render-key", "version": 1, "configured": true, "last4": "1234"]
        var group: [String: Any] = ["desired": frozen ? 2 : 1,
            "effective": status == "effective" && !frozen ? 1 : 0, "status": frozen ? "pending" : status]
        if status == "failed" { group["error"] = "示例激活失败" }
        var page: [String: Any] = ["environment_id": "render", "revision": frozen ? 2 : 1, "desired": frozen ? 2 : 1,
            "groups": ["brain": group],
            "usage": ["local_date": "2026-10-24", "attempts": 3, "known_cny": 11, "estimated_cny": 0.5,
                "unknown_attempts": 1, "foreign_currency_attempts": 0, "subscription_remaining": "套餐余量未知", "threshold_cny": 10,
                "owner_reserve_cny": 1, "pause_on_limit": true, "paused": status == "failed"],
            "items": offset == 0 ? [["kind": "provider", "value": provider]] : [["kind": "role", "value": role], ["kind": "credential", "value": credential]],
            "next_offset": NSNull()]
        if offset == 0 { page["next_offset"] = 1 }
        if frozen { page["draft"] = ["draft_id": "render-draft", "action": "commit", "payload": ["providers": [], "roles": [role]]] }
        return page
    }
}
