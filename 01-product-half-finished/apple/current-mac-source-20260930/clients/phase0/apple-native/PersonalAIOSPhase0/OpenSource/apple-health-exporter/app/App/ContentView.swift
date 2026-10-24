import Foundation
import SwiftUI
import UniformTypeIdentifiers
import UIKit

private enum PAIOSPalette {
    static let ink = Color(uiColor: .systemBackground)
    static let panel = Color(uiColor: .secondarySystemBackground)
    static let panelStrong = Color(uiColor: .tertiarySystemBackground)
    static let line = Color(uiColor: .separator)
    static let primary = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.82, green: 1.00, blue: 0.28, alpha: 1)
                : UIColor(red: 0.20, green: 0.43, blue: 0.02, alpha: 1)
        }
    )
    static let primaryForeground = Color(
        uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? .black : .white
        }
    )
    static let cyan = Color(uiColor: .systemCyan)
    static let violet = Color(uiColor: .systemPurple)
    static let coral = Color(uiColor: .systemRed)
    static let text = Color(uiColor: .label)
    static let secondaryText = Color(uiColor: .secondaryLabel)
}

private enum AppSection: String, CaseIterable, Identifiable {
    case health
    case status
    case more

    var id: String { rawValue }

    var title: String {
        switch self {
        case .health: "健康"
        case .status: "状态"
        case .more: "更多"
        }
    }

    var icon: String {
        switch self {
        case .health: "heart.fill"
        case .status: "waveform.path.ecg"
        case .more: "circle.grid.2x2.fill"
        }
    }
}

#if DEBUG
enum PAIOSDebugLaunch {
    static let physicalHealthAuthorizationArgument =
        "--paios-physical-health-authorization"
    static let physicalHealthProbeArgument =
        "--paios-physical-health-probe"
    static let physicalHealthUploadSmokeArgument =
        "--paios-physical-health-upload-smoke"
    static let physicalHealthUploadRetryArgument =
        "--paios-physical-health-upload-retry"
    static let ingestEndpointEnvironment =
        "PAIOS_DEBUG_INGEST_ENDPOINT"
    static let ingestTokenEnvironment =
        "PAIOS_DEBUG_INGEST_TOKEN"

    static var shouldRunPhysicalHealthAuthorization: Bool {
        ProcessInfo.processInfo.arguments.contains(
            physicalHealthAuthorizationArgument
        )
    }

    static var shouldRunPhysicalHealthProbe: Bool {
        ProcessInfo.processInfo.arguments.contains(
            physicalHealthProbeArgument
        )
    }

    static var shouldRunPhysicalHealthUploadSmoke: Bool {
        ProcessInfo.processInfo.arguments.contains(
            physicalHealthUploadSmokeArgument
        )
    }

    static var shouldRunPhysicalHealthUploadRetry: Bool {
        ProcessInfo.processInfo.arguments.contains(
            physicalHealthUploadRetryArgument
        )
    }

    static var shouldIsolateAutomaticHealthSync: Bool {
        shouldRunPhysicalHealthAuthorization
            || shouldRunPhysicalHealthProbe
            || shouldRunPhysicalHealthUploadSmoke
            || shouldRunPhysicalHealthUploadRetry
    }

    static var ingestEndpoint: String? {
        ProcessInfo.processInfo.environment[ingestEndpointEnvironment]
    }

    static var ingestToken: String? {
        ProcessInfo.processInfo.environment[ingestTokenEnvironment]
    }
}
#endif

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection = AppSection.health

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack { SetupView() }
                .tag(AppSection.health)
                .tabItem { Label(AppSection.health.title, systemImage: AppSection.health.icon) }
            NavigationStack { StatusView() }
                .tag(AppSection.status)
                .tabItem { Label(AppSection.status.title, systemImage: AppSection.status.icon) }
            NavigationStack { MoreView() }
                .tag(AppSection.more)
                .tabItem { Label(AppSection.more.title, systemImage: AppSection.more.icon) }
        }
        .environment(\.locale, Locale(identifier: "zh_Hans_CN"))
        .tint(PAIOSPalette.primary)
        .alert(
            "个人 AI 终端",
            isPresented: Binding(
                get: { model.alertMessage != nil },
                set: { if !$0 { model.alertMessage = nil } }
            )
        ) {
            Button("确定") { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? "")
        }
    }
}

