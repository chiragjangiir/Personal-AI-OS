import SwiftUI

struct YimiModelParametersView: View {
    @Binding var parameters: ModelSettingsParameters
    @Environment(\.dismiss) private var dismiss
    @State private var thinking = "inherit"
    @State private var budget = ""
    @State private var output = ""
    @State private var context = ""
    @State private var temperature = ""
    @State private var reasoning = ""
    @State private var error: String?
    var body: some View {
        Form {
            Section("思考") {
                Picker("思考模式", selection: $thinking) {
                    Text("由服务商决定").tag("inherit")
                    Text("开启").tag("on")
                    Text("关闭").tag("off")
                }
                numberField("思考预算", text: $budget)
                TextField("推理强度（留空使用默认）", text: $reasoning)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            Section("生成参数") {
                numberField("最多输出 tokens", text: $output)
                numberField("上下文上限", text: $context)
                TextField("温度（留空使用默认）", text: $temperature).keyboardType(.decimalPad)
            }
            Section {
                Text("留空表示不覆盖。服务商是否接受参数，以测试连接和实际运行结果为准。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
                Button("保存到编辑草稿", action: apply).frame(minHeight: 44)
            }
            if let error { Section { Text(error).foregroundStyle(Yimi.danger) } }
        }.navigationTitle("高级参数").tint(Yimi.klein)
            .onAppear {
                thinking = parameters.thinking.map { $0.enabled ? "on" : "off" } ?? "inherit"
                budget = parameters.thinking?.budget.map(String.init) ?? ""
                output = parameters.max_output_tokens.map(String.init) ?? ""
                context = parameters.context_limit.map(String.init) ?? ""
                temperature = parameters.temperature.map { String($0) } ?? ""
                reasoning = parameters.reasoning_effort ?? ""
            }
    }
    private func numberField(_ title: String, text: Binding<String>) -> some View {
        TextField(title + "（留空使用默认）", text: text).keyboardType(.numberPad)
    }
    private func apply() {
        let integers = [budget, output, context]
        guard integers.allSatisfy({ $0.isEmpty || (Int($0).map { $0 > 0 } ?? false) }),
              temperature.isEmpty || (Double(temperature).map { $0.isFinite && $0 >= 0 && $0 <= 2 } ?? false) else {
            error = "token 数量需为正整数，温度需在 0 到 2 之间。"; return
        }
        var next = parameters
        next.thinking = thinking == "inherit" ? nil : ModelSettingsThinking(enabled: thinking == "on", budget: Int(budget))
        next.max_output_tokens = Int(output)
        next.context_limit = Int(context)
        next.temperature = Double(temperature)
        next.reasoning_effort = reasoning.isEmpty ? nil : reasoning
        parameters = next
        dismiss()
    }
}

struct YimiModelFallbacksView: View {
    @Binding var routes: [ModelSettingsRoute]
    let providers: [ModelSettingsProvider]
    @State private var provider = ""
    @State private var modelID = ""
    var body: some View {
        List {
            Section {
                ForEach(routes.indices, id: \.self) { index in
                    NavigationLink {
                        YimiModelFallbackView(route: $routes[index], providers: providers)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(index + 1). \(routes[index].model_id)")
                            Text(routes[index].provider_ref).font(.caption).foregroundStyle(Yimi.ink2)
                        }.frame(minHeight: 44)
                    }
                }.onDelete { routes.remove(atOffsets: $0) }
                    .onMove { routes.move(fromOffsets: $0, toOffset: $1) }
            } header: { Text("按顺序尝试") } footer: { Text("拖动调整顺序。原有备用模型的高级参数会一起保留。") }
            Section("添加备用模型") {
                Picker("服务商", selection: $provider) {
                    Text("请选择").tag("")
                    ForEach(providers.filter { $0.wire_protocol != "local_onnx" }, id: \.id) { item in Text(item.display_name).tag(item.id) }
                }
                TextField("模型 ID", text: $modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("添加到末尾") {
                    routes.append(ModelSettingsRoute(provider_ref: provider, model_id: modelID, parameters: ModelSettingsParameters()))
                    modelID = ""
                }.frame(minHeight: 44).disabled(provider.isEmpty || modelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.navigationTitle("备用顺序").toolbar { EditButton() }.tint(Yimi.klein)
    }
}

private struct YimiModelFallbackView: View {
    @Binding var route: ModelSettingsRoute
    let providers: [ModelSettingsProvider]
    var body: some View {
        Form {
            Picker("服务商", selection: $route.provider_ref) {
                ForEach(providers.filter { $0.wire_protocol != "local_onnx" }, id: \.id) { item in Text(item.display_name).tag(item.id) }
            }
            TextField("模型 ID", text: $route.model_id).textInputAutocapitalization(.never).autocorrectionDisabled()
            NavigationLink("高级参数") { YimiModelParametersView(parameters: $route.parameters) }
        }.navigationTitle("备用模型").tint(Yimi.klein)
    }
}
