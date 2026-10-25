#if os(iOS) && !SWIFT_PACKAGE
import XCTest
import SwiftUI
import UIKit
import Vision
@testable import HealthKitExporter

/// Pixel snapshots with OCR assertions in a temporary simulator window.
/// Attachments require visual review; there are no approved golden images.
@MainActor
final class YimiModelSettingsRenderingTests: XCTestCase {
    func testActivationFailureDistinguishesSavedAndEffectiveVersions() async throws {
        let fixture = await Fixture.ready()
        let shot = try await render(NavigationStack { YimiModelSettingsView(model: fixture.model) }, name: "activation-failed")
        XCTAssertTrue(shot.contains("应用失败，仍用原设置"), shot.text)
        XCTAssertTrue(shot.contains("期望v2"), shot.text)
        XCTAssertTrue(shot.contains("实际v1"), shot.text)
        XCTAssertTrue(shot.contains("主脑不可用"), shot.text)
        XCTAssertTrue(shot.contains("更多角色"), shot.text)
    }

    func testFrozenReviewRendersBothPagesAndFullPayload() async throws {
        let fixture = await Fixture.ready()
        var candidate = try XCTUnwrap(fixture.model.snapshot?.roles.first)
        candidate.model_id = "NEW-FIRST"
        await fixture.model.prepareRoutes(roles: [candidate], summary: "分页确认")
        XCTAssertEqual(fixture.model.review?.pageCount, 2)
        let shot = try await render(YimiModelSettingsConfirmationSheet(model: fixture.model), name: "frozen-review")
        for expected in ["完整差异", "2页", "OLD-FIRST", "NEW-FIRST", "OLD-LAST", "NEW-LAST", "FROZEN-PAYLOAD-END", "确认更改"] {
            XCTAssertTrue(shot.contains(expected), "Missing \(expected): \(shot.text)")
        }
    }

    func testConflictShowsLatestStateBesideOriginalEditingDraft() async throws {
        let fixture = await Fixture.ready()
        let original = try XCTUnwrap(fixture.model.snapshot?.roles.first)
        await fixture.model.prepareRoutes(roles: [original], summary: "CAS")
        fixture.commitError = "MODEL_SETTINGS_REVISION_CONFLICT"
        fixture.latest = true
        await fixture.model.confirm()
        XCTAssertNil(fixture.model.review)
        let shot = try await render(NavigationStack {
            YimiModelRoleView(model: fixture.model, role: original, providers: fixture.model.snapshot?.providers ?? [])
        }, name: "conflict-latest")
        for expected in ["服务器当前设置", "LATEST-FIRST", "OLD-FIRST", "从当前设置重新编辑", "设置已在另一台设备修改"] {
            XCTAssertTrue(shot.contains(expected), "Missing \(expected): \(shot.text)")
        }
    }

    func testUndoReentryAndBrainUnavailableResumeRemainVisible() async throws {
        let fixture = await Fixture.ready()
        fixture.prepareError = "MODEL_SETTINGS_KEY_REENTRY_REQUIRED"
        await fixture.model.prepareUndo(revision: 1)
        let undo = try await render(NavigationStack { YimiModelUndoView(model: fixture.model) }, name: "undo-key-reentry")
        XCTAssertTrue(undo.contains("密钥已被替换"), undo.text)
        XCTAssertTrue(undo.contains("重新填写"), undo.text)
        fixture.prepareError = nil
        await fixture.model.prepareBudget(pauseOnLimit: true, reserve: 0)
        let usage = try await render(NavigationStack { YimiModelUsageView(model: fixture.model) }, name: "brain-unavailable-resume")
        for expected in ["已暂停", "恢复", "不依赖主脑", "至少1元", "估算", "费用未知的调用"] {
            XCTAssertTrue(usage.contains(expected), "Missing \(expected): \(usage.text)")
        }
        XCTAssertFalse(usage.contains("已恢复"), "A visible resume action must not imply execution success")
    }

    private struct Shot {
        let text: String
        func contains(_ value: String) -> Bool {
            func normalized(_ value: String) -> String {
                value.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined().lowercased()
            }
            return normalized(text).contains(normalized(value))
        }
    }