private struct SetupView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            PAIOSBackdrop()
            Form {
                Section {
                    PAIOSRouteIntroduction(
                        title: "只读取你选择的数据",
                        message: "健康信号经你明确同意后，才会发送到你配置的私有服务器。",
                        icon: "heart.text.square.fill",
                        tint: PAIOSPalette.cyan
                    )
                }

                Section("私有服务器") {
                    HStack(spacing: 12) {
                        Image(systemName: "server.rack")
                            .foregroundStyle(PAIOSPalette.primary)
                            .frame(width: 24)
                        TextField("服务器地址", text: $model.settings.endpoint)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    HStack(spacing: 12) {
                        Image(systemName: "key.fill")
                            .foregroundStyle(PAIOSPalette.primary)
                            .frame(width: 24)
                        SecureField("API 令牌", text: $model.apiToken)
                            .textContentType(.password)
                    }
                    Text(endpointHelp)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    PAIOSNativeMetricToggle(
                        title: "血氧饱和度",
                        subtitle: "恢复状态",
                        icon: "lungs.fill",
                        isOn: $model.settings.metrics.oxygenSaturation
                    )
                    PAIOSNativeMetricToggle(
                        title: "体重",
                        subtitle: "身体组成",
                        icon: "scalemass.fill",
                        isOn: $model.settings.metrics.bodyMass
                    )
                    PAIOSNativeMetricToggle(
                        title: "体脂率",
                        subtitle: "身体组成",
                        icon: "figure.stand",
                        isOn: $model.settings.metrics.bodyFatPercentage
                    )
                    PAIOSNativeMetricToggle(
                        title: "去脂体重",
                        subtitle: "身体组成",
                        icon: "figure.strengthtraining.traditional",
                        isOn: $model.settings.metrics.leanBodyMass
                    )
                } header: {
                    Text("附加指标")
                } footer: {
                    Text("核心恢复、日常活动和训练指标默认包含；应用不会向 HealthKit 写入数据。")
                }

                Section("默认数据范围") {
                    ForEach(HealthMetricGroup.allCases) { group in
                        DisclosureGroup {
                            Text(group.summary)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } label: {
                            Label(group.title, systemImage: group.icon)
                                .foregroundStyle(.primary)
                        }
                    }
                }

                Section {
                    PAIOSActionButton(
                        title: "保存健康配置",
                        icon: "checkmark",
                        tone: .accent,
                        isLoading: model.isBusy
                    ) {
                        Task { await model.saveConfiguration() }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)

                    Button {
                        Task { await model.testConnection() }
                    } label: {
                        Label("测试服务器连接", systemImage: "bolt.horizontal.fill")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }

                if let message = model.actionMessage {
                    Section("配置状态") {
                        Label(message, systemImage: "checkmark.seal.fill")
                            .foregroundStyle(PAIOSPalette.primary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
        }
        .disabled(model.isBusy)
        .navigationTitle("健康")
        .navigationBarTitleDisplayMode(.large)
    }

    private var endpointHelp: String {
#if DEBUG
        "调试版本允许本地或私有测试主机使用 HTTP，此时流量与令牌未加密；发布版本必须使用 HTTPS。数据发送至 /v1/healthkit/ingest。"
#else
        "应用只接受 HTTPS，并将请求发送至 /v1/healthkit/ingest。"
#endif
    }
}

private enum HealthMetricGroup: String, CaseIterable, Identifiable {
    case recovery
    case activity
    case workout

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recovery: "恢复与睡眠"
        case .activity: "日常活动"
        case .workout: "训练上下文"
        }
    }

    var summary: String {
        switch self {
        case .recovery: "睡眠、HRV、静息心率、呼吸、腕温与心率恢复"
        case .activity: "活动能量、锻炼时间、站立时间、步数与体力强度"
        case .workout: "体能训练、训练心率、骑行功率、踏频与速度"
        }
    }

    var icon: String {
        switch self {
        case .recovery: "moon.stars.fill"
        case .activity: "figure.walk.motion"
        case .workout: "figure.run"
        }
    }

    var tint: Color {
        switch self {
        case .recovery: PAIOSPalette.violet
        case .activity: PAIOSPalette.primary
        case .workout: PAIOSPalette.cyan
        }
    }
}

private struct AuthorizationView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            PAIOSBackdrop()
            Form {
                Section {
                    PAIOSRouteIntroduction(
                        title: "两次独立选择",
                        message: "系统读取权限和服务器上传同意互不替代，你可以分别理解和决定。",
                        icon: "lock.shield.fill",
                        tint: PAIOSPalette.violet
                    )
                }

                Section("HealthKit 读取权限") {
                    Text("只有点击下方按钮后，系统才会申请读取权限。")
                        .foregroundStyle(.secondary)

                    DisclosureGroup("查看将申请的 \(model.selectedMetrics.count) 项数据") {
                        ForEach(model.selectedMetrics, id: \.rawValue) { metric in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(metric.displayName)
                                Text(metric.purpose)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 3)
                        }
                    }

                    Label(
                        "HealthKit 不会告诉应用某一项读取权限是否被拒绝；被拒绝与暂时没有数据可能表现相同。",
                        systemImage: "apple.logo"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                    Button {
                        Task { await model.requestAuthorization() }
                    } label: {
                        Label("申请读取权限", systemImage: "heart.text.square.fill")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)

                    Button("打开系统设置") {
                        openURL(URL(string: UIApplication.openSettingsURLString)!)
                    }

                    Text(model.authorizationMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("上传到私有服务器") {
                    LabeledContent("目标服务器", value: model.destinationOrigin)
                    Text("所选 HealthKit 原始样本、来源与设备上下文、白名单元数据和删除记录会用于健康与健身分析。GPS 路线和未纳入类别不会导出。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Label(
                        model.consentValid
                            ? "上传同意与当前服务器和指标一致"
                            : "上传前仍需要你的明确同意",
                        systemImage: model.consentValid
                            ? "checkmark.shield.fill"
                            : "exclamationmark.shield.fill"
                    )
                    .foregroundStyle(model.consentValid ? PAIOSPalette.primary : PAIOSPalette.coral)

                    Button {
                        Task { await model.grantConsent() }
                    } label: {
                        Label(
                            model.consentValid ? "已完成上传同意" : "我同意上传",
                            systemImage: model.consentValid ? "checkmark" : "arrow.up.right"
                        )
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                }

                if !model.unavailableMetrics.isEmpty {
                    Section("这台设备暂不支持") {
                        ForEach(model.unavailableMetrics, id: \.rawValue) { metric in
                            Label(metric.displayName, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(PAIOSPalette.coral)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
        }
        .disabled(model.isBusy)
        .navigationTitle("健康授权")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct StatusView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var confirmAnchorReset = false
    @State private var confirmQueueClear = false

    var body: some View {
        PAIOSScreen {
            serverOverview
                .paiosReveal()

            runtimeCard
                .paiosReveal()

            operationCard
                .paiosReveal()

            if let message = model.actionMessage {
                PAIOSNotice(
                    title: "操作结果",
                    message: message,
                    icon: "checkmark.circle.fill",
                    tint: PAIOSPalette.primary
                )
                .paiosReveal()
            }
        }
        .disabled(model.isBusy)
        .refreshable { await model.refresh() }
        .navigationTitle("状态")
        .navigationBarTitleDisplayMode(.large)
        .confirmationDialog(
            "要重置全部 HealthKit 增量锚点吗？",
            isPresented: $confirmAnchorReset,
            titleVisibility: .visible
        ) {
            Button("重置锚点", role: .destructive) {
                Task { await model.resetAnchors() }
            }
        } message: {
            Text("下次同步可能重新加入历史样本；已有待上传批次会保留。")
        }
        .confirmationDialog(
            "要删除全部本地待上传数据吗？",
            isPresented: $confirmQueueClear,
            titleVisibility: .visible
        ) {
            Button("清空队列", role: .destructive) {
                Task { await model.clearQueue() }
            }
        } message: {
            Text("尚未被服务器接收的健康数据将从本机永久移除。")
        }
    }

    @ViewBuilder
    private var serverOverview: some View {
        if let cache = model.backendDataStatusCache {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .center, spacing: 14) {
                    PAIOSStatusOrb(state: cache.status.state.orbState, isActive: false)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("服务器健康数据")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PAIOSPalette.secondaryText)
                        Text(cache.status.state.displayName)
                            .font(.title2.weight(.bold))
                            .foregroundStyle(PAIOSPalette.text)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(cache.status.activeRecordCount.formatted())
                            .font(.title2.weight(.bold).monospacedDigit())
                            .foregroundStyle(cache.status.state.color)
                        Text("有效记录")
                            .font(.caption)
                            .foregroundStyle(PAIOSPalette.secondaryText)
                    }
                }

                LazyVGrid(
                    columns: statusColumns,
                    spacing: 10
                ) {
                    PAIOSDomainTile(title: "恢复", domain: cache.status.domains.recovery)
                    PAIOSDomainTile(title: "睡眠", domain: cache.status.domains.sleep)
                    PAIOSDomainTile(title: "活动", domain: cache.status.domains.activity)
                    PAIOSDomainTile(title: "锻炼", domain: cache.status.domains.workouts)
                }

                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 10) {
                            PAIOSCompactFact(title: "最近检查", value: dateText(cache.retrievedAt))
                            PAIOSCompactFact(title: "最新记录", value: dateText(cache.status.latestRecordAt))
                        }
                    } else {
                        HStack {
                            PAIOSCompactFact(title: "最近检查", value: dateText(cache.retrievedAt))
                            Spacer()
                            PAIOSCompactFact(
                                title: "最新记录",
                                value: dateText(cache.status.latestRecordAt),
                                alignment: .trailing
                            )
                        }
                    }
                }

                ForEach(cache.status.warnings, id: \.self) { warning in
                    PAIOSNotice(
                        title: "需要关注",
                        message: backendWarningText(warning),
                        icon: "exclamationmark.triangle.fill",
                        tint: PAIOSPalette.coral
                    )
                }

                if let message = model.backendDataStatusMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(PAIOSPalette.secondaryText)
                }
            }
            .paiosCard(accent: cache.status.state.color, emphasis: true)
        } else {
            PAIOSNotice(
                title: "等待服务器状态",
                message: model.backendDataStatusMessage ?? "下拉刷新或点击立即同步后，这里会显示服务器数据状态。",
                icon: "server.rack",
                tint: PAIOSPalette.secondaryText
            )
        }
    }

    private var runtimeCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            PAIOSSectionHeading(
                title: "运行状态",
                subtitle: "只展示经过脱敏的操作信息。"
            )

            PAIOSStatusLine(
                title: "服务器可用性",
                value: backendAvailabilityText,
                icon: "network"
            )
            PAIOSStatusLine(
                title: "最近同步尝试",
                value: dateText(model.status.lastSyncAttempt),
                icon: "arrow.triangle.2.circlepath"
            )
            PAIOSStatusLine(
                title: "最近成功上传",
                value: dateText(model.status.lastSuccessfulUpload),
                icon: "arrow.up.circle.fill"
            )
            PAIOSStatusLine(
                title: "最近观察事件",
                value: dateText(model.status.lastObserverEvent),
                icon: "eye.fill"
            )
            PAIOSStatusLine(
                title: "后台传输",
                value: model.status.backgroundRegistration,
                icon: "arrow.clockwise.icloud.fill"
            )
            PAIOSStatusLine(
                title: "最近脱敏错误",
                value: model.status.lastRedactedError ?? "无",
                icon: "exclamationmark.bubble.fill",
                showDivider: false
            )
        }
        .paiosCard()
    }

    private var operationCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            PAIOSSectionHeading(
                title: "控制这条链路",
                subtitle: "常用操作在前，具有数据影响的操作保持独立确认。"
            )

            PAIOSActionButton(title: "立即同步", icon: "arrow.up.right", tone: .accent) {
                Task { await model.syncNow() }
            }
            PAIOSActionButton(
                title: "重试上传队列",
                icon: "arrow.clockwise",
                tone: .neutral
            ) {
                Task { await model.retryQueue() }
            }
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 10) {
                        destructiveControls
                    }
                } else {
                    HStack(spacing: 10) {
                        destructiveControls
                    }
                }
            }
        }
        .paiosCard(emphasis: true)
    }

    private func dateText(_ date: Date?) -> String {
        date?.formatted(date: .abbreviated, time: .shortened) ?? "从未"
    }

    private var backendAvailabilityText: String {
        guard let reachable = model.status.backendReachable else {
            return "尚未检查"
        }
        let state = reachable ? "可连接" : "不可连接，上传已暂缓"
        guard let checkedAt = model.status.lastBackendReachabilityCheck else {
            return state
        }
        return "\(state) · \(dateText(checkedAt))"
    }

    private func backendWarningText(_ warning: String) -> String {
        let normalized = warning.lowercased()
        let domainNames = [
            "recovery": "恢复",
            "sleep": "睡眠",
            "activity": "活动",
            "workouts": "锻炼"
        ]
        for (key, name) in domainNames {
            if normalized == "\(key) data is absent" {
                return "服务器中没有\(name)数据。"
            }
            if normalized == "\(key) data is stale" {
                return "服务器中的\(name)数据已经过期。"
            }
        }
        return "服务器返回了需要关注的状态提示。"
    }

    @ViewBuilder
    private var destructiveControls: some View {
        PAIOSCompactButton(title: "重置锚点", icon: "scope", tone: .danger) {
            confirmAnchorReset = true
        }
        PAIOSCompactButton(title: "清空队列", icon: "trash.fill", tone: .danger) {
            confirmQueueClear = true
        }
    }

    private var statusColumns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: 10), GridItem(.flexible())]
    }
}

