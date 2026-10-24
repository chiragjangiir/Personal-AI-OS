import AppKit
import SwiftUI

struct DesktopOnboardingView: View {
    @ObservedObject var model: DesktopAppModel
    @ObservedObject var pairing: DesktopPairingController
    @State private var step = 0
    @State private var outputSelected = true
    @State private var suggestedFolders: Set<String> = []
    @State private var savingFolders = false
    @AppStorage("desktop.onboardingComplete") private var onboardingComplete = false
    @AppStorage("desktop.showMenuBar") private var showMenuBar = true
    @Environment(\.openWindow) private var openWindow
    @Environment(\.desktopRendering) private var rendering
    @Environment(\.dismissWindow) private var dismissWindow
    init(model: DesktopAppModel, pairing: DesktopPairingController, initialStep: Int = 0) {
        self.model = model; self.pairing = pairing; _step = State(initialValue: initialStep)
    }
    var body: some View {
        VStack(spacing: 24) {
            HStack(spacing: 10) {
                ForEach(0..<4) { index in
                    Capsule().fill(index <= step ? Yimi.klein : Yimi.hair).frame(width: 42, height: 4)
                }
            }.padding(.top, 14).accessibilityLabel("第 \(step + 1) 步，共 4 步")
            Group {
                switch step {
                case 0: welcome
                case 1: pairingStep
                case 2: folderStep
                default: ready
                }
            }.frame(maxWidth: 450, maxHeight: .infinity)
            if let error = pairing.errorMessage ?? model.error { Text(error).foregroundStyle(Yimi.danger).font(.callout).textSelection(.enabled) }
        }.padding(28).frame(minWidth: 540, minHeight: 510)
            .background(Yimi.ground).foregroundStyle(Yimi.ink).tint(Yimi.klein).navigationTitle("首次设置")
            .onChange(of: pairing.pairing) { _, value in if !rendering, value != nil { step = 2 } }
    }
    private var welcome: some View {
        VStack(spacing: 18) {
            Image("YimLockup").resizable().scaledToFit().frame(width: 180, height: 60).accessibilityLabel("Yim")
            Text("让依米来到你的电脑").font(.title2).fontWeight(.semibold)
            Text("和手机上的依米是同一个她。你说过的话和她做好的事，会接着出现在这里。")
                .multilineTextAlignment(.center).foregroundStyle(Yimi.ink2)
            DesktopCheckbox(title: "在菜单栏显示依米", isOn: $showMenuBar)
            Button("添加这台电脑") { step = 1 }.buttonStyle(.borderedProminent).controlSize(.large)
                .accessibilityIdentifier("mac.pairing.begin")
        }
    }
    private var pairingStep: some View {
        DesktopPairingQRView(pairing: pairing)
    }
    private var folderStep: some View {
        VStack(spacing: 14) {
            Text("她可以碰哪些文件夹？").font(.title2).fontWeight(.semibold)
            Text("由你选择。没选的地方，她不能访问。你直接交给她的文件只授权那一个文件。")
                .multilineTextAlignment(.center).foregroundStyle(Yimi.ink2)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(["Downloads", "Desktop", "Documents"], id: \.self) { key in
                    DesktopCheckbox(title: key == "Downloads" ? "下载" : key == "Desktop" ? "桌面" : "文稿", isOn: Binding(get: { suggestedFolders.contains(key) }, set: { selected in
                        if selected { suggestedFolders.insert(key) } else { suggestedFolders.remove(key) }
                    }))
                }
                DesktopCheckbox(title: "文稿 / 依米 · 她做好的东西放这里", isOn: $outputSelected)
            }
            Button("选择其他文件夹…") {
                UserDefaults.standard.set(DesktopSettingsPane.folders.rawValue, forKey: "desktop.settingsPane"); openWindow(id: "settings")
                NotificationCenter.default.post(name: .desktopShowFolders, object: nil)
            }
            HStack(spacing: 18) {
                Button("先跳过") { step = 3 }.buttonStyle(.plain)
                Button("继续") { authorizeSelectedFolders() }.buttonStyle(.borderedProminent).disabled(savingFolders)
            }
        }
    }
    private var ready: some View {
        VStack(spacing: 18) {
            YimiPortrait(breathes: false).frame(width: 80, height: 80).clipShape(Circle())
            Text("我在这儿了").font(.title2).fontWeight(.semibold)
            Text("按住 ⌥ Space 说一句试试。松开就发送，我用文字回复你。")
                .multilineTextAlignment(.center).foregroundStyle(Yimi.ink2)
            Text("需要停下电脑上的操作，按 ⌃ ⌥ .。聊天照常。").font(.callout).foregroundStyle(Yimi.ink2)
            Button("开始对话") {
                onboardingComplete = true
                Task { await model.connect() }
                openWindow(id: "chat"); dismissWindow(id: "pairing")
            }.buttonStyle(.borderedProminent).controlSize(.large)
        }
    }
    private func authorizeSelectedFolders() {
        savingFolders = true
        Task {
            defer { savingFolders = false }
            do {
                try await model.authorizeOnboardingFolders(suggestions: suggestedFolders, output: outputSelected)
                model.error = nil
                step = 3
            } catch { model.error = DesktopUserFacingError.message(error) }
        }
    }
}
