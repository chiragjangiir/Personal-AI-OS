import AppKit
import KeyboardShortcuts
import LiveKit
import SwiftUI


@MainActor final class DesktopBoot: ObservableObject {
    let model: DesktopAppModel?
    let error: String?
    init() {
        LiveKitSDK.disableLogging()
        do { model = try DesktopAppModel(ownerUnlockEnabled: UserDefaults.standard.bool(forKey: "desktop.voiceOwnerUnlock")); error = nil }
        catch { model = nil; self.error = DesktopUserFacingError.message(error) }
    }
}

@main struct YimiDesktop: App {
    @NSApplicationDelegateAdaptor(DesktopApplicationDelegate.self) private var delegate
    @StateObject private var boot = DesktopBoot()
    @AppStorage("desktop.showMenuBar") private var showMenuBar = true
    @AppStorage("desktop.onboardingComplete") private var onboardingComplete = false
    var body: some Scene {
        Window("依米", id: "chat") {
            root { model in
                if (!onboardingComplete || model.pairing == nil), let pairing = model.pairingController { DesktopOnboardingView(model: model, pairing: pairing, initialStep: model.pairing == nil ? 0 : 2) }
                else { DesktopChatView(model: model) }
            }
        }.defaultSize(width: 440, height: 660)
        .commands {
            DesktopChatTextCommands()
            CommandMenu("依米") {
                Button("和依米通话…") { delegate.open("call") }
                    .accessibilityIdentifier("mac.call.open.command")
                Button("和依米说话…") { delegate.open("chat") }.disabled(boot.model?.connected != true)
                    .globalKeyboardShortcut(.holdToTalk)
                Button(boot.model?.pause.paused == true ? "继续让依米操作电脑" : "暂停依米操作电脑") {
                    Task { await boot.model?.togglePause() }
                }.globalKeyboardShortcut(.pauseDesktop)
            }
            CommandGroup(replacing: .appSettings) { Button("设置…") { delegate.open("settings") }.keyboardShortcut(",") }
            CommandGroup(after: .windowArrangement) {
                Button("打开依米") { delegate.open("chat") }.keyboardShortcut("o")
                Button("活动与确认") { delegate.open("activity") }.keyboardShortcut("l")
            }
        }
        Window("活动与确认", id: "activity") { root { DesktopActivityView(model: $0) } }.defaultSize(width: 650, height: 650)
        Window("依米 · 通话", id: "call") {
            root { DesktopCallView(model: $0) }
        }.defaultSize(width: 560, height: 640)
        Window("设置", id: "settings") { root { DesktopSettingsView(model: $0) } }.windowResizability(.contentSize)
        Window("首次设置", id: "pairing") {
            root { model in if let pairing = model.pairingController { DesktopOnboardingView(model: model, pairing: pairing) } }
        }.defaultSize(width: 600, height: 560)
        // macOS 26 re-reports the status item's visibility on every scene update; writing that
        // unchanged value back to the defaults re-renders the app and spins the main thread.
        MenuBarExtra(isInserted: Binding(get: { showMenuBar }, set: { if $0 != showMenuBar { showMenuBar = $0 } })) {
            if let model = boot.model { DesktopMenuContents(model: model) }
            else { Text(boot.error ?? "未连接"); Button("退出依米") { NSApp.terminate(nil) } }
        } label: {
            if let model = boot.model { DesktopStatusIcon(model: model) }
            else { Image(systemName: "circle.slash") }
        }.menuBarExtraStyle(.menu)
    }
    @ViewBuilder private func root<Content: View>(@ViewBuilder content: @escaping (DesktopAppModel) -> Content) -> some View {
        if let model = boot.model {
            DesktopWindowRoot(model: model, delegate: delegate, content: content(model))
        } else {
            VStack(spacing: 16) { Text("依米未能启动").font(.headline); Text(boot.error ?? "").textSelection(.enabled) }.padding(30)
        }
    }
}

private struct DesktopWindowRoot<Content: View>: View {
    @ObservedObject var model: DesktopAppModel
    let delegate: DesktopApplicationDelegate
    let content: Content
    @Environment(\.openWindow) private var openWindow
    @AppStorage("desktop.showMenuBar") private var showMenuBar = true
    var body: some View {
        content.onAppear {
            delegate.bind(model); delegate.open = { openWindow(id: $0); NSApp.activate(ignoringOtherApps: true) }
            delegate.updatePolicy(showMenuBar: showMenuBar)
        }.onChange(of: showMenuBar) { _, value in delegate.updatePolicy(showMenuBar: value) }
        .task { await model.activate() }
    }
}

