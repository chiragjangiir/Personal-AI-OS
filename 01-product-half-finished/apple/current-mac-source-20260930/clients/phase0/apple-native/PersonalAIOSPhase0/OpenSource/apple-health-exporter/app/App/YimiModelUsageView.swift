import SwiftUI

struct YimiModelUsageView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    @State private var pauseOnLimit = false
    @State private var reserve = "1"
    var body: some View {
        Form {
            if let usage = model.snapshot?.usage {
                Section("今日用量 · \(usage.local_date)") {
                    LabeledContent("已知费用", value: money(usage.known_cny))
                    LabeledContent("估算费用", value: money(usage.estimated_cny) + "（估算）")
                    LabeledContent("费用未知的调用", value: "\(usage.unknown_attempts) 次")
                    LabeledContent("非人民币调用", value: "\(usage.foreign_currency_attempts) 次")
                    LabeledContent("调用总数", value: "\(usage.attempts) 次")
                    LabeledContent("套餐余量", value: usage.subscription_remaining)
                    LabeledContent("每日提醒", value: money(usage.threshold_cny))
                    Text("按北京时间统计。未知费用不记为零；估算和套餐余量不能当作已知消费。")
                        .font(.footnote).foregroundStyle(Yimi.ink2)
                }
                Section("超额后的行为") {
                    LabeledContent("已保存策略", value: usage.pause_on_limit ? "超过提醒额后暂停" : "只提醒，继续工作")
                    Toggle("超过提醒额后暂停付费工作", isOn: $pauseOnLimit)
                    HStack {
                        Text("对话保留额（元）")
                        TextField("至少 1 元", text: $reserve).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                    Text("默认只提醒。开启暂停需确认；保留额至少 1 元，用于和依米对话。费用未知时无法保证精确限额。")
                        .font(.footnote).foregroundStyle(Yimi.ink2)
                    Button("查看策略更改") {
                        if let value = Double(reserve), value.isFinite, value >= 1 {
                            Task { await model.prepareBudget(pauseOnLimit: pauseOnLimit, reserve: value) }
                        }
                    }.frame(minHeight: 44).disabled(!model.canWrite || model.busy || !validReserve)
                }
                Section {
                    LabeledContent("当前工作", value: usage.paused ? "已暂停" : "未暂停")
                    if let date = usage.resumed_local_date { LabeledContent("已恢复日期", value: date) }
                    Button("恢复") { Task { await model.prepareResume() } }
                        .frame(minHeight: 44).disabled(!model.canWrite || model.busy)
                        .accessibilityIdentifier("model-settings-resume")
                    Text("不依赖主脑。确认后解除当日暂停，原队列继续工作；次日仍按已保存的策略判断。")
                        .font(.footnote).foregroundStyle(Yimi.ink2)
                }
            } else { Text("暂未取得用量").foregroundStyle(Yimi.ink2) }
            if let message = model.message { Section { Text(message).foregroundStyle(Yimi.ink2) } }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle("用量与提醒").tint(Yimi.klein)
            .onAppear {
                if let usage = model.snapshot?.usage {
                    pauseOnLimit = usage.pause_on_limit
                    reserve = String(usage.owner_reserve_cny)
                }
            }
    }
    private var validReserve: Bool { Double(reserve).map { $0.isFinite && $0 >= 1 } ?? false }
    private func money(_ value: Double) -> String { value.formatted(.currency(code: "CNY")) }
}

struct YimiModelMacAuthorizationView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    var body: some View {
        List {
            Section {
                Text("授权一次后，这台 Mac 可用 Touch ID 独立修改模型设置。此授权不包含支付。")
                    .font(.subheadline).foregroundStyle(Yimi.ink2)
                Button("刷新待授权 Mac") { Task { await model.refreshPendingMacs() } }
                    .frame(minHeight: 44).disabled(model.busy || !model.connected)
            }
            Section("待授权设备") {
                if model.pendingMacs.isEmpty { Text("没有待授权的 Mac").foregroundStyle(Yimi.ink2) }
                ForEach(model.pendingMacs) { mac in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(mac.label ?? mac.device_id).font(.headline)
                        Text(mac.device_id).font(.caption).textSelection(.enabled)
                        LabeledContent("用途", value: mac.purpose)
                        if let fingerprint = mac.key_sha256 {
                            Text("公钥指纹").font(.caption).foregroundStyle(Yimi.ink2)
                            Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled)
                        }
                        Button("核对指纹并查看授权") { Task { await model.prepareAuthorization(mac) } }
                            .frame(minHeight: 44).disabled(!model.canWrite || model.busy || mac.key_sha256 == nil)
                            .accessibilityIdentifier("modelSettings.authorize." + mac.device_id)
                    }.padding(.vertical, 6)
                }
            }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle("授权 Mac").tint(Yimi.klein)
            .task { await model.refreshPendingMacs() }
            .refreshable { await model.refreshPendingMacs() }
    }
}
