import Foundation
import XCTest
@testable import HealthKitExporter
final class AssistantCentralControlTests: XCTestCase {
    private func fixtures() throws -> [String: Any] {
        #if SWIFT_PACKAGE
        let url = Bundle.module.url(forResource: "formal-control-envelope.fixture", withExtension: "json", subdirectory: "Fixtures/CentralText")
        #else
        let url = Bundle(for: Self.self).url(forResource: "formal-control-envelope.fixture", withExtension: "json")
        #endif
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(url))) as? [String: Any])
    }
    private func packet(_ value: Any) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value))
    }
    func testActualSourceControlWireAndUIConsumerKeepRunReplyDeliveryDistinct() throws {
        let wire = try fixtures()
        let cancelled = try packet(XCTUnwrap(wire["cancelled"]))
        let processedID = try XCTUnwrap(cancelled.fields.value("processed_event_id", as: String.self))
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "mac", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288))
        _ = try consumer.beginSubmit(eventID: "control-source", capturedAt: "2026-10-01T00:00:00.000Z", text: "synthetic original")
        // Synthetic UI setup. The three control receipts below are actual source-owner outputs.
        try consumer.accept(packet(["schema_version": AssistantCentralTextWire.schema, "operation": "accepted", "session_id": "continuity", "event_id": "control-source", "processed_event_id": processedID, "admission": ["state": "running", "run_id": "synthetic-control-run", "idempotency_key": "key"]]))
        _ = try consumer.requestControl("cancel_run", controlID: "cancel-1")
        try consumer.accept(cancelled)
        XCTAssertTrue(consumer.status.contains("running"))
        XCTAssertNil(consumer.header)
        XCTAssertNil(consumer.presentation)
        XCTAssertFalse(consumer.ackConfirmed)
        _ = try consumer.requestControl("reconcile", controlID: "reconcile-1")
        let reconciled = try packet(XCTUnwrap(wire["reconciled"]))
        try consumer.accept(reconciled)
        XCTAssertEqual(consumer.controlReceipt, reconciled)
        let playback = try packet(XCTUnwrap(wire["playback"]))
        XCTAssertEqual(try playback.fields.value("receipt", as: CentralBody.self)?.value("playback_status", as: String.self), "unknown")
        XCTAssertEqual(try playback.fields.value("receipt", as: CentralBody.self)?.value("receipt", as: CentralBody.self)?.value("status", as: String.self), "interrupted")
        for name in ["forged", "other", "old"] { XCTAssertEqual(try packet(XCTUnwrap(wire[name])).fields.value("operation", as: String.self), "rejected") }
    }
    func testInvalidControlAndCrossSessionReceiptDoNotChangeUITruth() throws {
        XCTAssertThrowsError(try AssistantCentralTextWire.control(operation: "stop", controlID: "control", processedID: "D"))
        XCTAssertThrowsError(try AssistantCentralTextWire.control(operation: "cancel_playback", controlID: "control", processedID: "D", replyEpoch: 0))
        var value = try XCTUnwrap(fixtures()["cancelled"] as? [String: Any])
        value["forged_permission"] = true
        XCTAssertThrowsError(try packet(value))
        value.removeValue(forKey: "forged_permission")
        value["session_id"] = "foreign"
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "mac", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288))
        _ = try consumer.beginSubmit(eventID: "control-source", capturedAt: "2026-10-01T00:00:00.000Z", text: "synthetic")
        XCTAssertThrowsError(try consumer.accept(packet(value)))
        XCTAssertNil(consumer.controlReceipt)
        XCTAssertNil(consumer.presentation)
    }
}