private extension BackendDataState {
    var displayName: String {
        switch self {
        case .current: "当前"
        case .stale: "已过期"
        case .empty: "无数据"
        }
    }

    var color: Color {
        switch self {
        case .current: PAIOSPalette.primary
        case .stale: PAIOSPalette.coral
        case .empty: PAIOSPalette.secondaryText
        }
    }

    var orbState: PAIOSOrbState {
        switch self {
        case .current: .success
        case .stale: .failure
        case .empty: .neutral
        }
    }
}

private struct BackfillView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        PAIOSScreen {
            PAIOSRouteIntroduction(
                title: "把过去带回当前上下文",
                message: "按有限批次补齐历史记录，不改变日常增量同步锚点。",
                icon: "clock.arrow.circlepath",
                tint: PAIOSPalette.cyan
            )

            dateRangeCard
                .paiosReveal()

            if let progress = model.backfillProgress {
                progressCard(progress)
                    .paiosReveal()
            }

            actionCard
                .paiosReveal()

            if let message = model.actionMessage {
                PAIOSNotice(
                    title: "历史回填状态",
                    message: message,
                    icon: "clock.badge.checkmark.fill",
                    tint: PAIOSPalette.primary
                )
                .paiosReveal()
            }
        }
        .navigationTitle("历史回填")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var dateRangeCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            PAIOSSectionHeading(
                title: "选择时间范围",
                subtitle: "导出器按自然月拆分，并为每种健康数据创建有限批次。"
            )

            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 10) { dateFields }
                } else {
                    HStack(spacing: 10) { dateFields }
                }
            }

            Label("不会修改增量同步锚点", systemImage: "checkmark.shield.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PAIOSPalette.primary)
        }
        .paiosCard(accent: PAIOSPalette.cyan)
    }

    @ViewBuilder
    private var dateFields: some View {
        PAIOSDateField(
            title: "开始日期",
            date: $model.backfillStart,
            minimum: nil,
            maximum: model.backfillEnd
        )
        PAIOSDateField(
            title: "结束日期",
            date: $model.backfillEnd,
            minimum: model.backfillStart,
            maximum: Date()
        )
    }

    private func progressCard(_ progress: BackfillProgress) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 10) {
                        progressHeading(progress)
                        progressPercentage(progress)
                    }
                } else {
                    HStack {
                        progressHeading(progress)
                        Spacer()
                        progressPercentage(progress)
                    }
                }
            }

            ProgressView(
                value: Double(progress.currentMetric),
                total: Double(max(progress.totalMetrics, 1))
            )
            .tint(PAIOSPalette.cyan)

            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 10) { progressFacts(progress) }
                } else {
                    HStack(spacing: 10) { progressFacts(progress) }
                }
            }

            Text("当前分段：\(progress.chunkStart.formatted(date: .abbreviated, time: .omitted))")
                .font(.footnote)
                .foregroundStyle(PAIOSPalette.secondaryText)
        }
        .paiosCard(accent: PAIOSPalette.cyan, emphasis: true)
    }

    private func progressHeading(_ progress: BackfillProgress) -> some View {
        PAIOSSectionHeading(
            title: "正在回填历史数据",
            subtitle: "第 \(progress.currentMetric) 项，共 \(progress.totalMetrics) 项"
        )
    }

    private func progressPercentage(_ progress: BackfillProgress) -> some View {
        Text("\(Int(Double(progress.currentMetric) / Double(max(progress.totalMetrics, 1)) * 100))%")
            .font(.title2.weight(.bold).monospacedDigit())
            .foregroundStyle(PAIOSPalette.text)
    }

    @ViewBuilder
    private func progressFacts(_ progress: BackfillProgress) -> some View {
        PAIOSDataTile(
            title: "已加入队列",
            value: "\(progress.queuedBatches) 批",
            icon: "tray.full.fill",
            tint: PAIOSPalette.violet
        )
        PAIOSDataTile(
            title: "已处理记录",
            value: progress.processedRecords.formatted(),
            icon: "checkmark.circle.fill",
            tint: PAIOSPalette.primary
        )
    }

    private var actionCard: some View {
        VStack(spacing: 12) {
            if model.isBackfillRunning {
                PAIOSActionButton(
                    title: "暂停历史回填",
                    icon: "pause.fill",
                    tone: .neutral
                ) {
                    model.cancelBackfill()
                }
            } else {
                PAIOSActionButton(
                    title: "开始新的历史回填",
                    icon: "arrow.up.right",
                    tone: .accent
                ) {
                    model.startBackfill()
                }
                if model.hasResumableBackfill {
                    PAIOSActionButton(
                        title: "继续已保存的回填",
                        icon: "play.fill",
                        tone: .neutral
                    ) {
                        model.resumeBackfill()
                    }
                }
            }
        }
        .paiosCard(emphasis: true)
    }
}

