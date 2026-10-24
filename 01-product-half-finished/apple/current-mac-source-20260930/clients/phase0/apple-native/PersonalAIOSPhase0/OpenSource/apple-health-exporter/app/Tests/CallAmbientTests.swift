import Foundation
import XCTest
@testable import HealthKitExporter

final class CallAmbientTests: XCTestCase {
    private func packet(_ fields: [String: Any]) throws -> CentralTextPacket {
        var body = fields
        body["schema_version"] = "paios.central.text-envelope.v1"
        body["session_id"] = body["session_id"] ?? "continuity"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
    }
    func testPreferenceDefaultsAndPersistsAllChoices() throws {
        let name = "CallAmbientTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(CallSilenceTimeout.load(from: defaults), .threeMinutes)
        for option in CallSilenceTimeout.allCases {
            defaults.set(option.rawValue, forKey: CallSilenceTimeout.preferenceKey)
            XCTAssertEqual(CallSilenceTimeout.load(from: defaults), option)
            let data = try AssistantCentralTextWire.call("call_open", callID: "call-1", silenceTimeout: option)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(body["silence_timeout_ms"] as? Int, option.rawValue)
        }
        defaults.set(999, forKey: CallSilenceTimeout.preferenceKey)
        XCTAssertEqual(CallSilenceTimeout.load(from: defaults), .threeMinutes)
        for invalid in [false, "0", 999] as [Any] {
            XCTAssertThrowsError(try AssistantCentralTextWire.encode("call_open", fields: ["call_id": "call-1", "silence_timeout_ms": invalid]))
        }
    }
    func testAmbientStateCreatesCallAfterIdleOrEndedCall() throws {
        var call = CentralCall()
        try call.accept(packet(["operation": "call_state", "call_id": "ambient-1", "state": "live", "mode": "ambient"]).fields)
        XCTAssertEqual(call.id, "ambient-1")
        XCTAssertTrue(call.isActive)
        XCTAssertTrue(call.isAmbient)
        try call.accept(packet(["operation": "call_state", "call_id": "ambient-2", "state": "live", "mode": "ambient"]).fields)
        XCTAssertEqual(call.id, "ambient-1", "an active call cannot be replaced")
        try call.accept(packet(["operation": "call_state", "call_id": "ambient-1", "state": "closed", "mode": "ambient"]).fields)
        try call.accept(packet(["operation": "call_state", "call_id": "ambient-2", "state": "live", "mode": "ambient"]).fields)
        XCTAssertEqual(call.id, "ambient-2")
        var manual = CentralCall(id: "manual-1", state: "opening")
        try manual.accept(packet(["operation": "call_state", "call_id": "manual-1", "state": "live"]).fields)
        XCTAssertFalse(manual.isAmbient)
    }
    func testAmbientCallRejectsOtherSession() throws {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "phone", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, callRejoinWindowS: 120))
        XCTAssertThrowsError(try consumer.accept(packet(["operation": "call_state", "call_id": "ambient-other", "state": "live", "mode": "ambient", "session_id": "other-session"])))
        XCTAssertFalse(consumer.call.isActive)
        XCTAssertNil(consumer.call.id)
    }
    func testPlaybackRetirementOnlyMutesOldSIDInBoundCall() throws {
        var retirement = CallPlaybackRetirement()
        _ = try retirement.accept(packet(["operation": "call_state", "call_id": "call-1", "state": "live"]), sessionID: "continuity")
        XCTAssertNil(try retirement.accept(packet(["operation": "call_playback_reset", "call_id": "other-call", "track_sid": "old"]), sessionID: "continuity"))
        XCTAssertNil(try retirement.accept(packet(["operation": "call_playback_reset", "call_id": "call-1", "track_sid": "old", "session_id": "other-session"]), sessionID: "continuity"))
        XCTAssertEqual(try retirement.accept(packet(["operation": "call_playback_reset", "call_id": "call-1", "track_sid": "old"]), sessionID: "continuity"), "old")
        XCTAssertTrue(retirement.retiredSIDs.contains("old"))
        XCTAssertFalse(retirement.retiredSIDs.contains("new"))
        for index in 0..<300 {
            _ = try retirement.accept(packet(["operation": "call_playback_reset", "call_id": "call-1", "track_sid": "retired-\(index)"]), sessionID: "continuity")
        }
        XCTAssertEqual(retirement.retiredSIDs.count, CallPlaybackRetirement.retainedSIDLimit)
        XCTAssertTrue(retirement.retiredSIDs.contains("retired-299"))
    }
}
