import AppKit
import AVFoundation
import KeyboardShortcuts
import ServiceManagement
import SwiftUI
import UserNotifications
import DesktopKit

enum DesktopSettingsPane: String, CaseIterable, Identifiable {
    case general = "通用", appearance = "她的样子", permissions = "权限", folders = "文件夹", devices = "设备", privacy = "隐私"
    var id: String { rawValue }
    var symbol: String { switch self { case .general: "gearshape"; case .appearance: "person.crop.square"; case .permissions: "hand.raised"; case .folders: "folder"; case .devices: "desktopcomputer"; case .privacy: "lock" } }
}

struct DesktopSettingsView: View {
    @ObservedObject var model: DesktopAppModel
    var renderingPane: DesktopSettingsPane? = nil
    var renderingAndroidStatus = AndroidHostStatus(state: .stopped)
    var renderingAndroidEnabled = true
    @AppStorage("desktop.settingsPane") private var savedPane = DesktopSettingsPane.general.rawValue
    @AppStorage("desktop.showMenuBar") private var showMenuBar = true
    @State private var loginEnabled = false
    @State private var notifications = "用到时再问"
    @State private var confirmUnpair = false
    @Environment(\.openWindow) private var openWindow
    @Environment(\.desktopRendering) private var rendering
    private var pane: DesktopSettingsPane { renderingPane ?? DesktopSettingsPane(rawValue: savedPane) ?? .general }
    var body: some View {
        Group {
            if rendering {
                VStack(alignment: .leading, spacing: 16) {
                    Text(pane.rawValue).font(.headline)
                    settingsContent
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Yimi.paper)
            } else if pane == .devices {
                ScrollView { settingsContent.padding(.horizontal, 24).padding(.top, 23).padding(.bottom, 30) }.background(Yimi.paper)
            } else { Form { settingsContent }.formStyle(.grouped) }
        }.tint(Yimi.klein).foregroundStyle(Yimi.ink)
        .frame(minWidth: 580, minHeight: 430).navigationTitle(pane.rawValue)
        .toolbar {
            ToolbarItemGroup(placement: .principal) {
                ForEach(DesktopSettingsPane.allCases) { tab in
                    Button { savedPane = tab.rawValue } label: {
                        VStack(spacing: 3) { Image(systemName: tab.symbol); Text(tab.rawValue).font(.caption) }
                            .padding(5).background(pane == tab ? Yimi.tint : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain).accessibilityIdentifier("settings." + String(describing: tab)).accessibilityAddTraits(pane == tab ? .isSelected : [])
                }
            }
        }
        .task { guard !rendering else { return }; await refreshPermissions(); await model.refreshFolders() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard !rendering else { return }; Task { await refreshPermissions() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .desktopShowFolders)) { _ in if !rendering { savedPane = DesktopSettingsPane.folders.rawValue } }
        .alert("解除这台电脑的配对？", isPresented: $confirmUnpair) {
            Button("取消", role: .cancel) { }.keyboardShortcut(.defaultAction)
            Button("解除配对", role: .destructive) { Task { await model.unpair() } }
        } message: { Text("依米会立刻断开。本机配对凭据和对话缓存会清除；活动记录、文件和文件夹设置保留。要再用，需在手机上重新添加。") }
    }
    @ViewBuilder private var settingsContent: some View {
            switch pane {
            case .general: general
            case .appearance: DesktopAppearanceView(model: model)
            case .permissions: permissions
            case .folders: folders
            case .devices: devices
            case .privacy: privacy
            }
            if let error = model.error { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) }
    }
    private var general: some View {
        Group {
            Section {
                DesktopCheckbox(title: "登录时打开依米", isOn: Binding(get: { loginEnabled }, set: { value in
                    do { if value { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }; loginEnabled = SMAppService.mainApp.status == .enabled; model.error = nil }
                    catch { model.error = DesktopUserFacingError.message(error) }
                }))
                DesktopCheckbox(title: "在菜单栏显示依米", isOn: $showMenuBar)
                Text("关掉后，从 Dock 或聚焦搜索打开。").font(.caption).foregroundStyle(Yimi.ink2)
            }
            Section("说话与停手") {
                DesktopShortcutRecorder(title: "按住说话", name: .holdToTalk)
                Text("按住开始听，松开发送。依米用文字回复。").font(.caption).foregroundStyle(Yimi.ink2)
                DesktopShortcutRecorder(title: "暂停依米操作电脑", name: .pauseDesktop)
                Text("账户操作和原生文件工具都会暂停，找和读也会停。已完成的修改不会撤销；聊天照常。").font(.caption).foregroundStyle(Yimi.ink2)
            }
            DesktopVoiceEnrollmentSection(model: model, rendering: rendering)
            Section("连接") { Text(model.connectionLabel); Text("聊天和账户操作的连接都由这台 Mac 向外建立。").font(.caption).foregroundStyle(Yimi.ink2) }
        }
    }
    private var permissions: some View {
        Section("这台 Mac 的权限") {
            if let reason = model.toolLockReason { Text(reason).foregroundStyle(.orange) }
            Text("配对后，依米可使用你的 Mac 账户，读取和修改原文件、运行工具及联网。下方文件夹设置只约束原生文件工具。").font(.caption).foregroundStyle(Yimi.ink2)
            permission("文件夹", detail: "原生文件工具的文件夹范围", status: model.folders.isEmpty ? "尚未选择" : "已选择 \(model.folders.count) 个") {
                savedPane = DesktopSettingsPane.folders.rawValue
            }
            permission("麦克风", detail: "按住说话、通话和对话录入时使用", status: rendering ? "用到时再问" : captureStatus(.audio)) { openPrivacy("Privacy_Microphone") }
            permission("摄像头", detail: "配对扫码和视频通话时使用", status: rendering ? "用到时再问" : captureStatus(.video)) { openPrivacy("Privacy_Camera") }
            permission("通知", detail: "最终文字回复、手机确认提醒", status: notifications) { openPrivacy("Privacy_Notifications") }
            Text("麦克风、摄像头和通知显示本机授权状态。操作其他 App 或读取屏幕，受 macOS 为依米设置的“自动化”和“屏幕录制”权限约束。文件访问受限时，可在系统设置中为依米开启“完全磁盘访问”。").font(.caption).foregroundStyle(Yimi.ink2)
        }
    }
    private var folders: some View {
        Section {
            Text("这些设置用于原生文件工具。关掉“可以改动”，这类工具只能在该文件夹里找和读；账户操作不受此开关限制。")
            ForEach(model.folders) { folder in
                HStack {
                    VStack(alignment: .leading) { Label(folder.label, systemImage: "folder"); Text(folder.id).font(.caption).foregroundStyle(Yimi.ink2) }
                    Spacer()
                    DesktopCheckbox(title: "可以改动", isOn: Binding(get: { folder.write }, set: { value in
                        operation { try await model.desktop.setWrite(value, folder: folder.id); await model.refreshFolders() }
                    }))
                    Button { operation { try await model.desktop.remove(folder: folder.id); await model.refreshFolders() } } label: { Image(systemName: "minus.circle") }
                        .accessibilityLabel("移除文件夹：" + folder.label)
                }
            }
            Button("添加文件夹…", systemImage: "plus") { chooseFolder() }
            Text("原生文件工具默认将工坊结果保存到文稿/依米。临时文件授权不支持写回原文件，修改结果需另存到可写文件夹。")
                .font(.caption).foregroundStyle(Yimi.ink2)
        }
    }
    private var devices: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                deviceHeading("这台电脑")
                VStack(spacing: 0) {
                    HStack(spacing: 11) {
                        Image(systemName: "desktopcomputer").font(.system(size: 26)).frame(width: 28, height: 28)
                            .foregroundStyle(Yimi.ink2).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("这台 Mac").font(.system(size: 13, weight: .medium))
                            Text(model.pairing == nil ? "尚未配对" : model.connected ? "已连接依米" : model.connectionLabel)
                                .font(.system(size: 11)).foregroundStyle(Yimi.ink2).frame(minHeight: 18)
                        }
                        Spacer()
                        Button("解除配对…") { confirmUnpair = true }.buttonStyle(DesktopAndroidSettingsButtonStyle())
                            .disabled(!model.connected || model.pairing == nil)
                    }.padding(.horizontal, 14).padding(.vertical, 13)
                    Rectangle().fill(Yimi.hair).frame(height: 1)
                    if rendering {
                        DesktopAndroidSettingsRow(status: renderingAndroidStatus, enabled: renderingAndroidEnabled)
                    } else if let controller = model.androidHost {
                        DesktopAndroidSettingsControl(controller: controller, model: model)
                    }
                }.background(Yimi.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Yimi.hair, lineWidth: 1))
            }
            VStack(alignment: .leading, spacing: 8) {
                deviceHeading("其他终端 · 在手机上管理")
                VStack(spacing: 0) {
                    ForEach(model.terminals.filter { !$0.isSelf }) { terminal in
                        HStack {
                            Text(terminal.displayName).font(.system(size: 12)); Spacer()
                            Text(terminal.connected ? "在线" : "离线").font(.system(size: 12)).foregroundStyle(Yimi.ink2)
                        }.padding(.horizontal, 14).padding(.vertical, 13)
                    }
                }.background(Yimi.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Yimi.hair, lineWidth: 1))
                Text("这里仅能解除这台 Mac 的配对。管理其他设备，请在手机上打开“设备”。")
                    .font(.system(size: 11)).foregroundStyle(Yimi.ink2).padding(.horizontal, 10)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func deviceHeading(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Yimi.ink2).padding(.leading, 11)
    }
    private var privacy: some View {
        Section {
            LabeledContent("原生文件移到废纸篓前确认") { Button("重新询问") { operation { try await model.desktop.resetTrashConsent() } } }
            Text("原生文件工具下次移到废纸篓前，在手机上重新询问；此项不约束账户命令。").font(.caption).foregroundStyle(Yimi.ink2)
            LabeledContent("原生文件活动", value: "保留 365 天")
            Button("查看活动") { openWindow(id: "activity") }
            Text("原生文件活动记文件名、数量和结果。账户操作另记命令文本，不记命令输出；可在活动页打开“账户命令记录”。").font(.caption).foregroundStyle(Yimi.ink2)
            LabeledContent("原生文件撤销副本", value: "保留 30 天")
            LabeledContent("工坊文件副本", value: "用完即删 · 跟随服务器设置")
            Text("付款仍需逐次确认；向他人发送信息，按收件人和任务类型首次确认。").font(.caption).foregroundStyle(Yimi.ink2)
        }
    }
    private func permission(_ name: String, detail: String, status: String, action: @escaping () -> Void) -> some View {
        HStack { VStack(alignment: .leading) { Text(name); Text(detail).font(.caption).foregroundStyle(Yimi.ink2) }; Spacer(); Text(status).font(.callout); Button(name == "文件夹" ? "管理…" : "系统设置…", action: action) }
    }
    private func captureStatus(_ type: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: type) { case .authorized: "已允许"; case .denied, .restricted: "未允许"; default: "用到时再问" }
    }
    private func refreshPermissions() async {
        loginEnabled = SMAppService.mainApp.status == .enabled
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notifications = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional ? "已允许" : settings.authorizationStatus == .notDetermined ? "用到时再问" : "未允许"
    }
    private func openPrivacy(_ anchor: String) { if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + anchor) { NSWorkspace.shared.open(url) } }
    private func chooseFolder() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.begin { response in guard response == .OK, let url = panel.url else { return }; operation { _ = try await model.desktop.authorize(folder: url, write: true); await model.refreshFolders() } }
    }
    private func operation(_ action: @escaping () async throws -> Void) { Task { do { try await action(); model.error = nil } catch { model.error = DesktopUserFacingError.message(error) } } }
}