private struct DiagnosticsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isExporting = false
    @State private var document = DiagnosticsDocument(text: "")

    var body: some View {
        PAIOSScreen {
            PAIOSRouteIntroduction(
                title: "定位问题，不暴露你",
                message: "诊断只保留运行信息，敏感身份与健康内容会被省略或脱敏。",
                icon: "stethoscope",
                tint: PAIOSPalette.coral
            )

            VStack(alignment: .leading, spacing: 18) {
                PAIOSSectionHeading(
                    title: "脱敏诊断包",
                    subtitle: "包含运行时间、数据类型名称、队列数量和目标服务器。"
                )

                PAIOSPrivacyLine(icon: "key.slash.fill", text: "不包含 API 令牌")
                PAIOSPrivacyLine(icon: "person.crop.circle.badge.xmark", text: "不包含设备标识")
                PAIOSPrivacyLine(icon: "heart.slash.fill", text: "不包含健康数值和样本标识")
                PAIOSPrivacyLine(icon: "doc.badge.ellipsis", text: "请求正文会被省略")

                PAIOSActionButton(
                    title: "导出脱敏诊断",
                    icon: "square.and.arrow.up.fill",
                    tone: .accent
                ) {
                    Task {
                        if await model.prepareDiagnostics() {
                            document = DiagnosticsDocument(text: model.diagnosticsText)
                            isExporting = true
                        }
                    }
                }
            }
            .paiosCard(accent: PAIOSPalette.coral, emphasis: true)
            .paiosReveal()

            PAIOSNotice(
                title: "后台传输受 iOS 管理",
                message: "模拟器不支持 HealthKit 后台传输。真机锁定、低电量模式或应用被强制退出后，系统可能延迟传输。",
                icon: "iphone.gen3.radiowaves.left.and.right",
                tint: PAIOSPalette.cyan
            )
            .paiosReveal()
        }
        .navigationTitle("诊断")
        .navigationBarTitleDisplayMode(.inline)
        .fileExporter(
            isPresented: $isExporting,
            document: document,
            contentType: .plainText,
            defaultFilename: "PAIOS-健康诊断"
        ) { result in
            if case .failure(let error) = result {
                model.alertMessage = UserFacingError.message(for: error)
            }
        }
    }
}