    private func render<V: View>(_ content: V, name: String) async throws -> Shot {
        let size = CGSize(width: 430, height: 932)
        let host = UIHostingController(rootView: content.environment(\.dynamicTypeSize, .large).preferredColorScheme(.light))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        host.view.frame = window.bounds
        host.view.backgroundColor = .white
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        host.view.layoutIfNeeded()
        func scrollView(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height { return scroll }
            return view.subviews.lazy.compactMap { scrollView($0) }.first
        }
        let scroll = scrollView(host.view)
        let step = max(1, (scroll?.bounds.height ?? size.height) * 0.75)
        var texts: [String] = []
        var index = 0
        var offset = CGFloat.zero
        while true {
            scroll?.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(60))
            let format = UIGraphicsImageRendererFormat(); format.scale = 2
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true), "Render did not complete: \(name)")
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            let text = request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? ""
            XCTAssertFalse(text.isEmpty, "Offscreen rendering produced no readable pixels: \(name)-\(index)")
            texts.append(text)
            let attachment = XCTAttachment(image: image)
            attachment.name = "model-settings-" + name + "-\(index)"
            attachment.lifetime = .keepAlways
            add(attachment)
            guard let scroll else { break }
            // List refines estimated row heights as each page becomes visible.
            let maximum = max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            if offset >= maximum { break }
            offset = min(offset + step, maximum)
            index += 1
        }
        return Shot(text: texts.joined(separator: "\n"))
    }

    @MainActor private final class Fixture {
        var model: AssistantModelSettingsModel!
        var latest = false
        var commitError: String?
        var prepareError: String?
        private var action = "commit"
        static func ready() async -> Fixture {
            let fixture = Fixture()
            fixture.model.receive(.attached(CentralTransportBinding(sessionID: "render-session", deviceID: "render-phone",
                connectionEpoch: "render-epoch", expectedGatewayIdentity: "fixture", maxPacketBytes: 12288, deviceClass: "iphone")))
            await fixture.model.refresh()
            for _ in 0..<20 { await Task.yield() }
            return fixture
        }
        private init() {
            model = AssistantModelSettingsModel(sender: { [weak self] bytes, id, _ in
                guard let self else { throw CentralTextError.unavailable }
                let request = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
                let operation = try XCTUnwrap(request["operation"] as? String)
                let fields = request["request"] as? [String: Any] ?? [:]
                var result: [String: Any] = [:]
                var error: String?
                switch operation {
                case "model_settings_read": result = self.page(fields)
                case "model_settings_watch":
                    result = ["environment_id": "render", "desired": 2,
                        "groups": ["brain": ["desired": 2, "effective": 1, "status": "failed", "error": "主脑不可用"]]]
                case "model_settings_draft":
                    error = self.prepareError
                    self.action = fields["action"] as? String ?? "commit"
                    result = ["draft_id": "render-draft", "action": self.action, "expected_revision": 2,
                        "change_sha256": String(repeating: "a", count: 64), "principal_id": "owner",
                        "expires_at_ms": Date().addingTimeInterval(120).timeIntervalSince1970 * 1000]
                case "model_settings_challenge": result = ["nonce": String(repeating: "A", count: 43), "expires_in_ms": 120000]
                case "model_settings_commit": error = self.commitError
                default: throw CentralTextError.unavailable
                }
                var response: [String: Any] = ["operation": "model_settings_receipt", "session_id": "render-session",
                    "control_id": id, "ok": error == nil, "schema_version": "paios.central.text-envelope.v1"]
                if let error { response["error_code"] = error } else { response["result"] = result }
                return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: response))
            }, signer: { _, _ in Data(repeating: 1, count: 64) })
        }
        private func page(_ request: [String: Any]) -> [String: Any] {
            let draft = request["draft_id"] != nil
            let offset = request["offset"] as? Int ?? 0
            let prefix = draft ? "NEW" : latest ? "LATEST" : "OLD"
            let role: [String: Any] = ["id": offset == 0 ? "brain" : "vision", "profile": "owner", "provider_ref": "fixture-api",
                "model_id": prefix + (offset == 0 ? "-FIRST" : "-LAST"), "parameters": [:], "ordered_fallbacks": [], "activation_boundary": "brain_idle"]
            var items: [[String: Any]] = [["kind": "role", "value": role]]
            if offset == 0 { items.insert(["kind": "provider", "value": ["id": "fixture-api", "display_name": "Fixture API",
                "wire_protocol": "chat_completions", "base_url": "https://fixture.invalid/v1", "credential_ref": "fixture-key"]], at: 0) }
            var page: [String: Any] = ["environment_id": "render", "revision": draft ? 3 : latest ? 3 : 2, "desired": draft ? 3 : 2,
                "groups": ["brain": ["desired": 2, "effective": 1, "status": "failed", "error": "主脑不可用"]],
                "usage": ["local_date": "2026-10-24", "attempts": 3, "known_cny": 11, "estimated_cny": 0.5,
                    "unknown_attempts": 1, "foreign_currency_attempts": 0, "subscription_remaining": "未知", "threshold_cny": 10,
                    "owner_reserve_cny": 1, "pause_on_limit": true, "paused": true], "items": items]
            if offset == 0 { page["next_offset"] = 1 }
            if draft { page["draft"] = ["draft_id": "render-draft", "action": action,
                "payload": ["expected_revision": 2, "review_marker": "FROZEN-PAYLOAD-END"]] }
            return page
        }
    }
}
#endif
