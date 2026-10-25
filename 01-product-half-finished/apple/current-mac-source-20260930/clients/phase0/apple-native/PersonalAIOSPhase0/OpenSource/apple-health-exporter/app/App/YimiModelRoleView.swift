import SwiftUI

struct YimiModelRoleView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    @State var role: ModelSettingsRole
    let providers: [ModelSettingsProvider]
    @State private var showingCatalog = false
    @State private var testedRole: ModelSettingsRole?

    var body: some View {
        Form {
            Section {
                Text("编辑草稿 · 确认前仍使用已生效的设置").font(.footnote).foregroundStyle(Yimi.ink2)
                LabeledContent("配置", value: role.profile)
                LabeledContent("生效边界", value: role.activation_boundary)
                if !role.editable { Text("本地能力 · 首版只读").foregroundStyle(Yimi.ink2) }
            }
            if let current = model.snapshot?.roles.first(where: { $0.key == role.key }) {
                Section("服务器当前设置") {
                    Text([current.provider_ref, current.model_id, current.inherit_from.map { "继承 " + $0 }].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline).foregroundStyle(Yimi.ink2)
                    if current != role {
                        Button("从当前设置重新编辑") { role = current; showingCatalog = false; testedRole = nil }
                            .frame(minHeight: 44).disabled(model.busy)
                    }
                }
            }
            Section("模型") {
                Picker("服务商", selection: Binding(get: { role.provider_ref ?? "" }, set: { role.provider_ref = $0.isEmpty ? nil : $0; if !$0.isEmpty { role.inherit_from = nil }; showingCatalog = false })) {
                    Text("未选择").tag("")
                    ForEach(providers.filter { $0.wire_protocol != "local_onnx" }, id: \.id) { provider in
                        Text(provider.display_name).tag(provider.id)
                    }
                }
                TextField("模型 ID", text: Binding(get: { role.model_id ?? "" }, set: { role.model_id = $0.isEmpty ? nil : $0; if !$0.isEmpty { role.inherit_from = nil } }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Picker("继承角色", selection: Binding(get: { role.inherit_from ?? "" }, set: {
                    role.inherit_from = $0.isEmpty ? nil : $0
                    if !$0.isEmpty { role.provider_ref = nil; role.model_id = nil; showingCatalog = false }
                })) {
                    Text("独立设置").tag("")
                    ForEach((model.snapshot?.roles ?? []).filter { $0.profile == role.profile && $0.id != role.id }, id: \.key) { item in
                        Text(item.id).tag(item.id)
                    }
                }
                Button("读取服务商模型列表") {
                    if let ref = role.provider_ref {
                        showingCatalog = true
                        Task { await model.loadCatalog(providerRef: ref) }
                    }
                }.frame(minHeight: 44).disabled(role.provider_ref == nil || model.busy)
                if showingCatalog, let catalog = model.catalog, catalog.provider_ref == role.provider_ref {
                    Text("\(catalog.source) · \(catalog.fetched_at)").font(.caption).foregroundStyle(Yimi.ink2)
                    if catalog.status == "unavailable" {
                        Text("服务商未提供模型列表").font(.footnote).foregroundStyle(Yimi.ink2)
                    } else if catalog.status == "failed" {
                        Text(catalog.safe_error ?? catalog.message ?? "读取模型列表失败").foregroundStyle(Yimi.danger)
                    } else {
                        ForEach(catalog.models, id: \.id) { item in
                            Button { role.model_id = item.id } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.display_name ?? item.id)
                                        if item.display_name != nil { Text(item.id).font(.caption).foregroundStyle(Yimi.ink2) }
                                    }
                                    Spacer()
                                    if role.model_id == item.id { Image(systemName: "checkmark") }
                                }.frame(minHeight: 44)
                            }
                        }
                    }
                }
            }.disabled(!role.editable || !model.canWrite || model.busy)
            Section {
                NavigationLink("高级参数") { YimiModelParametersView(parameters: $role.parameters) }
                NavigationLink("备用模型顺序（\(role.ordered_fallbacks.count)）") {
                    YimiModelFallbacksView(routes: $role.ordered_fallbacks, providers: providers)
                }
                Toggle("停用此角色", isOn: Binding(get: { role.disabled ?? false }, set: { role.disabled = $0 }))
            }.disabled(!role.editable || !model.canWrite || model.busy)
            Section {
                Button("测试连接 · 会产生少量用量") {
                    let candidate = role
                    testedRole = nil
                    Task { await model.testConnection(role: candidate); testedRole = candidate }
                }
                    .frame(minHeight: 44).disabled(!role.editable || model.busy || !model.canWrite)
                if testedRole == role, let result = model.testResult { Text(result).font(.footnote).foregroundStyle(Yimi.ink2) }
                Button("查看完整更改") {
                    Task { await model.prepareRoutes(roles: [role], summary: "修改 \(role.key)") }
                }.frame(minHeight: 44).disabled(!role.editable || !model.canWrite || model.busy)
            }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle(role.displayName).navigationBarTitleDisplayMode(.inline).tint(Yimi.klein)
    }
}
