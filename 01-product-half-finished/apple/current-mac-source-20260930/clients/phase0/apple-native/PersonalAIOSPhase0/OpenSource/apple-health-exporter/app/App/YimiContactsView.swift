import SwiftUI

struct YimiContactsView: View {
    @ObservedObject var vm: AssistantViewModel
    var body: some View {
        List {
            Section {
                Toggle("同步联系人到我的 Mac", isOn: Binding(get: { vm.contactsEnabled }, set: { value in
                    Task { await vm.setContactsEnabled(value) }
                })).disabled(vm.contactsChanging)
                Text(vm.contactsStatus).font(.footnote).foregroundStyle(.secondary)
                Button("现在同步") { Task { await vm.syncContactsNow() } }.disabled(!vm.contactsEnabled || vm.contactsChanging)
            } footer: {
                Text("只读取姓名、号码、号码标签和卡片里的相关人。不会修改通讯录。不会读取邮箱、地址或备注。数据通过加密连接发送到你配对的 Mac。")
            }
            Section {
                Text("关系从这张卡片指向相关人。例如，张三卡片里的“母亲：王芳”，表示王芳是张三的母亲。")
                Text("这不表示王芳是你的母亲。也不表示她是医疗紧急联系人。")
            } header: { Text("关系的方向") }
            Section {
                Text("iOS 18 及以后可以只授权部分联系人。只同步当前可读取的卡片。移出授权范围或删除的卡片会从 Mac 联系人库移除。重新授权后会重新同步。")
                Text("拒绝或撤销通讯录权限会暂停同步，不会把通讯录当作空列表发送删除。关闭同步不会删除 Mac 已收到的联系人。")
                Text("重装 App 后会重新上传可读取的联系人。旧安装留下的联系人不会自动清除。")
            } header: { Text("授权与同步范围") } footer: {
                Text("联系人变化、回到前台和重连时会继续同步。后台执行时间由 iOS 决定。")
            }
        }
        .navigationTitle("联系人同步").navigationBarTitleDisplayMode(.inline).toolbarRole(.editor)
        .task { await vm.refreshContactsStatus() }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in Task { await vm.refreshContactsStatus() } }
    }
}
