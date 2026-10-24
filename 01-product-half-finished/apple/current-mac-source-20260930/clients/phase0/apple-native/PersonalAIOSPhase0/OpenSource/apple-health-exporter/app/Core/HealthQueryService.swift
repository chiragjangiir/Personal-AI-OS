import Foundation
import HealthKit
#if canImport(UIKit)
import UIKit
#endif

protocol HealthQuerying: Sendable {
    func bootstrapPage(
        for metric: HealthMetric,
        after date: Date
    ) async throws -> HealthQueryPage

    func incrementalPage(
        for metric: HealthMetric,
        anchor: Data?,
        startDate: Date,
        limit: Int
    ) async throws -> HealthQueryPage

    func backfillPage(
        for metric: HealthMetric,
        start: Date,
        end: Date,
        cursor: Data?,
        limit: Int
    ) async throws -> HealthQueryPage
}

protocol ProtectedDataChecking: Sendable {
    var isProtectedDataAvailable: Bool { get }
}

struct SystemProtectedDataChecker: ProtectedDataChecking {
    var isProtectedDataAvailable: Bool {
#if canImport(UIKit)
        UIApplication.shared.isProtectedDataAvailable
#else
        true
#endif
    }
}

final class HealthQueryService: HealthQuerying, @unchecked Sendable {
    private struct RawPage {
        let samples: [HKSample]
        let deletedObjects: [HKDeletedObject]
        let newAnchor: HKQueryAnchor
    }

    private let healthStore: HKHealthStore
    private let protectedDataChecker: ProtectedDataChecking

    init(
        healthStore: HKHealthStore,
        protectedDataChecker: ProtectedDataChecking = SystemProtectedDataChecker()
    ) {
        self.healthStore = healthStore
        self.protectedDataChecker = protectedDataChecker
    }

    func bootstrapPage(
        for metric: HealthMetric,
        after date: Date
    ) async throws -> HealthQueryPage {
        let predicate = HKQuery.predicateForSamples(
            withStart: date,
            end: nil,
            options: [.strictStartDate]
        )
        let page = try await page(
            for: metric,
            predicate: predicate,
            anchorData: nil,
            limit: HKObjectQueryNoLimit
        )
        return HealthQueryPage(
            records: [],
            deletedRecords: [],
            newAnchor: page.newAnchor,
            rawChangeCount: 0
        )
    }