@MainActor final class DesktopApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: DesktopAppModel?
    private var voice: DesktopVoicePanel?
    func bind(_ model: DesktopAppModel) {
        self.model = model
        if voice == nil { voice = DesktopVoicePanel(model: model) }
    }
    var open: (String) -> Void = { _ in }
    private var observers: [NSObjectProtocol] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        KeyboardShortcuts.onKeyDown(for: .holdToTalk) { [weak self] in self?.voice?.keyDown() }
        KeyboardShortcuts.onKeyUp(for: .holdToTalk) { [weak self] in self?.voice?.keyUp() }
        KeyboardShortcuts.onKeyDown(for: .pauseDesktop) { [weak self] in Task { await self?.model?.togglePause() } }
        observers.append(NotificationCenter.default.addObserver(forName: Notification.Name("desktop.openChat"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.open("chat") }
        })
        for name in [NSWindow.didBecomeMainNotification, NSWindow.didBecomeKeyNotification,
                     NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                let closingWindow = notification.name == NSWindow.willCloseNotification ? notification.object as? NSWindow : nil
                DispatchQueue.main.async {
                    if notification.name == NSWindow.didBecomeKeyNotification, (notification.object as? NSWindow)?.title == "依米" { Task { await self?.model?.shownTimeline() } }
                    self?.updatePolicy(showMenuBar: UserDefaults.standard.object(forKey: "desktop.showMenuBar") as? Bool ?? true, excluding: closingWindow)
                }
            })
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            do { try await model?.prepareForTermination() } catch { NSLog("Desktop shutdown: %@", error.localizedDescription) }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func updatePolicy(showMenuBar: Bool, excluding closingWindow: NSWindow? = nil) {
        for window in NSApp.windows where DesktopSettingsPane.allCases.map(\.rawValue).contains(window.title) || window.title == "设置" {
            window.standardWindowButton(.miniaturizeButton)?.isEnabled = false
            window.standardWindowButton(.zoomButton)?.isEnabled = false
        }
        let windowOpen = NSApp.windows.contains { $0 !== closingWindow && $0.isVisible && $0.canBecomeMain }
        NSApp.setActivationPolicy(windowOpen || !showMenuBar ? .regular : .accessory)
    }
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        func add(_ title: String, action: Selector?, key: String = "", modifiers: NSEvent.ModifierFlags = .command, to parent: NSMenu? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self; item.keyEquivalentModifierMask = modifiers
            (parent ?? menu).addItem(item)
            return item
        }
        _ = add("依米 · " + (model?.pause.paused == true ? "已暂停操作电脑" : model?.connectionLabel ?? "未连接"), action: nil)
        for errand in model?.errands.prefix(5) ?? [] {
            let item = add(errand.title, action: nil)
            let submenu = NSMenu(); item.submenu = submenu
            _ = add("第 \(errand.step) 步 · \(errand.step)/\(errand.maxSteps)", action: nil, to: submenu)
            let stop = add("停下", action: #selector(cancelErrand(_:)), to: submenu); stop.representedObject = errand.id
        }
        if let model, model.inFlight > 0 { _ = add("正在办 · \(model.inFlight) 项操作", action: nil) }
        if let model, !model.confirmations.isEmpty {
            let item = add("等你在手机上确认（\(model.confirmations.count)）", action: nil)
            let submenu = NSMenu(); item.submenu = submenu
            for confirmation in model.confirmations.prefix(5) { _ = add(confirmation.text ?? "请在手机上查看", action: nil, to: submenu) }
            _ = add("全部…", action: #selector(activity), to: submenu)
        }
        menu.addItem(.separator())
        let talk = add("和依米说话…", action: #selector(chat), key: " ", modifiers: .option)
        talk.setShortcut(for: .holdToTalk)
        talk.isEnabled = model?.connected == true
        _ = add("打开依米", action: #selector(chat), key: "o")
        _ = add("活动与确认", action: #selector(activity), key: "l")
        menu.addItem(.separator())
        let pauseItem = add(model?.pause.paused == true ? "继续让依米操作电脑" : "暂停依米操作电脑", action: #selector(pause))
        pauseItem.setShortcut(for: .pauseDesktop)
        _ = add("设置…", action: #selector(settings), key: ",")
        menu.addItem(.separator())
        _ = add("退出依米", action: #selector(quit), key: "q")
        menu.autoenablesItems = false
        for item in menu.items where item.action == nil && item.submenu == nil { item.isEnabled = false }
        return menu
    }
    @objc private func cancelErrand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Task { await model?.cancelErrand(id) }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func chat() { open("chat") }
    @objc private func activity() { open("activity") }
    @objc private func settings() { open("settings") }
    @objc private func pause() { Task { await model?.togglePause() } }
}
