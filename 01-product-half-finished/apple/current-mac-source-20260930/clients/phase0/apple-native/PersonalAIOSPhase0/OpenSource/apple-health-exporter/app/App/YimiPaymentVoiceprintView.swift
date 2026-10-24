import SwiftUI

/// 她了解你 → 我的声音: whether 依米 knows the owner's voice, enrollment (8 sentences, hold to read each), re-enrollment
/// and "忘记我的声音". Each sentence is recorded on the session's microphone and measured on the owner server; the voiceprint
/// itself stays encrypted on that server.
struct YimiPaymentVoiceprintView: View {
    @ObservedObject var vm: AssistantViewModel
    @State private var enrolling = false
    @State private var forgetting = false
    @State private var forgettingGlasses = false
    @State private var busy = false
    @State private var selectedVoiceDeviceID = ""
    @State private var trustNote: String?

    static let sentences = [
        "依米，明天早上八点提醒我开会。", "今天中午我想吃一碗牛肉面，不要香菜。", "帮我看看周末的天气，适不适合去爬山。",
        "我刚才和老王聊的那个项目，下周一要交方案。", "给我妈发个消息，说我晚上七点到家。", "最近睡眠不太好，晚上总是醒好几次。",
        "这家咖啡店的拿铁比上次那家好喝多了。", "依米，把刚才那段对话总结一下。",
    ]

    var body: some View {
        Group {
            if enrolling {
                YimiPaymentVoiceprintEnrollment(vm: vm) { finished in
                    withAnimation(Yimi.Motion.page) { enrolling = false }
                    if finished { Task { await vm.refreshVoiceprint() } }
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                status.transition(.opacity)
            }
        }
        .animation(Yimi.Motion.page, value: enrolling)
        .navigationTitle("我的声音")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .task { if vm.sessionState.isActive { await vm.refreshVoiceprint() } }
        .onChange(of: vm.sessionState.isActive) { _, active in if active { Task { await vm.refreshVoiceprint() } } }
        .confirmationDialog("忘记你的声音？", isPresented: $forgetting, titleVisibility: .visible) {
            Button("忘记我的声音", role: .destructive) {
                Task { busy = true; _ = await vm.forgetVoiceprint(); busy = false }
            }
        } message: {
            Text("之后依米不再认得你的声音；声纹支付和免密支付会关闭，需要你重新开启。要下单、发消息这类事，会先请你在手机上点“确认是我”。")
        }
        .confirmationDialog("忘记眼镜上的声音？", isPresented: $forgettingGlasses, titleVisibility: .visible) {
            Button("忘记眼镜上的声音", role: .destructive) { Task { await vm.payment.forgetGlassesVoice() } }
        } message: {
            Text("需要 Face ID 或密码。如果没有其他有效声纹，声纹支付和免密支付也会关闭。")
        }
    }

    private var status: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        Image(systemName: owner?.enrolled == true ? "person.wave.2.fill" : "person.wave.2")
                            .font(.system(size: 22, weight: .medium)).foregroundStyle(Yimi.klein)
                            .frame(width: 44, height: 44).background(Yimi.tint, in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text(headline).font(.system(size: 17, weight: .semibold)).foregroundStyle(Yimi.ink)
                            if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(Yimi.ink2) }
                        }
                    }
                    Text("听出是你，她才会帮你下单、发消息、翻看你的记录；别人的声音只能和她聊天。声纹只存在你自己的服务器上，加密保存。")
                        .font(.system(size: 14)).foregroundStyle(Yimi.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 6)
            }
            YimiVoiceTrustWindowControls(devices: vm.voiceprint.voiceDevices, selectedDeviceID: $selectedVoiceDeviceID,
                busy: busy, active: vm.sessionState.isActive, note: trustNote) {
                Task {
                    busy = true; trustNote = nil
                    if await vm.trustVoiceWindow(sourceDeviceID: selectedVoiceDeviceID) {
                        trustNote = "已确认，接下来 1 分钟内这台设备上的声音视为你本人"
                    }
                    busy = false
                }
            }
            .onChange(of: vm.voiceprint.voiceDevices, initial: true) { _, devices in
                if !devices.contains(where: { $0.id == selectedVoiceDeviceID }) {
                    selectedVoiceDeviceID = vm.voiceprint.activeVoiceDeviceID ?? ""
                }
            }
            if let payment = vm.payment.settings, vm.payment.available {
                Section("眼镜上的声音") {
                    LabeledContent("我的眼镜", value: payment.voiceprint.glasses ? "已录入" : "未录入")
                    Text("戴上并解锁眼镜，在眼镜的「设置 → 我的声音」发起录入，再到 iPhone 确认。")
                        .font(.system(size: 14)).foregroundStyle(Yimi.ink2)
                    if payment.voiceprint.glasses {
                        Button("忘记眼镜上的声音", role: .destructive) { forgettingGlasses = true }.disabled(vm.payment.busy)
                    }
                    if let error = vm.payment.error { Text(error).foregroundStyle(Yimi.danger) }
                }
            }
            Section {
                Button {
                    withAnimation(Yimi.Motion.page) { enrolling = true }
                } label: {
                    Label(owner?.enrolled == true ? "重新录入" : "录入我的声音", systemImage: "mic")
                }
                .disabled(!vm.sessionState.isActive || busy)
                if owner?.enrolled == true || owner?.reenrollmentRequired == true {
                    Button(role: .destructive) { forgetting = true } label: {
                        Label("忘记我的声音", systemImage: "trash")
                    }
                    .disabled(!vm.sessionState.isActive || busy)
                }
            } footer: {
                if let error = vm.voiceprintError {
                    Text(error).foregroundStyle(Yimi.danger)
                }
            }
        }
        .tint(Yimi.klein)
    }

    private var owner: CentralVoiceprintOwner? { vm.voiceprint.owner }
    private var headline: String {
        guard let owner else { return vm.sessionState.isActive ? "正在读取…" : "我的声音" }
        if owner.reenrollmentRequired { return "需要重新录一次" }
        return owner.enrolled ? "依米认得你的声音" : "还没录入你的声音"
    }
    private var detail: String? {
        guard let owner else { return nil }
        if owner.reenrollmentRequired { return "服务器上的声纹模型更新了，之前的录音不能再用" }
        guard owner.enrolled else { return "读 8 句话，大约一分钟" }
        let when = owner.updatedAt.map { " · " + $0.formatted(.dateTime.month().day()) + "更新" } ?? ""
        return "已录入 \(owner.samples) 句" + when
    }
}

