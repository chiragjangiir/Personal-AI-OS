import Combine
import Foundation
import HealthKit

@MainActor
final class AppModel: ObservableObject {
    @Published var settings = AppSettings()
    @Published var apiToken = ""
    @Published var status = OperationalStatus()
    @Published var backendDataStatusCache: BackendDataStatusCache?
    @Published var backendDataStatusMessage: String?
    @Published var authorizationMessage =
        "本次安装尚未申请 HealthKit 读取权限。"
    @Published var consentValid = false
    @Published var isBusy = false
    @Published var alertMessage: String?
    @Published var actionMessage: String?
    @Published var backfillStart =
        Calendar.current.date(byAdding: .month, value: -12, to: Date()) ?? Date()
    @Published var backfillEnd = Date()
    @Published var backfillProgress: BackfillProgress?
    @Published var isBackfillRunning = false
    @Published var hasResumableBackfill = false
    @Published var diagnosticsText = ""

    private var coordinator: SyncCoordinator?
    private var healthQueryService: HealthQuerying?
    private var settingsStore: SettingsStoring?
    private var credentialStore: CredentialStoring?
    private var authorizationService: HealthAuthorizing?
    private var backgroundRegistrar: BackgroundSyncRegistrar?
    private var backendDataStatusClient: BackendDataStatusFetching?
    private var backendDataStatusStore: BackendDataStatusStoring?
    private var backfillTask: Task<Void, Never>?
    private var automaticSyncInProgress = false

    init(placeFlush: (@MainActor @Sendable () async -> Bool)? = nil) {
        do {
            let root = try StoragePaths.productionRoot()
            try StoragePaths.prepareDirectory(root)
            let healthStore = HKHealthStore()
            let settingsStore = UserDefaultsSettingsStore()
            let credentialStore = KeychainCredentialStore()
            let healthQueryService = HealthQueryService(healthStore: healthStore)
            let coordinator = SyncCoordinator(
                queryService: healthQueryService,
                anchorStore: FileAnchorStore(root: root),
                outboxStore: FileOutboxStore(root: root),
                payloadEncoder: JSONPayloadEncoder(),
                backendAvailabilityChecker: BackendAvailabilityClient(),
                uploader: UploadClient(),
                settingsStore: settingsStore,
                credentialStore: credentialStore,
                backfillStore: FileBackfillStateStore(root: root),
                statusStore: FileStatusStore(root: root)
            )
            let backgroundRegistrar = BackgroundSyncRegistrar(
                healthStore: healthStore,
                coordinator: coordinator,
                placeFlush: placeFlush
            )

            self.coordinator = coordinator
            self.healthQueryService = healthQueryService
            self.settingsStore = settingsStore
            self.credentialStore = credentialStore
            self.authorizationService = HealthAuthorizationService(healthStore: healthStore)
            self.backgroundRegistrar = backgroundRegistrar
            self.backendDataStatusClient = BackendDataStatusClient()
            self.backendDataStatusStore = FileBackendDataStatusStore(root: root)
#if DEBUG
            if !PAIOSDebugLaunch.shouldIsolateAutomaticHealthSync {
                backgroundRegistrar.registerAppRefresh()
            }
#else
            backgroundRegistrar.registerAppRefresh()
#endif

            Task { await loadInitialState() }
        } catch {
            alertMessage = UserFacingError.message(for: error)
        }
    }

    var selectedMetrics: [HealthMetric] {
        HealthTypeRegistry.selectedMetrics(settings.metrics)
    }

    var unavailableMetrics: [HealthMetric] {
        HealthTypeRegistry.unavailableMetrics(settings.metrics)
    }

    var destinationOrigin: String {
        (try? EndpointResolver.destinationOrigin(from: settings.endpoint))
            ?? "尚未配置有效的 HTTPS 服务器"
    }

    func saveConfiguration() async {
        await runUserAction(success: "配置已保存。") {
            try await persistConfiguration()
        }
    }

    func testConnection() async {
        await runUserAction(success: "连接成功，服务器已接收空测试批次。") {
            try await persistConfiguration()
            guard let coordinator else { throw initializationError() }
            try await coordinator.testConnection()
            try await refreshStatus()
        }
    }

