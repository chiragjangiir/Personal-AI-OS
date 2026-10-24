import Foundation
import DesktopKit
@testable import LiveKit
import XCTest

/// A sleep the test releases by hand; a cancelled wait is counted and never retries.
private final class ManualSleep: @unchecked Sendable {
    private let lock = NSLock()
    private var requested: [Duration] = [], waiting: [AsyncStream<Void>.Continuation] = [], cancelledCount = 0
    var delays: [Duration] { lock.withLock { requested } }
    var cancelled: Int { lock.withLock { cancelledCount } }
    func sleep(_ delay: Duration) async throws {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        lock.withLock { requested.append(delay); waiting.append(continuation) }
        for await _ in stream { return }
        lock.withLock { cancelledCount += 1 }
        throw CancellationError()
    }
    func elapse() { lock.withLock { waiting.isEmpty ? nil : waiting.removeLast() }?.yield(()) }
}

@MainActor final class DesktopReconnectTests: XCTestCase {
    func testCentralRoomAliasDoesNotReplaceTheJoinedRoomIdentity() throws {
        let central = CentralTransportBinding(sessionID: "continuity", deviceID: "00000000-0000-4000-8000-000000000019",
            connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288)
        let binding = try AssistantLiveKitDataBinding(joinedRoomName: "paios-r-projected", expectedRoomName: "opaque-room-alias",
            roomSID: "RM_actual", participantIdentity: "paios-t-projected", participantAttributes: [:],
            bootstrapCanPublishData: true, runtimeCanPublishData: true, roomIsConnected: true, centralBinding: central)
        XCTAssertEqual(binding.sessionID, "paios-r-projected")
        XCTAssertEqual(binding.connectionID, "rm_actual")
        let legacyAttributes = ["device_id": "iphone_fixture", "client_instance_id": "client_fixture",
            "device_class": "iphone", "schema_version": AssistantRealtimeDataEvent.schemaVersion]
        _ = try AssistantLiveKitDataBinding(joinedRoomName: "legacy_room", expectedRoomName: "legacy_room", roomSID: "RM_actual",
            participantIdentity: "iphone_fixture", participantAttributes: legacyAttributes,
            bootstrapCanPublishData: true, runtimeCanPublishData: true, roomIsConnected: true)
        XCTAssertThrowsError(try AssistantLiveKitDataBinding(joinedRoomName: "legacy_room", expectedRoomName: "other_room",
            roomSID: "RM_actual", participantIdentity: "iphone_fixture", participantAttributes: legacyAttributes,
            bootstrapCanPublishData: true, runtimeCanPublishData: true, roomIsConnected: true)) {
            XCTAssertEqual($0 as? LiveKitSessionError, .invalidPublisherBinding)
        }
    }

