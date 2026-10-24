import BackgroundTasks
import Foundation
import HealthKit
import OSLog

protocol BackgroundSyncRegistering: Sendable {
    func registerAppRefresh()
    func registerObservers(for metrics: [HealthMetric]) async
    func scheduleAppRefresh()
}

final class BackgroundSyncRegistrar: BackgroundSyncRegistering, @unchecked Sendable {
    static let refreshIdentifier = "ai.paios.personal.phase0.refresh"

    private let healthStore: HKHealthStore
    private let coordinator: SyncCoordinator
    private let placeFlush: (@MainActor @Sendable () async -> Bool)?
    private let logger = Logger(
        subsystem: "ai.paios.personal.phase0",
        category: "background"
    )
    private let lock = NSLock()
    private var observerQueries: [HKObserverQuery] = []

    init(healthStore: HKHealthStore, coordinator: SyncCoordinator, placeFlush: (@MainActor @Sendable () async -> Bool)? = nil) {
        self.healthStore = healthStore
        self.coordinator = coordinator
        self.placeFlush = placeFlush
    }

    func registerAppRefresh() {
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self, let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(refreshTask)
        }
        Task {
            do {
                try await coordinator.setBackgroundRegistration(
                    registered ? "应用后台刷新已注册" : "应用后台刷新注册失败"
                )
            } catch {
                logger.error("Could not persist background registration status.")
            }
        }
    }

    func registerObservers(for metrics: [HealthMetric]) async {
        stopObservers()
        do {
            try await disableAllBackgroundDelivery()
        } catch {
            do {
                try await coordinator.noteOperationalError(error)
            } catch {
                logger.error("Could not persist background reset error.")
            }
        }
        let available = metrics.compactMap { metric -> (HealthMetric, HKSampleType)? in
            guard let type = metric.sampleType else { return nil }
            return (metric, type)
        }
        var enabledCount = 0
        var failures: [String] = []

        for (metric, sampleType) in available {
            let observer = HKObserverQuery(
                sampleType: sampleType,
                predicate: nil
            ) { [weak self] _, completion, error in
                guard let self else {
                    completion()
                    return
                }
                self.handleObserverEvent(
                    metric: metric,
                    initialError: error,
                    completion: completion
                )
            }
            healthStore.execute(observer)
            appendObserver(observer)

            do {
                try await enableBackgroundDelivery(for: sampleType)
                enabledCount += 1
            } catch {
                failures.append(metric.displayName)
                do {
                    try await coordinator.noteOperationalError(error)
                } catch {
                    logger.error("Could not persist observer error status.")
                }
            }
        }

        let state: String
        if available.isEmpty {
            state = "没有受支持的 HealthKit 数据类型"
        } else if failures.isEmpty {
            state = "已为 \(enabledCount) 种数据启用每小时后台传输"
        } else {
            state = "已启用 \(enabledCount)/\(available.count) 种；失败：\(failures.joined(separator: "、"))"
        }
        do {
            try await coordinator.setBackgroundRegistration(state)
        } catch {
            logger.error("Could not persist observer registration status.")
        }
    }

    func scheduleAppRefresh() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date().addingTimeInterval(60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            Task {
                do {
                    try await coordinator.noteOperationalError(error)
                } catch {
                    logger.error("Could not persist app refresh scheduling error.")
                }
            }
        }
    }

    private func handleObserverEvent(
        metric: HealthMetric,
        initialError: Error?,
        completion: @escaping () -> Void
    ) {
        Task {
            do {
                if let initialError {
                    throw initialError
                }
                try await coordinator.recordObserverEvent()
                _ = try await coordinator.queueIncremental(metric: metric)
            } catch {
                completion()
                do {
                    try await coordinator.noteOperationalError(error)
                } catch {
                    logger.error("Could not persist observer processing error.")
                }
                return
            }

            completion()
            do {
                try await coordinator.uploadPending(includePermanent: false)
            } catch {
                do {
                    try await coordinator.noteOperationalError(error)
                } catch {
                    logger.error("Could not persist observer upload error.")
                }
            }
        }
    }

    private func handle(_ task: BGAppRefreshTask) {
        scheduleAppRefresh()
        let completionGate = BackgroundTaskCompletionGate(task: task)
        let operation = Task {
            async let placesSucceeded = placeFlush?() ?? true
            do {
                let result = try await coordinator.syncNow()
                let placesOK = await placesSucceeded
                completionGate.complete(success: result.failures.isEmpty && placesOK)
            } catch {
                do {
                    try await coordinator.noteOperationalError(error)
                } catch {
                    logger.error("Could not persist app refresh error.")
                }
                _ = await placesSucceeded
                completionGate.complete(success: false)
            }
        }
        task.expirationHandler = {
            operation.cancel()
            completionGate.complete(success: false)
        }
    }

    private func enableBackgroundDelivery(for type: HKObjectType) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            healthStore.enableBackgroundDelivery(for: type, frequency: .hourly) {
                success,
                error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: MessageError(
                            message: "HealthKit 未启用后台传输。"
                        )
                    )
                }
            }

        }
    }

    private func disableAllBackgroundDelivery() async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            healthStore.disableAllBackgroundDelivery { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: MessageError(
                            message: "HealthKit 未能重置后台传输。"
                        )
                    )
                }
            }

        }
    }

    private func appendObserver(_ observer: HKObserverQuery) {
        lock.lock()
        observerQueries.append(observer)
        lock.unlock()
    }

    private func stopObservers() {
        lock.lock()
        let existing = observerQueries
        observerQueries.removeAll()
        lock.unlock()
        for query in existing {
            healthStore.stop(query)
        }
    }
}

private final class BackgroundTaskCompletionGate: @unchecked Sendable {
    private let task: BGAppRefreshTask
    private let lock = NSLock()
    private var completed = false

    init(task: BGAppRefreshTask) {
        self.task = task
    }

    func complete(success: Bool) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        task.setTaskCompleted(success: success)
    }
}
