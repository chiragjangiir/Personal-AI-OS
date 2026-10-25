import AppKit
import AVFoundation
import LiveKit
import SwiftUI

/// Production call surface; the shared coordinator remains the owner of every media transition.
struct DesktopCallView: View {
    @ObservedObject var model: DesktopAppModel
    @State private var failure: String?
    @State private var working = false
    @State private var retryAction: (@MainActor (DesktopCallEngine) async throws -> Void)?
    @State private var lastVideo = false
    @State private var swapped = false
    @State private var cameras: [AVCaptureDevice] = []
    private var active: Bool { model.call.isActive || model.callSnapshot?.isDialing == true }
    private var mic: AssistantMediaPhase { model.callSnapshot?.media.microphone ?? .off }
    private var camera: AssistantMediaPhase { model.callSnapshot?.media.camera ?? .off }
    private var thinking: Bool { model.call.conversationMode == .thinking }
    private var avatar: Bool { model.call.avatarAllowed && model.callSnapshot?.videoCallRequested == true }
    private var problem: String? {
        if let failure { return failure }
        guard let code = model.callSnapshot?.callFailure else { return nil }
        return ComponentVideoFailureCode(rawValue: code)?.message ?? "通话没接通。请重试，或回到语音。"
    }
    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                conversationControls
                HStack {
                    DesktopIdentityHeader(model: model, showsConnection: false)
                    Spacer()
                    Text(status).foregroundStyle(Yimi.ink2).accessibilityIdentifier("call.status")
                }
                if active {
                    DesktopCallStage(preview: model.callPreview, camera: camera, avatar: avatar, thinking: thinking, ready: model.call.videoFrameRendered, swapped: $swapped)
                        .frame(maxWidth: .infinity, maxHeight: .infinity).frame(minHeight: 200)
                    Text(avatar ? (model.call.videoFrameRendered ? "数字人：开" : "数字人：正在连接") : "数字人：关").foregroundStyle(Yimi.ink2).accessibilityIdentifier("call.avatar.status")
                    if thinking {
                        Text("思考模式下不能用数字人，镜头仍可使用").foregroundStyle(Yimi.ink2)
                            .accessibilityIdentifier("call.avatar.reason")
                    } else {
                        Text(DesktopCallError.avatarUnavailableMessage).foregroundStyle(Yimi.ink2)
                            .accessibilityIdentifier("call.avatar.reason")
                    }
                    Text(muteStatus).foregroundStyle(mic == .unknown ? Yimi.danger : Yimi.ink2)
                        .accessibilityIdentifier("call.mute.status").accessibilityLabel(muteAnnouncement)
                    if mic == .closing { Text("正在关闭麦克风，对方暂时仍可能听到你。").foregroundStyle(Yimi.ink2) }
                    if mic == .unknown { Text("你仍可能被听到。请重试静音，或结束通话。").foregroundStyle(Yimi.danger) }
                    HStack(spacing: 16) {
                        Button(muteAction, systemImage: mic == .off ? "mic.slash" : "mic") {
                            run { try await $0.setMuted(mic != .off) }
                        }.disabled(working || mic == .opening || mic == .closing).accessibilityIdentifier("call.mute")
                        Button(camera == .unknown ? "重试关镜头" : camera == .on ? "关镜头" : "开视频", systemImage: "video") {
                            run { try await $0.setCamera(camera != .on && camera != .unknown) }
                        }.disabled(working || !model.call.isActive || camera == .opening || camera == .closing).accessibilityIdentifier("call.camera")
                        Menu("更多", systemImage: "ellipsis") {
                            Button(avatar ? "关闭数字人" : "开启数字人") {
                                swapped = false
                                run { try await $0.setAvatar(!avatar) }
                            }.disabled(!avatar || !model.call.avatarAllowed).accessibilityIdentifier("call.avatar")
                            deviceChoices
                        }.disabled(working || !model.call.isActive).accessibilityIdentifier("call.more")
                        Button(mic == .unknown ? "结束通话" : "挂断", systemImage: "phone.down.fill", role: .destructive) {
                            run { try await $0.end() }
                        }.accessibilityIdentifier("call.end")
                    }
                } else {
                    Spacer()
                    if thinking {
                        Image(systemName: "waveform").font(.system(size: 44)).foregroundStyle(Yimi.ink2).accessibilityHidden(true)
                    } else {
                        YimiPortrait(breathes: false).frame(width: 100, height: 136).clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                    Text(model.call.id == nil ? "和依米通话" : "通话已结束").font(.title3)
                    Text("语音通话用麦克风；视频通话还需要摄像头权限。" + DesktopCallError.avatarUnavailableMessage)
                        .foregroundStyle(Yimi.ink2).multilineTextAlignment(.center)
                    HStack(spacing: 16) {
                        Button("语音通话", systemImage: "phone") { start(video: false) }.accessibilityIdentifier("call.start.voice")
                        Button("视频通话", systemImage: "video") { start(video: true) }.accessibilityIdentifier("call.start.video")
                    }.disabled(working || !model.connected).buttonStyle(.borderedProminent)
                    if !model.connected {
                        Text(model.connectionLabel).foregroundStyle(Yimi.ink2)
                        Button("连接") { Task { await model.connect() } }.accessibilityIdentifier("call.connect")
                    }
                    Spacer()
                }
                if let problem {
                    Text(problem).foregroundStyle(Yimi.danger).textSelection(.enabled).accessibilityIdentifier("call.failure")
                    HStack {
                        Button("重试") {
                            if let retryAction { run(retryAction) }
                            else if !active { start(video: lastVideo) }
                        }.disabled(active && retryAction == nil).accessibilityIdentifier("call.retry")
                        Button("回到语音") {
                            if active { run { engine in try await engine.setAvatar(false); try await engine.setCamera(false) } }
                            else { start(video: false) }
                        }.accessibilityIdentifier("call.back.voice")
                    }.disabled(working)
                }
            }
        }.padding(24).background(Yimi.ground).foregroundStyle(Yimi.ink)
            .frame(minWidth: 480, minHeight: 430)
            .onChange(of: muteStatus) { _, _ in
                guard model.call.isActive else { return }
                NSAccessibility.post(element: NSApplication.shared, notification: .announcementRequested,
                    userInfo: [.announcement: muteAnnouncement, .priority: NSAccessibilityPriorityLevel.low.rawValue])
            }
            .task { do { cameras = try await CameraCapturer.captureDevices() } catch { failure = DesktopUserFacingError.message(error) } }
    }
    @ViewBuilder private var conversationControls: some View {
        if let mode = model.call.conversationMode {
            VStack(spacing: 12) {
                Picker("通话模式", selection: Binding(get: { mode }, set: { selected in
                    run(sharedFailure: true) { try await $0.setConversationMode(selected) }
                })) {
                    Text(CallConversationMode.chat.label).tag(CallConversationMode.chat)
                        .accessibilityIdentifier("call.conversationMode.chat")
                    Text(CallConversationMode.thinking.label).tag(CallConversationMode.thinking)
                        .accessibilityIdentifier("call.conversationMode.thinking")
                }.pickerStyle(.segmented).controlSize(.large).frame(minHeight: 44)
                    .disabled(working || !model.call.isActive || model.call.pendingConversationMode != nil)
                    .accessibilityIdentifier("call.conversationMode")
                if let pending = model.call.pendingConversationMode {
                    HStack(spacing: 12) {
                        ProgressView().controlSize(.small)
                        Text("正在切换到\(pending.label)…").foregroundStyle(Yimi.ink2)
                            .accessibilityIdentifier("call.conversationMode.pending")
                        Button("重新发送") {
                            run(sharedFailure: true) { try await $0.resendConversationMode() }
                        }.frame(minHeight: 44).disabled(working)
                            .accessibilityIdentifier("call.conversationMode.resend")
                    }
                }
                if let failure = model.call.conversationModeFailure {
                    Text(failure).foregroundStyle(Yimi.danger).textSelection(.enabled)
                        .accessibilityIdentifier("call.conversationMode.failure")
                }
                if let status = model.call.thinkingStatus {
                    Text(status.text).foregroundStyle(Yimi.ink2)
                        .accessibilityIdentifier("call.thinking.status")
                    HStack(spacing: 16) {
                        if status.actions.contains("retry") {
                            Button(model.call.thinkingRetryFailure != nil ? "重新发送" : model.call.thinkingRetryPending ? "正在重试…" : "重试") {
                                run(sharedFailure: true) { try await $0.retryThinking() }
                            }.frame(minHeight: 44)
                                .disabled(working || !model.call.canRetryThinking && model.call.thinkingRetryFailure == nil)
                                .accessibilityIdentifier("call.thinking.retry")
                        }
                        if status.actions.contains("switch_to_chat") {
                            Button("切回聊天") {
                                run(sharedFailure: true) { try await $0.setConversationMode(.chat) }
                            }.frame(minHeight: 44).disabled(working || model.call.pendingConversationMode != nil)
                                .accessibilityIdentifier("call.thinking.switchToChat")
                        }
                    }
                }
                if let failure = model.call.thinkingRetryFailure {
                    Text(failure).foregroundStyle(Yimi.danger).textSelection(.enabled)
                        .accessibilityIdentifier("call.thinking.retryFailure")
                }
            }
        }
    }
    private var status: String {
        if model.callSnapshot?.isDialing == true || ["opening", "connecting"].contains(model.call.state) { return "正在接通…" }
        return model.call.isActive ? "通话中" : "未在通话"
    }
    private var muteStatus: String {
        if model.callSnapshot?.isDialing == true, mic == .off { return "麦克风还没打开" }
        return AssistantCallMuteState(mic).statusText
    }
    private var muteAnnouncement: String {
        if mic == .unknown { return "不确定是否已静音，你仍可能被听到。请重试静音，或结束通话。" }
        return muteStatus + ((mic == .opening || mic == .closing) ? "，请稍候。" : mic == .off ? "。按钮，取消静音。" : "")
    }
    private var muteAction: String { mic == .unknown ? "重试静音" : mic == .off ? "取消静音" : "静音" }
    @ViewBuilder private var deviceChoices: some View {
        Menu("麦克风") {
            ForEach(AudioManager.shared.inputDevices) { device in
                Button(device.name) { AudioManager.shared.inputDevice = device }.accessibilityIdentifier("call.device.microphone.\(device.id)")
            }
        }.accessibilityIdentifier("call.device.microphone")
        Menu("输出设备") {
            ForEach(AudioManager.shared.outputDevices) { device in
                Button(device.name) { AudioManager.shared.outputDevice = device }.accessibilityIdentifier("call.device.output.\(device.id)")
            }
        }.accessibilityIdentifier("call.device.output")
        Menu("镜头") {
            ForEach(cameras, id: \.uniqueID) { device in
                Button(device.localizedName) {
                    run { _ in
                        guard let track = model.callPreview.localVideoTrack as? LocalVideoTrack,
                              let capturer = track.capturer as? CameraCapturer else { throw CentralTextError.unavailable }
                        _ = try await capturer.set(options: CameraCaptureOptions(device: device,
                            dimensions: capturer.options.dimensions, fps: capturer.options.fps))
                    }
                }.accessibilityIdentifier("call.device.camera.\(device.uniqueID)")
            }
        }.disabled(camera != .on).accessibilityIdentifier("call.device.camera")
    }
    private func start(video: Bool) {
        lastVideo = video; swapped = false
        run { engine in
            let cameraOn = try await engine.start(video: video)
            if video && !cameraOn {
                failure = "摄像头未获允许，语音通话继续。请在系统设置中允许摄像头，再重新开视频。"
                retryAction = { try await $0.setCamera(true) }
            }
        }
    }
    private func run(sharedFailure: Bool = false, _ action: @escaping @MainActor (DesktopCallEngine) async throws -> Void) {
        guard let engine = model.callEngine else { failure = "还没连接。请先连接，再开始通话。"; return }
        failure = nil; retryAction = nil; working = true
        Task {
            defer { working = false }
            do { try await action(engine) } catch {
                // The coordinator publishes mode and thinking failures beside their controls.
                if sharedFailure { return }
                retryAction = action
                if let permission = error as? MediaPermissionError, permission == .cameraDenied {
                    failure = "摄像头权限未开启。请在系统设置的隐私与安全性中允许依米使用摄像头。"
                } else { failure = DesktopUserFacingError.message(error) }
            }
        }
    }
}

