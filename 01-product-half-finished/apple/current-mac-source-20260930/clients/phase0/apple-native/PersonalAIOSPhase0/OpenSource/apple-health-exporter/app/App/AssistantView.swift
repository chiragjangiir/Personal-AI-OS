import SwiftUI

@MainActor
struct AssistantView: View {
    @EnvironmentObject private var appModel: AppModel
    @StateObject private var model: AssistantViewModel
    @State private var voicePressing = false
    @State private var healthOpen = false

    init(viewModel: AssistantViewModel) {
        _model = StateObject(wrappedValue: viewModel)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                conversationCard
                promptComposer
                moreSection
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .navigationTitle("个人 AI 助手")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(uiColor: .systemGroupedBackground))
        .task {
            await model.refreshPermissions()
        }
    }

    // MARK: - Everyday surface: state, the answer, the voice turn.

    private var sessionTint: Color {
        switch model.sessionState {
        case .active: return .green
        case .failed: return .red
        case .idle, .stopped: return Color(uiColor: .tertiaryLabel)
        default: return .orange
        }
    }

    private var conversationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle().fill(sessionTint).frame(width: 9, height: 9)
                Text(model.sessionState.displayName)
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("assistant.sessionState")
                Spacer()
                if model.sessionState.canStop {
                    Label("端到端加密", systemImage: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if model.call.lines.isEmpty { resultContent } else { callTranscript }
            if model.textOwner == .centralCandidate && !model.call.isActive { voiceTurnSummary }
            if !model.promptStatusText.isEmpty {
                Text(model.promptStatusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("assistant.prompt.status")
            }
            if let warning = model.startupWarning {
                Label(warning, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let lastError = model.lastError {
                Label(lastError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("assistant.failure")
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color(uiColor: .secondarySystemGroupedBackground)))
    }

    private var resultContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let presentation = model.centralPresentation, model.textOwner == .centralCandidate {
                Text(QwenHandoff.split(presentation.text).display)
                    .font(.title3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("assistant.result")
                    .id(presentation.packet.bytes)
                    .onAppear { Task { await model.centralTextSurfaceConsumed(presentation) } }
                if model.qwenPendingURL != nil {
                    Button("交给千问") { model.openQwen() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("assistant.qwen")
                }
            } else {
                Text(model.resultText.isEmpty
                     ? (model.sessionState.canStop ? AssistantView.activeHint : AssistantView.emptyResult)
                     : model.resultText)
                    .font(model.resultText.isEmpty ? .body : .title3)
                    .foregroundStyle(model.resultText.isEmpty ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("assistant.result")
            }
            Text(model.resultIsFinal ? "完整回答" : "等待中")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .accessibilityIdentifier("assistant.result.finality")
        }
    }

    static let emptyResult = "点「开始」，然后按住下方按钮说话；也可以直接输入文字。"
    static let activeHint = "按住下方按钮说话，或在下面输入文字。"

    // Candidates and the turn's own state; the hold button itself lives in the bottom bar.
    private var callTranscript: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.call.lines.suffix(8)) { line in
                HStack(alignment: .top, spacing: 6) {
                    Text(line.role == "user" ? "你" : line.role == "main_agent" ? "依米·补充" : "依米")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(line.role == "user" ? Color.secondary : Color.accentColor)
                        .frame(width: 52, alignment: .leading)
                    Text(line.text + (line.interrupted ? "…" : ""))
                        .font(line.role == "user" ? .body : .title3)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityIdentifier("assistant.call.transcript")
    }

    @ViewBuilder private var voiceTurnSummary: some View {
        if model.voiceTurn.phase != .idle {
            Text(model.voiceTurn.status)
                .font(.footnote)
                .foregroundStyle(model.voiceTurn.phase == .failed ? .red : .secondary)
        }
        ForEach(model.voiceTurn.candidates) { candidate in
            VStack(alignment: .leading, spacing: 8) {
                Text(candidate.transcript.isEmpty ? "（没有听清内容）" : candidate.transcript)
                    .font(.body)
                    .textSelection(.enabled)
                Button("发送这句原文") { Task { await model.sendVoiceCandidate(candidate) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.voiceTurn.phase != .ready || candidate.transcript.isEmpty)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color(uiColor: .tertiarySystemGroupedBackground)))
            .accessibilityIdentifier("assistant.voice.candidate")
        }
        if model.voiceTurn.isActive {
            Button("取消本次语音", role: .cancel) { Task { await model.cancelVoiceTurn() } }
                .font(.footnote)
                .accessibilityIdentifier("assistant.voice.cancel")
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 10) {
            if model.textOwner == .centralCandidate && model.sessionState.canStop {
                callButton
            }
            HStack(spacing: 10) {
                if model.canRetryRemoteStop {
                    Button("重试结束") { Task { await model.retryRemoteStop() } }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .accessibilityIdentifier("assistant.retryRemoteStop")
                }
                Button { Task { await model.start() } } label: {
                    Label("开始", systemImage: "play.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!model.canStart)
                .accessibilityIdentifier("assistant.start")
                Button { Task { await model.stop() } } label: {
                    Label("结束", systemImage: "stop.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(!model.canStop)
                .accessibilityIdentifier("assistant.stop")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.bar)
    }

    // One tap to talk, one tap to hang up; barge-in and turn-taking happen centrally.
    private var callButton: some View {
        Button {
            Task { if model.call.isActive { await model.endCall() } else { await model.startCall() } }
        } label: {
            Label(model.call.isActive ? (model.call.state == "opening" ? "正在接通…" : "挂断") : "和依米通话",
                  systemImage: model.call.isActive ? "phone.down.fill" : "phone.fill")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 60)
                .background(Capsule().fill(model.call.isActive ? Color.red : Color.green))
                .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assistant.call")
    }

    private var holdToTalk: some View {
        HStack(spacing: 10) {
            Label(voicePressing ? "松开结束" : model.voiceTurn.status,
                  systemImage: voicePressing ? "waveform" : "mic.fill")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 60)
                .background(Capsule().fill((voicePressing ? Color.red : Color.accentColor)
                    .opacity(model.canUseVoiceTurn ? 1 : 0.35)))
                .foregroundStyle(.white)
                .contentShape(Capsule())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !voicePressing, model.canUseVoiceTurn,
                              !model.voiceTurn.isActive || model.voiceTurn.phase == .ready else { return }
                        voicePressing = true
                        Task { await model.voicePressed() }
                    }
                    .onEnded { _ in
                        guard voicePressing else { return }
                        voicePressing = false
                        Task { await model.voiceReleased() }
                    })
                .accessibilityIdentifier("assistant.voice.hold")
            if !model.microphoneEnabled {
                // The microphone stays an explicit choice; it is just offered where it is needed.
                Button { Task { await model.setMicrophoneEnabled(true) } } label: {
                    Label("开麦克风", systemImage: "mic.slash").labelStyle(.iconOnly).font(.title3)
                        .frame(width: 60, height: 60)
                }
                .buttonStyle(.bordered)
                .clipShape(Circle())
                .accessibilityLabel("打开麦克风")
                .accessibilityIdentifier("assistant.voice.enableMicrophone")
            }
        }
    }

    // MARK: - Everything that is not the everyday loop.

    private var moreSection: some View {
        DisclosureGroup("更多") {
            VStack(alignment: .leading, spacing: 16) {
                mediaCard
                AssistantVideoPreview(model: model.videoPreviewModel)
                Text("位置质量：" + model.locationQuality.displayName)
                    .font(.footnote)
                    .foregroundStyle(model.locationQuality == .unavailable ? .secondary : .primary)
                    .accessibilityIdentifier("assistant.locationQuality")
                if model.textOwner == .centralCandidate { centralControls }
                GroupBox("连接详情") {
                    VStack(spacing: 10) {
                        statusRow("媒体加密", model.e2eeSummary)
                        statusRow("Bootstrap", "由控制面注入，不绑定固定 URL")
                    }
                    .padding(.top, 4)
                }
                if model.canManageWatchBinding {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.watchBindingStatus).font(.footnote)
                        HStack {
                            Button("登记或更换 Watch") { Task { await model.manageWatchBinding(revoke: false) } }
                                .accessibilityIdentifier("assistant.registerWatch")
                            Button("撤销 Watch") { Task { await model.manageWatchBinding(revoke: true) } }
                                .accessibilityIdentifier("assistant.revokeWatch")
                        }.disabled(model.watchBindingBusy)
                    }
                }
                healthLink
                Text("只有明确点「开始」或打开媒体开关后才请求权限并采集；音频、视频与数据全程端到端加密。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 12)
        }
        .font(.subheadline)
    }

    private var promptComposer: some View {
        HStack(spacing: 10) {
            TextField("输入问题，例如：告诉我今天的状态", text: $model.promptText)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .frame(height: 46)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemGroupedBackground)))
                .textInputAutocapitalization(.sentences)
                .submitLabel(.send)
                .onSubmit { Task { await model.submitPrompt() } }
                .accessibilityIdentifier("assistant.prompt")
            Button { Task { await model.submitPrompt() } } label: {
                Image(systemName: model.promptState == .submitting ? "ellipsis.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 34))
            }
            .disabled(!model.canSubmitPrompt)
            .accessibilityLabel(model.textOwner == .centralCandidate ? "提交原文" : "发送问题")
            .accessibilityIdentifier("assistant.sendPrompt")
        }
    }

    private var centralControls: some View {
        GroupBox("运行与记忆") {
            VStack(alignment: .leading, spacing: 10) {
                Button("读取本次待批记录") { Task { await model.requestCentralMemoryProposals() } }
                    .disabled(!model.centralCanRequest || !model.sessionState.canStop)
                    .accessibilityIdentifier("assistant.memory.read")
                Text(model.centralMemoryStatus).font(.caption)
                Text("控制包只在本次 App 进程保留。重启后原控制状态未知；不会自动新建决定。").font(.caption).foregroundStyle(.secondary)
                ForEach(model.centralMemoryProposals) { proposal in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("候选操作：\(memoryOperation(proposal.command.operation))；原版本：\(proposal.command.expected_version)")
                        Text(proposal.command.assertion.predicate)
                        Text(memoryValue(proposal.command.assertion.value))
                        Text(proposal.command.assertion.subject_ref.type == .unknown_subject ? "主体未确认" :
                            proposal.command.assertion.subject_ref.type == .speaker_cluster ? "主体来自说话人簇" : "来源已标识主体").font(.caption)
                        Text("记录状态：\(proposal.command.assertion.status.rawValue)；适用性：\(proposal.command.assertion.applicability_status.rawValue)").font(.caption)
                        DisclosureGroup("来源详情") {
                            Text("来源 D：\(proposal.origin.processed_event_id)；运行：\(proposal.origin.run_id)").font(.caption)
                            Text("主体引用：" + proposal.command.assertion.subject_ref.id).font(.caption)
                        }
                        Text("证据：\(proposal.command.assertion.evidence_status)；原件数量：\(proposal.command.evidence_refs.count)").font(.caption)
                        ForEach(proposal.command.assertion.unknown_conditions, id: \.self) { Text("未知：" + $0).font(.caption) }
                        ForEach(proposal.command.assertion.conflicts, id: \.self) { Text("冲突：" + $0).font(.caption) }
                        if let receipt = proposal.receipt {
                            Text("记录已提交；版本 \(receipt.version)")
                        } else if let decision = proposal.decision {
                            Text("决定已记录：" + decision.decision.rawValue + "；记忆提交尚未确认")
                        }
                        HStack {
                            Button("批准" + memoryOperation(proposal.command.operation)) { Task { await model.decideCentralMemory(proposal, choice: .approve) } }
                            Button("拒绝") { Task { await model.decideCentralMemory(proposal, choice: .reject) } }
                        }.disabled(!model.centralMemoryDecisionIDs.contains(proposal.id) || !model.sessionState.canStop)
                    }.padding(.vertical, 6)
                }
                ForEach(model.centralMemoryRetryControls, id: \.self) { controlID in
                    Button("重发原待批请求") { Task { await model.retryCentralMemoryControl(controlID) } }
                        .disabled(!model.sessionState.canStop)
                }
                Button("取消当前运行") { Task { await model.requestCentralControl("cancel_run") } }
                    .disabled(!model.centralCanCancelRun || !model.sessionState.canStop)
                Button("取消当前播放") { Task { await model.requestCentralControl("cancel_playback") } }
                    .disabled(!model.centralCanCancelPlayback || !model.sessionState.canStop)
                if model.centralCanRetryVoiceGeneration {
                    Button("重试语音生成") { Task { await model.requestCentralControl("retry_voice") } }
                        .disabled(!model.sessionState.canStop)
                        .accessibilityIdentifier("assistant.centralRetryVoiceGeneration")
                }
                Button("对账当前运行") { Task { await model.requestCentralControl("reconcile") } }
                    .disabled(!model.centralCanRequest || !model.sessionState.canStop)
                Button("主动取得本次结果") { Task { await model.requestCentralResult() } }
                    .disabled(!model.centralCanRequest || !model.sessionState.canStop)
                    .accessibilityIdentifier("assistant.centralResult")
                ForEach(Array(model.centralRetainedVoiceResultIDs.enumerated()), id: \.element) { item in
                    Button("重读较早语音状态 \(item.offset + 1)") {
                        Task { await model.requestCentralRetainedResult(item.element) }
                    }
                    .disabled(!model.sessionState.canStop)
                    .accessibilityIdentifier("assistant.centralRetainedResult.\(item.offset)")
                }
                Button("重读封存结果") { Task { await model.requestCentralResult(sealed: true) } }
                    .disabled(!model.centralCanRequestSealed || !model.sessionState.canStop)
                    .accessibilityIdentifier("assistant.centralSealedResult")
                if model.centralCanRetrySubmission {
                    Button("重发原提交") { Task { await model.retryCentralSubmission() } }
                }
                if model.centralCanRetryACK {
                    Button("重发原显示回执") { Task { await model.retryCentralRenderedACK() } }
                }
            }
            .padding(.top, 4)
        }
    }

    private func memoryOperation(_ operation: CentralMemoryProposal.Command.Operation) -> String {
        switch operation {
        case .create: return "新增记录"
        case .correct: return "纠正记录"
        case .review: return "审查记录"
        case .delete: return "删除记录"
        case .retract: return "撤回记录"
        case .deny: return "否定记录"
        }
    }

    private func memoryValue(_ value: CentralJSONValue) -> String {
        switch value {
        case .null: return "null"
        case .boolean(let value): return String(value)
        case .number(let value): return String(value)
        case .string(let value): return value
        case .array(let values): return "[" + values.map(memoryValue).joined(separator: ", ") + "]"
        case .object(let values): return values.keys.sorted().map { $0 + ": " + memoryValue(values[$0]!) }.joined(separator: "; ")
        }
    }

    private var mediaCard: some View {
        GroupBox("本次会话") {
            VStack(spacing: 10) {
                mediaToggle(
                    title: "麦克风",
                    icon: "mic",
                    isOn: model.microphoneEnabled,
                    permission: model.mediaPermissions.microphone
                ) { enabled in
                    await model.setMicrophoneEnabled(enabled)
                }
                mediaToggle(
                    title: "前台相机",
                    icon: "camera",
                    isOn: model.cameraEnabled,
                    permission: model.mediaPermissions.camera
                ) { enabled in
                    await model.setCameraEnabled(enabled)
                }
                mediaToggle(
                    title: "前台位置",
                    icon: "location",
                    isOn: model.locationEnabled,
                    permission: model.locationPermission
                ) { enabled in
                    await model.setLocationEnabled(enabled)
                }
                Text("A3 不申请后台位置；相机也不会在后台继续采集。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 4)
        }
    }

    private func mediaToggle(
        title: String,
        icon: String,
        isOn: Bool,
        permission: AssistantPermissionStatus,
        action: @escaping (Bool) async -> Void
    ) -> some View {
        Toggle(
            isOn: Binding(
                get: { isOn },
                set: { value in
                    Task {
                        await action(value)
                    }
                }
            )
        ) {
            HStack {
                Label(title, systemImage: icon)
                Spacer()
                Text(permission.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func statusRow(
        _ title: String,
        _ value: String
    ) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .fontWeight(.medium)
                .accessibilityIdentifier(
                    title == "会话"
                        ? "assistant.sessionState"
                        : "assistant.status." + title
                )
        }
        .font(.subheadline)
    }

    // ContentView owns NavigationStacks: a sheet, never a push (see YimiRoute).
    private var healthLink: some View {
        Button { healthOpen = true } label: {
            Label(
                "进入健康数据与旧终端诊断",
                systemImage: "heart.text.square"
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("assistant.health")
        .sheet(isPresented: $healthOpen) { ContentView().environmentObject(appModel) }
    }
}
