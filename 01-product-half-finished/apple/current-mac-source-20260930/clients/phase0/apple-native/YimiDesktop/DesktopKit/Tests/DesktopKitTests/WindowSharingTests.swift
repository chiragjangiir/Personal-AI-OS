import AppKit
import MCP
import Vision
import XCTest
@testable import DesktopKit

final class WindowSharingTests: XCTestCase {
    private func window(_ capture: @escaping @Sendable () async throws -> WindowScreenshot = {
        WindowScreenshot(jpeg: Data([1, 2, 3]), width: 800, height: 600)
    }) -> SharedWindow { SharedWindow(id: 42, title: "测试窗口", screenshot: capture) }

    func testSharedWindowCaptureThroughExecutorAndRevocation() async throws {
        try await TestDesktop.fixture { desktop, _, _ in
            await desktop.windowSharing.share(window())
            let result = try await desktop.call(id: "capture", name: "window_capture", arguments: ["question": "窗口里是什么？", "window_id": 42])
            XCTAssertEqual(result.objectValue?["isError"], false)
            XCTAssertEqual(result.objectValue?["content"]?.arrayValue?.first?.objectValue?["data"], "AQID")
            XCTAssertEqual(result.objectValue?["structuredContent"]?.objectValue?["width"], 800)
            let other = try await desktop.call(id: "other", name: "window_capture", arguments: ["question": "查看另一个窗口", "window_id": 43])
            XCTAssertEqual(other.objectValue?["isError"], true)
            XCTAssertEqual(other.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"], .string(WindowSharingError.otherWindow.localizedDescription))
            await desktop.pause(.manual)
            let paused = try await desktop.call(id: "paused", name: "window_capture", arguments: ["question": "窗口里是什么？"])
            XCTAssertEqual(paused.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"], "主人暂停了依米操作电脑")
            await desktop.resume(.manual)
            await desktop.windowSharing.stop()
            let stopped = try await desktop.call(id: "stopped", name: "window_capture", arguments: ["question": "窗口里是什么？"])
            XCTAssertEqual(stopped.objectValue?["isError"], true)
            XCTAssertEqual(stopped.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"], .string(WindowSharingError.notShared.localizedDescription))
        }
    }

    func testStoppingDuringCaptureDiscardsPendingImage() async throws {
        let sharing = WindowSharing(), entered = expectation(description: "capture started")
        let release = CaptureLatch()
        await sharing.share(window {
            entered.fulfill()
            await release.wait()
            return WindowScreenshot(jpeg: Data([1]), width: 1, height: 1)
        })
        let pending = Task { try await sharing.capture(windowID: nil) }
        await fulfillment(of: [entered], timeout: 2)
        await sharing.stop(); await release.resume()
        do { _ = try await pending.value; XCTFail("A revoked capture must not return pixels") }
        catch { XCTAssertEqual(error.localizedDescription, WindowSharingError.notShared.localizedDescription) }
    }

    func testCaptureErrorsStayChineseWithoutRawSystemErrors() async throws {
        let sharing = WindowSharing()
        await sharing.share(window { throw NSError(domain: "Unknown(secret)", code: 17) })
        do { _ = try await sharing.capture(windowID: nil); XCTFail("Capture must fail") }
        catch { XCTAssertEqual(error.localizedDescription, WindowSharingError.capture.localizedDescription) }
        for error in [WindowSharingError.permission, .unavailable, .notShared, .otherWindow, .capture] {
            XCTAssertFalse(error.localizedDescription.contains("Unknown("))
            XCTAssertNil(error.localizedDescription.range(of: "[A-Za-z_]", options: .regularExpression))
        }
    }

    /// Opt-in only. Creates and captures this test's own window, without manipulating other apps.
    @MainActor func testRealWindowCaptureAndLegibleText() async throws {
        guard let output = ProcessInfo.processInfo.environment["PAIOS_WINDOW_CAPTURE_PROBE"] else { throw XCTSkip("Real-window probe is opt-in") }
        _ = NSApplication.shared
        let panel = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 900, height: 350), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "依米窗口截图验证"
        let text = NSTextField(labelWithString: "Yimi window capture 7392")
        text.font = .systemFont(ofSize: 42); text.frame = NSRect(x: 40, y: 120, width: 820, height: 100)
        panel.contentView?.addSubview(text); panel.orderFront(nil)
        defer { panel.orderOut(nil) }
        let windows = try await WindowSharing.windows()
        let source = try XCTUnwrap(windows.first { $0.id == UInt32(panel.windowNumber) })
        let sharing = WindowSharing(); await sharing.share(source)
        let capture = try await sharing.capture(windowID: source.id)
        await sharing.stop()
        let bytes = try XCTUnwrap(capture.objectValue?["content"]?.arrayValue?.first?.objectValue?["data"]?.stringValue.flatMap { Data(base64Encoded: $0) })
        let image = try XCTUnwrap(NSBitmapImageRep(data: bytes))
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
        try VNImageRequestHandler(data: bytes).perform([request])
        let recognized = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        XCTAssertTrue(recognized.contains("7392"), recognized)
        XCTAssertLessThanOrEqual(max(image.pixelsWide, image.pixelsHigh), 1600)
        // User-requested probe evidence is the only image written; product captures stay in memory.
        try bytes.write(to: URL(fileURLWithPath: output))
        print("WINDOW_CAPTURE_PROBE size=\(image.pixelsWide)x\(image.pixelsHigh) bytes=\(bytes.count) OCR=\(recognized)")
    }
}

private actor CaptureLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async { if !released { await withCheckedContinuation { continuation = $0 } } }
    func resume() { released = true; continuation?.resume(); continuation = nil }
}
