import Foundation
import XCTest
@testable import PersonalAIOSWatch

final class WatchWorkoutCoordinatorTests: XCTestCase {
    func testCyclingStatisticsMapperPreservesMissingOptionalValues() {
        let values = WatchCyclingStatisticsValues(
            heartRateBPM: 148,
            activeEnergyKcal: 12.5,
            distanceM: 321.25,
            elapsedS: 42,
            cadenceSPM: nil,
            cyclingSpeedMPS: nil,
            heartRateSampleAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        let observedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = WatchCyclingMetricMapper.snapshot(
            from: values,
            workoutID: "workout-1",
            observedAt: observedAt
        )

        XCTAssertEqual(snapshot?.workoutID, "workout-1")
        XCTAssertEqual(snapshot?.observedAt, observedAt)
        XCTAssertEqual(snapshot?.heartRateBPM, 148)
        XCTAssertEqual(snapshot?.activeEnergyKcal, 12.5)
        XCTAssertEqual(snapshot?.distanceM, 321.25)
        XCTAssertEqual(snapshot?.elapsedS, 42)
        XCTAssertNil(snapshot?.cadenceSPM)
        XCTAssertNil(snapshot?.cyclingSpeedMPS)
    }

    func testCyclingStatisticsMapperDropsNonFiniteOptionalValues() {
        let values = WatchCyclingStatisticsValues(
            heartRateBPM: .nan,
            activeEnergyKcal: .infinity,
            distanceM: -1,
            elapsedS: 8,
            cadenceSPM: 80,
            cyclingSpeedMPS: -.infinity,
            cadenceSampleAt: Date(timeIntervalSince1970: 1_700_000_001)
        )

        let snapshot = WatchCyclingMetricMapper.snapshot(
            from: values,
            workoutID: "workout-2",
            observedAt: Date(timeIntervalSince1970: 1_700_000_001)
        )

        XCTAssertNotNil(snapshot)
        XCTAssertNil(snapshot?.heartRateBPM)
        XCTAssertNil(snapshot?.activeEnergyKcal)
        XCTAssertNil(snapshot?.distanceM)
        XCTAssertEqual(snapshot?.cadenceSPM, 80)
        XCTAssertNil(snapshot?.cyclingSpeedMPS)
    }

    func testCyclingStatisticsMapperRejectsInvalidElapsedTime() {
        let values = WatchCyclingStatisticsValues(
            heartRateBPM: nil,
            activeEnergyKcal: nil,
            distanceM: nil,
            elapsedS: .infinity,
            cadenceSPM: nil,
            cyclingSpeedMPS: nil
        )

        XCTAssertNil(
            WatchCyclingMetricMapper.snapshot(
                from: values,
                workoutID: "workout-3",
                observedAt: Date(timeIntervalSince1970: 1_700_000_002)
            )
        )
    }

    func testIndependentSensorFreshnessUsesSampleDateWhileCumulativeValuesContinue() throws {
        let sampleAt = Date(timeIntervalSince1970: 1_700_000_000)
        let values = WatchCyclingStatisticsValues(
            heartRateBPM: 140, activeEnergyKcal: 20, distanceM: 200, elapsedS: 8,
            cadenceSPM: 80, cyclingSpeedMPS: 5, heartRateSampleAt: sampleAt,
            cadenceSampleAt: sampleAt.addingTimeInterval(4),
            cyclingSpeedSampleAt: sampleAt.addingTimeInterval(4))
        let boundary = try XCTUnwrap(WatchCyclingMetricMapper.snapshot(
            from: values, workoutID: "ride", observedAt: sampleAt.addingTimeInterval(5)))
        XCTAssertEqual(boundary.heartRateBPM, 140)
        let stale = try XCTUnwrap(WatchCyclingMetricMapper.snapshot(
            from: values, workoutID: "ride", observedAt: sampleAt.addingTimeInterval(5.001)))
        XCTAssertEqual(stale.heartRateBPM, 140)
        XCTAssertEqual(stale.heartRateSampleAt, sampleAt)
        XCTAssertEqual(stale.cadenceSPM, 80)
        XCTAssertEqual(stale.cyclingSpeedMPS, 5)
        let stopped = try XCTUnwrap(WatchCyclingMetricMapper.snapshot(
            from: values, workoutID: "ride", observedAt: sampleAt.addingTimeInterval(10)))
        XCTAssertNil(stopped.cadenceSPM)
        XCTAssertNil(stopped.cyclingSpeedMPS)
        XCTAssertEqual(stopped.activeEnergyKcal, 20)
        XCTAssertEqual(stopped.distanceM, 200)
        let future = try XCTUnwrap(WatchCyclingMetricMapper.snapshot(
            from: values, workoutID: "ride", observedAt: sampleAt.addingTimeInterval(-1)))
        XCTAssertNil(future.heartRateBPM)
        XCTAssertNil(future.cadenceSPM)
        let undated = WatchCyclingStatisticsValues(
            heartRateBPM: 140, activeEnergyKcal: 1, distanceM: nil, elapsedS: 1,
            cadenceSPM: 80, cyclingSpeedMPS: 5)
        XCTAssertNil(WatchCyclingMetricMapper.snapshot(
            from: undated, workoutID: "ride", observedAt: sampleAt)?.heartRateBPM)
        let packet = WatchCyclingMetricEnvelope(snapshot: boundary, sequence: 1)
        XCTAssertEqual(try WatchCyclingMetricEnvelope.decodeStrict(packet.encodedStrict()), packet)
    }

    func testStopOrderIsSessionThenCollectionThenFinish() {
        let machine = WatchWorkoutStopStateMachine()

        XCTAssertTrue(machine.beginStop())
        XCTAssertEqual(machine.phase, .sessionEndRequested)
        XCTAssertTrue(machine.markSessionEnded())
        XCTAssertEqual(machine.phase, .sessionEnded)
        XCTAssertTrue(machine.markCollectionEnded())
        XCTAssertEqual(machine.phase, .collectionEnded)
        XCTAssertTrue(machine.markFinishRequested())
        XCTAssertEqual(machine.phase, .finishRequested)
        XCTAssertTrue(machine.markSaved())
        XCTAssertEqual(machine.phase, .saved)
    }

    func testOutOfOrderFinishCannotClaimSaved() {
        let machine = WatchWorkoutStopStateMachine()

        XCTAssertFalse(machine.markFinishRequested())
        XCTAssertFalse(machine.markSaved())
        XCTAssertEqual(machine.phase, .idle)
    }

    func testFinishWithoutWorkoutRemainsUnknownSave() {
        let machine = WatchWorkoutStopStateMachine()

        XCTAssertTrue(machine.beginStop())
        XCTAssertTrue(machine.markSessionEnded())
        XCTAssertTrue(machine.markCollectionEnded())
        XCTAssertTrue(machine.markFinishRequested())
        XCTAssertTrue(machine.markUnknownSave())
        XCTAssertEqual(machine.phase, .unknownSave)
        XCTAssertFalse(machine.markSaved())
    }
}