    /// Opt in with a local SFU fixture; the Node relay owns response assertions.
    func testRealSFUDesktopHandshake() async throws {
        guard let path = ProcessInfo.processInfo.environment["PAIOS_DESKTOP_SFU_CONFIG"] else {
            throw XCTSkip("PAIOS_DESKTOP_SFU_CONFIG is not configured")
        }
        let fixture = try JSONDecoder().decode(SFUFixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let root = URL(fileURLWithPath: fixture.root, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let room = SystemLiveKitRoomOperator(encryptionProvider: SFUEncryptionProvider(key: fixture.key))
        let wire = try DesktopSessionTransport(room: room, temporary: root.appendingPathComponent("incoming"))
        let desktop = try Desktop(store: root.appendingPathComponent("state"), resources: root)
        let ready = expectation(description: "relay accepted encrypted Desktop handshake")
        let audit = expectation(description: "native list_allowed_directories completed")
        let completed = expectation(description: "relay received tool response and sent pause")
        let encrypted = expectation(description: "Core verified data channel encryption")
        let stream = desktop.subscribe()
        let observer = Task {
            var sawReady = false, sawAudit = false
            for await event in stream {
                if event == .ready(true), !sawReady { sawReady = true; ready.fulfill() }
                if case .audit(let row) = event,
                   row.tool == "list_allowed_directories", row.result == "ok", !sawAudit {
                    sawAudit = true; audit.fulfill()
                }
                if case .pause(let state) = event, state.paused, sawReady && sawAudit {
                    completed.fulfill(); break
                }
            }
        }
        await desktop.start(transport: wire)
        let request = AssistantRealtimeConnectRequest(
            details: AssistantConnectionDetails(serverURL: fixture.url, roomName: fixture.roomName,
                participantToken: fixture.token,
                capabilities: AssistantMediaCapabilities(publishableSources: [], canPublishData: true)),
            intent: AssistantStartIntent(userInitiated: true),
            centralBinding: CentralTransportBinding(sessionID: "sfu-test-session",
                deviceID: "00000000-0000-4000-8000-000000000019", connectionEpoch: "sfu-test-epoch",
                expectedGatewayIdentity: fixture.gatewayIdentity, maxPacketBytes: 15_000))
        do {
            try await room.connect(request, attemptID: 1) { event in
                if case .encryptionActive = event { encrypted.fulfill() }
            }
            // Gate relay attach on completed Core setup, without touching the app GUI.
            try Data().write(to: root.appendingPathComponent("connected"))
            await fulfillment(of: [encrypted, ready, audit, completed], timeout: 40)
            let rows = try await desktop.audit(before: nil, limit: 10)
            XCTAssertTrue(rows.contains { $0.tool == "list_allowed_directories" && $0.result == "ok" })
        } catch {
            observer.cancel(); wire.finish(); await desktop.stop(); await room.stop(attemptID: 1)
            try await wire.removeTemporaryFiles()
            throw error
        }
        observer.cancel(); wire.finish(); await desktop.stop(); await room.stop(attemptID: 1)
        try await wire.removeTemporaryFiles()
    }

    private var revision: UInt64 = 0
    private func accept(_ model: DesktopAppModel, _ state: AssistantSessionState) async {
        revision += 1
        await model.accept(AssistantSessionSnapshot(state: state, revision: revision,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false))
    }
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<2000 where !condition() { try await Task.sleep(for: .milliseconds(1)) }
        XCTAssertTrue(condition())
    }
    private func within(_ delay: Duration, attempt: Int) -> Bool {
        let base = Duration.seconds(min(30, 1 << attempt))
        return delay >= base / 2 && delay <= base
    }

    func testRoomRotationKeepsDesktopSubscriptionsAndInvalidatesRelayReadiness() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let room = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let wire = try DesktopSessionTransport(room: room, temporary: root.appendingPathComponent("incoming"))
        let desktop = try Desktop(store: root.appendingPathComponent("state"), resources: root)
        var events = desktop.subscribe().makeAsyncIterator()
        let before = expectation(description: "initial handshake answered")
        let after = expectation(description: "new handshake and native tool call answered after rotation")
        after.expectedFulfillmentCount = 2
        let sink = RotationWire(wire: wire) { object in
            if object["id"] as? String == "before" { before.fulfill() }
            if ["after", "native-call"].contains(object["id"] as? String ?? "") {
                XCTAssertNotNil(object["result"])
                if object["id"] as? String == "native-call" {
                    let result = object["result"] as? [String: Any]
                    XCTAssertNotEqual(result?["isError"] as? Bool, true)
                    let structured = result?["structuredContent"] as? [String: Any]
                    XCTAssertEqual((structured?["directories"] as? [Any])?.count, 0)
                }
                after.fulfill()
            }
        }
        await desktop.start(transport: sink)
        let initialize: [String: Any] = ["protocolVersion": "2025-11-25", "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]
        func deliver(_ id: String, method: String, params: [String: Any]) async throws {
            let bytes = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": method, "params": params])
            let source = StreamReaderSource { continuation in
                continuation.yield(bytes); continuation.finish()
            }
            let reader = ByteStreamReader(info: ByteStreamInfo(id: UUID().uuidString,
                topic: DesktopSessionTransport.frameTopic, timestamp: Date(), totalLength: bytes.count,
                attributes: ["v": "1"], encryptionType: .gcm, mimeType: "application/json", name: "frame"), source: source)
            try await wire.receive(topic: DesktopSessionTransport.frameTopic, reader: reader, current: { true }, progress: {})
        }
        try await deliver("before", method: "initialize", params: initialize)
        await fulfillment(of: [before], timeout: 2)
        _ = await events.next() // initialize invalidates the previous relay confirmation.
        wire.rotate(reopen: true)
        let reset = await events.next()
        XCTAssertEqual(reset, .ready(false))
        try await deliver("after", method: "initialize", params: initialize)
        try await deliver("native-call", method: "tools/call", params: ["name": "list_allowed_directories", "arguments": [:]])
        await fulfillment(of: [after], timeout: 2)
        let audit = try await desktop.audit(before: nil, limit: 10)
        XCTAssertTrue(audit.contains { $0.tool == "list_allowed_directories" && $0.result == "ok" })
        wire.finish(); await desktop.stop(); try await wire.removeTemporaryFiles()
    }

    func testTransientSnapshotsDoNotRetireTheLogicalDesktopTransport() async throws {
        let control = FakeDesktopControl()
        let model = try DesktopAppModel(desktop: control,
            storeURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        await accept(model, .active(encryptionActive: true))
        await accept(model, .reconnecting)
        XCTAssertFalse(model.connected); XCTAssertFalse(model.desktopReady)
        await accept(model, .encryptionPreparing)
        await accept(model, .active(encryptionActive: true))
        let stops = await control.stopCalls
        XCTAssertEqual(stops, 0)
        XCTAssertTrue(model.connected)
        XCTAssertFalse(model.desktopReady, "an active room still needs the relay's readiness confirmation")
    }

    func testDelayDoublesWithJitterAndIsCappedAtThirtySeconds() {
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 0, jitter: 0), .milliseconds(500))
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 0, jitter: 1), .seconds(1))
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 3, jitter: 1), .seconds(8))
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 5, jitter: 1), .seconds(30))
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 60, jitter: 1), .seconds(30))
        XCTAssertEqual(AssistantReconnectBackoff.delay(attempt: 60, jitter: 0), .seconds(15))
    }

    /// Regression: one failed first connect became 20+ bootstraps a minute, each replacing the last before it connected.
    func testFailedConnectionWaitsOneGrowingDelayNeverOverlapsAndResetsOnSuccess() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = ManualSleep()
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root, sleep: { try await clock.sleep($0) })
        for _ in 0..<5 { await accept(model, .failed(code: "network")) }
        try await until { clock.delays.count == 1 }
        XCTAssertNotNil(model.reconnect)
        XCTAssertEqual(clock.delays.count, 1, "failures while a retry waits never start another attempt")
        XCTAssertFalse(model.connected); XCTAssertEqual(model.connectionLabel, "未连接")
        XCTAssertEqual(model.error, "连接已中断，请重新连接。", "today's wording, no connect step shown")
        for attempt in 1...6 {
            clock.elapse(); try await until { model.reconnect == nil }
            await accept(model, .failed(code: "network")); try await until { clock.delays.count == attempt + 1 }
        }
        for (attempt, delay) in clock.delays.enumerated() { XCTAssertTrue(within(delay, attempt: attempt), "attempt \(attempt): \(delay)") }

        await accept(model, .active(encryptionActive: true))
        XCTAssertTrue(model.connected); XCTAssertNil(model.reconnect)
        try await until { clock.cancelled == 1 }
        await accept(model, .failed(code: "network")); try await until { clock.delays.count == 8 }
        XCTAssertTrue(within(clock.delays[7], attempt: 0), "a connection resets the delay")

        await model.connect()
        XCTAssertNil(model.reconnect); try await until { clock.cancelled == 2 }
        await accept(model, .failed(code: "network")); try await until { clock.delays.count == 9 }
        XCTAssertTrue(within(clock.delays[8], attempt: 1), "a tap retries at once; only a connection resets the delay")
    }

    /// A room the gateway left fails its binding; the Mac starts one fresh connection (bootstrap) on the shared backoff.
    func testGatewayLeftSchedulesOneFreshConnection() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = ManualSleep()
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root, sleep: { try await clock.sleep($0) })
        for _ in 0..<3 { await accept(model, .failed(code: LiveKitSessionAdapter.gatewayLeftCode)) }
        try await until { clock.delays.count == 1 }
        XCTAssertNotNil(model.reconnect); XCTAssertTrue(within(clock.delays[0], attempt: 0))
    }

    func testRetiredClientBindingSchedulesReconnectWithoutAButton() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = ManualSleep()
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root, sleep: { try await clock.sleep($0) })
        await accept(model, .active(encryptionActive: true))
        await accept(model, .stopping)
        XCTAssertNil(model.reconnect, "cleanup still owns the connection")
        await accept(model, .stopped(remoteStopConfirmed: true))
        XCTAssertNotNil(model.reconnect, "retiring a binding must not require a manual connect step")
        await accept(model, .active(encryptionActive: true))
    }

    func testRevokedPairingNeverSchedulesARetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = ManualSleep()
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root, sleep: { try await clock.sleep($0) })
        await accept(model, .failed(code: "realtime_pairing_revoked"))
        XCTAssertNil(model.reconnect); XCTAssertTrue(clock.delays.isEmpty)
    }
}