extension Notification.Name { static let desktopShowFolders = Notification.Name("desktop.showFolders") }

/// The optional Mac channel projects Core's server-owned conversation draft.
private struct DesktopVoiceEnrollmentSection: View {
    @ObservedObject var model: DesktopAppModel
    let rendering: Bool
    private var enrollment: CentralVoiceEnrollment { model.voiceEnrollment }
    private var active: Bool { [.collecting, .paused, .checked].contains(enrollment.phase) }
    private var busy: Bool { model.voiceEnrollmentBusy || enrollment.pending != nil }
    var body: some View {
        Section("你的声音 · 可选 Mac 补充") {
            Text("用这台 Mac 和依米聊一会儿，补充这台设备上的收音。不同设备的声音各自保存。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            Text(status).accessibilityIdentifier("desktop.voiceEnrollment.status")
            if active {
                ProgressView(value: Double(enrollment.cleanSpeechMS), total: Double(max(1, enrollment.targetSpeechMS)))
                    .accessibilityLabel("清晰语音收集进度").accessibilityIdentifier("desktop.voiceEnrollment.progress")
                Text("已收集清晰语音 \(enrollment.cleanSpeechMS / 1000) 秒，只计算你清楚、单独说话的部分。")
                    .font(.caption).foregroundStyle(Yimi.ink2)
                if let issue = enrollment.issue {
                    Text(issueText(issue)).accessibilityIdentifier("desktop.voiceEnrollment.quality")
                }
                HStack {
                    if enrollment.phase == .checked {
                        Button("使用这段录音") { send("commit") }.disabled(!enrollment.canUse)
                            .accessibilityIdentifier("desktop.voiceEnrollment.use")
                    } else {
                        Button(enrollment.phase == .paused ? "继续" : "暂停") { send(enrollment.phase == .paused ? "resume" : "pause") }
                            .accessibilityIdentifier("desktop.voiceEnrollment.pauseResume")
                        Button("结束并检查") { send("check") }.accessibilityIdentifier("desktop.voiceEnrollment.check")
                    }
                    Button("放弃这段录音", role: .destructive) { send("discard") }
                        .accessibilityIdentifier("desktop.voiceEnrollment.discard")
                }.disabled(busy || !model.connected || rendering)
            } else {
                Button(enrollment.owner?.enrolled == true ? "补录一段对话" : "开始聊一会儿") { send("start") }
                    .disabled(busy || !model.connected || !enrollment.available || model.call.isActive || rendering)
                    .accessibilityIdentifier("desktop.voiceEnrollment.start")
            }
            if busy { ProgressView("正在等待依米确认…").accessibilityIdentifier("desktop.voiceEnrollment.pending") }
            if !enrollment.available {
                Text("对话录入尚未开放，连接支持此功能的依米服务后重试。")
                    .font(.caption).foregroundStyle(Yimi.ink2)
            }
            Button("刷新声音状态") { send("status") }.disabled(busy || !model.connected || rendering)
                .accessibilityIdentifier("desktop.voiceEnrollment.refresh")
            Text("沿用通话麦克风、回声消除与降噪。原有声纹保留到新录音检查并保存成功。此对话不用于支付声纹录入。")
                .font(.caption).foregroundStyle(Yimi.ink2)
        }
        .task(id: model.connected) { if !rendering, model.connected { await model.controlVoiceEnrollment("status") } }
        .onDisappear { if !rendering, enrollment.phase == .collecting { send("pause") } }
    }
    private var status: String {
        switch enrollment.phase {
        case .collecting: return "正在熟悉你的声音"
        case .paused: return "已暂停，清晰语音进度保留"
        case .checked: return enrollment.canUse ? "这段可以使用" : "还需补充，请放弃后重新来一段"
        case .committed: return "已熟悉你在 Mac 上的声音"
        default: return enrollment.owner?.enrolled == true ? "已熟悉" : "未录入"
        }
    }
    private func issueText(_ issue: String) -> String {
        switch issue {
        case "multiple_speakers": return "这段有多人声音"
        case "VOICE_ENROLLMENT_OTHER_SPEAKER": return "这段声音还没有确认是你，请继续说一段"
        case "VOICEPRINT_ENROLLMENT_INCONSISTENT": return "这些声音片段不够一致，请重新来一段"
        case "VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED", "VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES": return "清晰语音还不够，继续聊一会儿吧"
        case "no_speech", "too_short", "too_quiet": return "离麦克风近一点，用平常说话的声音"
        case "low_snr": return "背景声有点大"
        case "clipped": return "声音有些失真，请离麦克风稍远一点"
        default: return "这段声音暂时不能使用，请再试一次"
        }
    }
    private func send(_ action: String) { Task { await model.controlVoiceEnrollment(action) } }
}
