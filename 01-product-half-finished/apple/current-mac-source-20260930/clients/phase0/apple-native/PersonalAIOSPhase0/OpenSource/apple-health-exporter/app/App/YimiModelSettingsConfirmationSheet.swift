import SwiftUI

struct YimiModelSettingsConfirmationSheet: View {
    @ObservedObject var model: AssistantModelSettingsModel
    private func explanation(_ action: String) -> String {
        switch action {
        case "resume": return "确认后解除当日暂停，原队列继续工作。不需要等待主脑。"
        case "pause": return "确认后保存暂停策略。对话保留额至少 1 元。"
        case "authorize_mac": return "确认后，这台 Mac 可用 Touch ID 独立修改模型设置。此授权不包含支付。"
        default: return "确认后保存，当前任务结束后自动生效。"
        }
    }
    var body: some View {
        NavigationStack {
            List {
                if let review = model.review {
                    Section {
                        Text(explanation(review.draft.action))
                        Text("这是服务器冻结的草稿，尚未应用。")
                            .font(.footnote).foregroundStyle(Yimi.ink2)
                        LabeledContent("当前版本", value: "v\(review.draft.expected_revision)")
                        LabeledContent("已读取分页", value: "\(review.pageCount) 页")
                        LabeledContent("确认有效至", value: review.expiresAt.formatted())
                        Text(review.draft.draft_id).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    Section("完整差异") {
                        ForEach(Array(review.changes.enumerated()), id: \.offset) { _, change in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(change.title).font(.headline)
                                Text("原设置").font(.caption).foregroundStyle(Yimi.ink2)
                                Text(change.before).font(.subheadline).textSelection(.enabled)
                                Text("改为").font(.caption).foregroundStyle(Yimi.ink2)
                                Text(change.after).font(.subheadline).textSelection(.enabled)
                            }.padding(.vertical, 6)
                        }
                    }
                    Section("冻结的操作内容") {
                        Text(review.payloadText).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    if !review.complete { Section { Text("分页尚未读取完整，暂不能确认。").foregroundStyle(Yimi.danger) } }
                    if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) } }
                    Section {
                        Button { Task { await model.confirm() } } label: {
                            Label(model.busy ? "正在确认" : "用 Face ID 确认更改", systemImage: "faceid")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }.disabled(model.busy || !model.canWrite || !review.complete || review.expiresAt <= Date())
                            .accessibilityIdentifier("modelSettings.review.confirm")
                    }
                }
            }
            .navigationTitle("确认更改").navigationBarTitleDisplayMode(.inline)
            .tint(Yimi.klein).scrollContentBackground(.hidden).background(Yimi.ground)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("再想想") { model.discardReview() }.disabled(model.busy)
                    .accessibilityIdentifier("modelSettings.review.cancel")
            } }
        }.interactiveDismissDisabled(model.busy)
    }
}