    func incrementalPage(
        for metric: HealthMetric,
        anchor: Data?,
        startDate: Date,
        limit: Int
    ) async throws -> HealthQueryPage {
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: nil,
            options: [.strictStartDate]
        )
        return try await page(
            for: metric,
            predicate: predicate,
            anchorData: anchor,
            limit: limit
        )
    }

    func backfillPage(
        for metric: HealthMetric,
        start: Date,
        end: Date,
        cursor: Data?,
        limit: Int
    ) async throws -> HealthQueryPage {
        let predicate = HKQuery.predicateForSamples(
            withStart: start,
            end: end,
            options: [.strictStartDate]
        )
        return try await page(
            for: metric,
            predicate: predicate,
            anchorData: cursor,
            limit: limit
        )
    }

    private func page(
        for metric: HealthMetric,
        predicate: NSPredicate?,
        anchorData: Data?,
        limit: Int
    ) async throws -> HealthQueryPage {
        guard protectedDataChecker.isProtectedDataAvailable else {
            throw ExporterError.protectedDataUnavailable
        }
        guard let sampleType = metric.sampleType else {
            throw ExporterError.unsupportedType(metric.displayName)
        }
        let anchor = try decodeAnchor(anchorData)
        let rawPage = try await executeAnchoredQuery(
            type: sampleType,
            predicate: predicate,
            anchor: anchor,
            limit: limit
        )

        let includedSamples: [HKSample]
        if metric.workoutOnly {
            includedSamples = try await measurementsWithinWorkouts(rawPage.samples)
        } else {
            includedSamples = rawPage.samples
        }

        return HealthQueryPage(
            records: try includedSamples.map { try record(from: $0, metric: metric) },
            deletedRecords: rawPage.deletedObjects.map {
                DeletedRecord(sampleType: sampleType.identifier, sampleId: $0.uuid)
            },
            newAnchor: try encodeAnchor(rawPage.newAnchor),
            rawChangeCount: rawPage.samples.count + rawPage.deletedObjects.count
        )
    }

    private func executeAnchoredQuery(
        type: HKSampleType,
        predicate: NSPredicate?,
        anchor: HKQueryAnchor?,
        limit: Int
    ) async throws -> RawPage {
        let gate = HealthQueryCompletionGate<RawPage>(store: healthStore)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let query = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: anchor, limit: limit) {
                    _, samples, deletedObjects, newAnchor, error in
                    if let error { gate.finish(.failure(error)); return }
                    guard let newAnchor else { gate.finish(.failure(ExporterError.invalidAnchor)); return }
                    gate.finish(.success(RawPage(samples: samples ?? [], deletedObjects: deletedObjects ?? [], newAnchor: newAnchor)))
                }
                gate.execute(query, continuation: continuation)
            }
        } onCancel: { gate.finish(.failure(CancellationError())) }
    }

    private func measurementsWithinWorkouts(_ samples: [HKSample]) async throws -> [HKSample] {
        guard
            let earliest = samples.map(\.startDate).min(),
            let latest = samples.map(\.endDate).max()
        else {
            return []
        }

        let predicate = HKQuery.predicateForSamples(
            withStart: earliest,
            end: latest,
            options: []
        )
        let workouts = try await executeSampleQuery(
            type: HKObjectType.workoutType(),
            predicate: predicate
        ).compactMap { $0 as? HKWorkout }

        return samples.filter { sample in
            workouts.contains { workout in
                workout.startDate <= sample.startDate && workout.endDate >= sample.endDate
            }
        }
    }

    private func executeSampleQuery(
        type: HKSampleType,
        predicate: NSPredicate?
    ) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: samples ?? [])
                }
            }
            healthStore.execute(query)
        }
    }

    private func record(from sample: HKSample, metric: HealthMetric) throws -> HealthRecord {
        let value: RecordValue
        if let quantitySample = sample as? HKQuantitySample {
            value = .numeric(try metric.canonicalUnit.value(from: quantitySample.quantity))
        } else if let categorySample = sample as? HKCategorySample {
            value = .category(categorySample.value)
        } else if let workout = sample as? HKWorkout {
            value = .workout(
                WorkoutValue(
                    activityType: workout.workoutActivityType.rawValue,
                    durationSeconds: workout.duration,
                    totalEnergyKilocalories: workout.totalEnergyBurned?.doubleValue(
                        for: .kilocalorie()
                    ),
                    totalDistanceMeters: workout.totalDistance?.doubleValue(for: .meter())
                )
            )
        } else {
            throw ExporterError.unsupportedType(sample.sampleType.identifier)
        }

        return HealthRecord(
            sampleType: sample.sampleType.identifier,
            sampleId: sample.uuid,
            start: sample.startDate,
            end: sample.endDate,
            value: value,
            unit: metric.canonicalUnit.symbol,
            source: sourceInfo(from: sample.sourceRevision),
            device: deviceInfo(from: sample.device),
            metadata: MetadataAllowlist.filtered(sample.metadata)
        )
    }

    private func sourceInfo(from revision: HKSourceRevision) -> SourceInfo {
        SourceInfo(
            name: revision.source.name,
            bundleIdentifier: revision.source.bundleIdentifier,
            version: revision.version,
            productType: revision.productType
        )
    }

    private func deviceInfo(from device: HKDevice?) -> DeviceInfo? {
        guard let device else { return nil }
        return DeviceInfo(
            name: device.name,
            manufacturer: device.manufacturer,
            model: device.model,
            hardwareVersion: device.hardwareVersion,
            firmwareVersion: device.firmwareVersion,
            softwareVersion: device.softwareVersion,
            localIdentifier: device.localIdentifier,
            udiDeviceIdentifier: device.udiDeviceIdentifier
        )
    }

    private func decodeAnchor(_ data: Data?) throws -> HKQueryAnchor? {
        guard let data else { return nil }
        do {
            return try NSKeyedUnarchiver.unarchivedObject(
                ofClass: HKQueryAnchor.self,
                from: data
            )
        } catch {
            throw ExporterError.invalidAnchor
        }
    }

    private func encodeAnchor(_ anchor: HKQueryAnchor) throws -> Data {
        try NSKeyedArchiver.archivedData(
            withRootObject: anchor,
            requiringSecureCoding: true
        )
    }
}