    func grantConsent() async {
        await runUserAction(success: "已记录对当前服务器和指标的上传同意。") {
            try await persistConfiguration()
            guard let settingsStore else { throw initializationError() }
            let origin = try EndpointResolver.destinationOrigin(from: settings.endpoint)
            let receipt = ConsentReceipt(
                destinationOrigin: origin,
                selectedMetricKeys: selectedMetrics.map(\.rawValue),
                consentedAt: Date()
            )
            try await settingsStore.saveConsent(receipt)
            consentValid = true
        }
    }

    func requestAuthorization(registerBackgroundObservers: Bool = true) async {
        await runUserAction(
            success: "HealthKit 权限申请已完成。系统不会透露哪些读取权限被拒绝。"
        ) {
            guard let authorizationService, let settingsStore else {
                throw initializationError()
            }
            let previous = try await settingsStore.loadSettings()
            if previous.metrics != settings.metrics {
                await backgroundRegistrar?.registerObservers(for: [])
            }
            let outcome = try await authorizationService.requestReadAuthorization(
                for: selectedMetrics
            )
            settings.authorizationRequested = true
            try await settingsStore.saveSettings(settings)
            try await refreshConsent()
            authorizationMessage =
                "已申请 \(outcome.requestedMetricKeys.count) 种受支持的数据类型。"
                + "系统设计上无法区分没有数据与读取权限被拒绝。"
            if !outcome.unavailableMetricKeys.isEmpty {
                authorizationMessage +=
                    " 不可用类型：\(outcome.unavailableMetricKeys.map(metricDisplayName).joined(separator: "、"))。"
            }
            if registerBackgroundObservers {
                await backgroundRegistrar?.registerObservers(for: selectedMetrics)
            }
        }
    }

    func syncNow() async {
        await runUserAction(success: nil) {
            try await persistConfiguration()
            try ensureAuthorizationWasRequested()
            try await ensureCurrentConsent(requiredMetricKeys: selectedMetrics.map(\.rawValue))
            guard let coordinator else { throw initializationError() }
            let result = try await coordinator.syncNow()
            try await refreshStatus()
            if result.failures.isEmpty {
                if result.metricKeysWithMoreChanges.isEmpty {
                    actionMessage =
                        "增量数据已加入队列，并已尝试上传待处理批次。"
                } else {
                    actionMessage =
                        "一个有限分页已同步。HealthKit 中仍有后续变化；"
                        + "请再次点击“立即同步”继续安全处理。"
                }
            } else {
                actionMessage =
                    "同步已完成，以下数据类型发生独立失败："
                    + result.failures.keys.sorted().map(metricDisplayName).joined(separator: "、")
            }
        }
    }

    func retryQueue() async {
        await runUserAction(success: "已重试本地上传队列。") {
            try await persistConfiguration()
            try await ensureCurrentConsent(requiredMetricKeys: selectedMetrics.map(\.rawValue))
            guard let coordinator else { throw initializationError() }
            try await coordinator.uploadPending(includePermanent: true)
            try await refreshStatus()
        }
    }

    func resetAnchors() async {
        await runUserAction(success: "增量同步锚点已重置。") {
            guard let coordinator else { throw initializationError() }
            await backgroundRegistrar?.registerObservers(for: [])
            try await coordinator.resetAnchors()
            if settings.authorizationRequested {
                await backgroundRegistrar?.registerObservers(for: selectedMetrics)
            }
        }
    }

    func clearQueue() async {
        await runUserAction(success: "本地上传队列已清空。") {
            guard let coordinator else { throw initializationError() }
            try await coordinator.clearQueue()
            try await refreshStatus()
        }
    }

    func startBackfill() {
        runBackfill(createNew: true)
    }

    func resumeBackfill() {
        runBackfill(createNew: false)
    }

    func cancelBackfill() {
        backfillTask?.cancel()
        if let coordinator {
            Task { await coordinator.cancelBackfill() }
        }
    }

    func prepareDiagnostics() async -> Bool {
        guard let coordinator else {
            alertMessage = UserFacingError.message(for: initializationError())
            return false
        }
        do {
            diagnosticsText = try await coordinator.redactedDiagnostics()
            return true
        } catch {
            alertMessage = UserFacingError.message(for: error)
            return false
        }
    }

