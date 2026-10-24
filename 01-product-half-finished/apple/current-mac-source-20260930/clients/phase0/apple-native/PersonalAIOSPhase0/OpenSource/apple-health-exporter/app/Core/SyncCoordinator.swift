import Foundation

actor SyncCoordinator {
    private let queryService: HealthQuerying
    private let anchorStore: AnchorStoring
    private let outboxStore: OutboxStoring
    private let payloadEncoder: PayloadEncoding
    private let backendAvailabilityChecker: BackendAvailabilityChecking
    private let uploader: Uploading
    private let settingsStore: SettingsStoring
    private let credentialStore: CredentialStoring
    private let backfillStore: BackfillStateStoring
    private let statusStore: StatusStoring
    private let retryPolicy: RetryPolicy
    private let calendar: Calendar
    private let now: @Sendable () -> Date
    private let jitter: @Sendable () -> Double
    private let queryLimit: Int
    private let maximumIncrementalPagesPerMetric: Int
    private let maximumUploadsPerRun: Int

    private var lockedMetricKeys: Set<String> = []
    private var metricWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var uploadLocked = false
    private var uploadWaiters: [CheckedContinuation<Void, Never>] = []
    private var backfillCancellationRequested = false

    init(
        queryService: HealthQuerying,
        anchorStore: AnchorStoring,
        outboxStore: OutboxStoring,
        payloadEncoder: PayloadEncoding,
        backendAvailabilityChecker: BackendAvailabilityChecking,
        uploader: Uploading,
        settingsStore: SettingsStoring,
        credentialStore: CredentialStoring,
        backfillStore: BackfillStateStoring,
        statusStore: StatusStoring,
        retryPolicy: RetryPolicy = RetryPolicy(),
        calendar: Calendar = .current,
        queryLimit: Int = 100,
        maximumIncrementalPagesPerMetric: Int = 1,
        maximumUploadsPerRun: Int = 10,
        now: @escaping @Sendable () -> Date = { Date() },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }
    ) {
        self.queryService = queryService
        self.anchorStore = anchorStore
        self.outboxStore = outboxStore
        self.payloadEncoder = payloadEncoder
        self.backendAvailabilityChecker = backendAvailabilityChecker
        self.uploader = uploader
        self.settingsStore = settingsStore
        self.credentialStore = credentialStore
        self.backfillStore = backfillStore
        self.statusStore = statusStore
        self.retryPolicy = retryPolicy
        self.calendar = calendar
        self.queryLimit = queryLimit
        self.maximumIncrementalPagesPerMetric = max(
            1,
            maximumIncrementalPagesPerMetric
        )
        self.maximumUploadsPerRun = max(1, maximumUploadsPerRun)
        self.now = now
        self.jitter = jitter
    }

    func syncNow() async throws -> SyncRunResult {
        try await mutateStatus {
            $0.lastSyncAttempt = now()
            $0.lastRedactedError = nil
        }

        let settings = try await settingsStore.loadSettings()
        let selected = HealthTypeRegistry.selectedMetrics(settings.metrics)
        var result = await queueIncremental(metrics: selected)

        do {
            try await uploadPending(includePermanent: false)
        } catch {
            result.failures["upload"] = await redactedMessage(for: error)
        }
        try await refreshPendingCount()

        if !result.failures.isEmpty {
            let combined = result.failures
                .sorted { $0.key < $1.key }
                .map { "\(metricDisplayName($0.key))：\($0.value)" }
                .joined(separator: "; ")
            try await mutateStatus { $0.lastRedactedError = String(combined.prefix(512)) }
        }
        return result
    }

    func queueIncremental(metrics: [HealthMetric]) async -> SyncRunResult {
        var result = SyncRunResult()
        for metric in metrics {
            guard metric.sampleType != nil else {
                result.failures[metric.rawValue] =
                    ExporterError.unsupportedType(metric.displayName).localizedDescription
                continue
            }
            do {
                let hasMoreChanges = try await queueIncremental(metric: metric)
                result.completedMetricKeys.append(metric.rawValue)
                if hasMoreChanges {
                    result.metricKeysWithMoreChanges.append(metric.rawValue)
                }
            } catch {
                result.failures[metric.rawValue] = await redactedMessage(for: error)
            }
        }
        return result
    }

    @discardableResult
    func queueIncremental(metric: HealthMetric) async throws -> Bool {
        await acquireMetricLock(metric.rawValue)
        defer { releaseMetricLock(metric.rawValue) }

        var anchorState = try await anchorStore.state(for: metric.rawValue)
        if anchorState == nil {
            let predicateStart = Date(
                timeIntervalSince1970: floor(now().timeIntervalSince1970)
            )
            let page = try await queryService.bootstrapPage(
                for: metric,
                after: predicateStart
            )
            let batchSeed = [
                "schema=1",
                "mode=incremental",
                "bootstrap=true",
                "metric=\(metric.rawValue)",
                "predicateStart=\(predicateStart.timeIntervalSince1970)",
                "new=\(BatchIDFactory.anchorFingerprint(page.newAnchor))"
            ].joined(separator: "|")
            try await enqueue(
                page: page,
                mode: .incremental,
                seed: batchSeed,
                metricKey: metric.rawValue
            )
            try await anchorStore.save(
                QueryAnchorState(
                    anchor: page.newAnchor,
                    predicateStart: predicateStart
                ),
                for: metric.rawValue
            )
            try await refreshPendingCount()
            return false
        }

        for _ in 0..<maximumIncrementalPagesPerMetric {
            try Task.checkCancellation()
            guard let currentState = anchorState else {
                throw ExporterError.invalidAnchor
            }
            let page = try await queryService.incrementalPage(
                for: metric,
                anchor: currentState.anchor,
                startDate: currentState.predicateStart,
                limit: queryLimit
            )

            if page.rawChangeCount == 0 {
                return false
            }

            let batchSeed = [
                "schema=1",
                "mode=incremental",
                "metric=\(metric.rawValue)",
                "predicateStart=\(currentState.predicateStart.timeIntervalSince1970)",
                "old=\(BatchIDFactory.anchorFingerprint(currentState.anchor))",
                "new=\(BatchIDFactory.anchorFingerprint(page.newAnchor))"
            ].joined(separator: "|")
            try await enqueue(
                page: page,
                mode: .incremental,
                seed: batchSeed,
                metricKey: metric.rawValue
            )
            if metric == .workout, page.rawChangeCount < queryLimit {
                try await enqueueWorkoutMeasurements(
                    for: page.records,
                    parentSeed: batchSeed
                )
            }

            // The anchor is deliberately persisted only after the exact payload is durable.
            let newState = QueryAnchorState(
                anchor: page.newAnchor,
                predicateStart: currentState.predicateStart
            )
            try await anchorStore.save(newState, for: metric.rawValue)
            anchorState = newState
            if page.rawChangeCount < queryLimit {
                try await refreshPendingCount()
                return false
            }
            await Task.yield()
        }
        try await refreshPendingCount()
        return true
    }

    func recordObserverEvent() async throws {
        try await mutateStatus { $0.lastObserverEvent = now() }
    }

    func uploadPending(includePermanent: Bool) async throws {
        await acquireUploadLock()
        defer { releaseUploadLock() }
        try Task.checkCancellation()

        guard try await outboxStore.count() > 0 else {
            try await refreshPendingCount()
            return
        }
        let attemptDate = now()
        try await mutateStatus { $0.lastSyncAttempt = attemptDate }
        let settings = try await settingsStore.loadSettings()
        let endpoint = try EndpointResolver.ingestURL(from: settings.endpoint)
        let origin = try EndpointResolver.destinationOrigin(from: settings.endpoint)
        let selectedKeys = HealthTypeRegistry.selectedMetrics(settings.metrics).map(\.rawValue)
        guard let consent = try await settingsStore.loadConsent(),
              consent.matches(origin: origin, metricKeys: selectedKeys) else {
            throw ExporterError.consentRequired
        }
        guard let token = try credentialStore.apiToken(), !token.isEmpty else {
            throw ExporterError.missingToken
        }

        let pending = try await outboxStore.pending(
            now: attemptDate,
            includePermanent: includePermanent,
            limit: maximumUploadsPerRun
        )
        guard !pending.isEmpty else {
            try await refreshPendingCount()
            return
        }

        let backendAvailable = try await backendAvailabilityChecker.isBackendAvailable(
            at: endpoint
        )
        try await mutateStatus {
            $0.lastBackendReachabilityCheck = attemptDate
            $0.backendReachable = backendAvailable
        }
        guard backendAvailable else {
            try await refreshPendingCount()
            return
        }

        for item in pending {
            try Task.checkCancellation()
            guard Set(item.requiredMetricKeys).isSubset(
                of: Set(consent.selectedMetricKeys)
            ) else {
                let message =
                    "上传同意未覆盖此队列批次中的全部指标。"
                try await outboxStore.markPermanent(
                    batchId: item.batchId,
                    error: message
                )
                try await mutateStatus { $0.lastRedactedError = message }
                continue
            }
            let disposition = await uploader.upload(
                item,
                endpoint: endpoint,
                token: token,
                now: attemptDate
            )
            switch disposition {
            case .accepted:
                try await outboxStore.remove(batchId: item.batchId)
                try await mutateStatus {
                    $0.lastSuccessfulUpload = now()
                    $0.lastRedactedError = nil
                }
            case .retryable(let message, let retryAfter):
                let redacted = Redactor.redact(message, token: token, endpoint: endpoint)
                let delay = retryPolicy.delay(
                    afterAttempt: item.attemptCount,
                    retryAfter: retryAfter,
                    jitterUnit: jitter()
                )
                try await outboxStore.markRetry(
                    batchId: item.batchId,
                    nextAttemptAt: attemptDate.addingTimeInterval(delay),
                    error: redacted
                )
                try await mutateStatus { $0.lastRedactedError = redacted }
            case .permanent(let message):
                let redacted = Redactor.redact(message, token: token, endpoint: endpoint)
                try await outboxStore.markPermanent(batchId: item.batchId, error: redacted)
                try await mutateStatus { $0.lastRedactedError = redacted }
            }
        }
        try await refreshPendingCount()
    }

    func testConnection() async throws {
        let settings = try await settingsStore.loadSettings()
        let endpoint = try EndpointResolver.ingestURL(from: settings.endpoint)
        guard let token = try credentialStore.apiToken(), !token.isEmpty else {
            throw ExporterError.missingToken
        }
        let batchID = UUID()
        let createdAt = now()
        let batch = ExportBatch(
            batchId: batchID,
            deviceId: UUID(),
            createdAt: createdAt,
            timezone: TimeZone.current.identifier,
            mode: .incremental,
            records: [],
            deletedRecords: []
        )
        let item = OutboxItem(
            batchId: batchID,
            payload: try payloadEncoder.encode(batch),
            requiredMetricKeys: [],
            createdAt: createdAt,
            attemptCount: 0,
            nextAttemptAt: createdAt,
            permanentFailure: false,
            lastError: nil
        )
        switch await uploader.upload(item, endpoint: endpoint, token: token, now: createdAt) {
        case .accepted:
            return
        case .retryable(let message, _), .permanent(let message):
            throw MessageError(message: Redactor.redact(message, token: token, endpoint: endpoint))
        }
    }

    func startBackfill(
        start: Date,
        end: Date,
        metrics: [HealthMetric]
    ) async throws {
        guard start < end else {
            throw MessageError(message: "历史回填的开始时间必须早于结束时间。")
        }
        let availableKeys = metrics.filter { $0.sampleType != nil }.map(\.rawValue)
        let checkpoint = BackfillCheckpoint(
            runId: UUID(),
            start: start,
            end: end,
            metricKeys: availableKeys,
            metricIndex: 0,
            chunkStart: start,
            queryCursor: nil,
            queuedBatches: 0,
            processedRecords: 0
        )
        try await backfillStore.save(checkpoint)
        backfillCancellationRequested = false
    }

    func resumeBackfill(
        progress: (@Sendable (BackfillProgress) -> Void)? = nil
    ) async throws {
        guard var checkpoint = try await backfillStore.load() else {
            throw MessageError(message: "没有可以继续的历史回填任务。")
        }
        backfillCancellationRequested = false

        while checkpoint.metricIndex < checkpoint.metricKeys.count {
            if backfillCancellationRequested || Task.isCancelled {
                throw ExporterError.cancelled
            }
            guard let metric = HealthTypeRegistry.metric(
                forKey: checkpoint.metricKeys[checkpoint.metricIndex]
            ), metric.sampleType != nil else {
                checkpoint.metricIndex += 1
                checkpoint.chunkStart = checkpoint.start
                checkpoint.queryCursor = nil
                try await backfillStore.save(checkpoint)
                continue
            }
            if checkpoint.chunkStart >= checkpoint.end {
                checkpoint.metricIndex += 1
                checkpoint.chunkStart = checkpoint.start
                checkpoint.queryCursor = nil
                try await backfillStore.save(checkpoint)
                continue
            }

            let chunkEnd = min(
                BackfillChunker.nextBoundary(
                    after: checkpoint.chunkStart,
                    calendar: calendar
                ),
                checkpoint.end
            )
            progress?(
                BackfillProgress(
                    currentMetric: checkpoint.metricIndex + 1,
                    totalMetrics: checkpoint.metricKeys.count,
                    chunkStart: checkpoint.chunkStart,
                    end: checkpoint.end,
                    queuedBatches: checkpoint.queuedBatches,
                    processedRecords: checkpoint.processedRecords
                )
            )

            let page = try await queryService.backfillPage(
                for: metric,
                start: checkpoint.chunkStart,
                end: chunkEnd,
                cursor: checkpoint.queryCursor,
                limit: queryLimit
            )
            if !page.records.isEmpty || !page.deletedRecords.isEmpty {
                let seed = [
                    "schema=1",
                    "mode=backfill",
                    "run=\(checkpoint.runId.uuidString)",
                    "metric=\(metric.rawValue)",
                    "chunk=\(checkpoint.chunkStart.timeIntervalSince1970)",
                    "old=\(BatchIDFactory.anchorFingerprint(checkpoint.queryCursor))",
                    "new=\(BatchIDFactory.anchorFingerprint(page.newAnchor))"
                ].joined(separator: "|")
                _ = try await enqueue(
                    page: page,
                    mode: .backfill,
                    seed: seed,
                    metricKey: metric.rawValue
                )
                checkpoint.queuedBatches += 1
                checkpoint.processedRecords +=
                    page.records.count + page.deletedRecords.count
            }

            if page.rawChangeCount >= queryLimit {
                checkpoint.queryCursor = page.newAnchor
            } else {
                checkpoint.queryCursor = nil
                checkpoint.chunkStart = chunkEnd
            }
            // This cursor is advanced only after any non-empty page is durable in the outbox.
            try await backfillStore.save(checkpoint)
            if !page.records.isEmpty || !page.deletedRecords.isEmpty {
                try await uploadPending(includePermanent: false)
            }
        }

        try await backfillStore.clear()
        try await refreshPendingCount()
    }

    func cancelBackfill() {
        backfillCancellationRequested = true
    }

    func backfillCheckpoint() async throws -> BackfillCheckpoint? {
        try await backfillStore.load()
    }

    func resetAnchors() async throws {
        let lockedKeys = await acquireAllMetricLocks()
        defer { releaseMetricLocks(lockedKeys) }
        try await anchorStore.resetAll()
    }

    func clearQueue() async throws {
        let lockedKeys = await acquireAllMetricLocks()
        defer { releaseMetricLocks(lockedKeys) }
        try await outboxStore.clear()
        try await refreshPendingCount()
    }

    func currentStatus() async throws -> OperationalStatus {
        var status = try await statusStore.load()
        status.pendingOutboxBatches = try await outboxStore.count()
        return status
    }

    func setBackgroundRegistration(_ value: String) async throws {
        try await mutateStatus { $0.backgroundRegistration = value }
    }

    func noteOperationalError(_ error: Error) async throws {
        let message = await redactedMessage(for: error)
        try await mutateStatus { $0.lastRedactedError = message }
    }

    func redactedDiagnostics() async throws -> String {
        let settings = try await settingsStore.loadSettings()
        let status = try await currentStatus()
        let origin = (try? EndpointResolver.destinationOrigin(from: settings.endpoint))
            ?? "<未配置>"
        let selected = HealthTypeRegistry.selectedMetrics(settings.metrics).map(\.rawValue).sorted()
        let unavailable = HealthTypeRegistry.unavailableMetrics(settings.metrics)
            .map(\.rawValue)
            .sorted()
        let anchorKeys = try await anchorStore.storedMetricKeys()
        let hasBackfill = try await backfillStore.load() != nil

        return [
            "PAIOS HealthKit 导出器脱敏诊断",
            "生成时间：\(ISO8601.utc.string(from: now()))",
            "操作系统：\(ProcessInfo.processInfo.operatingSystemVersionString)",
            "目标服务器：\(origin)",
            "已选指标：\(selected.joined(separator: "、"))",
            "不可用指标：\(unavailable.joined(separator: "、"))",
            "已保存锚点类型：\(anchorKeys.sorted().joined(separator: "、"))",
            "待上传批次数：\(status.pendingOutboxBatches)",
            "存在可继续的历史回填：\(yesNo(hasBackfill))",
            "最近观察事件：\(dateDescription(status.lastObserverEvent))",
            "最近同步尝试：\(dateDescription(status.lastSyncAttempt))",
            "最近成功上传：\(dateDescription(status.lastSuccessfulUpload))",
            "最近服务器连通性检查：\(dateDescription(status.lastBackendReachabilityCheck))",
            "服务器可连接：\(status.backendReachable.map(yesNo) ?? "未知")",
            "最近错误：\(status.lastRedactedError ?? "无")",
            "后台注册：\(status.backgroundRegistration)",
            "API 令牌：<已脱敏>",
            "设备标识：<已脱敏>",
            "请求正文与健康数值：<未包含>"
        ].joined(separator: "\n")
    }

    @discardableResult
    private func enqueue(
        page: HealthQueryPage,
        mode: SyncMode,
        seed: String,
        metricKey: String
    ) async throws -> Bool {
        let deviceID = try credentialStore.deviceID()
        let batchID = BatchIDFactory.make(seed: "\(deviceID.uuidString)|\(seed)")
        let createdAt = now()
        let batch = ExportBatch(
            batchId: batchID,
            deviceId: deviceID,
            createdAt: createdAt,
            timezone: TimeZone.current.identifier,
            mode: mode,
            records: page.records,
            deletedRecords: page.deletedRecords
        )
        let payload = try payloadEncoder.encode(batch)
        guard payload.count <= UploadClient.maximumPayloadBytes else {
            throw ExporterError.payloadTooLarge(UploadClient.maximumPayloadBytes)
        }
        return try await outboxStore.enqueue(
            batchId: batchID,
            payload: payload,
            requiredMetricKeys: [metricKey],
            createdAt: createdAt
        )
    }

    private func enqueueWorkoutMeasurements(
        for records: [HealthRecord],
        parentSeed: String
    ) async throws {
        let measurementMetrics: [HealthMetric] = [
            .heartRate,
            .cyclingPower,
            .cyclingCadence,
            .cyclingSpeed
        ]
        for workout in records {
            guard case .workout = workout.value else { continue }
            for metric in measurementMetrics where metric.sampleType != nil {
                var cursor: Data?
                while true {
                    try Task.checkCancellation()
                    let page = try await queryService.backfillPage(
                        for: metric,
                        start: workout.start,
                        end: workout.end,
                        cursor: cursor,
                        limit: queryLimit
                    )
                    if !page.records.isEmpty || !page.deletedRecords.isEmpty {
                        let seed = [
                            parentSeed,
                            "workout=\(workout.sampleId.uuidString)",
                            "measurement=\(metric.rawValue)",
                            "old=\(BatchIDFactory.anchorFingerprint(cursor))",
                            "new=\(BatchIDFactory.anchorFingerprint(page.newAnchor))"
                        ].joined(separator: "|")
                        _ = try await enqueue(
                            page: page,
                            mode: .incremental,
                            seed: seed,
                            metricKey: metric.rawValue
                        )
                    }
                    guard page.rawChangeCount >= queryLimit else { break }
                    cursor = page.newAnchor
                }
            }
        }
    }

    private func acquireMetricLock(_ key: String) async {
        if !lockedMetricKeys.contains(key) {
            lockedMetricKeys.insert(key)
            return
        }
        await withCheckedContinuation { continuation in
            metricWaiters[key, default: []].append(continuation)
        }
    }

    private func acquireUploadLock() async {
        if !uploadLocked {
            uploadLocked = true
            return
        }
        await withCheckedContinuation { continuation in
            uploadWaiters.append(continuation)
        }
    }

    private func releaseUploadLock() {
        guard !uploadWaiters.isEmpty else {
            uploadLocked = false
            return
        }
        uploadWaiters.removeFirst().resume()
    }

    private func acquireAllMetricLocks() async -> [String] {
        let keys = HealthMetric.allCases.map(\.rawValue).sorted()
        for key in keys {
            await acquireMetricLock(key)
        }
        return keys
    }

    private func releaseMetricLocks(_ keys: [String]) {
        for key in keys.reversed() {
            releaseMetricLock(key)
        }
    }

    private func releaseMetricLock(_ key: String) {
        guard var waiters = metricWaiters[key], !waiters.isEmpty else {
            metricWaiters[key] = nil
            lockedMetricKeys.remove(key)
            return
        }
        let next = waiters.removeFirst()
        metricWaiters[key] = waiters.isEmpty ? nil : waiters
        next.resume()
    }

    private func refreshPendingCount() async throws {
        let count = try await outboxStore.count()
        try await mutateStatus { $0.pendingOutboxBatches = count }
    }

    private func mutateStatus(
        _ mutation: (inout OperationalStatus) -> Void
    ) async throws {
        var status = try await statusStore.load()
        mutation(&status)
        try await statusStore.save(status)
    }

    private func redactedMessage(for error: Error) async -> String {
        let settings = try? await settingsStore.loadSettings()
        let endpoint = settings.flatMap { try? EndpointResolver.ingestURL(from: $0.endpoint) }
        let token = try? credentialStore.apiToken()
        return Redactor.redact(
            UserFacingError.message(for: error),
            token: token ?? nil,
            endpoint: endpoint
        )
    }

    private func dateDescription(_ date: Date?) -> String {
        date.map(ISO8601.utc.string) ?? "从未"
    }

    private func yesNo(_ value: Bool) -> String {
        value ? "是" : "否"
    }

    private func metricDisplayName(_ key: String) -> String {
        if key == "upload" { return "上传" }
        return HealthTypeRegistry.metric(forKey: key)?.displayName ?? "未知数据类型"
    }
}

enum BackfillChunker {
    static func nextBoundary(after date: Date, calendar: Calendar) -> Date {
        calendar.date(byAdding: .month, value: 1, to: date)
            ?? date.addingTimeInterval(28 * 24 * 60 * 60)
    }

    static func chunks(start: Date, end: Date, calendar: Calendar) -> [Range<Date>] {
        guard start < end else { return [] }
        var result: [Range<Date>] = []
        var cursor = start
        while cursor < end {
            let next = min(nextBoundary(after: cursor, calendar: calendar), end)
            guard next > cursor else { break }
            result.append(cursor..<next)
            cursor = next
        }
        return result
    }
}
