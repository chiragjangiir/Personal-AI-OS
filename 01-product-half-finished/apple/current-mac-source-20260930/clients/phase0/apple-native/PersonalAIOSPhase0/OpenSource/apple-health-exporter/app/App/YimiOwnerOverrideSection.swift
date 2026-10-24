import SwiftUI

struct YimiOwnerOverrideSection: View {
    @ObservedObject var model: YimiOwnerOverrideModel
    @State private var passphrase = ""

    var body: some View {
        Section {
            LabeledContent { YimiOwnerOverrideStatus(status: model.status) } label: { Text("最高权限") }
                .accessibilityIdentifier("ownerOverride.status")
            if model.status?.enabled == true {
                Button("关闭最高权限", role: .destructive) { Task { await model.request("owner_override_disable") } }
                    .disabled(model.busy || !model.connected)
            } else {
                SecureField("输入最高权限口令", text: $passphrase)
                    .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("ownerOverride.passphrase")
                Button("开启最高权限") { _ = model.enable(passphrase: &passphrase) }
                    .disabled(passphrase.isEmpty || model.busy || !model.connected || model.status?.available != true)
                    .accessibilityIdentifier("ownerOverride.enable")
            }
            if model.busy { ProgressView("正在更新最高权限") }
            if !model.connected { Text("连接依米后可设置最高权限").foregroundStyle(Yimi.ink2) }
            else if model.status?.available == false { Text("服务器尚未配置最高权限口令").foregroundStyle(Yimi.ink2) }
            if let error = model.error { Text(error).foregroundStyle(Yimi.danger) }
        } header: { Text("最高权限") } footer: {
            Text("开启后，你的设备上所有需要认人的请求都按你本人处理；付款仍需逐次确认")
        }
        .onDisappear { passphrase = "" }
    }
}

struct YimiOwnerOverrideStatus: View {
    let status: CentralOwnerOverride?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { tick in
            Text(status?.statusText(at: tick.date) ?? "未连接")
        }
    }
}