private struct MoreView: View {
    var body: some View {
        ZStack {
            PAIOSBackdrop()
            List {
                Section {
                    PAIOSRouteIntroduction(
                        title: "每项能力都有明确边界",
                        message: "在这里管理授权、历史数据和脱敏诊断。",
                        icon: "circle.grid.2x2.fill",
                        tint: PAIOSPalette.violet
                    )
                }

                Section("数据与支持") {
                NavigationLink {
                    AuthorizationView()
                } label: {
                    PAIOSNavigationRow(
                        title: "健康授权",
                        subtitle: "管理 HealthKit 读取权限与服务器上传同意",
                        icon: "heart.text.square.fill",
                        tint: PAIOSPalette.violet
                    )
                }

                NavigationLink {
                    BackfillView()
                } label: {
                    PAIOSNavigationRow(
                        title: "历史回填",
                        subtitle: "按有限批次补齐过去的健康数据",
                        icon: "clock.arrow.circlepath",
                        tint: PAIOSPalette.cyan
                    )
                }

                NavigationLink {
                    DiagnosticsView()
                } label: {
                    PAIOSNavigationRow(
                        title: "脱敏诊断",
                        subtitle: "导出可排查、不可还原个人数据的运行信息",
                        icon: "stethoscope",
                        tint: PAIOSPalette.coral
                    )
                }
                }

                Section {
                    Label(
                        "当前版本面向非商业个人使用。健康数据只沿你明确配置并同意的链路流动。",
                        systemImage: "lock.shield.fill"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("更多")
        .navigationBarTitleDisplayMode(.large)
    }
}

private struct PAIOSScreen<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            PAIOSBackdrop()
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 22) {
                    content
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }
}

private struct PAIOSBackdrop: View {
    var body: some View {
        PAIOSPalette.ink.ignoresSafeArea()
    }
}

private struct PAIOSSectionHeading: View {
    let title: String
    let subtitle: String?

    init(title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(PAIOSPalette.text)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline.weight(.medium))
                    .lineSpacing(3)
                    .foregroundStyle(PAIOSPalette.secondaryText)
            }
        }
    }
}

