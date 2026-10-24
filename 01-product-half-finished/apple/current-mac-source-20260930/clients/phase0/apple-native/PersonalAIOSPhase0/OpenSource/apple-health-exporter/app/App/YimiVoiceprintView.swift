import SwiftUI
import AVFoundation

/// Familiarity enrollment uses live call capture and server-measured clean turns.
struct YimiVoiceprintView: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject private var conversation: YimiConversation
    @State private var showingConversation = false
    @State private var previewPlayer: AVAudioPlayer?
    @State private var previewError: String?
    @State private var requestedAction: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(vm: AssistantViewModel) {
        self.vm = vm
        _conversation = ObservedObject(wrappedValue: vm.conversation)
    }
    private var enrollment: CentralVoiceEnrollment { vm.voiceEnrollment }
    private var active: Bool { [.collecting, .paused, .checked].contains(enrollment.phase) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if showingConversation || active { recording } else { introduction }
                if let error = vm.voiceEnrollmentError {
                    Text(error).foregroundStyle(Yimi.danger)
                    Button("重试") { send("read") }.accessibilityIdentifier("voiceEnrollment.retry")
                }
            }
            .padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
        }
        .background(Yimi.ground).tint(Yimi.klein)
        .navigationTitle(showingConversation || active ? "和依米聊一会儿" : "你的声音")
        .navigationBarTitleDisplayMode(.inline).toolbarRole(.editor)
        .task { _ = await vm.controlVoiceEnrollment("read") }
        .onDisappear {
            previewPlayer?.stop()
            if enrollment.phase == .collecting { Task { _ = await vm.controlVoiceEnrollment("pause") } }
        }
        .animation(reduceMotion ? nil : Yimi.Motion.component, value: enrollment.phase)
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 14) {
                Image(systemName: "person.wave.2").font(.title2).foregroundStyle(Yimi.klein)
                    .frame(width: 48, height: 48).background(Yimi.tint, in: Circle())
                VStack(alignment: .leading, spacing: 6) {
                    Text(familiarity).font(.title3.weight(.semibold)).foregroundStyle(Yimi.ink)
                        .accessibilityIdentifier("voiceEnrollment.status")
                    if let date = enrollment.owner?.updatedAt {
                        Text("最近录入：\(date.formatted(date: .abbreviated, time: .shortened))").font(.footnote).foregroundStyle(Yimi.ink2)
                    }
                    if enrollment.owner?.updatedAt != nil {
                        Text("来源设备：\(enrollment.sourceDevice.map { deviceName($0) } ?? "未记录")").font(.footnote).foregroundStyle(Yimi.ink2)
                    }
                }
            }
            Text("聊聊最近的生活，让依米更熟悉你的声音。她会自然地问你、接着你的话聊，不用背稿。")
                .font(.body).foregroundStyle(Yimi.ink)
            VStack(alignment: .leading, spacing: 12) {
                Label("找一个安静的地方，用平常说话的声音", systemImage: "ear")
                Label("沿用通话的麦克风、回声消除与降噪", systemImage: "mic")
                Label("来电或切换耳机时暂停，清晰语音进度保留", systemImage: "pause.circle")
            }.font(.subheadline).foregroundStyle(Yimi.ink2)
            primary(enrollment.owner?.enrolled == true ? "补录一段对话" : "开始聊一会儿", id: "voiceEnrollment.start") {
                Task { if await vm.controlVoiceEnrollment("start") { showingConversation = true } }
            }.disabled(!vm.sessionState.isActive || vm.voiceEnrollmentBusy || !enrollment.available || vm.call.isActive)
            if vm.call.isActive {
                Text("通话结束后，再开始声音录入。").font(.footnote).foregroundStyle(Yimi.ink2)
            }
            if !enrollment.available {
                Text("对话录入尚未开放。连接支持此功能的依米服务后重试。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
            }
            VStack(alignment: .leading, spacing: 16) {
                Text("可选补充").font(.headline)
                Label("眼镜补充", systemImage: "eyeglasses")
                Label("Mac 补充", systemImage: "desktopcomputer")
                Text("眼镜：设置 → 补充声音，在这台 iPhone 上用 Face ID 允许后，戴着眼镜和依米聊一会儿。Mac：设置 → 通用 → 你的声音。不同设备各自保存，不是必经步骤，也不用于支付。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card))
            Text("原有声纹会保留，直到新录音检查并保存成功。此对话不用于支付声纹录入。")
                .font(.footnote).foregroundStyle(Yimi.ink2)
        }
    }

    private var recording: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 14) {
                YimiPortrait(breathes: enrollment.phase == .collecting && !reduceMotion)
                    .frame(width: 64, height: 76).clipShape(RoundedRectangle(cornerRadius: Yimi.Radius.small))
                VStack(alignment: .leading, spacing: 6) {
                    Text(phaseTitle).font(.title3.weight(.semibold)).foregroundStyle(Yimi.ink)
                    Text("与通话相同收音").font(.subheadline).foregroundStyle(Yimi.ink2)
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                Text("已检查录音 \(duration(enrollment.recordedMS))").font(.subheadline.monospacedDigit()).foregroundStyle(Yimi.ink2)
                Text("已收集清晰语音 \(duration(enrollment.cleanSpeechMS))")
                    .font(.headline.monospacedDigit()).accessibilityIdentifier("voiceEnrollment.progress")
                ProgressView(value: Double(enrollment.cleanSpeechMS), total: Double(max(1, enrollment.targetSpeechMS)))
                    .tint(Yimi.klein).accessibilityLabel("清晰语音收集进度")
                Text("只计算你清楚、单独说话的部分。时长不代表识别准确率。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
            }
            if let issue = enrollment.issue {
                Label(issueText(issue), systemImage: "exclamationmark.circle").font(.body).foregroundStyle(Yimi.ink)
                    .accessibilityIdentifier("voiceEnrollment.quality")
            }
            if enrollment.phase == .checked { checkResult }
            else if enrollment.phase == .committed {
                Label("已熟悉你的声音", systemImage: "checkmark.circle.fill").foregroundStyle(Yimi.ok)
                primary("完成", id: "voiceEnrollment.done") { showingConversation = false }
            } else {
                transcript
                HStack(spacing: 16) {
                    Button(enrollment.phase == .paused ? "继续" : "暂停") { send(enrollment.phase == .paused ? "resume" : "pause") }
                        .accessibilityIdentifier("voiceEnrollment.pauseResume")
                    Spacer()
                    Button("结束并检查") { send("check") }.accessibilityIdentifier("voiceEnrollment.check")
                }.font(.body.weight(.medium)).frame(minHeight: 48).disabled(vm.voiceEnrollmentBusy || !active)
            }
            if vm.voiceEnrollmentBusy {
                ProgressView(pendingText).accessibilityIdentifier("voiceEnrollment.pending")
            }
            if enrollment.phase != .committed {
                Button("放弃这段录音", role: .destructive) {
                    Task { if await vm.controlVoiceEnrollment("discard") { showingConversation = false } }
                }.frame(minHeight: 44).disabled(vm.voiceEnrollmentBusy).accessibilityIdentifier("voiceEnrollment.discard")
            }
        }
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 14) {
            let lines = Array(conversation.callLines(vm.call.id).suffix(4))
            if lines.isEmpty {
                Text(enrollment.phase == .paused ? "对话已暂停，清晰语音进度保留。准备好后继续。" : "依米正在接通，准备和你聊聊。")
                    .foregroundStyle(Yimi.ink2)
            }
            ForEach(lines) { line in
                VStack(alignment: .leading, spacing: 5) {
                    Text(line.kind == .me ? "你" : "依米").font(.footnote.weight(.semibold)).foregroundStyle(Yimi.ink2)
                    Text(line.text).font(.body).foregroundStyle(Yimi.ink)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card))
            .accessibilityIdentifier("voiceEnrollment.conversation")
    }

    private var checkResult: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(enrollment.canUse ? "这段可以使用" : "还需补充").font(.title3.weight(.semibold)).foregroundStyle(Yimi.ink)
            if enrollment.canUse { Label("单人声音清晰", systemImage: "checkmark.circle").foregroundStyle(Yimi.ok) }
            Text("保留原有声纹，直到新录音检查和保存成功。").font(.footnote).foregroundStyle(Yimi.ink2)
            Button("试听清晰片段") {
                Task {
                    previewError = nil
                    guard await vm.controlVoiceEnrollment("preview"), let audio = vm.voiceEnrollment.previewAudio else { return }
                    do {
                        let player = try AVAudioPlayer(data: audio)
                        guard player.play() else { previewError = "这次没能播放，请再试听一次"; return }
                        previewPlayer = player
                    } catch { previewError = "这次没能播放，请再试听一次" }
                }
            }.frame(minHeight: 44).disabled(!enrollment.canUse || vm.voiceEnrollmentBusy)
                .accessibilityIdentifier("voiceEnrollment.preview")
            if let previewError { Text(previewError).font(.footnote).foregroundStyle(Yimi.danger) }
            primary("使用这段录音", id: "voiceEnrollment.use") { send("commit") }.disabled(!enrollment.canUse || vm.voiceEnrollmentBusy)
            Button("重新来一段") {
                Task {
                    if await vm.controlVoiceEnrollment("discard"), await vm.controlVoiceEnrollment("start") { showingConversation = true }
                }
            }.frame(minHeight: 44).disabled(vm.voiceEnrollmentBusy).accessibilityIdentifier("voiceEnrollment.restart")
        }
    }

    private var familiarity: String {
        guard let owner = enrollment.owner else { return "正在读取…" }
        if owner.reenrollmentRequired { return "还需补充" }
        return owner.enrolled ? "已熟悉" : "未录入"
    }
    private var phaseTitle: String {
        switch enrollment.phase {
        case .collecting: return "正在熟悉你的声音"
        case .paused: return "已暂停"
        case .checked: return "检查录音"
        case .committed: return "保存成功"
        default: return "等待依米确认"
        }
    }
    private func duration(_ ms: Int) -> String { String(format: "%02d:%02d", ms / 60_000, ms / 1_000 % 60) }
    private func issueText(_ issue: String) -> String {
        switch issue {
        case "multiple_speakers": return "这段有多人声音"
        case "VOICE_ENROLLMENT_OTHER_SPEAKER": return "这段声音还没有确认是你，请继续说一段"
        case "no_speech", "too_short", "too_quiet": return "离麦克风近一点"
        case "low_snr": return "背景声有点大"
        case "clipped": return "声音有些失真，请离麦克风稍远一点"
        case "VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED", "VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES": return "清晰语音还不够，继续聊一会儿吧"
        case "VOICEPRINT_ENROLLMENT_INCONSISTENT": return "这些声音片段不够一致，请重新来一段"
        default: return "这段声音暂时不能使用，请再试一次"
        }
    }
    private func deviceName(_ type: String) -> String {
        switch type { case "phone": return "iPhone"; case "glasses": return "眼镜"; case "mac": return "Mac"; default: return type }
    }
    private var pendingText: String {
        switch requestedAction { case "check": return "正在检查录音…"; case "commit": return "正在保存…"; default: return "正在等待依米确认…" }
    }
    private func send(_ action: String) {
        Task { requestedAction = action; defer { requestedAction = nil }; _ = await vm.controlVoiceEnrollment(action) }
    }
    private func primary(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 50) }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).accessibilityIdentifier(id)
    }
}
