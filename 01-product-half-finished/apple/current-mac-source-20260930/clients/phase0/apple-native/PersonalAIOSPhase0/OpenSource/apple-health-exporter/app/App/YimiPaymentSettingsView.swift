import SwiftUI

private enum YimiPaymentEnableMethod: String, Identifiable {
    case voice, auto
    var id: String { rawValue }
}

struct YimiPaymentSettingsView: View {
    @ObservedObject var payment: YimiPaymentModel
    var ownerOverride: YimiOwnerOverrideModel? = nil
    var onVoice: (() -> Void)? = nil
    @State private var enabling: YimiPaymentEnableMethod?
    @State private var disablingVoice = false
    @State private var forgettingGlasses = false

    var body: some View {
        List {
            if let ownerOverride { YimiOwnerOverrideSection(model: ownerOverride) }
            if let settings = payment.settings {
                summary(settings)
                Section {
                    Toggle(isOn: Binding(get: { settings.voice_enabled }, set: { value in
                        if value { enabling = .voice } else { disablingVoice = true }
                    })) {
                        settingLabel("声纹支付", "你发起这件事 + 说「付吧」，两句都认出是你才付")
                    }.disabled(!payment.available || (!settings.voice_enabled && payment.busy) || (!settings.voice_enabled && !settings.prerequisites.voice.isEmpty))
                    Toggle(isOn: Binding(get: { settings.auto_enabled }, set: { value in
                        if value { enabling = .auto } else { Task { await payment.change(["kind": "auto", "enabled": false]) } }
                    })) {
                        settingLabel("免密支付", "小额，凭你发起这件事那句话的声音，不再点确认")
                    }.disabled(!payment.available || (!settings.auto_enabled && payment.busy) || (!settings.auto_enabled && !settings.prerequisites.auto.isEmpty))
                    if let paused = settings.paused_until {
                        Text("今天免密已暂停 · 至\(YimiPaymentText.date(paused))").font(.footnote).foregroundStyle(Yimi.ink2)
                        Button("用 Face ID 恢复免密支付") { enabling = .auto }
                            .disabled(payment.busy || !settings.prerequisites.auto.isEmpty)
                    }
                } header: { Text("更方便的付法") } footer: {
                    Text("两个开关默认关闭。打字发起、新收款方、超过限额，都要点付款卡。声纹不是密码，录音可能模仿你的声音。")
                }
                prerequisites(settings)
                Section {
                    NavigationLink("进入依米的锁") { YimiPaymentLockSettingsView(payment: payment) }
                    NavigationLink("付款限额") { YimiPaymentLimitsView(payment: payment, settings: settings) }
                }
                Section("声音与记录") {
                    if let onVoice {
                        Button(action: onVoice) {
                            HStack { Text("我的声音"); Spacer(); Text(settings.voiceprint.phone_app ? "手机已录入" : "手机未录入").foregroundStyle(Yimi.ink2); Image(systemName: "chevron.right").font(.caption) }
                        }.foregroundStyle(Yimi.ink)
                    }
                    HStack { Text("眼镜上的声音"); Spacer(); Text(settings.voiceprint.glasses ? "已录入" : "未录入").foregroundStyle(Yimi.ink2) }
                    if settings.voiceprint.glasses {
                        Button("忘记眼镜上的声音", role: .destructive) { forgettingGlasses = true }.disabled(payment.busy || !payment.available)
                    }
                    NavigationLink("付款记录") { YimiPaymentRecordsView(payment: payment) }
                }
                if !payment.approvals.isEmpty {
                    Section("等你确认") {
                        ForEach(payment.approvals) { approval in
                            YimiPaymentApprovalCard(payment: payment, approval: approval).listRowInsets(EdgeInsets())
                        }
                    }
                }
            } else {
                Section {
                    if payment.busy { ProgressView("正在读取支付设置") }
                    else { Text(payment.available ? "正在等支付设置" : "连接依米后可查看支付与安全").foregroundStyle(Yimi.ink2) }
                }
            }
            if let error = payment.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }
        .navigationTitle("支付与安全").navigationBarTitleDisplayMode(.inline).toolbarRole(.editor)
        .tint(Yimi.klein).scrollContentBackground(.hidden).background(Yimi.ground)
        .task { await payment.refresh() }
        .refreshable { await payment.refresh() }
        .sheet(item: $enabling) { method in
            if let settings = payment.settings {
                YimiPaymentEnableSheet(payment: payment, method: method, settings: settings)
            }
        }
        .confirmationDialog("关闭声纹支付？", isPresented: $disablingVoice, titleVisibility: .visible) {
            Button("关闭声纹支付", role: .destructive) { Task { await payment.change(["kind": "voice", "enabled": false]) } }
            Button("保持开启", role: .cancel) {}
        } message: { Text("免密支付也会一起关闭。之后每一笔都要你点「付款」。") }
        .confirmationDialog("忘记眼镜上的声音？", isPresented: $forgettingGlasses, titleVisibility: .visible) {
            Button("用 Face ID 忘记", role: .destructive) { Task { await payment.forgetGlassesVoice() } }
            Button("取消", role: .cancel) {}
        } message: { Text("眼镜要重新录入才能用声音付款。如果没有其他有效声纹，声纹支付和免密支付也会关闭。") }
    }