private struct PAIOSRouteIntroduction: View {
    let title: String
    let message: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(PAIOSPalette.text)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(PAIOSPalette.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

private struct PAIOSNativeMetricToggle: View {
    let title: String
    let subtitle: String
    let icon: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: icon)
                    .foregroundStyle(PAIOSPalette.primary)
            }
        }
        .tint(PAIOSPalette.primary)
    }
}

private struct PAIOSNavigationRow: View {
    let title: String
    let subtitle: String
    let icon: String
    let tint: Color

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        } icon: {
            Image(systemName: icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 30)
        }
    }
}

private enum PAIOSButtonTone {
    case accent
    case neutral
    case danger
}

private struct PAIOSActionButton: View {
    @Environment(\.isEnabled) private var isEnabled
    let title: String
    let icon: String
    let tone: PAIOSButtonTone
    var isLoading = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if isLoading {
                    ProgressView()
                        .tint(foreground)
                } else {
                    Image(systemName: icon)
                        .font(.subheadline.weight(.bold))
                }
                Text(title)
                    .font(.headline)
                Spacer()
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 17)
            .background(background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(border, lineWidth: 1)
            )
        }
        .buttonStyle(PAIOSPressButtonStyle())
    }

    private var foreground: Color {
        guard isEnabled else { return PAIOSPalette.secondaryText }
        return switch tone {
        case .accent: PAIOSPalette.primaryForeground
        case .neutral: PAIOSPalette.text
        case .danger: PAIOSPalette.coral
        }
    }

    private var background: Color {
        guard isEnabled else { return PAIOSPalette.panelStrong }
        return switch tone {
        case .accent: PAIOSPalette.primary
        case .neutral: Color.white.opacity(0.07)
        case .danger: PAIOSPalette.coral.opacity(0.08)
        }
    }

    private var border: Color {
        guard isEnabled else { return PAIOSPalette.line }
        return switch tone {
        case .accent: .clear
        case .neutral: PAIOSPalette.line
        case .danger: PAIOSPalette.coral.opacity(0.38)
        }
    }
}