/// The enrollment itself: one sentence at a time, hold to read it, each measured on the Mac (too short or silent asks
/// again); once at least five are good the set is committed, and any the registry finds unlike the rest are asked again.
private struct YimiPaymentVoiceprintEnrollment: View {
    @ObservedObject var vm: AssistantViewModel
    let done: (_ finished: Bool) -> Void

    enum TakeState: Equatable { case pending, good, retry(String) }
    struct Take: Equatable { var sampleID: String?; var state: TakeState = .pending }
    enum Phase: Equatable { case ready, opening, recording, measuring, committing, enrolled }

    @State private var takes = Array(repeating: Take(), count: YimiPaymentVoiceprintView.sentences.count)
    @State private var current = 0
    @State private var phase = Phase.ready
    @State private var press: UInt64?
    @State private var pressing = false
    @State private var note: String?

    private var good: [String] { takes.compactMap { $0.state == .good ? $0.sampleID : nil } }

    var body: some View {
        VStack(spacing: 0) {
            progress.padding(.top, 18).padding(.horizontal, 20)
            Spacer(minLength: 12)
            sentenceCard.padding(.horizontal, 20)
            Spacer(minLength: 12)
            if phase == .enrolled { finished } else { recorder }
            commitBar.padding(.horizontal, 20).padding(.bottom, 14)
        }
        .background(Yimi.ground)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(phase == .enrolled ? "完成" : "取消") { cancelRecording(); done(phase == .enrolled) }
                    .disabled(phase == .committing)
            }
        }
        .animation(Yimi.Motion.component, value: phase)
        .animation(Yimi.Motion.component, value: takes)
        .animation(Yimi.Motion.component, value: current)
        .onDisappear { cancelRecording() }
        .onChange(of: vm.sessionState.isActive) { _, active in
            if !active, [.opening, .recording, .measuring].contains(phase) { cancelRecording(); phase = .ready; note = "这句没录完，请重读一遍" }
        }
    }

    private var progress: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                ForEach(takes.indices, id: \.self) { index in
                    Button { if phase == .ready { current = index; note = nil } } label: {
                        Capsule().fill(color(for: index)).frame(height: 6)
                            .overlay(Capsule().stroke(Yimi.klein, lineWidth: index == current ? 1.5 : 0).padding(-2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("第 \(index + 1) 句" + (takes[index].state == .good ? "，已录好" : ""))
                }
            }
            Text(phase == .enrolled ? "全部完成" : "第 \(current + 1) / \(takes.count) 句")
                .font(.system(size: 13).monospacedDigit()).foregroundStyle(Yimi.ink2)
        }
    }

    private func color(for index: Int) -> Color {
        switch takes[index].state {
        case .good: return Yimi.ok
        case .retry: return Yimi.danger
        case .pending: return index == current ? Yimi.klein : Yimi.hair
        }
    }

    private var sentenceCard: some View {
        VStack(spacing: 14) {
            Text(phase == .enrolled ? "已记住你的声音" : YimiPaymentVoiceprintView.sentences[current])
                .font(.system(size: 24, weight: .medium)).foregroundStyle(Yimi.ink)
                .multilineTextAlignment(.center).lineSpacing(4)
                .frame(maxWidth: .infinity, minHeight: 120)
                .contentTransition(.opacity)
            Text(hint).font(.system(size: 14)).foregroundStyle(hintColor)
                .multilineTextAlignment(.center).frame(minHeight: 40, alignment: .top)
                .contentTransition(.opacity)
        }
        .padding(.horizontal, 20).padding(.vertical, 26)
        .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
    }

    private var hint: String {
        if phase == .enrolled { return "以后听到你的声音，依米就知道是你。" }
        if let note { return note }
        if case .retry(let reason) = takes[current].state { return reason }
        switch phase {
        case .opening: return "准备中…"
        case .recording: return "请读，读完再松开"
        case .measuring: return "正在听…"
        case .committing: return "正在生成你的声纹…"
        default: return takes[current].state == .good ? "这句已经录好了，可以重读覆盖" : "用平常说话的声音，按住下面的按钮读出来"
        }
    }
    private var hintColor: Color {
        if note != nil { return Yimi.danger }
        if case .retry = takes[current].state, phase == .ready { return Yimi.danger }
        return Yimi.ink2
    }

    private var recorder: some View {
        VStack(spacing: 10) {
            ZStack {
                if phase == .measuring || phase == .committing { ProgressRing(progress: nil).scaleEffect(2.1) }
                Image(systemName: phase == .recording ? "waveform" : "mic.fill")
                    .font(.system(size: 30, weight: .medium)).foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(phase == .recording ? Yimi.kleinPressed : Yimi.klein, in: Circle())
                    .shadow(color: Yimi.klein.opacity(0.28), radius: 12, y: 8)
                    .scaleEffect(phase == .recording || phase == .opening ? 0.94 : 1)
                    .opacity(canRecord || phase == .recording || phase == .opening ? 1 : 0.4)
            }
            .frame(width: 120, height: 120)
            .contentShape(Circle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in if !pressing { pressing = true; begin() } }
                .onEnded { _ in pressing = false; end() })
            .sensoryFeedback(.impact(weight: .medium), trigger: pressing)
            .accessibilityLabel("按住读这句").accessibilityAddTraits(.isButton)
            Text(phase == .recording ? "松开结束" : "按住读这句").font(.system(size: 13)).foregroundStyle(Yimi.ink2)
        }
        .padding(.bottom, 18)
    }

    private var finished: some View {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Yimi.ok)
            .padding(.bottom, 40).transition(.scale.combined(with: .opacity))
    }

    private var canRecord: Bool { phase == .ready && vm.sessionState.isActive }

    @ViewBuilder
    private var commitBar: some View {
        if phase != .enrolled {
            VStack(spacing: 8) {
                Button { commit() } label: {
                    Text(good.count >= 5 ? "完成录入（已录好 \(good.count) 句）" : "至少录好 5 句")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(good.count >= 5 ? .white : Yimi.ink3)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(good.count >= 5 ? Yimi.klein : Yimi.paper, in: Capsule())
                }
                .buttonStyle(PressScale(scale: 0.97))
                .disabled(good.count < 5 || phase != .ready)
                Text(good.count < takes.count ? "读完 8 句会更准" : " ").font(.system(size: 12)).foregroundStyle(Yimi.ink3)
            }
        }
    }

    // MARK: actions

    /// Finger down: the window opens first (microphone published, central cutting), then "请读" — so no word is lost.
    private func begin() {
        guard canRecord else { return }
        let id = vm.nextVoiceprintPress()
        press = id; note = nil; phase = .opening
        Task {
            let open = await vm.beginVoiceprintSample(id)
            guard press == id else { return }  // lifted meanwhile; end() settled it
            if open { phase = .recording; return }
            // The window never opened (refused, not connected): say why; the lift then has nothing to commit.
            press = nil; phase = .ready; note = vm.voiceprintError ?? "麦克风还没准备好，再按一次试试"
        }
    }

    private func end() {
        guard let id = press, phase == .opening || phase == .recording else { return }
        guard phase == .recording else {
            press = nil
            phase = .ready; note = "等出现“请读”再开始读"
            Task { _ = await vm.endVoiceprintSample(id, cancel: true) }
            return
        }
        phase = .measuring
        let index = current
        Task {
            let sample = await vm.endVoiceprintSample(id, cancel: false)
            guard press == id else { return }
            press = nil; phase = .ready
            guard let sample else { note = vm.voiceprintError ?? "按住读完整句再松开"; return }
            switch sample.quality {
            case .ok:
                takes[index] = Take(sampleID: sample.sampleID, state: .good)
                try? await Task.sleep(nanoseconds: 450_000_000)
                if let next = nextIndex(after: index) { current = next }
            case .tooShort: takes[index] = Take(sampleID: nil, state: .retry("有点短，请完整读一遍"))
            case .noSpeech: takes[index] = Take(sampleID: nil, state: .retry("没听到声音，靠近一点再读"))
            }
        }
    }

    private func cancelRecording() {
        pressing = false
        guard let id = press else { return }
        press = nil
        Task { _ = await vm.endVoiceprintSample(id, cancel: true) }
    }

    /// The next sentence still to record (pending or asked again), after `index` first.
    private func nextIndex(after index: Int) -> Int? {
        let order = Array(takes.indices[(index + 1)...]) + Array(takes.indices[...index])
        return order.first { takes[$0].state != .good }
    }

    private func commit() {
        guard good.count >= 5, phase == .ready else { return }
        let ids = good
        phase = .committing; note = nil
        Task {
            let result = await vm.enrollVoiceprint(ids)
            guard let result else { phase = .ready; note = vm.voiceprintError ?? "没成功，请再试一次"; return }
            if result.enrolled { phase = .enrolled; return }
            for index in takes.indices where takes[index].sampleID.map(result.rejected.contains) == true {
                takes[index] = Take(sampleID: nil, state: .retry("这句听起来不太像你，请再读一遍"))
            }
            phase = .ready
            if let first = takes.indices.first(where: { if case .retry = takes[$0].state { return true }; return false }) { current = first }
        }
    }
}

struct YimiVoiceTrustWindowControls: View {
    let devices: [CentralVoiceDevice]
    @Binding var selectedDeviceID: String
    let busy: Bool
    let active: Bool
    let note: String?
    let open: () -> Void

    var body: some View {
        Section {
            Picker("正在说话的设备", selection: $selectedDeviceID) {
                Text("请选择设备").tag("")
                ForEach(devices) { device in Text(device.title).tag(device.id) }
            }
            .disabled(busy)
            Button(action: open) {
                Label("接下来 1 分钟是我在说", systemImage: "faceid")
            }
            .disabled(!active || busy || selectedDeviceID.isEmpty)
            .accessibilityIdentifier("voice.trust-window.open")
            if busy { ProgressView("正在确认…") }
            if let note { Text(note).foregroundStyle(Yimi.ink2) }
        } header: {
            Text("确认是我")
        } footer: {
            Text("通过 Face ID 后，仅对所选设备生效。通常持续 1 分钟；通话中至少持续到挂断。")
        }
    }
}