    private func summary(_ settings: CentralPaymentSettings) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(settings.voice_enabled || settings.auto_enabled ? "已开启更方便的付法" : "默认：每笔你点确认").font(.headline)
                Text(settings.auto_enabled
                     ? "免密单笔 ≤ ¥\(YimiPaymentText.amount(settings.limits.auto_order_fen))，今天已用 ¥\(YimiPaymentText.amount(settings.today_auto_used_fen)) / ¥\(YimiPaymentText.amount(settings.limits.auto_day_fen))。"
                     : settings.voice_enabled
                         ? "每一笔先给你看金额和收款方。你可以点「付款」；如果用声音发起，也可以在同一台设备上说「付吧」，发起那句和「付吧」的声纹都验证通过后才付。"
                         : "每一笔付款，先把金额和收款方给你看，你点了「付款」才付。")
                    .font(.subheadline).foregroundStyle(Yimi.ink2)
            }.padding(.vertical, 6)
        }
    }

    private func settingLabel(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(title); Text(subtitle).font(.caption).foregroundStyle(Yimi.ink2).fixedSize(horizontal: false, vertical: true) }
    }

    private func prerequisites(_ settings: CentralPaymentSettings) -> some View {
        Section {
            prerequisite("已录入你的声音", ready: settings.voiceprint.phone_app || settings.voiceprint.glasses)
            prerequisite("iPhone 锁已开启", ready: settings.locks.phone.enabled)
            prerequisite("眼镜锁已开启", ready: settings.locks.glasses.enabled)
            prerequisite("付款密钥已就绪", ready: settings.keys.device && settings.keys.user)
            if !settings.voice_enabled { prerequisite("免密还需要先开声纹支付", ready: false) }
        } header: { Text("开启前需要") } footer: { Text("开关只在 iPhone 上修改。付款时，说话的那台设备也要处于解锁状态。") }
    }

    private func prerequisite(_ title: String, ready: Bool) -> some View {
        Label(title, systemImage: ready ? "checkmark.circle" : "circle")
            .font(.subheadline).foregroundStyle(ready ? Yimi.ink : Yimi.ink2)
            .accessibilityLabel(title + (ready ? "，已满足" : "，未满足"))
    }

}