private struct PAIOSCompactButton: View {
    @Environment(\.isEnabled) private var isEnabled
    let title: String
    let icon: String
    let tone: PAIOSButtonTone
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.title3.weight(.semibold))
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(
                isEnabled
                    ? (tone == .danger ? PAIOSPalette.coral : PAIOSPalette.text)
                    : PAIOSPalette.secondaryText
            )
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
            .padding(.vertical, 14)
            .background(
                isEnabled ? PAIOSPalette.panelStrong : PAIOSPalette.panel,
                in: RoundedRectangle(cornerRadius: 16)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(
                        isEnabled && tone == .danger
                            ? PAIOSPalette.coral.opacity(0.28)
                            : PAIOSPalette.line
                    )
            )
        }
        .buttonStyle(PAIOSPressButtonStyle())
    }
}

private struct PAIOSPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(
                reduceMotion || !isEnabled ? 1 : (configuration.isPressed ? 0.97 : 1)
            )
            .opacity(configuration.isPressed && isEnabled ? 0.82 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.24, dampingFraction: 0.78),
                value: configuration.isPressed
            )
    }
}

private struct PAIOSDataTile: View {
    let title: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
            Spacer(minLength: 0)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(PAIOSPalette.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(PAIOSPalette.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(PAIOSPalette.panelStrong, in: RoundedRectangle(cornerRadius: 14))
    }
}

private enum PAIOSOrbState {
    case neutral
    case success
    case failure

    var color: Color {
        switch self {
        case .neutral: PAIOSPalette.secondaryText
        case .success: PAIOSPalette.primary
        case .failure: PAIOSPalette.coral
        }
    }