private struct SFUFixture: Decodable {
    let url: URL
    let token: String
    let key: Data
    let gatewayIdentity: String
    let root: String
    let roomName: String
}

private struct SFUEncryptionProvider: LiveKitEncryptionOptionsProviding {
    let key: Data
    func makeEncryptionOptions(for request: AssistantRealtimeConnectRequest) async throws -> EncryptionOptions {
        let provider = BaseKeyProvider(isSharedKey: true)
        provider.setKey(keyData: key)
        return EncryptionOptions(keyProvider: provider, encryptionType: .gcm)
    }
}

/// Exercise the real incoming transport and Desktop authority while recording outbound frames locally.
private final class RotationWire: DesktopTransport, @unchecked Sendable {
    let auditDeviceID: String? = "mac-rotation-fixture"
    let wire: DesktopSessionTransport
    let response: @Sendable ([String: Any]) -> Void
    init(wire: DesktopSessionTransport, response: @escaping @Sendable ([String: Any]) -> Void) {
        self.wire = wire; self.response = response
    }
    func frames() -> AsyncStream<DesktopFrame> { wire.frames() }
    func downloads() -> AsyncStream<DesktopIncomingFile> { wire.downloads() }
    func onReset(_ handler: @escaping @Sendable () -> Void) { wire.onReset(handler) }
    func send(_ frame: Data) async throws { response(try JSONSerialization.jsonObject(with: frame) as! [String: Any]) }
    func upload(file: URL, attributes: [String: String]) async throws { throw DesktopError.unavailable }
}
