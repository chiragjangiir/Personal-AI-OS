import AppKit
import CryptoKit
import Foundation
import SwiftUI
import XCTest

@MainActor final class DesktopActivityTests: XCTestCase {
    private func model() throws -> (DesktopAppModel, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return (try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: folder), folder)
    }
    private func fixture(_ name: String) throws -> [String: Any] {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let path = apple.appendingPathComponent("PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Tests/Fixtures/activity-update.fixtures.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
        let fixtures = try XCTUnwrap(object["fixtures"] as? [String: [String: Any]])
        var fields = try XCTUnwrap(fixtures[name == "measured_progress" ? "single_running" : name])
        if name == "measured_progress" {
            var card = try XCTUnwrap(fields["card"] as? [String: Any])
            var items = try XCTUnwrap(card["items"] as? [[String: Any]])
            card["progress"] = ["version": 1, "value": 4, "total": 10]
            items[0]["progress"] = ["version": 1, "value": 2, "total": 10]
            card["items"] = items
            fields["card"] = card
        }
        return fields
    }
    private func consumer(session: String = "session-fixture-1") throws -> AssistantCentralTextConsumer {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: session, deviceID: "mac-test", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288))
        return consumer
    }
    private func accept(_ name: String, into consumer: inout AssistantCentralTextConsumer) throws {
        let bytes = try JSONSerialization.data(withJSONObject: fixture(name))
        try consumer.accept(AssistantCentralTextWire.decode(bytes))
    }
    private func collapsed(_ model: DesktopAppModel) throws -> Bool {
        let entry = try XCTUnwrap(model.chatEntries.first { if case .activity = $0 { return true }; return false })
        guard case .activity(_, let collapsed) = entry else { throw CentralTextError.invalidPacket }
        return collapsed
    }
    func testRevisionReplacementAndExactReplyAnchoring() async throws {
        let (model, folder) = try model(); defer { try? FileManager.default.removeItem(at: folder) }
        let date = Date()
        let owner = YimiItem(id: "me-input", kind: .me, text: "打开云手机", date: date,
            submissionProcessedID: "processed-fixture-1")
        let other = YimiItem(id: "her-other-input", kind: .her, text: "另一件事完成了", date: date.addingTimeInterval(1))
        var state = try consumer()
        try accept("single_running", into: &state); await model.accept(state)
        model.timeline = [owner, other]
        XCTAssertEqual(model.chatEntries.map(\.id), ["message-me-input", "activity-a:fixture-single", "message-her-other-input"])
        try accept("single_slow", into: &state); await model.accept(state)
        try accept("single_running", into: &state); await model.accept(state)
        XCTAssertEqual(model.activities.count, 1)
        XCTAssertEqual(model.activities.first?.card.revision, 4)
        try accept("succeeded", into: &state); await model.accept(state)
        model.timeline = [owner, other]
        XCTAssertFalse(try collapsed(model), "an unrelated reply cannot collapse this card")
        model.timeline.append(YimiItem(id: "her-processed-fixture-1", kind: .her, text: "云手机已打开", date: date.addingTimeInterval(2)))
        XCTAssertTrue(try collapsed(model))
        XCTAssertEqual(model.chatEntries.map(\.id).suffix(2), ["message-her-processed-fixture-1", "activity-a:fixture-single"])
        model.beginCentralSession()
        XCTAssertTrue(model.activities.isEmpty)
        XCTAssertFalse(model.chatEntries.contains { if case .activity = $0 { return true }; return false })
    }
    func testPartialAndFailedCardsRemainExpandedAndSessionReplacementClears() async throws {
        let (model, folder) = try model(); defer { try? FileManager.default.removeItem(at: folder) }
        var state = try consumer(session: "session-fixture-2")
        try accept("parallel_six", into: &state); await model.accept(state)
        try accept("partial_done", into: &state); await model.accept(state)
        model.timeline = [YimiItem(id: "her-processed-fixture-2", kind: .her, text: "五件完成", date: Date())]
        XCTAssertFalse(try collapsed(model))
        XCTAssertEqual(model.activities.first?.card.items.count, 6)
        state = try consumer()
        try accept("failed_timeout", into: &state)
        model.beginCentralSession(); await model.accept(state)
        XCTAssertEqual(model.activities.count, 1)
        XCTAssertEqual(model.activities.first?.card.failure_reason, "超时，结果未知")
        XCTAssertFalse(try collapsed(model))
        try state.reset(binding: CentralTransportBinding(sessionID: "new-session", deviceID: "mac-test", connectionEpoch: "2",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288))
        await model.accept(state)
        XCTAssertTrue(model.activities.isEmpty)
    }
    func testDesktopConsumesExplicitProgressAndKeepsUnmeasuredWorkIndeterminate() async throws {
        let (model, folder) = try model(); defer { try? FileManager.default.removeItem(at: folder) }
        var state = try consumer()
        let fields = try fixture("measured_progress")
        try state.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields)))
        await model.accept(state)
        let measured = try XCTUnwrap(model.activities.first)
        XCTAssertEqual(measured.card.progress?.value, 4)
        XCTAssertEqual(measured.card.items.first?.progress?.value, 2)
        XCTAssertTrue(measured.accessibilityLabel(at: measured.arrivedAt).contains("进度 40%"))
        XCTAssertFalse(measured.pill.contains("件在办"))
        try accept("single_slow", into: &state); await model.accept(state)
        let unmeasured = try XCTUnwrap(model.activities.first)
        XCTAssertNil(unmeasured.card.progress, "Replacing a snapshot clears old measured progress")
        XCTAssertNil(unmeasured.card.items.first?.progress)
        XCTAssertFalse(unmeasured.accessibilityLabel(at: unmeasured.arrivedAt).contains("进度 "))
        XCTAssertTrue(unmeasured.accessibilityLabel(at: unmeasured.arrivedAt).contains("用时"))
    }
    func testOffscreenActivityScreenshots() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["ACTIVITY_SCREENSHOT_DIR"] ?? environment["TEST_RUNNER_ACTIVITY_SCREENSHOT_DIR"] else {
            throw XCTSkip("Set ACTIVITY_SCREENSHOT_DIR to export native offscreen activity snapshots")
        }
        let (model, folder) = try model(); defer { try? FileManager.default.removeItem(at: folder) }
        let secrets = ActivityRenderingSecrets()
        let controller = try DesktopPairingController(store: DesktopPairingStore(pairingStore: secrets, recipientStore: secrets))
        let output = URL(fileURLWithPath: path, isDirectory: true)
        let windowsBefore = NSApp?.windows.count ?? 0
        let fixtures = ["measured_progress", "single_running", "single_slow", "parallel_six", "failed_timeout", "partial_done", "succeeded"]
        var files: [URL] = []
        model.connected = true; model.connectionLabel = "已连接 · 测试环境"
        for name in fixtures {
            let fields = try fixture(name)
            let processedID = try XCTUnwrap(fields["processed_event_id"] as? String)
            let sessionID = try XCTUnwrap(fields["session_id"] as? String)
            var state = try consumer(session: sessionID)
            try accept(name, into: &state)
            model.beginCentralSession(); await model.accept(state)
            let date = Date(timeIntervalSince1970: 1_792_425_600)
            let owner = YimiItem(id: "me-snapshot-input", kind: .me, text: name == "parallel_six" || name == "partial_done"
                ? "打开云手机，顺便把这几件事一起办。" : "依米，帮我打开云手机。", date: date,
                submissionProcessedID: processedID)
            model.timeline = [owner]
            for (widthName, width) in [("narrow", 440.0), ("wide", 760.0)] {
                files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output,
                    variant: "native-offscreen-\(name)-\(widthName)", screens: ["chat"], chatSize: CGSize(width: width, height: 1100))
            }
            if name == "succeeded" {
                model.timeline.append(YimiItem(id: "her-" + processedID, kind: .her, text: "云手机已打开。", date: date.addingTimeInterval(1)))
                XCTAssertTrue(try collapsed(model))
                for (widthName, width) in [("narrow", 440.0), ("wide", 760.0)] {
                    files += try DesktopUIRenderer.export(model: model, pairing: controller, directory: output,
                        variant: "native-offscreen-succeeded-with-reply-\(widthName)", screens: ["chat"], chatSize: CGSize(width: width, height: 660))
                }
            }
        }
        // Shared native component at phone width; this is a macOS renderer, not an iPhone runtime.
        func savePhone(_ name: String, _ activity: ActivityPresentation, collapsed: Bool = false,
                       expanded: Bool = false, size: DynamicTypeSize = .large) throws {
            for scheme in [ColorScheme.light, .dark] {
                let suffix = scheme == .light ? "light" : "dark"
                let content = YimiActivityCard(activity: activity, collapsed: collapsed, wide: expanded)
                    .padding(16).frame(width: 330).background(Yimi.paper)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                let data = try DesktopUIRenderer.png(content, scheme: scheme)
                let url = output.appendingPathComponent("shared-native-phone-width-\(name)-\(suffix).png")
                try data.write(to: url)
            }
        }
        for name in fixtures {
            let bytes = try JSONSerialization.data(withJSONObject: fixture(name))
            let update = try JSONDecoder().decode(CentralActivityUpdate.self, from: bytes)
            let activity = ActivityPresentation(update: update, arrivedAt: Date())
            try savePhone(name, activity)
            if name == "succeeded" { try savePhone("succeeded-collapsed", activity, collapsed: true) }
            if name == "parallel_six" {
                try savePhone("parallel-six-expanded-accessibility3", activity, expanded: true, size: .accessibility3)
            }
        }
        XCTAssertEqual(files.count, 32)
        for file in files {
            let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: file)))
            XCTAssertGreaterThan(image.pixelsWide, 800)
            XCTAssertGreaterThan(image.pixelsHigh, 1200)
        }
        XCTAssertEqual(NSApp?.windows.count ?? 0, windowsBefore)
        XCTAssertEqual(secrets.keyRequests, 0)
        print("Native offscreen NSHostingView snapshots (not simulator): 32 Mac chat + 18 shared phone-width PNGs at \(output.path)")
    }

}


private final class ActivityRenderingSecrets: DesktopPairingPersisting, DesktopRecipientKeyPersisting, @unchecked Sendable {
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