    var icon: String {
        switch self {
        case .neutral: "circle.dotted"
        case .success: "checkmark"
        case .failure: "xmark"
        }
    }
}

private struct PAIOSStatusOrb: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: PAIOSOrbState
    let isActive: Bool
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .fill(state.color.opacity(0.16))
                .frame(width: 52, height: 52)
                .scaleEffect(isActive && pulse ? 1.18 : 1)
                .opacity(isActive && pulse ? 0.35 : 1)
            Circle()
                .fill(state.color)
                .frame(width: 38, height: 38)
            Image(systemName: state.icon)
                .font(.caption.weight(.black))
                .foregroundStyle(PAIOSPalette.ink)
        }
        .onAppear {
            guard isActive, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
        .onChange(of: isActive) { _, active in
            guard active, !reduceMotion else {
                pulse = false
                return
            }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

private struct PAIOSDomainTile: View {
    let title: String
    let domain: BackendDataDomainStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PAIOSPalette.secondaryText)
                Spacer()
                Circle()
                    .fill(domain.state.color)
                    .frame(width: 7, height: 7)
                    .shadow(color: domain.state.color.opacity(0.55), radius: 5)
            }
            Text(domain.recordCount.formatted())
                .font(.title2.weight(.bold).monospacedDigit())
                .foregroundStyle(PAIOSPalette.text)
            Text(domain.state.displayName)
                .font(.caption)
                .foregroundStyle(domain.state.color)
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .padding(14)
        .background(PAIOSPalette.panelStrong, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PAIOSStatusLine: View {
    let title: String
    let value: String
    let icon: String
    var showDivider = true

    var body: some View {
        VStack(spacing: 13) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PAIOSPalette.cyan)
                    .frame(width: 28, height: 28)
                    .background(PAIOSPalette.cyan.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PAIOSPalette.secondaryText)
                    Text(value)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(PAIOSPalette.text)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            if showDivider {
                Rectangle()
                    .fill(PAIOSPalette.line)
                    .frame(height: 1)
            }
        }
    }
}

private struct PAIOSCompactFact: View {
    let title: String
    let value: String
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 3) {
            Text(title)
                .font(.caption)
                .foregroundStyle(PAIOSPalette.secondaryText)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PAIOSPalette.text)
        }
    }
}

private struct PAIOSDateField: View {
    let title: String
    @Binding var date: Date
    let minimum: Date?
    let maximum: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PAIOSPalette.secondaryText)
            datePicker
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PAIOSPalette.panelStrong, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder
    private var datePicker: some View {
        if let minimum, let maximum {
            DatePicker("", selection: $date, in: minimum...maximum, displayedComponents: [.date])
                .labelsHidden()
                .datePickerStyle(.compact)
                .tint(PAIOSPalette.primary)
        } else if let maximum {
            DatePicker("", selection: $date, in: ...maximum, displayedComponents: [.date])
                .labelsHidden()
                .datePickerStyle(.compact)
                .tint(PAIOSPalette.primary)
        } else if let minimum {
            DatePicker("", selection: $date, in: minimum..., displayedComponents: [.date])
                .labelsHidden()
                .datePickerStyle(.compact)
                .tint(PAIOSPalette.primary)
        } else {
            DatePicker("", selection: $date, displayedComponents: [.date])
                .labelsHidden()
                .datePickerStyle(.compact)
                .tint(PAIOSPalette.primary)
        }
    }
}

private struct PAIOSNotice: View {
    let title: String
    let message: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon)
                .font(.headline)
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(PAIOSPalette.text)
                Text(message)
                    .font(.footnote)
                    .lineSpacing(3)
                    .foregroundStyle(PAIOSPalette.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PAIOSPrivacyLine: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PAIOSPalette.primary)
                .frame(width: 28)
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(PAIOSPalette.text)
            Spacer()
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(PAIOSPalette.primary)
        }
        .padding(.vertical, 2)
    }
}

private struct PAIOSCardModifier: ViewModifier {
    let accent: Color?
    let emphasis: Bool

    func body(content: Content) -> some View {
        content
            .padding(18)
            .background(
                LinearGradient(
                    colors: [
                        (accent ?? PAIOSPalette.panel).opacity(emphasis ? 0.10 : 0.04),
                        PAIOSPalette.panel
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        emphasis
                            ? Color.clear
                            : (accent ?? PAIOSPalette.line).opacity(accent == nil ? 1 : 0.28),
                        lineWidth: 1
                    )
            )
            .shadow(
                color: .black.opacity(emphasis ? 0.18 : 0),
                radius: emphasis ? 12 : 0,
                y: emphasis ? 6 : 0
            )
    }
}

private struct PAIOSRevealModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
    }
}

private extension View {
    func paiosCard(
        accent: Color? = nil,
        emphasis: Bool = false
    ) -> some View {
        modifier(PAIOSCardModifier(accent: accent, emphasis: emphasis))
    }

    func paiosInput(icon: String? = nil) -> some View {
        HStack(spacing: 10) {
            if let icon {
                Image(systemName: icon)
                    .foregroundStyle(PAIOSPalette.cyan)
            }
            self
                .foregroundStyle(PAIOSPalette.text)
        }
        .font(.body.weight(.medium))
        .padding(.horizontal, 15)
        .frame(minHeight: 52)
        .background(PAIOSPalette.panelStrong, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PAIOSPalette.line))
    }

    func paiosReveal() -> some View {
        modifier(PAIOSRevealModifier())
    }
}

private struct DiagnosticsDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    let text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
