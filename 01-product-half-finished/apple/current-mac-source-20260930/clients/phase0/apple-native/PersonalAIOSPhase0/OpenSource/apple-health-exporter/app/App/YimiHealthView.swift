import SwiftUI

/// 她了解你 → 健康数据与诊断. The legacy exporter screens (授权、回填、诊断) own their own tab of NavigationStacks, so they
/// open as a sheet — never pushed onto the root stack (see YimiRoute).
struct YimiHealthView: View {
    @ObservedObject var vm: AssistantViewModel
    @State private var exporterOpen = false

    var body: some View {
        List {
            Section {
                Toggle("开启健康同步", isOn: Binding(get: { vm.healthEnabled }, set: { value in
                    Task { await vm.setHealthEnabled(value) }
                }))
                Text(vm.healthStatus).font(.footnote).foregroundStyle(.secondary)
                Button("现在同步") { Task { await vm.syncHealthNow() } }.disabled(!vm.healthEnabled)
            } header: { Text("同步到我的 Mac") } footer: {
                Text("只读取你授权的记录。同步已有记录和后续变化，包括健康 App 中的删除。数据通过加密连接发送到你配对的 Mac。关闭同步不会删除 Mac 已收到的记录。")
            }
            Section {
                Text("睡眠与阶段、全天心率、静息心率、心率变异性、呼吸、血氧、步数、活动能量、训练、跌倒、步行稳定性、睡眠腕温和体温。")
                Text("设备没有采集的指标不会产生记录。睡眠阶段、血氧和温度取决于设备及系统支持。未授权与没有数据无法区分。")
                    .font(.footnote).foregroundStyle(.secondary)
            } header: { Text("读取范围") } footer: {
                Text("健康记录仅供日常上下文参考，不用于医疗诊断。依米不会写入健康 App。你可以在健康 App 中随时修改读取权限。iOS 决定后台执行时间；前台和重连会继续同步。")
            }
            Section {
                Button { exporterOpen = true } label: {
                    Label("健康导出器与诊断", systemImage: "stethoscope")
                }
            } footer: {
                Text("原健康导出器的授权、历史回填和脱敏诊断。")
            }
        }
        .navigationTitle("健康数据与诊断")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .task { await vm.refreshHealthStatus() }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in
            Task { await vm.refreshHealthStatus() }
        }
        .sheet(isPresented: $exporterOpen) {
            ContentView().presentationDragIndicator(.visible)
        }
    }
}
