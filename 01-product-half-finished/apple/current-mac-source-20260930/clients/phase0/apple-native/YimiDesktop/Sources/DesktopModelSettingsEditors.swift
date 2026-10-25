import SwiftUI

struct DesktopModelSettingsProviderEditor: View {
    @ObservedObject var model: AssistantModelSettingsModel
    let original: ModelSettingsProvider
    @Environment(\.dismiss) private var dismiss
    @State private var provider: ModelSettingsProvider
    @State private var key = ""

    init(model: AssistantModelSettingsModel, original: ModelSettingsProvider) {
        self.model = model; self.original = original
        _provider = State(initialValue: original)
    }

    private var writable: Bool { model.canWrite && original.wire_protocol != "local_onnx" }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("服务商") {
                    LabeledContent("标识", value: provider.id)
                    TextField("名称", text: $provider.display_name)
                    TextField("API 地址", text: $provider.base_url)
                    Picker("协议", selection: $provider.wire_protocol) {
                        Text("OpenAI Chat Completions").tag("chat_completions")
                        Text("OpenAI Responses").tag("codex_responses")
                        Text("Anthropic Messages").tag("anthropic_messages")
                        if original.wire_protocol == "local_onnx" { Text("本地 ONNX · 只读").tag("local_onnx") }
                    }
                    TextField("密钥引用", text: optional($provider.credential_ref))
                    DisclosureGroup("服务商能力") {
                        TextField("区域", text: optional($provider.region))
                        TextField("模型目录能力", text: optional($provider.catalog_capability))
                        TextField("用量能力", text: optional($provider.usage_capability))
                        TextField("会话亲和性", text: optional($provider.session_affinity))
                    }
                    Button("审阅服务商修改…") {
                        Task {
                            await model.prepareRoutes(providers: [provider], summary: "修改服务商：" + provider.display_name)
                            if model.review != nil { dismiss() }
                        }
                    }.disabled(model.busy)
                }.disabled(!writable)
                Section("密钥") {
                    if let credential = model.snapshot?.credentials.first(where: { $0.credential_ref == original.credential_ref }) {
                        LabeledContent("状态", value: credential.configured ? "已配置 · 尾号 " + (credential.last4 ?? "—") : "未配置")
                        LabeledContent("密钥版本", value: String(credential.version))
                        if let date = credential.updated_at { LabeledContent("更新于", value: date) }
                        if credential.test_status == "key_reentry_required" { Text("该版本的密钥已被替换，请重新填写。").foregroundStyle(Yimi.danger) }
                    }
                    SecureField("输入新密钥", text: $key).accessibilityIdentifier("modelSettings.key.input").disabled(!writable || model.busy)
                    Text("密钥只发送一次。发送时立即清空输入框，不在本机保存。服务商地址或密钥引用修改需先确认保存。")
                        .font(.caption).foregroundStyle(Yimi.ink2)
                    Button("审阅新密钥…") {
                        guard let ref = original.credential_ref else { return }
                        let submission = model.prepareKey(credentialRef: ref, key: &key)
                        Task {
                            await submission?.value
                            if model.review != nil { dismiss() }
                        }
                    }.disabled(!writable || model.busy || key.isEmpty || original.credential_ref == nil)
                        .accessibilityIdentifier("modelSettings.key.prepare")
                }
                if let error = model.error { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) }
            }.formStyle(.grouped)
            HStack { Spacer(); Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction) }.padding()
        }.frame(width: 600, height: 650).tint(Yimi.klein).foregroundStyle(Yimi.ink).background(Yimi.paper)
            .onDisappear { key = "" }
    }

    private func optional(_ binding: Binding<String?>) -> Binding<String> {
        Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 })
    }
}

struct DesktopModelSettingsRoleEditor: View {
    @ObservedObject var model: AssistantModelSettingsModel
    let original: ModelSettingsRole
    @Environment(\.dismiss) private var dismiss
    @State private var role: ModelSettingsRole
    @State private var catalogRequested = false
    private var writable: Bool { model.canWrite && original.editable && !model.busy }

