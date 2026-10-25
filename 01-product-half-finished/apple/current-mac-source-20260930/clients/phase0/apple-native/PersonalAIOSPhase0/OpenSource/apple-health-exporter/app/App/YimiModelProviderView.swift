import SwiftUI

struct YimiModelProviderView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    @State var provider: ModelSettingsProvider
    @State private var key = ""
    var body: some View {
        Form {
            if let current = model.snapshot?.providers.first(where: { $0.id == provider.id }) {
                Section("服务器当前设置") {
                    Text(current.display_name).font(.headline)
                    Text(current.base_url).font(.caption).foregroundStyle(Yimi.ink2).textSelection(.enabled)
                    if current != provider {
                        Button("从当前设置重新编辑") { provider = current }.frame(minHeight: 44).disabled(model.busy)
                    }
                }
            }
            Section("服务商草稿") {
                TextField("名称", text: $provider.display_name)
                Picker("接口协议", selection: $provider.wire_protocol) {
                    Text("Chat Completions").tag("chat_completions")
                    Text("Responses").tag("codex_responses")
                    Text("Anthropic Messages").tag("anthropic_messages")
                    if provider.wire_protocol == "local_onnx" { Text("本地 ONNX · 只读").tag("local_onnx") }
                }
                TextField("服务地址", text: $provider.base_url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("查看服务商更改") {
                    Task { await model.prepareRoutes(providers: [provider], summary: "修改服务商 \(provider.display_name)") }
                }.frame(minHeight: 44)
            }.disabled(!model.canWrite || model.busy || provider.wire_protocol == "local_onnx")
            if provider.wire_protocol == "local_onnx" { Section { Text("本地服务商 · 首版只读").foregroundStyle(Yimi.ink2) } }
            if let credentialRef = provider.credential_ref, provider.wire_protocol != "local_onnx" {
                Section("服务器密钥") {
                    if let credential = model.snapshot?.credentials.first(where: { $0.credential_ref == credentialRef }) {
                        LabeledContent("状态", value: credential.configured ? "已配置" : "未配置")
                        if let last4 = credential.last4 { LabeledContent("末四位", value: last4) }
                        if let updated = credential.updated_at { LabeledContent("更新时间", value: updated) }
                        if let test = credential.test_status { LabeledContent("测试状态", value: test) }
                    }
                    SecureField("填写新密钥", text: $key).textContentType(.none)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("model-settings-key")
                    Button("查看密钥更改") {
                        _ = model.prepareKey(credentialRef: credentialRef, key: &key)
                    }.frame(minHeight: 44).disabled(!model.canWrite || model.busy || key.isEmpty)
                }
                Section { Text("密钥只发送到服务器一次。发出后立即清空，手机不保存；旧密钥不会保留。")
                    .font(.footnote).foregroundStyle(Yimi.ink2) }
            }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle(provider.display_name).navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
            .onDisappear { key = "" }
    }
}