    func appDidBecomeActive() {
#if DEBUG
        guard !PAIOSDebugLaunch.shouldIsolateAutomaticHealthSync else { return }
#endif
        backgroundRegistrar?.scheduleAppRefresh()
        Task {
            await attemptAutomaticSync()
            do {
                try await refreshStatus()
            } catch {
                alertMessage = UserFacingError.message(for: error)
            }
        }
    }

    func protectedDataDidBecomeAvailable() {
#if DEBUG
        guard !PAIOSDebugLaunch.shouldIsolateAutomaticHealthSync else { return }
#endif
        Task { await attemptAutomaticSync() }
    }

    func refresh() async {
        do {
            try await refreshStatus()
        } catch {
            alertMessage = UserFacingError.message(for: error)
        }
    }

    private func loadInitialState() async {
        do {
            guard
                let settingsStore,
                let credentialStore,
                let coordinator
            else {
                throw initializationError()
            }
            settings = try await settingsStore.loadSettings()
            apiToken = try credentialStore.apiToken() ?? ""
            do {
                if let cache = try await backendDataStatusStore?.load(),
                   let origin = try? EndpointResolver.destinationOrigin(from: settings.endpoint),
                   cache.destinationOrigin.caseInsensitiveCompare(origin) == .orderedSame {
                    backendDataStatusCache = cache
                }
            } catch {
                backendDataStatusMessage = "无法读取已保存的服务器数据状态。"
            }
            try await refreshConsent()
            status = try await coordinator.currentStatus()
            hasResumableBackfill = try await coordinator.backfillCheckpoint() != nil
#if DEBUG
            let isIsolatedHealthFlow =
                PAIOSDebugLaunch.shouldIsolateAutomaticHealthSync
#else
            let isIsolatedHealthFlow = false
#endif
#if DEBUG
            if isIsolatedHealthFlow {
                if PAIOSDebugLaunch.shouldRunPhysicalHealthAuthorization {
                    await requestAuthorization(registerBackgroundObservers: false)
                }
                if PAIOSDebugLaunch.shouldRunPhysicalHealthProbe {
                    await runPhysicalHealthProbe()
                }
                if PAIOSDebugLaunch.shouldRunPhysicalHealthUploadSmoke {
                    await runPhysicalHealthUploadSmoke()
                }
                if PAIOSDebugLaunch.shouldRunPhysicalHealthUploadRetry {
                    await runPhysicalHealthUploadRetry()
                }
                return
            }
#endif
            if settings.authorizationRequested && !isIsolatedHealthFlow {
                await backgroundRegistrar?.registerObservers(for: selectedMetrics)
            }
            if !isIsolatedHealthFlow {
                backgroundRegistrar?.scheduleAppRefresh()
                await attemptAutomaticSync()
            }
            try await refreshStatus()
        } catch {
            alertMessage = UserFacingError.message(for: error)
        }
    }

