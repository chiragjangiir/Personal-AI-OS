import AppKit
import DesktopKit
import SwiftUI

struct DesktopWeChatSettings: View {
    @ObservedObject var preview: DesktopWeChatPreview
    let owner: String?
    @Environment(\.desktopRendering) private var rendering
    @State private var names = ""
    @State private var working = false
    @State private var error: String?

    init(preview: DesktopWeChatPreview, owner: String?) {
        self.preview = preview; self.owner = owner
        _names = State(initialValue: preview.policy.chats.joined(separator: "\n"))
    }

    var body: some View {
        Section {
            Toggle("让依米整理选定的微信通知预览", isOn: Binding(get: { preview.policy.enabled }, set: { save(enabled: $0) }))
                .accessibilityIdentifier("wechat.preview.enabled")
                .disabled(working || owner == nil || rendering)
            Text("只读通知里已有的文字，不打开微信，不翻聊天记录。预览可能不完整。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            Text("允许预览的聊天或发送者").font(.callout.weight(.medium))
            Text("每行一个名称，与微信通知标题完全一致。同名聊天都会匹配；名称不作为发送身份。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            TextEditor(text: $names).font(.body).frame(height: 66)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Yimi.hair))
                .accessibilityLabel("允许预览的聊天或发送者，每行一个名称")
                .accessibilityIdentifier("wechat.preview.chats").disabled(working || rendering)
            Button("保存预览范围") { save(enabled: preview.policy.enabled) }
                .disabled(working || owner == nil || rendering).accessibilityIdentifier("wechat.preview.save")
            Text(preview.status).font(.callout).textSelection(.enabled).accessibilityIdentifier("wechat.preview.status")
            if let error { Text(error).foregroundStyle(Yimi.danger) }
            Text("开启后，新通知中选定范围的预览会送到你的依米云端，用于摘要和草稿。关闭后清除本机未上传内容；对话里已有内容仍保留。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            HStack {
                Text("需要 macOS 的完全磁盘访问。这个系统权限范围较大；依米的预览读取只查询微信通知。")
                    .font(.caption).foregroundStyle(Yimi.ink2)
                Button("系统设置…") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
                }.disabled(rendering).accessibilityIdentifier("wechat.preview.permission")
            }
            Text("摘要与草稿在“和依米聊”中查看。草稿不会自动发送；向他人发送仍按收件人和任务类型首次确认。")
                .font(.caption).foregroundStyle(Yimi.ink2)
        }
        .onChange(of: preview.policy.chats) { _, value in names = value.joined(separator: "\n") }
    }
    private func save(enabled: Bool) {
        guard !rendering, let owner else { return }
        working = true
        Task {
            defer { working = false }
            do { try await preview.configure(enabled: enabled, names: names, owner: owner); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}
