import Foundation
import XCTest

final class DesktopCallTests: XCTestCase {
    @MainActor
    func testMacAvatarEnableAndRetryExplainPhoneOnlySupportWithoutChangingMedia() async throws {
        let sensors = AvatarUnavailableSensors()
        let coordinator = AssistantSessionCoordinator(bootstrapProvider: UnconfiguredAssistantBootstrapProvider(),
            realtime: AvatarUnavailableTransport(), mediaPermissions: sensors, locationService: sensors,
            receipts: AppleReceiptStore(), careIdentity: { nil })
        let engine = DesktopCallEngine(coordinator: coordinator)
        let before = await coordinator.presentationSnapshot()
        for _ in 0..<2 {
            do {
                try await engine.setAvatar(true)
                XCTFail("Mac cannot authorize avatar activation")
            } catch {
                XCTAssertEqual(error as? DesktopCallError, .avatarUnavailable)
                XCTAssertEqual(DesktopUserFacingError.message(error),
                    "Mac 上暂时不能开启数字人。请在 iPhone 通话里查看费用并确认开启。")
            }
        }
        let after = await coordinator.presentationSnapshot()
        XCTAssertEqual(after.videoCallRequested, before.videoCallRequested)
        XCTAssertEqual(after.media.camera, before.media.camera)
        XCTAssertEqual(after.media.microphone, before.media.microphone)
        let consumer = await coordinator.centralTextSnapshot()
        XCTAssertNil(consumer.call.id)
    }

    private func packet(_ fields: [String: Any]) throws -> CentralTextPacket {
        var body = fields
        body["schema_version"] = AssistantCentralTextWire.schema
        body["session_id"] = "desktop-continuity"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
    }

    private func openedCall() throws -> AssistantCentralTextConsumer {
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTransportBinding(sessionID: "desktop-continuity", deviceID: "mac",
            connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, callRejoinWindowS: 120))
        _ = try consumer.openCall()
        return consumer
    }

    func testHangupFencesLateLiveStateOnSameCall() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        XCTAssertEqual(consumer.call.state, "opening")
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live"]))
        XCTAssertTrue(consumer.call.isActive)
        _ = try consumer.closeCall()
        XCTAssertEqual(consumer.call.state, "closing")
        XCTAssertFalse(consumer.call.isActive)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live"]))
        XCTAssertEqual(consumer.call.state, "closing", "late transport delivery cannot reopen a local hangup")
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "closed"]))
        XCTAssertEqual(consumer.call.state, "closed")
        XCTAssertEqual(consumer.call.id, id)
    }

    func testAvatarDowngradeKeepsSameLiveVoiceCallAndInterruptedTranscript() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        let credentials = ["provider": "artc", "app_id": "app", "channel_id": "avatar", "user_id": "mac",
                           "token": "test-credential", "token_expire_at": "1800003600", "audio_input": "gateway"]
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live", "video": true,
                                    "video_revision": 1, "media": credentials]))
        XCTAssertEqual(consumer.call.state, "connecting", "avatar is not live until its first rendered frame")
        consumer.renderedCallFrame(id)
        XCTAssertEqual(consumer.call.state, "live")
        try consumer.accept(packet(["operation": "call_transcript", "call_id": id, "role": "assistant",
                                    "turn": 1, "text": "到这里", "final": true, "interrupted": true]))
        consumer.stopCallVideo(id)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live",
                                    "video": false, "video_revision": 2]))
        XCTAssertEqual(consumer.call.id, id)
        XCTAssertTrue(consumer.call.isActive)
        XCTAssertEqual(consumer.call.state, "live")
        XCTAssertNil(consumer.call.media)
        XCTAssertEqual(consumer.call.video, false)
        XCTAssertEqual(consumer.call.lines.last?.text, "到这里")
        XCTAssertEqual(consumer.call.lines.last?.interrupted, true)
    }

    func testStaleAvatarRevisionCannotUndoVoiceDowngrade() throws {
        var consumer = try openedCall()
        let id = try XCTUnwrap(consumer.call.id)
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "live",
                                    "video": false, "video_revision": 2]))
        try consumer.accept(packet(["operation": "call_state", "call_id": id, "state": "connecting",
                                    "video": true, "video_revision": 1]))
        XCTAssertEqual(consumer.call.videoRevision, 2)
        XCTAssertEqual(consumer.call.video, false)
        XCTAssertEqual(consumer.call.state, "live")
        XCTAssertEqual(consumer.call.id, id)
    }
}

private actor AvatarUnavailableTransport: AssistantRealtimeTransporting {
    func connect(_ request: AssistantRealtimeConnectRequest,
                 events: @escaping @Sendable (AssistantRealtimeEvent) -> Void) async throws {
        XCTFail("Unsupported avatar activation must not connect")
        throw CentralTextError.unavailable
    }
    func setMedia(source: AssistantMediaSource, enabled: Bool, userInitiated: Bool, keepPublished: Bool) async throws {
        XCTFail("Unsupported avatar activation must not change media")
        throw CentralTextError.unavailable
    }
    func stop() async {}
}

@MainActor private final class AvatarUnavailableSensors: AssistantLocationProviding, MediaPermissionProviding {
    func authorizationStatus() -> AssistantPermissionStatus { .unavailable }
    func cachedFixAgeMilliseconds() -> Int? { nil }
    func requestWhenInUseAuthorization(userInitiated: Bool) async throws -> AssistantPermissionStatus {
        XCTFail("Unsupported avatar activation must not request location")
        throw CentralTextError.unavailable
    }
    func requestOneShot(userInitiated: Bool) async throws -> AssistantLocationObservation { throw CentralTextError.unavailable }
    func snapshot() async -> AssistantMediaPermissionSnapshot { .init(camera: .unavailable, microphone: .unavailable) }
    func authorize(source: AssistantMediaSource, userInitiated: Bool) async throws -> AssistantPermissionStatus {
        XCTFail("Unsupported avatar activation must not request media")
        throw CentralTextError.unavailable
    }
}
