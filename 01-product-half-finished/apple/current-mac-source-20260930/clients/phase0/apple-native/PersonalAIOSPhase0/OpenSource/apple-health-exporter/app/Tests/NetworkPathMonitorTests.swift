import Network
import XCTest
@testable import HealthKitExporter

final class NetworkPathMonitorTests: XCTestCase {
    func testMapsNetworkStatuses() {
        XCTAssertEqual(
            NetworkPathMonitor.map(.satisfied),
            .satisfied
        )
        XCTAssertEqual(
            NetworkPathMonitor.map(.unsatisfied),
            .unsatisfied
        )
        XCTAssertEqual(
            NetworkPathMonitor.map(.requiresConnection),
            .requiresConnection
        )
    }

    func testTransitionDetectsLossAndRecovery() {
        let old = AssistantNetworkPathState(
            status: .satisfied,
            isExpensive: false,
            isConstrained: false,
            usesWiFi: true,
            usesCellular: false
        )
        let lost = AssistantNetworkPathState(
            status: .unsatisfied,
            isExpensive: false,
            isConstrained: false,
            usesWiFi: false,
            usesCellular: false
        )
        XCTAssertEqual(
            NetworkPathMonitor.transition(from: old, to: lost),
            .becameUnsatisfied
        )
    }
}