    private func persistConfiguration() async throws {
        _ = try EndpointResolver.ingestURL(from: settings.endpoint)
        guard !apiToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ExporterError.missingToken
        }
        guard let settingsStore, let credentialStore else {
            throw initializationError()
        }
        let previous = try await settingsStore.loadSettings()
        let origin = try EndpointResolver.destinationOrigin(from: settings.endpoint)
        if backendDataStatusCache?.destinationOrigin.caseInsensitiveCompare(origin)
            != .orderedSame {
            backendDataStatusCache = nil
            backendDataStatusMessage = nil
        }
        if previous.metrics != settings.metrics {
            settings.authorizationRequested = false
            await backgroundRegistrar?.registerObservers(for: [])
        }
        try await settingsStore.saveSettings(settings)
        try credentialStore.setAPIToken(apiToken)
        try await refreshConsent()
    }

    private func refreshConsent() async throws {
        guard let settingsStore else { throw initializationError() }
        guard
            let origin = try? EndpointResolver.destinationOrigin(from: settings.endpoint),
            let receipt = try await settingsStore.loadConsent()
        else {
            consentValid = false
            return
        }
        consentValid = receipt.matches(
            origin: origin,
            metricKeys: selectedMetrics.map(\.rawValue)
        )
    }

    private func runBackfill(createNew: Bool) {
        guard backfillTask == nil else { return }
        guard let coordinator else {
            alertMessage = UserFacingError.message(for: initializationError())
            return
        }

        isBackfillRunning = true
        actionMessage = nil
        backfillTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await persistConfiguration()
                try ensureAuthorizationWasRequested()
                let requiredMetricKeys: [String]
                if createNew {
                    requiredMetricKeys = selectedMetrics.map(\.rawValue)
                } else {
                    requiredMetricKeys =
                        try await coordinator.backfillCheckpoint()?.metricKeys
                        ?? selectedMetrics.map(\.rawValue)
                }
                try await ensureCurrentConsent(requiredMetricKeys: requiredMetricKeys)
                if createNew {
                    try await coordinator.startBackfill(
                        start: backfillStart,
                        end: backfillEnd,
                        metrics: selectedMetrics
                    )
                }
                try await coordinator.resumeBackfill { [weak self] progress in
                    Task { @MainActor in
                        self?.backfillProgress = progress
                    }
                }
                hasResumableBackfill = false
                backfillProgress = nil
                actionMessage = "历史数据批次已加入队列，正在尝试上传待处理批次。"
                do {
                    try await coordinator.uploadPending(includePermanent: false)
                } catch {
                    try await coordinator.noteOperationalError(error)
                }
                try await refreshStatus()
            } catch ExporterError.cancelled {
                hasResumableBackfill = true
                actionMessage = "历史回填已安全暂停，可以继续。"
            } catch is CancellationError {
                hasResumableBackfill = true
                actionMessage = "历史回填已安全暂停，可以继续。"
            } catch {
                hasResumableBackfill =
                    (try? await coordinator.backfillCheckpoint()) != nil
                alertMessage = UserFacingError.message(for: error)
            }
            isBackfillRunning = false
            backfillTask = nil
        }
    }

    private func attemptAutomaticSync() async {
        guard !automaticSyncInProgress else { return }
        automaticSyncInProgress = true
        defer { automaticSyncInProgress = false }
        guard let coordinator, let settingsStore, let credentialStore else { return }
        do {
            let storedSettings = try await settingsStore.loadSettings()
            let origin = try? EndpointResolver.destinationOrigin(
                from: storedSettings.endpoint
            )
            let selectedKeys = HealthTypeRegistry.selectedMetrics(
                storedSettings.metrics
            ).map(\.rawValue)
            let receipt = try await settingsStore.loadConsent()
            let hasToken = try credentialStore.apiToken()?.isEmpty == false
            if storedSettings.authorizationRequested,
               let origin,
               receipt?.matches(origin: origin, metricKeys: selectedKeys) == true,
               hasToken {
                _ = try await coordinator.syncNow()
            } else {
                try await coordinator.uploadPending(includePermanent: false)
            }
        } catch {
            do {
                try await coordinator.noteOperationalError(error)
            } catch {
                alertMessage = UserFacingError.message(for: error)
            }
        }
    }

    private func refreshStatus() async throws {
        guard let coordinator else { throw initializationError() }
        status = try await coordinator.currentStatus()
        hasResumableBackfill = try await coordinator.backfillCheckpoint() != nil
        await refreshBackendDataStatus()
    }

    private func refreshBackendDataStatus() async {
        guard let backendDataStatusClient, let backendDataStatusStore else {
            backendDataStatusMessage = "本次安装无法使用服务器数据状态功能。"
            return
        }
        guard
            let endpoint = try? EndpointResolver.ingestURL(from: settings.endpoint),
            let origin = try? EndpointResolver.destinationOrigin(from: settings.endpoint),
            !apiToken.isEmpty
        else {
            backendDataStatusMessage = nil
            return
        }

        do {
            let snapshot = try await backendDataStatusClient.fetchStatus(
                at: endpoint,
                token: apiToken
            )
            let cache = BackendDataStatusCache(
                destinationOrigin: origin,
                retrievedAt: Date(),
                status: snapshot
            )
            backendDataStatusCache = cache
            backendDataStatusMessage = nil
            do {
                try await backendDataStatusStore.save(cache)
            } catch {
                backendDataStatusMessage =
                    "状态已刷新，但无法保存用于离线显示。"
            }
        } catch is CancellationError {
            return
        } catch {
            backendDataStatusMessage =
                backendDataStatusCache == nil
                ? "当前无法获取服务器数据状态。"
                : "刷新失败，正在显示最近一次已知的服务器数据状态。"
        }
    }

