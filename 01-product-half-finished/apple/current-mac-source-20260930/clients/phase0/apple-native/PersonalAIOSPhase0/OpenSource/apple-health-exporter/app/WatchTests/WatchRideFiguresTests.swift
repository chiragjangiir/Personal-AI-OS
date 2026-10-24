import Foundation
import HealthKit
import XCTest
@testable import PersonalAIOSWatch

final class WatchRideFiguresTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func local(workout: String = "live-1", speed: Double? = nil, speedAge: TimeInterval = 1, heart: Double? = nil,
                       heartAge: TimeInterval = 1, distance: Double? = 4_000, elapsed: Double = 600, kcal: Double? = 90) -> WatchCyclingMetricSnapshot {
        WatchCyclingMetricSnapshot(workoutID: workout, observedAt: now, heartRateBPM: heart, activeEnergyKcal: kcal, distanceM: distance,
            elapsedS: elapsed, cadenceSPM: nil, cyclingSpeedMPS: speed, heartRateSampleAt: heart == nil ? nil : now.addingTimeInterval(-heartAge),
            cadenceSampleAt: nil, cyclingSpeedSampleAt: speed == nil ? nil : now.addingTimeInterval(-speedAge))
    }
    private func phone(workout: String? = "live-1", ended: Bool = false, speed: Double? = 30, hr: Double? = 150, elev: Double? = nil) -> WatchYimiRideMetrics {
        WatchYimiRideMetrics(ride_id: "ride-1", workout_id: workout, ended: ended, speed_kmh: speed, avg_kmh: 22, max_kmh: 41, distance_m: 5_000,
                             elapsed_s: 700, moving_s: 650, hr_bpm: hr, hr_avg: 140, hr_max: 175, kcal: 120, elev_gain_m: elev)
    }
    private func live(_ metrics: WatchYimiRideMetrics?, receivedAgo: TimeInterval? = 1, local snapshot: WatchCyclingMetricSnapshot?, elapsed: Double? = 612) -> WatchRideFigures {
        .live(phone: metrics, phoneAt: receivedAgo.map { now.addingTimeInterval(-$0) }, local: snapshot, elapsed: elapsed, now: now)
    }

    func testPhoneLostLocalFiguresCarryTheScreen() {
        let figures = live(nil, local: local(speed: 7, heart: 141))
        XCTAssertEqual(figures.speedMPS, 7); XCTAssertEqual(figures.heartRate, 141)
        XCTAssertEqual(figures.distanceM, 4_000); XCTAssertEqual(figures.elapsedS, 612); XCTAssertEqual(figures.kcal, 90)
        XCTAssertFalse(figures.phoneCurrent)
    }

    func testStaleSamplesStayUnavailableNeverBecomeNewReadings() {
        let figures = live(nil, local: local(speed: 7, speedAge: 5.1, heart: 141, heartAge: 5.1))
        XCTAssertNil(figures.speedMPS); XCTAssertNil(figures.heartRate)
        XCTAssertEqual(live(nil, local: local(speed: 7, speedAge: 5, heart: 141, heartAge: 5)).heartRate, 141)
        XCTAssertNil(live(nil, local: local(distance: nil)).distanceM)
    }

    func testCurrentPhoneFiguresWinAndLocalFillsWhatItLacks() {
        let figures = live(phone(speed: nil), local: local(speed: 7, heart: 141))
        XCTAssertTrue(figures.phoneCurrent)
        XCTAssertEqual(figures.speedMPS, 7); XCTAssertEqual(figures.heartRate, 150)
        XCTAssertEqual(figures.distanceM, 5_000); XCTAssertEqual(figures.elapsedS, 700)
        XCTAssertEqual(live(phone(speed: 36), local: local(speed: 7)).speedMPS, 10)
    }

    func testPhoneFiguresNotCurrentOrNotForThisWorkoutAreIgnored() {
        XCTAssertFalse(live(phone(), receivedAgo: 10.1, local: local()).phoneCurrent)
        XCTAssertTrue(live(phone(), receivedAgo: 10, local: local()).phoneCurrent)
        XCTAssertFalse(live(phone(), receivedAgo: nil, local: local()).phoneCurrent)
        XCTAssertFalse(live(phone(workout: "an-earlier-ride"), local: local()).phoneCurrent)
        XCTAssertFalse(live(phone(workout: nil), local: local()).phoneCurrent)
        XCTAssertFalse(live(phone(ended: true), local: local()).phoneCurrent)
        // The phone cannot supply a workout the watch is not running.
        XCTAssertFalse(live(phone(), local: nil).phoneCurrent)
        XCTAssertEqual(live(phone(workout: "an-earlier-ride"), local: local()).distanceM, 4_000)
    }

    func testReconnectionSwitchesSourceWithoutChangingTheWorkoutOrKeepingAStore() {
        let snapshot = local(speed: 7, heart: 141)
        let before = live(nil, local: snapshot)
        let during = live(phone(), local: snapshot)
        let after = live(phone(), receivedAgo: 30, local: snapshot)
        XCTAssertFalse(before.phoneCurrent); XCTAssertTrue(during.phoneCurrent); XCTAssertFalse(after.phoneCurrent)
        XCTAssertEqual(after, WatchRideFigures.live(phone: nil, phoneAt: nil, local: snapshot, elapsed: 612, now: now))
    }

    func testSummaryUsesPhoneTotalsForThisWorkoutElseTheSavedWorkout() throws {
        let saved = WatchRideSummary(workoutID: "live-1", distanceM: 30_000, durationS: 3_600, kcal: 800, hrAvg: nil, hrMax: nil, maxKMH: nil, elevationM: 120)
        let fromPhone = WatchRideSummaryFigures.resolve(phone: phone(ended: true, elev: 186), local: saved)
        XCTAssertEqual(fromPhone.avgKMH, 22); XCTAssertEqual(fromPhone.maxKMH, 41); XCTAssertEqual(fromPhone.timeS, 650)
        XCTAssertEqual(fromPhone.elevationM, 186); XCTAssertEqual(fromPhone.hrMax, 175)
        XCTAssertEqual(WatchRideSummaryFigures.resolve(phone: phone(ended: true), local: saved).elevationM, 120)
        for unusable in [nil, phone(ended: false), phone(workout: "another", ended: true)] {
            let alone = WatchRideSummaryFigures.resolve(phone: unusable, local: saved)
            XCTAssertEqual(alone.distanceM, 30_000); XCTAssertEqual(alone.timeS, 3_600); XCTAssertEqual(alone.elevationM, 120)
            XCTAssertEqual(alone.kcal, 800)
            XCTAssertEqual(try XCTUnwrap(alone.avgKMH), 30, accuracy: 0.001)
            XCTAssertNil(alone.maxKMH); XCTAssertNil(alone.hrAvg)
        }
    }

    func testSavedWorkoutSuppliesDurationAndClimbOnlyWhenRecorded() {
        let start = now.addingTimeInterval(-3_600)
        func workout(_ metadata: [String: Any]?) -> HKWorkout {
            HKWorkout(activityType: .cycling, start: start, end: now, workoutEvents: nil, totalEnergyBurned: nil, totalDistance: nil, metadata: metadata)
        }
        let climbed = WatchRideSummary(workoutID: "live-1", workout: workout([HKMetadataKeyElevationAscended: HKQuantity(unit: .meter(), doubleValue: 120)]))
        XCTAssertEqual(climbed.workoutID, "live-1"); XCTAssertEqual(climbed.durationS, 3_600); XCTAssertEqual(climbed.elevationM, 120)
        let flat = WatchRideSummary(workoutID: "live-1", workout: workout(nil))
        XCTAssertNil(flat.elevationM); XCTAssertNil(flat.avgKMH)
    }
}
