import AppKit
import SwiftUI
import DesktopKit

extension EnvironmentValues {
    @Entry var desktopRendering = false
}

/// Content-only snapshots. AppKit captures native controls without creating a window or starting the app lifecycle.
/// The caller supplies its test DesktopControl and model state; no synthetic state enters the running app.
@MainActor
enum DesktopUIRenderer {
    /// NSHostingView includes AppKit-backed SwiftUI controls that ImageRenderer cannot capture.
    static func png<V: View>(_ content: V, size: CGSize? = nil, scheme: ColorScheme) throws -> Data {
        let hosting = NSHostingView(rootView: content
            .environment(\.colorScheme, scheme).environment(\.desktopRendering, true))
        hosting.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let dimensions = size ?? hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: dimensions)
        hosting.layoutSubtreeIfNeeded()
        let scale: CGFloat = 2
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
            pixelsWide: Int(ceil(dimensions.width * scale)), pixelsHigh: Int(ceil(dimensions.height * scale)),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            throw CocoaError(.fileWriteUnknown)
        }
        bitmap.size = dimensions
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return data
    }

    static func export(model: DesktopAppModel, pairing: DesktopPairingController, directory: URL,
                       variant: String = "connected", screens: Set<String>? = nil,
                       chatSize: CGSize = CGSize(width: 440, height: 660),
                       androidStatus: AndroidHostStatus = AndroidHostStatus(state: .stopped), androidEnabled: Bool = true) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var outputs: [URL] = []
        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .light ? "light" : "dark"
            func save<V: View>(_ name: String, _ view: V, size: CGSize) throws {
                guard screens?.contains(name) ?? (name != "voice-hud") else { return }
                let data = try png(view.frame(width: size.width, height: size.height), size: size, scheme: scheme)
                let url = directory.appendingPathComponent("\(variant)-\(name)-\(suffix).png")
                try data.write(to: url); outputs.append(url)
            }
            try save("voice-hud", DesktopVoiceHUD(model: model), size: CGSize(width: 420, height: 100))
            try save("chat", DesktopChatView(model: model), size: chatSize)
            try save("menu", VStack(alignment: .leading, spacing: 13) { DesktopMenuContents(model: model) }
                .font(.system(size: 13)).buttonStyle(.plain).padding(18)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Yimi.surface).foregroundStyle(Yimi.ink), size: CGSize(width: 340, height: 430))
            try save("unpair", DesktopUnpairExplanation(), size: CGSize(width: 460, height: 220))
            try save("activity", DesktopActivityView(model: model), size: CGSize(width: 620, height: 740))
            for pane in DesktopSettingsPane.allCases {
                try save("settings-\(pane.id)", DesktopSettingsView(model: model, renderingPane: pane,
                    renderingAndroidStatus: androidStatus, renderingAndroidEnabled: androidEnabled), size: CGSize(width: 650, height: 520))
            }
            if screens?.contains("settings-phone") == true {
                try save("settings-phone", DesktopAndroidSettingsRow(status: androidStatus, enabled: androidEnabled)
                    .tint(Yimi.klein).foregroundStyle(Yimi.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Yimi.surface),
                    size: CGSize(width: 600, height: androidStatus.last_error == nil ? 133 : 170))
            }
            for step in 0..<4 {
                try save("onboarding-\(step)", DesktopOnboardingView(model: model, pairing: pairing, initialStep: step), size: CGSize(width: 560, height: 550))
            }
        }
        return outputs
    }
}

struct DesktopUnpairExplanation: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("解除这台电脑的配对？").font(.headline)
            Text("依米会立刻断开。本机配对凭据和对话缓存会清除；活动记录、文件和文件夹设置保留。要再用，需在手机上重新添加。")
                .font(.callout).foregroundStyle(Yimi.ink2)
            HStack {
                Text("取消").padding(.horizontal, 12).padding(.vertical, 6).background(Yimi.paper, in: RoundedRectangle(cornerRadius: 6))
                Text("解除配对").foregroundStyle(.white).padding(.horizontal, 12).padding(.vertical, 6).background(Yimi.danger, in: RoundedRectangle(cornerRadius: 6))
            }.font(.callout).frame(maxWidth: .infinity, alignment: .trailing)
        }.padding(24).background(Yimi.surface).foregroundStyle(Yimi.ink)
    }
}
