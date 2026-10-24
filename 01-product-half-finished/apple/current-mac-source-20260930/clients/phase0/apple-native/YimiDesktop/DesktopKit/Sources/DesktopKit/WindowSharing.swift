import AppKit
import MCP
import ScreenCaptureKit

public struct SharedWindow: Identifiable, Sendable {
    public let id: UInt32
    public let title: String
    let screenshot: @Sendable () async throws -> WindowScreenshot
}

struct WindowScreenshot: Sendable {
    let jpeg: Data
    let width: Int
    let height: Int
}

public enum WindowSharingError: LocalizedError {
    case permission, unavailable, notShared, otherWindow, capture
    public var errorDescription: String? {
        switch self {
        case .permission: return "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许依米，然后重试。"
        case .unavailable: return "无法读取窗口列表。请检查系统录屏权限后重试。"
        case .notShared: return "窗口共享已停止。请在电脑上重新选择共享窗口。"
        case .otherWindow: return "只能查看主人当前选择的共享窗口。请在电脑上重新选择窗口。"
        case .capture: return "无法截取共享窗口。请确认窗口仍然打开，并检查系统录屏权限。"
        }
    }
}

/// Choosing a window grants only that source. No pixels or grants are persisted.
public actor WindowSharing {
    private var selected: SharedWindow?
    private var generation = UUID()
    public init() {}

    public static func windows() async throws -> [SharedWindow] {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else { throw WindowSharingError.permission }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            return content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 0 && $0.frame.height > 0 }.map { window in
                SharedWindow(id: window.windowID, title: window.title.flatMap { $0.isEmpty ? nil : $0 } ?? window.owningApplication?.applicationName ?? "未命名窗口",
                             screenshot: { try await screenshot(window) })
            }
        } catch { throw WindowSharingError.unavailable }
    }

    public func share(_ window: SharedWindow) {
        generation = UUID()
        selected = window
    }

    public func stop() {
        generation = UUID()
        selected = nil
    }

    func capture(windowID: UInt32?) async throws -> Value {
        guard let selected else { throw WindowSharingError.notShared }
        guard windowID == nil || windowID == selected.id else { throw WindowSharingError.otherWindow }
        let token = generation
        let image: WindowScreenshot
        do { image = try await selected.screenshot() }
        catch { throw WindowSharingError.capture }
        guard generation == token else { throw WindowSharingError.notShared }
        try Task.checkCancellation()
        return ["isError": false,
                "content": [["type": "image", "mimeType": "image/jpeg", "data": .string(image.jpeg.base64EncodedString())]],
                "structuredContent": ["window_id": .int(Int(selected.id)), "title": .string(selected.title),
                                      "width": .int(image.width), "height": .int(image.height)]]
    }

    private static func screenshot(_ window: SCWindow) async throws -> WindowScreenshot {
        let filter = SCContentFilter(desktopIndependentWindow: window), config = SCStreamConfiguration()
        let scale = min(Double(filter.pointPixelScale), 1600 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.scalesToFit = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else {
            throw WindowSharingError.capture
        }
        // The existing encrypted MCP relay accepts at most one MiB per message.
        guard jpeg.count <= 750_000 else { throw WindowSharingError.capture }
        return WindowScreenshot(jpeg: jpeg, width: image.width, height: image.height)
    }
}