enum MetadataAllowlist {
    private static let allowedKeys: Set<String> = [
        HKMetadataKeyExternalUUID,
        HKMetadataKeySyncIdentifier,
        HKMetadataKeySyncVersion,
        HKMetadataKeyWasUserEntered,
        HKMetadataKeyIndoorWorkout,
        HKMetadataKeyElevationAscended,
        HKMetadataKeyAverageSpeed,
        HKMetadataKeyMaximumSpeed,
        HKMetadataKeyWeatherTemperature,
        HKMetadataKeyWeatherHumidity,
        HKMetadataKeyTimeZone,
        HKMetadataKeyPhysicalEffortEstimationType
    ]

    static func filtered(_ metadata: [String: Any]?) -> [String: String] {
        guard let metadata else { return [:] }
        return metadata.reduce(into: [:]) { result, pair in
            guard allowedKeys.contains(pair.key),
                  let value = stringValue(pair.value, key: pair.key) else {
                return
            }
            result[pair.key] = String(value.prefix(512))
        }
    }

    private static func stringValue(_ value: Any, key: String) -> String? {
        if let value = value as? String {
            return value
        }
        if let value = value as? Date {
            return ISO8601.utc.string(from: value)
        }
        if let value = value as? NSNumber {
            return value.stringValue
        }
        guard let quantity = value as? HKQuantity else {
            return nil
        }

        let unit: HKUnit
        let symbol: String
        let scale: Double
        switch key {
        case HKMetadataKeyElevationAscended:
            unit = .meter()
            symbol = "m"
            scale = 1
        case HKMetadataKeyAverageSpeed, HKMetadataKeyMaximumSpeed:
            unit = .meter().unitDivided(by: .second())
            symbol = "m/s"
            scale = 1
        case HKMetadataKeyWeatherTemperature:
            unit = .degreeCelsius()
            symbol = "degC"
            scale = 1
        case HKMetadataKeyWeatherHumidity:
            unit = .percent()
            symbol = "%"
            scale = 100
        default:
            return nil
        }
        return "\(quantity.doubleValue(for: unit) * scale) \(symbol)"
    }
}

/// One completion owns a bounded anchored query. Cancellation and timeout stop HealthKit and resume once.
private final class HealthQueryCompletionGate<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private let store: HKHealthStore
    private var result: Result<Value, Error>?
    private var continuation: CheckedContinuation<Value, Error>?
    private var query: HKQuery?
    private var timeout: Task<Void, Never>?
    init(store: HKHealthStore) { self.store = store }
    func execute(_ query: HKQuery, continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return }
        self.continuation = continuation; self.query = query
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            self?.finish(.failure(MessageError(message: "健康读取超时。请稍后重试。")))
        }
        store.execute(query)
        lock.unlock()
    }
    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation; self.continuation = nil
        let query = self.query; self.query = nil
        let timeout = self.timeout; self.timeout = nil
        lock.unlock()
        timeout?.cancel()
        if case .failure = result, let query { store.stop(query) }
        continuation?.resume(with: result)
    }
}
