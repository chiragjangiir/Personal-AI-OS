import SwiftUI

struct DesktopModelSettingsReviewView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    let review: ModelSettingsReview
    @State private var acknowledged = false
    private var current: Bool { model.review?.draft.draft_id == review.draft.draft_id }

    private var actionExplanation: String {
        switch review.draft.action {
        case "resume": return "检查完整冻结内容后，用 Touch ID 确认。确认后恢复今天的工作，自动继续排队任务。"
        case "pause": return "检查预算策略与主人对话保留额后，用 Touch ID 确认。预算策略按冻结内容生效。"
        case "authorize_mac": return "检查目标 Mac 与设置公钥后，用 Touch ID 确认本次授权。"
        case "set_key": return "检查服务商与新密钥尾号后，用 Touch ID 确认替换当前密钥。"
        default: return "检查完整冻结内容后，用 Touch ID 确认。保存后将在当前任务结束时生效。"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Label("确认模型与密钥修改", systemImage: "checkmark.shield").font(.title2)
                Text(actionExplanation)
                    .foregroundStyle(Yimi.ink2)
                HStack {
                    Text("基于版本 \(review.draft.expected_revision)")
                    Spacer()
                    Text("\(review.pageCount) 页 · " + (review.complete ? "已完整读取" : "尚未完整读取"))
                }.font(.caption)
            }.padding(22)
            Divider()
            DesktopContentScroll {
                VStack(alignment: .leading, spacing: 20) {
                    if !review.complete { Label("完整内容未读取完成，暂时不能确认。", systemImage: "exclamationmark.triangle").foregroundStyle(Yimi.danger) }
                    ForEach(review.changes, id: \.id) { change in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(change.title).font(.headline)
                            Text("修改前").font(.caption).foregroundStyle(Yimi.ink2)
                            Text(change.before).textSelection(.enabled)
                            Text("修改后").font(.caption).foregroundStyle(Yimi.ink2)
                            Text(change.after).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                    }
                    if review.draft.action == "undo", review.after.credentials.contains(where: { $0.test_status == "key_reentry_required" }) {
                        Label("旧密钥已被替换，需重新填写。此操作不能恢复旧密钥。", systemImage: "key")
                            .foregroundStyle(Yimi.danger)
                    }
                    if let key = review.draft.preview?.key {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("待保存的新密钥").font(.headline)
                            LabeledContent("密钥引用", value: key.credential_ref)
                            LabeledContent("新密钥尾号", value: key.last4)
                            Text("确认后替换当前密钥；旧密钥不会保留。").font(.caption).foregroundStyle(Yimi.ink2)
                        }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("完整修改前设置").font(.headline)
                        frozen(review.before)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("完整修改后设置").font(.headline)
                        frozen(review.after)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("本次冻结操作").font(.headline)
                        Text(review.payloadText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("确认信息").font(.headline)
                        LabeledContent("操作", value: review.draft.action)
                        LabeledContent("草稿", value: review.draft.draft_id)
                        LabeledContent("主人", value: review.draft.principal_id)
                        LabeledContent("到期", value: Date(timeIntervalSince1970: review.draft.expires_at_ms / 1000).formatted())
                        Text("内容摘要：" + review.draft.change_sha256).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                if let error = model.error { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) }
                if let testedRole = model.testedRole, review.after.roles.contains(testedRole), let result = model.testResult { Text(result).font(.caption).textSelection(.enabled) }
                DesktopCheckbox(title: "我已检查完整修改内容", isOn: $acknowledged)
                    .accessibilityIdentifier("modelSettings.review.acknowledge")
                    .disabled(!review.complete || model.busy || !current)
                HStack {
                    Button("取消") { model.discardReview() }.keyboardShortcut(.cancelAction).disabled(model.busy)
                        .accessibilityIdentifier("modelSettings.review.cancel")
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    Button("用 Touch ID 确认") { Task { await model.confirm() } }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("modelSettings.review.confirm")
                        .disabled(!acknowledged || !review.complete || !current || !model.canWrite || model.busy)
                }
            }.padding(22)
        }.frame(width: 720, height: 780).tint(Yimi.klein).foregroundStyle(Yimi.ink).background(Yimi.paper)
            .interactiveDismissDisabled(model.busy)
    }

    @ViewBuilder private func frozen(_ snapshot: ModelSettingsSnapshot) -> some View {
        let encoder = JSONEncoder()
        let _ = encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(snapshot) {
            Text(String(decoding: data, as: UTF8.self))
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text("无法展示完整设置，请取消并刷新后重试。").foregroundStyle(Yimi.danger)
        }
    }
}
