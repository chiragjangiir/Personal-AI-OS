import SwiftUI
import DesktopKit
import CoreGraphics

@MainActor
final class DesktopScreenSharing: ObservableObject {
    @Published private(set) var windowTitle: String?
    @Published private(set) var windows: [SharedWindow] = []
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published var choosing = false
    private let grant: WindowSharing

    init(grant: WindowSharing) { self.grant = grant }

    func chooseWindow() async {
        guard !busy, windowTitle == nil else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            windows = try await WindowSharing.windows()
            if windows.isEmpty { error = "没有可共享的窗口。请打开窗口后重试。" }
            else { choosing = true }
        } catch { self.error = (error as? WindowSharingError)?.localizedDescription ?? WindowSharingError.unavailable.localizedDescription }
    }

    func start(_ window: SharedWindow) async {
        choosing = false
        await grant.share(window)
        windowTitle = window.title; error = nil
    }

    func stop() async {
        await grant.stop()
        windowTitle = nil; windows = []; choosing = false; error = nil
    }
}

struct DesktopScreenSharingControls: View {
    @ObservedObject var sharing: DesktopScreenSharing
    @State private var selected: CGWindowID?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Label(sharing.windowTitle.map { "正在共享：\($0)" } ?? "窗口共享未开启",
                      systemImage: "rectangle.on.rectangle")
                    .lineLimit(2).textSelection(.enabled)
                    .accessibilityIdentifier("desktop.sharing.status")
                Spacer(minLength: 8)
                if sharing.windowTitle != nil {
                    Button("停止共享") { Task { await sharing.stop() } }
                        .accessibilityIdentifier("desktop.sharing.stop")
                } else {
                    Button(sharing.busy ? "正在准备…" : "共享窗口") { Task { await sharing.chooseWindow() } }
                        .accessibilityIdentifier("desktop.sharing.choose")
                }
            }
            .disabled(sharing.busy)
            if let error = sharing.error {
                Text(error).font(.callout).foregroundStyle(Yimi.danger)
                    .accessibilityIdentifier("desktop.sharing.error")
            }
        }
        .sheet(isPresented: $sharing.choosing) {
            VStack(alignment: .leading, spacing: 16) {
                Text("选择共享窗口").font(.headline)
                Picker("窗口", selection: $selected) {
                    Text("请选择窗口").tag(nil as CGWindowID?)
                    ForEach(sharing.windows, id: \.id) { window in
                        Text(window.title).tag(Optional(window.id))
                    }
                }
                .accessibilityIdentifier("desktop.sharing.windowPicker")
                HStack {
                    Spacer()
                    Button("取消") { sharing.choosing = false }.keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("desktop.sharing.cancel")
                    Button("开始共享") {
                        if let window = sharing.windows.first(where: { $0.id == selected }) {
                            Task { await sharing.start(window) }
                        }
                    }
                    .disabled(selected == nil).keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("desktop.sharing.start")
                }
            }
            .padding(24).frame(width: 440)
            .onAppear { selected = nil }
        }
    }
}