private struct YimiPaymentEnableSheet: View {
    @ObservedObject var payment: YimiPaymentModel
    let method: YimiPaymentEnableMethod
    let settings: CentralPaymentSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(method == .voice ? "开启声纹支付？" : "开启免密支付？").font(.title2.weight(.semibold))
                    Text(method == .voice
                         ? "你发起这件事的那句话，加上最后的「付吧」，两句一起核对声音。只在同一台 iPhone 或眼镜上说才有效。"
                         : "只在你用声音发起的请求上生效。认出你发起这件事的声音后，会有一段短暂倒计时；不想付就点取消。")
                }
                Section {
                    LabeledContent("单笔上限", value: "¥\(YimiPaymentText.amount(method == .voice ? settings.limits.voice_order_fen : settings.limits.auto_order_fen))")
                    if method == .auto { LabeledContent("当日累计", value: "¥\(YimiPaymentText.amount(settings.limits.auto_day_fen))") }
                }
                Section {
                    Text("新收款方、超过上限、认不出声音，都回到付款卡。声纹不是密码，录音可能模仿你的声音。")
                    if method == .auto { Text("关掉声纹支付、关任何一把锁、忘记有效声音，免密会一起关闭。") }
                }
                Section {
                    Button {
                        dismiss()
                        Task { await payment.change(["kind": method.rawValue, "enabled": true]) }
                    } label: { Label(method == .voice ? "用 Face ID 开启声纹支付" : "用 Face ID 开启免密支付", systemImage: "faceid") }
                    .disabled(payment.busy || !payment.available || !(method == .voice ? settings.prerequisites.voice : settings.prerequisites.auto).isEmpty)
                }
            }.navigationTitle("确认开启").navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}

struct YimiPaymentLockSettingsView: View {
    @ObservedObject var payment: YimiPaymentModel
    @State private var disabling: LockKind?
    private enum LockKind: String, Identifiable { case phone, glasses; var id: String { rawValue } }
    var body: some View {
        List {
            if let settings = payment.settings {
                Section {
                    Toggle(isOn: Binding(get: { settings.locks.phone.enabled }, set: { value in
                        if value { Task { await payment.change(["kind": "phone_lock", "enabled": true, "relock_s": settings.locks.phone.relock_s]) } }
                        else { disabling = .phone }
                    })) { VStack(alignment: .leading, spacing: 4) { Text("进入依米需要验证"); Text("Face ID，不行就用设备密码").font(.caption).foregroundStyle(Yimi.ink2) } }
                    .disabled(payment.busy || !payment.available)
                    if settings.locks.phone.enabled {
                        Picker("多久重新上锁", selection: Binding(get: { settings.locks.phone.relock_s }, set: { seconds in
                            Task { await payment.change(["kind": "relock", "relock_s": seconds]) }
                        })) {
                            ForEach(settings.locks.phone.relock_choices_s, id: \.self) { seconds in
                                Text(seconds == 0 ? "立即" : "\(seconds / 60) 分钟").tag(seconds)
                            }
                        }.disabled(payment.busy || !payment.available)
                    }
                } header: { Text("iPhone 上的依米") } footer: { Text("冷启动和离开 App 超过重锁时间后重新验证。锁住时，随身模式和通话照常；对话、付款卡和设置需要解锁后才能看。设备需要设有密码。") }
                Section {
                    if let deviceID = settings.locks.glasses.device_id, settings.locks.glasses.paired {
                        Toggle(isOn: Binding(get: { settings.locks.glasses.enabled }, set: { value in
                            if value { Task { await payment.change(["kind": "glasses_lock", "device_id": deviceID, "enabled": true]) } }
                            else { disabling = .glasses }
                        })) { Text("戴上后在手机确认解锁") }.disabled(payment.busy || !payment.available)
                        LabeledContent("当前状态", value: settings.locks.glasses.unlocked ? "已解锁" : "已锁定")
                    } else { Text("先配对眼镜，再开启眼镜锁").foregroundStyle(Yimi.ink2) }
                } header: { Text("眼镜上的依米") } footer: { Text("手机确认后，佩戴中有效，最多 12 小时。摘下、断线重连或息屏都会重新上锁。") }
                Section("用到这两把锁的功能") {
                    LabeledContent("声纹支付、免密支付", value: "两把锁都要开启")
                    Text("关掉任意一把锁，声纹支付和免密支付会一起关闭。").font(.footnote).foregroundStyle(Yimi.ink2)
                }
            }
            if let error = payment.error { Text(error).foregroundStyle(Yimi.danger) }
        }.navigationTitle("进入依米的锁").navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
            .confirmationDialog("关闭这把锁？", isPresented: Binding(get: { disabling != nil }, set: { if !$0 { disabling = nil } }), titleVisibility: .visible) {
                Button("用 Face ID 关闭", role: .destructive) {
                    guard let kind = disabling, let settings = payment.settings else { return }
                    disabling = nil
                    if kind == .phone { Task { await payment.change(["kind": "phone_lock", "enabled": false]) } }
                    else if let id = settings.locks.glasses.device_id { Task { await payment.change(["kind": "glasses_lock", "device_id": id, "enabled": false]) } }
                }
                Button("保持开启", role: .cancel) { disabling = nil }
            } message: { Text("声纹支付和免密支付也会关闭。重新开启后，需要你另外开启付款方式。") }
    }
}

