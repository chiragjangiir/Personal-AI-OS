import Foundation
import HealthKit

/// The numbers the ride screen shows, chosen one value at a time: the phone's figure while its relay is current and
/// belongs to this workout, otherwise the watch's own reading of the same workout. A value neither source has stays
/// nil and shows as "--"; nothing is estimated, and a heart-rate or speed sample older than the freshness window is
/// never shown as if it were new.
struct WatchRideFigures: Equatable {
    /// The phone pushes about once a second; two missed seconds-worth of relays means it is gone or out of step.
    static let phoneFreshness: TimeInterval = 10

    let speedMPS: Double?
    let distanceM: Double?
    let elapsedS: Double?
    let heartRate: Double?
    let kcal: Double?
    /// Whether the phone relay is current for this workout. Each sensor still needs its own fresh sample.
    let phoneCurrent: Bool
    var phoneHeartCurrent = false
    /// The widget must stop showing these sensor numbers at this time, even without another app publication.
    var sensorsExpireAt: Date? = nil

    static func live(phone: WatchYimiRideMetrics?, phoneAt: Date?, local: WatchCyclingMetricSnapshot?,
                     elapsed: TimeInterval?, now: Date) -> WatchRideFigures {
        let current = phone.flatMap { metrics in
            let received = phoneAt.map { now.timeIntervalSince($0) <= phoneFreshness } ?? false
            return received && !metrics.ended && metrics.matches(workoutID: local?.workoutID) ? metrics : nil
        }
        let localSpeed = local.flatMap { WatchCyclingMetricMapper.fresh($0.cyclingSpeedMPS, at: $0.cyclingSpeedSampleAt, observedAt: now) }
        let localHeart = local.flatMap { WatchCyclingMetricMapper.fresh($0.heartRateBPM, at: $0.heartRateSampleAt, observedAt: now) }
        let phoneSpeedAt = current?.speed_sample_at.flatMap(WatchStateReducer.date)
        let phoneHeartAt = current?.hr_sample_at.flatMap(WatchStateReducer.date)
        let phoneSpeed = WatchCyclingMetricMapper.fresh(current?.speed_kmh.map { $0 / 3.6 }, at: phoneSpeedAt, observedAt: now)
        let phoneHeart = WatchCyclingMetricMapper.fresh(current?.hr_bpm, at: phoneHeartAt, observedAt: now)
        let speedAt = phoneSpeed != nil ? phoneSpeedAt : localSpeed != nil ? local?.cyclingSpeedSampleAt : nil
        let heartAt = phoneHeart != nil ? phoneHeartAt : localHeart != nil ? local?.heartRateSampleAt : nil
        return WatchRideFigures(
            speedMPS: phoneSpeed ?? localSpeed,
            distanceM: current?.distance_m ?? local?.distanceM,
            elapsedS: current?.elapsed_s ?? elapsed ?? local?.elapsedS,
            heartRate: phoneHeart ?? localHeart,
            kcal: current?.kcal ?? local?.activeEnergyKcal,
            phoneCurrent: current != nil, phoneHeartCurrent: phoneHeart != nil,
            sensorsExpireAt: [speedAt, heartAt].compactMap { $0 }.min()?.addingTimeInterval(WatchCyclingMetricEnvelope.freshnessInterval))
    }
}

/// The saved workout's own totals, read from the HKWorkout the builder finished (the same record that went into
/// Health). `workoutID` is the live relay identity: HealthKit's saved UUID is a different value.
struct WatchRideSummary: Equatable {
    let workoutID: String
    let distanceM: Double?
    let durationS: Double
    let kcal: Double?
    let hrAvg: Double?
    let hrMax: Double?
    let maxKMH: Double?
    /// Present only when the system recorded the climb for this workout.
    let elevationM: Double?

    var avgKMH: Double? { distanceM.flatMap { durationS > 0 ? $0 / durationS * 3.6 : nil } }
}

extension WatchRideSummary {
    init(workoutID: String, workout: HKWorkout) {
        func statistics(_ id: HKQuantityTypeIdentifier) -> HKStatistics? {
            HKQuantityType.quantityType(forIdentifier: id).flatMap { workout.statistics(for: $0) }
        }
        let perMinute = HKUnit.count().unitDivided(by: .minute())
        let metersPerSecond = HKUnit.meter().unitDivided(by: .second())
        self.init(
            workoutID: workoutID,
            distanceM: statistics(.distanceCycling)?.sumQuantity()?.doubleValue(for: .meter()),
            durationS: workout.duration,
            kcal: statistics(.activeEnergyBurned)?.sumQuantity()?.doubleValue(for: .kilocalorie()),
            hrAvg: statistics(.heartRate)?.averageQuantity()?.doubleValue(for: perMinute),
            hrMax: statistics(.heartRate)?.maximumQuantity()?.doubleValue(for: perMinute),
            maxKMH: (statistics(.cyclingSpeed)?.maximumQuantity()?.doubleValue(for: metersPerSecond)).map { $0 * 3.6 },
            elevationM: (workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity)?.doubleValue(for: .meter()))
    }
}

/// What the summary screen shows: the phone's ride summary when it has arrived for this workout, otherwise the
/// saved workout's own totals. The climb is the phone's (its altitude readings) or, without it, the system's record.
struct WatchRideSummaryFigures: Equatable {
    let distanceM: Double?
    let timeS: Double
    let avgKMH: Double?
    let maxKMH: Double?
    let kcal: Double?
    let hrAvg: Double?
    let hrMax: Double?
    let elevationM: Double?
    var commentary: String? = nil

    static func resolve(phone: WatchYimiRide?, local: WatchRideSummary) -> WatchRideSummaryFigures {
        let ended = phone?.metrics.flatMap { $0.ended && $0.matches(workoutID: local.workoutID) ? $0 : nil }
        return WatchRideSummaryFigures(
            distanceM: ended?.distance_m ?? local.distanceM, timeS: ended?.moving_s ?? local.durationS,
            avgKMH: ended?.avg_kmh ?? local.avgKMH, maxKMH: ended?.max_kmh ?? local.maxKMH,
            kcal: ended?.kcal ?? local.kcal, hrAvg: ended?.hr_avg ?? local.hrAvg, hrMax: ended?.hr_max ?? local.hrMax,
            elevationM: ended?.elev_gain_m ?? local.elevationM,
            commentary: ended != nil ? phone?.text : nil)
    }
}
