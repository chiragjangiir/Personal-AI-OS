import Foundation
import XCTest
@testable import HealthKitExporter

final class AssistantPaymentChannelTests: XCTestCase {
    func testModelSettingsShareCorrelationButNeverPaymentProjection() async throws {
        let channel = AssistantPaymentChannel()
        let sent = expectation(description: "settings request published")
        let observed = expectation(description: "settings receipt and state only")
        observed.expectedFulfillmentCount = 2
        await channel.setObserver { event in if case .output = event { XCTFail("model settings entered payment projection") } }
        await channel.setModelSettingsObserver { event in if case .output = event { observed.fulfill() } }
        await channel.attach(binding: binding) { bytes, _, dispatch in
            try dispatch.begin()
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            if fields["control_id"] as? String == "settings-1" { sent.fulfill() }
        }
        let bytes = try AssistantCentralTextWire.encode("model_settings_read", fields: ["control_id": "settings-1"])
        let response = Task { try await channel.request(bytes, id: "settings-1", timeout: 2) }
        await fulfillment(of: [sent], timeout: 1)
        func settingsReceipt(session: String) throws -> CentralTextPacket {
            try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
                "schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_receipt",
                "session_id": session, "control_id": "settings-1", "ok": true, "result": [:]]))
        }
        _ = await channel.accept(try settingsReceipt(session: "old-session"))
        let packet = try settingsReceipt(session: binding.sessionID)
        _ = await channel.accept(packet)
        let received = try await response.value
        XCTAssertEqual(received, packet)
        let state = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_state",
            "session_id": binding.sessionID, "state": ["environment_id": "test", "desired": 1, "groups": [:]]]))
        _ = await channel.accept(state)
        await fulfillment(of: [observed], timeout: 1)
    }

    func testNonPhoneAttachmentDoesNotPublishPhonePresence() async throws {
        for deviceClass in ["mac", "glasses"] {
            let channel = AssistantPaymentChannel()
            var terminal = binding
            terminal.deviceClass = deviceClass
            await channel.attach(binding: terminal) { _, _, _ in XCTFail("terminal published phone_presence") }
            try await channel.presence("foreground")
            await channel.detach()
        }
    }

    private actor PublishGate {
        var continuation: CheckedContinuation<Void, Never>?
        func wait(_ entered: XCTestExpectation) async {
            await withCheckedContinuation { continuation = $0; entered.fulfill() }
        }
        func release() { continuation?.resume(); continuation = nil }
    }
    private let binding = CentralTransportBinding(sessionID: "session-1", deviceID: "phone-1",
        connectionEpoch: "epoch-1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, deviceClass: "iphone")

    private func request(_ id: String = "ctl-1") throws -> Data {
        try AssistantCentralTextWire.encode("payment_dispute", fields: ["control_id": id,
            "payment_id": "pay-00000000-0000-4000-8000-000000000001"])
    }

    private func receipt(_ id: String = "ctl-1", session: String = "session-1") throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": "paios.central.text-envelope.v1", "operation": "payment_receipt",
            "session_id": session, "control_id": id, "ok": true]))
    }

    func testExactReplyAlsoReachesObserverAndWrongSessionIsDropped() async throws {
        let channel = AssistantPaymentChannel()
        let sent = expectation(description: "request published")
        let observed = expectation(description: "valid reply observed")
        observed.expectedFulfillmentCount = 2
        await channel.setObserver { event in
            if case .output = event { observed.fulfill() }
        }
        await channel.attach(binding: binding) { bytes, _, dispatch in
            try dispatch.begin()
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            if fields["control_id"] as? String == "ctl-1" { sent.fulfill() }
        }
        let bytes = try request()
        let response = Task { try await channel.request(bytes, id: "ctl-1", timeout: 2) }
        await fulfillment(of: [sent], timeout: 1)
        _ = await channel.accept(try receipt(session: "old-session"))
        _ = await channel.accept(try receipt("unrelated"))
        let packet = try receipt()
        _ = await channel.accept(packet)
        let result = try await response.value
        XCTAssertEqual(result, packet)
        await fulfillment(of: [observed], timeout: 1)
    }

    func testDetachFailsPendingAndReattachResendsStoredPresence() async throws {
        let channel = AssistantPaymentChannel()
        try await channel.presence("background")
        let presence = expectation(description: "presence on every attach")
        presence.expectedFulfillmentCount = 2
        let sent = expectation(description: "request published")
        let sender: AssistantPaymentChannel.Sender = { bytes, _, dispatch in
            try dispatch.begin()
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            if fields["operation"] as? String == "phone_presence" {
                XCTAssertEqual(fields["state"] as? String, "background")
                presence.fulfill()
            } else { sent.fulfill() }
        }
        await channel.attach(binding: binding, send: sender)
        let bytes = try request()
        let response = Task { try await channel.request(bytes, id: "ctl-1", timeout: 2) }
        await fulfillment(of: [sent], timeout: 1)
        await channel.detach()
        do { _ = try await response.value; XCTFail("detached RPC succeeded") }
        catch AssistantPaymentChannelError.detached { }
        await channel.attach(binding: binding, send: sender)
        await fulfillment(of: [presence], timeout: 1)
    }

    func testTimeoutCleansPendingAndIDCannotBeReusedForLateReceipt() async throws {
        let channel = AssistantPaymentChannel()
        await channel.attach(binding: binding) { _, _, dispatch in try dispatch.begin() }
        let bytes = try request()
        do { _ = try await channel.request(bytes, id: "ctl-1", timeout: 0.01); XCTFail("RPC did not expire") }
        catch AssistantPaymentChannelError.timeout { }
        _ = await channel.accept(try receipt())
        do { _ = try await channel.request(bytes, id: "ctl-1", timeout: 1); XCTFail("reused correlation ID") }
        catch AssistantPaymentChannelError.notDispatched(let reason) {
            guard case AssistantPaymentChannelError.duplicateID = reason else { return XCTFail("wrong pre-dispatch error: \(reason)") }
        }
    }

    func testAttachPresenceFailureIsReportedAndLeavesPaymentDetached() async throws {
        let channel = AssistantPaymentChannel()
        let failure = expectation(description: "payment failure observed")
        await channel.setObserver { event in
            if case .failed = event { failure.fulfill() }
        }
        await channel.attach(binding: binding) { _, _, _ in throw CentralTextError.unavailable }
        await fulfillment(of: [failure], timeout: 1)
        do { _ = try await channel.request(request(), id: "ctl-1", timeout: 1); XCTFail("failed attachment usable") }
        catch AssistantPaymentChannelError.notDispatched(let reason) {
            guard case AssistantPaymentChannelError.detached = reason else { return XCTFail("wrong pre-dispatch error: \(reason)") }
        }
    }

    func testCancellationCleansPendingAndDetachedRequestCannotSend() async throws {
        let channel = AssistantPaymentChannel()
        let sent = expectation(description: "request published")
        await channel.attach(binding: binding) { bytes, _, dispatch in
            try dispatch.begin()
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            if fields["control_id"] as? String == "ctl-1" { sent.fulfill() }
        }
        let bytes = try request()
        let response = Task { try await channel.request(bytes, id: "ctl-1", timeout: 2) }
        await fulfillment(of: [sent], timeout: 1)
        response.cancel()
        do { _ = try await response.value; XCTFail("cancelled RPC succeeded") }
        catch is CancellationError { }
        await channel.detach()
        do { _ = try await channel.request(bytes, id: "ctl-2", timeout: 1); XCTFail("detached RPC sent") }
        catch AssistantPaymentChannelError.notDispatched(let reason) {
            guard case AssistantPaymentChannelError.detached = reason else { return XCTFail("wrong pre-dispatch error: \(reason)") }
        }
    }

    func testSenderPreflightFailureIsDistinctFromPossibleDispatch() async throws {
        let channel = AssistantPaymentChannel()
        await channel.attach(binding: binding) { bytes, _, dispatch in
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            guard let id = fields["control_id"] as? String else { return }
            if id == "known" { throw AssistantPaymentChannelError.notDispatched(CentralTextError.unavailable) }
            try dispatch.begin()
            throw CentralTextError.unavailable
        }
        do { _ = try await channel.request(request("known"), id: "known", timeout: 1); XCTFail("preflight succeeded") }
        catch AssistantPaymentChannelError.notDispatched(let reason) {
            guard case CentralTextError.unavailable = reason else { return XCTFail("wrong preflight error") }
        }
        do { _ = try await channel.request(request("possible"), id: "possible", timeout: 1); XCTFail("publish succeeded") }
        catch CentralTextError.unavailable { }
    }

    func testAlreadyCancelledRequestCannotReachSender() async throws {
        let channel = AssistantPaymentChannel()
        await channel.attach(binding: binding) { bytes, _, dispatch in
            try dispatch.begin()
            let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            XCTAssertEqual(fields["operation"] as? String, "phone_presence")
        }
        let bytes = try request()
        let response = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await channel.request(bytes, id: "ctl-1", timeout: 1)
        }
        do { _ = try await response.value; XCTFail("cancelled RPC dispatched") }
        catch AssistantPaymentChannelError.notDispatched(let reason) { XCTAssertTrue(reason is CancellationError) }
    }

    func testQueuedCancellationAndDetachFencePublisherHandoff() async throws {
        for detach in [false, true] {
            let channel = AssistantPaymentChannel(), gate = PublishGate()
            let entered = expectation(description: "queued before publisher")
            let finished = expectation(description: "queued publisher rejected")
            await channel.attach(binding: binding) { bytes, _, dispatch in
                let fields = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                guard fields["control_id"] != nil else { try dispatch.begin(); return }
                await gate.wait(entered)
                defer { finished.fulfill() }
                do { try dispatch.begin(); XCTFail("cancelled request reached publisher") }
                catch AssistantPaymentChannelError.notDispatched(let reason) { XCTAssertTrue(reason is CancellationError) }
            }
            let bytes = try request()
            let response = Task { try await channel.request(bytes, id: "ctl-1", timeout: 2) }
            await fulfillment(of: [entered], timeout: 1)
            if detach { await channel.detach() } else { response.cancel() }
            await gate.release()
            do { _ = try await response.value; XCTFail("queued request succeeded") }
            catch AssistantPaymentChannelError.notDispatched { }
            await fulfillment(of: [finished], timeout: 1)
        }
    }
}