private struct YimiPaymentLimitsView: View {
    @ObservedObject var payment: YimiPaymentModel
    let settings: CentralPaymentSettings
    @State private var autoOrder = ""
    @State private var autoDay = ""
    @State private var voiceOrder = ""
    @State private var validation: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Section("免密支付") {
                field("单笔上限（元）", text: $autoOrder)
                field("当日累计（元）", text: $autoDay)
                LabeledContent("今天已用", value: "¥\(YimiPaymentText.amount(settings.today_auto_used_fen))")
            }
            Section("声纹支付") { field("单笔上限（元）", text: $voiceOrder) }
            Section {
                Text("每项大于 ¥0，最多 ¥\(YimiPaymentText.amount(settings.limit_max_fen))，精确到分。所有限额修改都需要 Face ID 或设备密码。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
                if let message = validation ?? payment.error { Text(message).foregroundStyle(Yimi.danger) }
                Button { save() } label: { Label("用 Face ID 保存限额", systemImage: "faceid") }.disabled(payment.busy || !payment.available)
            }
        }.navigationTitle("付款限额").navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
            .onAppear {
                autoOrder = YimiPaymentText.amount(settings.limits.auto_order_fen)
                autoDay = YimiPaymentText.amount(settings.limits.auto_day_fen)
                voiceOrder = YimiPaymentText.amount(settings.limits.voice_order_fen)
            }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        HStack { Text(title); TextField("金额", text: text).keyboardType(.decimalPad).multilineTextAlignment(.trailing).monospacedDigit() }
    }
    private func save() {
        func fen(_ text: String) -> Int? {
            let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: Locale.current.decimalSeparator ?? ".", with: ".")
            guard normalized.range(of: #"^[0-9]+(?:\.[0-9]{1,2})?$"#, options: .regularExpression) != nil,
                  let decimal = Decimal(string: normalized, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
            var value = decimal * 100, rounded = Decimal()
            NSDecimalRound(&rounded, &value, 0, .plain)
            guard value == rounded, value > 0, value <= Decimal(settings.limit_max_fen) else { return nil }
            return NSDecimalNumber(decimal: value).intValue
        }
        guard let order = fen(autoOrder), let day = fen(autoDay), let voice = fen(voiceOrder) else {
            validation = "请输入范围内的金额，最多两位小数。"; return
        }
        validation = nil
        Task {
            await payment.change(["kind": "limits", "auto_order_fen": order, "auto_day_fen": day, "voice_order_fen": voice])
            if payment.error == nil { dismiss() }
        }
    }
}