    init(model: AssistantModelSettingsModel, original: ModelSettingsRole) {
        self.model = model; self.original = original
        _role = State(initialValue: original)
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section(role.displayName) {
                    LabeledContent("配置", value: role.profile)
                    LabeledContent("生效边界", value: role.activation_boundary)
                    if !original.editable { Text("本地模型与执行器首版只读。").foregroundStyle(Yimi.ink2) }
                    TextField("服务商标识", text: optional($role.provider_ref))
                    TextField("模型 ID", text: optional($role.model_id))
                    TextField("继承角色", text: optional($role.inherit_from))
                    Toggle("停用该角色", isOn: Binding(get: { role.disabled ?? false }, set: { role.disabled = $0 }))
                }.disabled(!writable)
                Section("模型列表") {
                    Button("读取服务商模型列表") {
                        if let provider = role.provider_ref { catalogRequested = true; Task { await model.loadCatalog(providerRef: provider) } }
                    }.disabled(!writable || role.provider_ref == nil)
                    if catalogRequested, let catalog = model.catalog, catalog.provider_ref == role.provider_ref {
                        Text("来源：\(catalog.source) · \(catalog.fetched_at)").font(.caption).foregroundStyle(Yimi.ink2)
                        if catalog.status == "available" {
                            ForEach(catalog.models, id: \.id) { item in
                                Button { role.model_id = item.id } label: {
                                    HStack { Text(item.display_name ?? item.id); Spacer(); Text(item.id).foregroundStyle(Yimi.ink2) }
                                }.disabled(!writable)
                            }
                            Text("列表不代表推理能力。选择后仍需测试连接。").font(.caption).foregroundStyle(Yimi.ink2)
                        } else if catalog.status == "unavailable" {
                            Text("服务商未提供模型列表，可填写模型 ID").foregroundStyle(Yimi.ink2)
                        } else {
                            Text(catalog.safe_error ?? catalog.message ?? "模型列表读取失败，请重试。").foregroundStyle(Yimi.danger)
                        }
                    }
                }
                Section("模型参数") {
                    DesktopModelSettingsParametersEditor(parameters: $role.parameters).disabled(!writable)
                }
                Section("按顺序回退") {
                    Text("从上到下依次尝试。不会自动增加回退路线。")
                        .font(.caption).foregroundStyle(Yimi.ink2)
                    ForEach(role.ordered_fallbacks.indices, id: \.self) { index in
                        DisclosureGroup("\(index + 1). \(role.ordered_fallbacks[index].provider_ref) · \(role.ordered_fallbacks[index].model_id)") {
                            TextField("服务商标识", text: $role.ordered_fallbacks[index].provider_ref)
                            TextField("模型 ID", text: $role.ordered_fallbacks[index].model_id)
                            DesktopModelSettingsParametersEditor(parameters: $role.ordered_fallbacks[index].parameters)
                            HStack {
                                Button("上移") { role.ordered_fallbacks.swapAt(index, index - 1) }.disabled(index == 0)
                                Button("下移") { role.ordered_fallbacks.swapAt(index, index + 1) }.disabled(index + 1 == role.ordered_fallbacks.count)
                                Spacer()
                                Button("移除", role: .destructive) { role.ordered_fallbacks.remove(at: index) }
                            }
                        }
                    }
                    Button("添加回退") {
                        role.ordered_fallbacks.append(ModelSettingsRoute(provider_ref: "", model_id: "", parameters: ModelSettingsParameters()))
                    }
                }.disabled(!writable)
                if let error = model.error { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) }
                if model.testedRole == role, let result = model.testResult { Text(result).textSelection(.enabled) }
            }.formStyle(.grouped)
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("测试连接 · 会产生少量用量") { prepare(test: true) }.disabled(!writable)
                Button("审阅修改…") { prepare(test: false) }.buttonStyle(.borderedProminent).disabled(!writable)
                    .accessibilityIdentifier("modelSettings.role.prepare")
            }.padding()
        }.onChange(of: role.provider_ref) { _ in catalogRequested = false }
        .frame(width: 660, height: 730).tint(Yimi.klein).foregroundStyle(Yimi.ink).background(Yimi.paper)
    }

    private func prepare(test: Bool) {
        let candidate = role
        Task {
            await model.prepareRoutes(roles: [candidate], summary: "修改角色：" + candidate.key)
            if model.review != nil {
                if test { await model.testConnection(role: candidate) }
                else { dismiss() }
            }
        }
    }

    private func optional(_ binding: Binding<String?>) -> Binding<String> {
        Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 })
    }
}

struct DesktopModelSettingsParametersEditor: View {
    @Binding var parameters: ModelSettingsParameters
    var body: some View {
        TextField("最大输出 token（留空为服务商默认）", value: $parameters.max_output_tokens, format: .number)
        TextField("上下文 token 上限（留空不指定）", value: $parameters.context_limit, format: .number)
        TextField("温度（留空为服务商默认）", value: $parameters.temperature, format: .number)
        TextField("推理力度（留空不指定）", text: Binding(
            get: { parameters.reasoning_effort ?? "" },
            set: { parameters.reasoning_effort = $0.isEmpty ? nil : $0 }))
        Toggle("指定思考参数", isOn: Binding(
            get: { parameters.thinking != nil },
            set: { parameters.thinking = $0 ? ModelSettingsThinking(enabled: true, budget: nil) : nil }))
        if parameters.thinking != nil {
            Toggle("开启思考", isOn: Binding(
                get: { parameters.thinking?.enabled ?? false },
                set: { parameters.thinking?.enabled = $0 }))
            TextField("思考 token 预算（留空不指定）", value: Binding(
                get: { parameters.thinking?.budget },
                set: { parameters.thinking?.budget = $0 }), format: .number)
        }
        Text("未指定的参数保持原样，由服务商决定。支持范围由所选模型决定。")
            .font(.caption).foregroundStyle(Yimi.ink2)
    }
}