private struct DesktopCallStage: View {
    @ObservedObject var preview: AssistantVideoPreviewModel
    let camera: AssistantMediaPhase
    let avatar: Bool
    let thinking: Bool
    let ready: Bool
    @Binding var swapped: Bool
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group { if avatar && !swapped { remote } else { local } }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if avatar {
                Button { swapped.toggle() } label: {
                    Group { if swapped { remote } else { local } }.frame(width: 138, height: 104).clipped()
                }.buttonStyle(.plain).clipShape(RoundedRectangle(cornerRadius: 12)).padding(12)
                    .accessibilityLabel("交换你和依米的画面").accessibilityIdentifier("call.swap")
            }
        }.background(Yimi.paper).clipShape(RoundedRectangle(cornerRadius: 16))
    }
    @ViewBuilder private var local: some View {
        if camera == .on, let track = preview.localVideoTrack { SwiftUIVideoView(track, layoutMode: .fit) }
        else {
            VStack(spacing: 12) {
                if avatar || camera == .opening { Image(systemName: camera == .opening ? "video" : "video.slash").font(.system(size: 32)) }
                Text(cameraLabel)
                if thinking { Image(systemName: "waveform").font(.system(size: 32)).accessibilityHidden(true) }
                else if !avatar { YimiPortrait(breathes: false).frame(width: 90, height: 120) }
            }.foregroundStyle(Yimi.ink2)
        }
    }
    private var cameraLabel: String {
        switch camera {
        case .opening: return "正在开启镜头…"
        case .closing: return "正在关闭镜头…"
        case .unknown: return "不确定镜头是否已关。请重试关镜头，或结束通话。"
        case .off: return avatar ? "镜头已关" : "语音通话"
        case .on: return "视频通话"
        }
    }
    private var remote: some View {
        ZStack {
            if let view = preview.artcRemoteView { DesktopCallARTCView(view: view).id(ObjectIdentifier(view)) }
            else if let track = preview.remoteVideoTrack { SwiftUIVideoView(track, layoutMode: .fit) }
            if !ready { ProgressView("数字人连接中…").foregroundStyle(Yimi.ink2) }
        }
    }
}
private struct DesktopCallARTCView: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