struct YimiPaymentRecordsView: View {
    @ObservedObject var payment: YimiPaymentModel
    var body: some View {
        List {
            if payment.records.isEmpty {
                if payment.loadingRecords { ProgressView("正在读取付款记录") }
                else { Text(payment.available ? "还没有付款记录" : "连接依米后查看付款记录").foregroundStyle(Yimi.ink2) }
            }
            ForEach(payment.records) { record in
                NavigationLink {
                    YimiPaymentRecordDetailView(payment: payment, paymentID: record.payment_id)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(record.payee ?? record.app).font(.body.weight(.medium))
                            if !record.summary.isEmpty { Text(record.summary).font(.subheadline).foregroundStyle(Yimi.ink2).lineLimit(2) }
                            Text([YimiPaymentText.date(record.at), YimiPaymentText.terminal(record.terminal), YimiPaymentText.method(record.method)]
                                .filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Yimi.ink2)
                        }
                        Spacer(minLength: 4)
                        VStack(alignment: .trailing, spacing: 6) {
                            Text("¥\(YimiPaymentText.amount(record.amount_fen))").font(.body.weight(.medium)).monospacedDigit()
                            Text(record.state.title).font(.caption).foregroundStyle(record.state == .paid ? Yimi.ok : Yimi.ink2)
                        }
                    }.padding(.vertical, 5)
                }
            }
            if let next = payment.nextBefore {
                Button("更早的记录") { Task { await payment.loadRecords(before: next) } }.disabled(payment.loadingRecords)
            }
            if let error = payment.error { Text(error).foregroundStyle(Yimi.danger) }
        }.navigationTitle("付款记录").navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
            .task { await payment.loadRecords() }.refreshable { await payment.loadRecords() }
    }
}

struct YimiPaymentDetailSheet: View {
    @ObservedObject var payment: YimiPaymentModel
    let paymentID: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            YimiPaymentRecordDetailView(payment: payment, paymentID: paymentID)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.tint(Yimi.klein)
    }
}

struct YimiPaymentRecordDetailView: View {
    @ObservedObject var payment: YimiPaymentModel
    let paymentID: String
    @State private var disputing = false
    var body: some View {
        List {
            if let record = payment.record, record.payment.payment_id == paymentID {
                let detail = record.payment
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("¥\(YimiPaymentText.amount(detail.amount_fen))").font(.largeTitle.weight(.semibold)).monospacedDigit()
                        Text(detail.state.title).font(.headline).foregroundStyle(detail.state == .paid ? Yimi.ok : Yimi.ink)
                        Text([detail.payee ?? detail.app, detail.summary, YimiPaymentText.method(detail.method), YimiPaymentText.terminal(detail.terminal)]
                            .filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(Yimi.ink2)
                        Text(YimiPaymentText.result(detail.state, orderCancel: detail.order_cancel)).font(.subheadline).foregroundStyle(Yimi.ink2)
                    }.padding(.vertical, 8)
                }
                if let initiating = detail.initiating_text { Section("你发起的请求") { Text(initiating) } }
                Section("经过") {
                    ForEach(Array(record.timeline.enumerated()), id: \.offset) { _, event in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: event.kind == "result_reported" && event.data.outcome == "paid" ? "checkmark.circle" : "circle")
                                .foregroundStyle(Yimi.ink2).font(.caption).padding(.top, 4)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(YimiPaymentText.date(event.at) + (event.terminal.map { " · " + YimiPaymentText.terminal($0) } ?? ""))
                                    .font(.caption).foregroundStyle(Yimi.ink2)
                                Text(eventTitle(event)).font(.subheadline)
                                if let note = eventDetail(event) { Text(note).font(.caption).foregroundStyle(Yimi.ink2) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(.vertical, 5)
                    }
                    if let next = record.next_seq {
                        Button("更早的经过") { Task { await payment.loadRecord(paymentID, beforeSeq: next) } }
                            .disabled(payment.loadingRecord || !payment.available)
                    }
                }
                Section {
                    Button("这不是我付的", role: .destructive) { disputing = true }.disabled(!payment.available)
                } footer: { Text("立即关闭声纹支付和免密支付，保留这笔记录。请同时去平台核对订单；这不会自动退款。") }
            } else if payment.loadingRecord { ProgressView("正在读取这笔付款") }
            if let error = payment.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle("这笔付款").navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
            .task(id: paymentID) { await payment.loadRecord(paymentID) }
            .confirmationDialog("这笔付款不是你授权的？", isPresented: $disputing, titleVisibility: .visible) {
                Button("关闭声纹支付和免密支付", role: .destructive) { Task { await payment.dispute(paymentID) } }
                Button("取消", role: .cancel) {}
            } message: { Text("记录会保留。请去平台核对订单，不要重复付款。") }
    }

