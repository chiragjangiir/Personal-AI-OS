import Foundation
import XCTest
@testable import HealthKitExporter

final class WatchRidePresentationTests: XCTestCase {
    func testShortWorkoutBoundary() {
        XCTAssertTrue(WatchRidePresentation.needsSaveDecision(elapsed: 59.9))
        XCTAssertFalse(WatchRidePresentation.needsSaveDecision(elapsed: 60))
    }
    func testOfflineRequiresExplicitLimitAndUsesLastSyncedLimit() {
        var presentation = WatchRidePresentation()
        let now = Date(timeIntervalSince1970: 100)
        XCTAssertFalse(presentation.update(heartRate: 190, phoneReachable: false, now: now))
        XCTAssertFalse(presentation.receive(.init(hr_zone: 3, text: nil, max_hr_bpm: 180), now: now))
        XCTAssertFalse(presentation.update(heartRate: 181, phoneReachable: true, now: now))
        XCTAssertTrue(presentation.update(heartRate: 181, phoneReachable: false, now: now))
        XCTAssertEqual(presentation.banner, "心率 181 了，慢一点，喝口水。")
        XCTAssertFalse(presentation.update(heartRate: 190, phoneReachable: false, now: now.addingTimeInterval(179)))
        XCTAssertTrue(presentation.update(heartRate: 190, phoneReachable: false, now: now.addingTimeInterval(180)))
    }
    func testBannerExpiresAfterSixSeconds() {
        var presentation = WatchRidePresentation()
        let now = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(presentation.receive(.init(hr_zone: 5, text: "慢一点", max_hr_bpm: 175), now: now))
        _ = presentation.update(heartRate: nil, phoneReachable: true, now: now.addingTimeInterval(5.9))
        XCTAssertEqual(presentation.banner, "慢一点")
        presentation.expire(at: now.addingTimeInterval(6))
        XCTAssertNil(presentation.banner)
    }
    func testMetricRelaysDoNotRepeatAnExpiredFeedbackHaptic() {
        var presentation = WatchRidePresentation()
        let now = Date(timeIntervalSince1970: 100)
        let feedback = WatchYimiRide(hr_zone: 5, text: "慢一点", max_hr_bpm: 175, feedback_at: "2026-10-20T08:00:00Z")
        XCTAssertTrue(presentation.receive(feedback, now: now))
        presentation.expire(at: now.addingTimeInterval(6))
        XCTAssertFalse(presentation.receive(feedback, now: now.addingTimeInterval(7)))
        XCTAssertNil(presentation.banner)
        let next = WatchYimiRide(hr_zone: 5, text: "慢一点", max_hr_bpm: 175, feedback_at: "2026-10-20T08:03:00Z")
        XCTAssertTrue(presentation.receive(next, now: now.addingTimeInterval(180)))
    }
}
