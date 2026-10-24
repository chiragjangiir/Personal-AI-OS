import XCTest
@testable import HealthKitExporter

final class MoveLifecycleOutboxTests: XCTestCase {
    func testCapacityFailureRollsBackCheckpointAndNeverEvictsUnacknowledgedIntents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-capacity-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("pending.sqlite")
        let database = try AssistantLocalOperationDatabase(url: url)
        let event = MoveEvent.navState(NavState(nav_id: UUID().uuidString.lowercased(), state: "cancelled", at: Date()))
        let records = try (0..<256).map { _ in try MoveLifecycleRecord(event: event, identity: "owner", sourceSession: "old-session") }
        let old = Data("old-checkpoint".utf8), next = Data("new-checkpoint".utf8)
        try database.preserveMoveEvents(records, checkpoint: old)
        let overflow = try MoveLifecycleRecord(event: event, identity: "owner", sourceSession: "new-session")
        XCTAssertThrowsError(try database.preserveMoveEvents([overflow], checkpoint: next))
        XCTAssertEqual(try database.moveCheckpoint(identity: "owner"), old)
        XCTAssertEqual(try database.pendingMoveEvents(identity: "owner").map(\.id), records.map(\.id))
        try database.preserveMoveEvents([records[0]])
        try database.acknowledgeMoveEvent(id: records[0].id, identity: "other-owner")
        XCTAssertEqual(try database.pendingMoveEvents(identity: "owner").count, 256)
        XCTAssertTrue(try database.pendingMoveEvents(identity: "other-owner").isEmpty)
        try database.acknowledgeMoveEvent(id: records[0].id, identity: "owner")
        try database.preserveMoveEvents([overflow], checkpoint: next)
        let reopened = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(try reopened.pendingMoveEvents(identity: "owner").last?.id, overflow.id)
        XCTAssertEqual(try reopened.moveCheckpoint(identity: "owner"), next)
    }
}