#if DEBUG
    private struct PhysicalHealthProbeMetric: Codable {
        let key: String
        let displayName: String
        let result: String
        let recordCount: Int
        let rawChangeCount: Int
        let earliestRecordAt: Date?
        let latestRecordAt: Date?
        let reachedPageLimit: Bool
        let errorType: String?
    }

    private struct PhysicalHealthProbeReport: Codable {
        let schemaVersion: Int
        let generatedAt: Date
        let lookbackDays: Int
        let pageLimit: Int
        let metrics: [PhysicalHealthProbeMetric]
    }

    private func runPhysicalHealthProbe() async {
        guard settings.authorizationRequested else {
            alertMessage = "请先完成 HealthKit 读取授权。"
            return
        }
        guard let healthQueryService else {
            alertMessage = UserFacingError.message(for: initializationError())
            return
        }

        let lookbackDays = 30
        let pageLimit = 512
        let end = Date()
        guard let start = Calendar.current.date(
            byAdding: .day,
            value: -lookbackDays,
            to: end
        ) else {
            alertMessage = "无法计算真机健康探针的时间范围。"
            return
        }

        var metricReports: [PhysicalHealthProbeMetric] = []
        for metric in selectedMetrics where metric.sampleType != nil {
            do {
                let page = try await healthQueryService.backfillPage(
                    for: metric,
                    start: start,
                    end: end,
                    cursor: nil,
                    limit: pageLimit
                )
                metricReports.append(
                    PhysicalHealthProbeMetric(
                        key: metric.rawValue,
                        displayName: metric.displayName,
                        result: page.records.isEmpty
                            ? (page.rawChangeCount > 0
                                ? "readable-but-filtered"
                                : "empty-or-denied")
                            : "readable",
                        recordCount: page.records.count,
                        rawChangeCount: page.rawChangeCount,
                        earliestRecordAt: page.records.map(\.start).min(),
                        latestRecordAt: page.records.map(\.end).max(),
                        reachedPageLimit: page.rawChangeCount >= pageLimit,
                        errorType: nil
                    )
                )
            } catch {
                metricReports.append(
                    PhysicalHealthProbeMetric(
                        key: metric.rawValue,
                        displayName: metric.displayName,
                        result: "query-error",
                        recordCount: 0,
                        rawChangeCount: 0,
                        earliestRecordAt: nil,
                        latestRecordAt: nil,
                        reachedPageLimit: false,
                        errorType: String(describing: type(of: error))
                    )
                )
            }
        }

        do {
            let report = PhysicalHealthProbeReport(
                schemaVersion: 1,
                generatedAt: end,
                lookbackDays: lookbackDays,
                pageLimit: pageLimit,
                metrics: metricReports
            )
            let root = try StoragePaths.productionRoot()
            let destination = root.appendingPathComponent(
                "physical-health-probe.json"
            )
            try AtomicFile.write(
                try JSONEncoder.exporter.encode(report),
                to: destination
            )
            let readableCount = metricReports.filter {
                $0.result == "readable"
            }.count
            actionMessage =
                "真机健康探针已完成：\(readableCount)/\(metricReports.count) 类指标读取到近 30 天样本。"
        } catch {
            alertMessage = UserFacingError.message(for: error)
        }
    }

    private func runPhysicalHealthUploadSmoke() async {
        guard settings.authorizationRequested else {
            alertMessage = "请先完成 HealthKit 读取授权。"
            return
        }
        guard
            let endpoint = PAIOSDebugLaunch.ingestEndpoint,
            let token = PAIOSDebugLaunch.ingestToken,
            !endpoint.isEmpty,
            !token.isEmpty,
            let coordinator,
            let settingsStore
        else {
            alertMessage = "真机上传测试缺少后端地址或临时令牌。"
            return
        }

        await runUserAction(success: nil) {
            settings.endpoint = endpoint
            apiToken = token
            try await persistConfiguration()

            let origin = try EndpointResolver.destinationOrigin(from: endpoint)
            let metricKeys = selectedMetrics.map(\.rawValue)
            try await settingsStore.saveConsent(
                ConsentReceipt(
                    destinationOrigin: origin,
                    selectedMetricKeys: metricKeys,
                    consentedAt: Date()
                )
            )
            consentValid = true

            let end = Date()
            guard let start = Calendar.current.date(
                byAdding: .day,
                value: -7,
                to: end
            ) else {
                throw MessageError(message: "无法计算真机上传测试的时间范围。")
            }
            try await coordinator.startBackfill(
                start: start,
                end: end,
                metrics: selectedMetrics
            )
            try await coordinator.resumeBackfill { [weak self] progress in
                Task { @MainActor in
                    self?.backfillProgress = progress
                }
            }
            try await coordinator.uploadPending(includePermanent: false)
            backfillProgress = nil
            try await refreshStatus()
            actionMessage = status.pendingOutboxBatches == 0
                ? "近 7 天真机健康数据已上传到临时私有后端。"
                : "真机健康数据已排队，仍有待上传批次。"
        }
    }

    private func runPhysicalHealthUploadRetry() async {
        guard
            let endpoint = PAIOSDebugLaunch.ingestEndpoint,
            let token = PAIOSDebugLaunch.ingestToken,
            !endpoint.isEmpty,
            !token.isEmpty,
            let coordinator,
            let settingsStore
        else {
            alertMessage = "真机队列重试缺少后端地址或临时令牌。"
            return
        }

        await runUserAction(success: nil) {
            settings.endpoint = endpoint
            apiToken = token
            try await persistConfiguration()

            let origin = try EndpointResolver.destinationOrigin(from: endpoint)
            try await settingsStore.saveConsent(
                ConsentReceipt(
                    destinationOrigin: origin,
                    selectedMetricKeys: selectedMetrics.map(\.rawValue),
                    consentedAt: Date()
                )
            )
            consentValid = true

            let maximumDrainPasses = 20
            var previousPending = try await coordinator.currentStatus()
                .pendingOutboxBatches
            let initialPending = previousPending

            for pass in 0..<maximumDrainPasses where previousPending > 0 {
                try await coordinator.uploadPending(includePermanent: pass == 0)
                let current = try await coordinator.currentStatus()
                guard current.backendReachable == true else { break }
                guard current.pendingOutboxBatches < previousPending else { break }
                previousPending = current.pendingOutboxBatches
                await Task.yield()
            }

            status = try await coordinator.currentStatus()
            hasResumableBackfill = try await coordinator.backfillCheckpoint() != nil
            if status.pendingOutboxBatches == 0 {
                actionMessage = "真机本地队列已全部上传到临时私有后端。"
            } else if status.backendReachable != true {
                actionMessage = "后端仍不可达；本地队列已保留，未丢失数据。"
            } else if status.pendingOutboxBatches < initialPending {
                actionMessage =
                    "已上传部分真机队列；剩余批次已保留，可继续重试。"
            } else {
                actionMessage = "本次没有可上传批次；本地队列保持不变。"
            }
        }
    }
