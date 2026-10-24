import SwiftUI

/// Level 2: what 依米 knows about you, plus device settings and the existing health / diagnostics screens.
/// Her memory lives in the main agent; until it is exposed to the app this page says so instead of inventing items.
struct YimiMemoryView: View {
    @ObservedObject var vm: AssistantViewModel
    var placeSensing: PlaceSensingService? = nil

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("她记住的事会出现在这里")
                        .font(.system(size: 16, weight: .semibold))
                    Text("口味、常去的地方、常用的车型、联系人……依米已经在记，这一页的同步正在接入。到时候每一条都能改、能删。")
                        .font(.system(size: 14)).foregroundStyle(Yimi.ink2)
                }
                .padding(.vertical, 6)
            } header: { Text("她了解你") }

            Section {
                NavigationLink { YimiVoiceprintView(vm: vm) } label: {
                    LabeledContent("你的声音") { Text(voiceStatus).foregroundStyle(Yimi.ink2) }
                }
                .accessibilityIdentifier("voiceEnrollment.entry")
            } header: { Text("声音") } footer: {
                Text("录入后，依米听得出哪句是你说的。")
            }

            Section { NavigationLink("支付与安全", value: YimiRoute.payment) }

            if let placeSensing {
                YimiPlaceSettings(service: placeSensing, backgroundLocationNeeded: vm.backgroundLocationNeeded)
            }

            Section {
                if vm.notificationPermission == .denied {
                    Link("在系统设置中允许提醒", destination: URL(string: UIApplication.openSettingsURLString)!)
                } else if vm.notificationPermission == .notDetermined {
                    Button("允许提醒通知") { Task { await vm.requestReminderAuthorization() } }
                }
                Toggle("用我的位置（外卖、打车更准）", isOn: Binding(
                    get: { vm.locationEnabled },
                    set: { value in Task { await vm.setLocationEnabled(value) } }))
                .tint(Yimi.klein)
                NavigationLink(value: YimiRoute.contacts) { Text("联系人同步") }
                NavigationLink(value: YimiRoute.health) { Text("健康数据与诊断") }
            } header: { Text("设备") }
        }
        .navigationTitle("她了解你")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .task {
            await vm.refreshNotificationPermissions()
            if vm.sessionState.isActive { _ = await vm.controlVoiceEnrollment("read") }
        }
    }

    private var voiceStatus: String {
        if vm.voiceEnrollment.phase == .collecting { return "正在熟悉" }
        guard let owner = vm.voiceEnrollment.owner else { return "" }
        if owner.reenrollmentRequired { return "还需补充" }
        return owner.enrolled ? "已熟悉" : "未录入"
    }
}

private struct YimiPlaceSettings: View {
    @ObservedObject var service: PlaceSensingService
    let backgroundLocationNeeded: Bool
    var body: some View {
        Section {
            Toggle("让依米了解我常去的地方", isOn: Binding(get: { service.state.enabled }, set: { value in
                Task { await service.setEnabled(value) }
            })).tint(Yimi.klein)
            LabeledContent("位置权限", value: service.permissionLevel)
            LabeledContent("监测地点", value: String(service.monitoredRegionCount))
            LabeledContent("上次上传") {
                if let date = service.state.lastUpload { Text(date, format: .dateTime.month().day().hour().minute()) }
                else { Text("尚未上传") }
            }
            if service.state.enabled || backgroundLocationNeeded, service.permissionLevel != "始终允许" {
                Link("在系统设置中允许始终访问位置", destination: URL(string: UIApplication.openSettingsURLString)!)
            }
            if service.state.revokePending { Text("已停止记录；联网且位置凭据可撤销时完成撤销。") }
            if let error = service.errorMessage { Text(error).foregroundStyle(.secondary) }
        } header: { Text("常去的地方") } footer: {
            Text("记录到访和进入、离开地点，保留 90 天。你可以随时让依米忘记。" +
                (backgroundLocationNeeded && service.permissionLevel != "始终允许"
                    ? "\n随身模式和眼镜后台待机需要始终允许位置。仅允许使用 App 时，后台定位会显示蓝色提示，眼镜后台待机不可用。"
                    : ""))
        }
    }
}
