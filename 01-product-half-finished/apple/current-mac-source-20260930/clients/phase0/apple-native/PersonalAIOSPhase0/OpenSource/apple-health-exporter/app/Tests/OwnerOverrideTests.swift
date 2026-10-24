import Foundation
import XCTest
@testable import HealthKitExporter

final class OwnerOverrideTests: XCTestCase {
    private func packet(enabled: Bool = false, session: String = "owner-session", id: String? = nil, errorCode: String? = nil) throws -> CentralTextPacket {
        var object: [String: Any] = ["schema_version": AssistantCentralTextWire.schema,
            "operation": "owner_override_status", "session_id": session,
            "owner_override": ["available": true, "enabled": enabled, "expires_at": NSNull(),
                               "enabled_by_device": enabled ? "phone-1" as Any : NSNull(), "remaining_s": NSNull()]]
        if let id { object["control_id"] = id }
        if let errorCode { object["error_code"] = errorCode }
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: object))
    }
    func testCountdownUsesServerExpiryAndExpiresAtZero() {
        let status = CentralOwnerOverride(available: true, enabled: true,
            expires_at: "2026-10-18T12:30:00.000Z", enabled_by_device: "phone-1", remaining_s: 900)
        let now = ISO8601DateFormatter().date(from: "2026-10-18T12:15:00Z")!
        XCTAssertEqual(status.statusText(at: now), "已开启 · 剩余 15:00")
        XCTAssertEqual(status.statusText(at: now.addingTimeInterval(900)), "已到期")
    }
    func testStatusDecodeAndEnableWireValidation() throws {
        let status = try XCTUnwrap(packet(enabled: true).fields.value("owner_override", as: CentralOwnerOverride.self))
        XCTAssertTrue(status.enabled)
        XCTAssertNil(status.expires_at)
        XCTAssertEqual(status.enabled_by_device, "phone-1")
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("owner_override_enable", fields: ["control_id": "a", "passphrase": ""]))
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("owner_override_enable", fields: ["control_id": "a", "passphrase": String(repeating: "a", count: 1025)]))
    }
    @MainActor
    func testSecureSubmissionClearsInputAndDisconnectClearsProjection() async throws {
        let model = YimiOwnerOverrideModel()
        let binding = CentralTransportBinding(sessionID: "owner-session", deviceID: "phone-1", connectionEpoch: "e1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 65536, deviceClass: "iphone")
        model.receive(.attached(binding))
        model.send = { bytes, id in
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            XCTAssertEqual(request["operation"] as? String, "owner_override_enable")
            XCTAssertEqual(request["passphrase"] as? String, "test-only-secret")
            XCTAssertEqual(request["control_id"] as? String, id)
            return try self.packet(enabled: true, id: id)
        }
        var passphrase = "test-only-secret"
        let submission = model.enable(passphrase: &passphrase)
        XCTAssertTrue(passphrase.isEmpty)
        await submission.value
        XCTAssertTrue(passphrase.isEmpty)
        XCTAssertEqual(model.status?.enabled, true)
        model.receive(.output(try packet(enabled: true, errorCode: "OWNER_OVERRIDE_LOCKED")))
        XCTAssertEqual(model.error, "尝试次数过多，请 15 分钟后重试")
        model.receive(.output(try packet(session: "other-session")))
        XCTAssertEqual(model.status?.enabled, true)
        model.receive(.detached)
        XCTAssertNil(model.status)
        XCTAssertFalse(model.connected)
    }
    func testStatusCorrelatesOnExistingPrivateChannel() async throws {
        let channel = AssistantPaymentChannel()
        let binding = CentralTransportBinding(sessionID: "owner-session", deviceID: "phone-1", connectionEpoch: "e1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 65536, deviceClass: "iphone")
        await channel.attach(binding: binding) { bytes, _, dispatch in
            try dispatch.begin()
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            if let id = object["control_id"] as? String { _ = await channel.accept(try self.packet(enabled: true, id: id)) }
        }
        let bytes = try AssistantCentralTextWire.encode("owner_override_disable", fields: ["control_id": "disable-1"])
        let reply = try await channel.request(bytes, id: "disable-1", timeout: 1)
        XCTAssertEqual(try reply.fields.value("control_id", as: String.self), "disable-1")
        await channel.detach()
        do { _ = try await channel.request(bytes, id: "disable-2", timeout: 1); XCTFail("Detached request dispatched") }
        catch AssistantPaymentChannelError.notDispatched { }
    }
}