#endif

    private func ensureCurrentConsent(requiredMetricKeys: [String]) async throws {
        guard let settingsStore else { throw initializationError() }
        let origin = try EndpointResolver.destinationOrigin(from: settings.endpoint)
        guard let receipt = try await settingsStore.loadConsent(),
              receipt.matches(
                  origin: origin,
                  metricKeys: selectedMetrics.map(\.rawValue)
              ),
              Set(requiredMetricKeys).isSubset(of: Set(receipt.selectedMetricKeys)) else {
            consentValid = false
            throw ExporterError.consentRequired
        }
        consentValid = true
    }

    private func ensureAuthorizationWasRequested() throws {
        guard settings.authorizationRequested else {
            throw MessageError(
                message: "同步健康数据前，请先申请 HealthKit 读取权限。"
            )
        }
    }

    private func runUserAction(
        success: String?,
        operation: () async throws -> Void
    ) async {
        guard !isBusy else { return }
        isBusy = true
        actionMessage = nil
        defer { isBusy = false }
        do {
            try await operation()
            if let success {
                actionMessage = success
            }
        } catch {
            alertMessage = UserFacingError.message(for: error)
        }
    }

    private func initializationError() -> MessageError {
        MessageError(message: "无法初始化健康数据导出服务。")
    }

    private func metricDisplayName(_ key: String) -> String {
        if key == "upload" { return "上传" }
        return HealthTypeRegistry.metric(forKey: key)?.displayName ?? "未知数据类型"
    }
}