    private func eventTitle(_ event: CentralPaymentTimeline) -> String {
        switch event.kind {
        case "intent_requested": return "收到你的办事请求"
        case "intent_refused": return "未接受付款请求"
        case "card_opened": return "收银台已就绪，付款卡已发出"
        case "methods_evaluated": return "核对可用的付款方式"
        case "auto_scheduled": return "进入免密付款可取消时间"
        case "auto_reverted": return "免密未放行，回到付款卡"
        case "decision_received": return event.data.decision == "cancel" ? "收到取消决定" : "收到你的付款决定"
        case "decision_rejected": return "这次决定未生效"
        case "voice_attempt":
            switch event.data.verdict {
            case "pass": return "两句话的声纹核验通过"
            case "insufficient": return "声音不足，未能核验"
            case "unavailable": return "声纹暂不可用"
            default: return "声音未通过核验，没有授权付款"
            }
        case "voice_ignored": return "这次语音未用于付款"
        case "grant_issued": return "已授权，等待执行手机付款"
        case "grant_expired": return "付款许可已过期"
        case "tap_started": return "执行手机开始点付款"
        case "result_reported":
            switch event.data.outcome {
            case "paid": return "收银台显示支付成功"
            case "not_paid": return "未完成付款"
            default: return "付款结果不明，已停止，不会重复付"
            }
        case "amount_changed": return "收银台金额发生变化，没有按旧金额付款"
        case "card_closed": return event.data.state?.title ?? "付款卡已关闭"
        case "order_cancel_result": return event.data.outcome == "done" ? "平台未付款订单已取消" : "平台订单取消未完成"
        case "policy_changed": return "付款设置已修改"
        case "lock_changed": return "进入依米的锁已修改"
        case "keys_registered": return "付款设备密钥已登记"
        case "keys_revoked": return "付款设备密钥已撤销"
        case "lease_started": return "付款终端已解锁"
        case "lease_ended": return "付款终端已重新锁定"
        case "approval_requested": return "眼镜请求手机确认"
        case "approval_decided": return event.data.decision == "deny" ? "已拒绝眼镜请求" : "已确认眼镜请求"
        case "enrolment_grant_issued": return "已允许眼镜录入声音"
        case "enrolment_grant_consumed": return "眼镜声音录入已完成"
        case "auto_paused": return "免密支付已暂停"
        case "dispute": return "已标记「这不是我付的」"
        case "cascade": return "声纹支付和免密支付已关闭"
        default: return "付款记录已更新"
        }
    }

    private func eventDetail(_ event: CentralPaymentTimeline) -> String? {
        let data = event.data
        if let reason = data.reason, let code = CentralPaymentReason(rawValue: reason),
           let line = code.line(newFen: data.read_amount_fen, oldFen: data.old_amount_fen, triesLeft: data.tries_left ?? 0) { return line }
        if let amount = data.read_amount_fen { return "点击前读到 ¥\(YimiPaymentText.amount(amount))" }
        if let amount = data.amount_fen { return "¥\(YimiPaymentText.amount(amount))" + (data.payee.map { " · " + $0 } ?? "") }
        if let detail = data.detail { return detail }
        if let method = data.method { return YimiPaymentText.method(method) }
        return nil
    }
}
