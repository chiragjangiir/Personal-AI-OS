import XCTest
import LiveKitWebRTC
@testable import LiveKit
@testable import LiveKitNanopb
@testable import HealthKitExporter

final class LiveKitSessionAdapterTests: XCTestCase {
    func testSDKCallbackOverflowFailsEstablishedAttachmentExplicitly() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let overflow = expectation(description: "bounded SDK callback overflow disconnects")
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding)) { event in
            if event == .disconnected(errorCode: "realtime_event_queue_overflow") { overflow.fulfill() }
        }
        await room.emitBurst(.centralText(try XCTUnwrap(fixture.chunks().first)), count: AssistantRealtimeEventIngress.maximumQueuedEvents * 100)
        await fulfillment(of: [overflow], timeout: 2)
        do {
            try await adapter.publishCentralTextData(Data(), binding: fixture.binding)
            XCTFail("overflowed attachment remained usable")
        } catch LiveKitSessionError.eventQueueOverflow { }
        await adapter.stop()
    }

    func testDequeuedSDKTextReturnsItsAdmissionBudget() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room), received = RealtimeEventLog()
        let size = AssistantRealtimeEventIngress.maximumQueuedEvents / 2
        let batches = (0..<3).map { expectation(description: "text batch \($0) drained") }
        batches.forEach { $0.expectedFulfillmentCount = size }
        let chunk = try XCTUnwrap(fixture.chunks().first)
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding)) { event in
            if event == .centralText(chunk) {
                received.append(event)
                batches[(received.events.count - 1) / size].fulfill()
            }
        }
        for batch in batches {
            await room.emitBurst(.centralText(chunk), count: size)
            await fulfillment(of: [batch], timeout: 2)
        }
        XCTAssertEqual(received.events.count, size * batches.count)
        try await adapter.publishCentralTextData(Data(), binding: fixture.binding)
        await adapter.stop()
    }

    func testResumeForwardsRecoveryBeforeReleasedEncryption() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder()
        let encryption = expectation(description: "initial and recovered encryption delivered")
        encryption.expectedFulfillmentCount = 2
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding)) { event in
            events.append(event)
            if event == .encryptionActive { encryption.fulfill() }
        }
        await room.emit(.resuming)
        await room.emit(.encryptionActive)
        await room.emit(.reconnected)
        await fulfillment(of: [encryption], timeout: 2)
        XCTAssertEqual(events.values, ["connected", "active", "resuming", "reconnected", "active"])
        await adapter.stop()
    }

    func testReadyForwardsOncePerAttachmentAndAllowsTimelineCatchup() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let sync = try AssistantCentralTextWire.encode("timeline_sync", fields: ["request_id": "catchup", "after_seq": 2])
        let initial = expectation(description: "initial timeline catchup"), restored = expectation(description: "recovered timeline catchup")
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { event in
            if case .centralText(let packet) = event, (try? packet.fields.value("operation", as: String.self)) == "ready" {
                Task {
                    try await adapter.publishCentralTextData(sync, binding: fixture.binding)
                    if await room.publishedPackets.count == 1 { initial.fulfill() } else { restored.fulfill() }
                }
            }
        })
        await fulfillment(of: [initial], timeout: 2)
        var sent = await room.publishedPackets
        XCTAssertEqual(sent.map(\.data), [sync])
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        for _ in 0..<20 { await Task.yield() }
        sent = await room.publishedPackets; XCTAssertEqual(sent.count, 1)
        await room.emit(.reconnecting); await room.emit(.reconnected); await room.emit(.encryptionActive)
        for _ in 0..<20 { await Task.yield() }
        sent = await room.publishedPackets; XCTAssertEqual(sent.count, 1)
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        await fulfillment(of: [restored], timeout: 2)
        sent = await room.publishedPackets; XCTAssertEqual(sent.map(\.data), [sync, sync])
        await adapter.stop()
    }

    func testReaderFailureFromPreviousAttachmentCannotDisconnectRecoveredRoom() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), oldStarted = expectation(description: "old handler running")
        let recovered = expectation(description: "new attachment handles bytes")
        let disconnected = expectation(description: "stale failure must not disconnect"); disconnected.isInverted = true
        let release = AsyncStream<Void>.makeStream()
        core.configureByteStreams(topics: ["paios.desktop.mcp.v1"]) { _, reader, _ in
            if reader.info.id == "old" {
                oldStarted.fulfill()
                for await _ in release.stream { break }
                throw CancellationError()
            }
            var bytes = Data()
            for try await chunk in reader { bytes.append(chunk) }
            XCTAssertEqual(bytes, Data("initialize".utf8)); recovered.fulfill()
        }
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "mac", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        _ = try core.beginAttempt(attemptID: 1, events: { event in if case .disconnected = event { disconnected.fulfill() } }, capabilities: .none, roomName: "desktop", centralBinding: binding)
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        try room._state.mutate { state in
            try state.stage.begin(dependencies); state.connectionState = .connected
            _ = state.updateRemoteParticipant(info: .with { $0.sid = "PA_gateway"; $0.identity = "gateway" }, room: room)
        }
        try await core.registerCentralByteStreams(in: room, attemptID: 1)
        func header(_ id: String) -> Livekit_DataStream.Header {
            .with { $0.streamID = id; $0.topic = "paios.desktop.mcp.v1"; $0.mimeType = "application/json"; $0.totalLength = 10; $0.contentHeader = .byteHeader(.with { $0.name = "frame" }) }
        }
        room.incomingStreamManager.handle(.header(header("old"), "gateway", .gcm))
        await fulfillment(of: [oldStarted], timeout: 2)
        core.room(room, didStartReconnectWithMode: .quick)
        core.room(room, didCompleteReconnectWithMode: .quick)
        release.continuation.yield(()); release.continuation.finish()
        await fulfillment(of: [disconnected], timeout: 0.2)
        room.incomingStreamManager.handle(.header(header("new"), "gateway", .gcm))
        room.incomingStreamManager.handle(.chunk(.with { $0.streamID = "new"; $0.content = Data("initialize".utf8) }, .gcm))
        room.incomingStreamManager.handle(.trailer(.with { $0.streamID = "new" }, .gcm))
        await fulfillment(of: [recovered], timeout: 2)
        await core.stop(attemptID: 1)
    }

    func testA84IncomingWriterCancellationPreservesEncryptedChat() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), cancelled = expectation(description: "incoming writer cancelled")
        let chat = expectation(description: "chat remains usable")
        let disconnected = expectation(description: "pause must not disconnect chat"); disconnected.isInverted = true
        core.configureByteStreams(topics: ["paios.desktop.file.v1"]) { _, _, _ in
            let source = AsyncStream<Void>.makeStream()
            let writer = Task { for await _ in source.stream {}; try Task.checkCancellation() }
            writer.cancel()
            do { try await writer.value; XCTFail("writer should cancel") }
            catch { cancelled.fulfill(); throw error }
        }
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "mac", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        _ = try core.beginAttempt(attemptID: 1, events: { event in
            if case .disconnected = event { disconnected.fulfill() }
            if case .centralText = event { chat.fulfill() }
        }, capabilities: .none, roomName: "desktop", centralBinding: binding)
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        try room._state.mutate { try $0.stage.begin(dependencies); $0.connectionState = .connected }
        try await core.registerCentralByteStreams(in: room, attemptID: 1)
        room.incomingStreamManager.handle(.header(.with {
            $0.streamID = "paused-transfer"; $0.topic = "paios.desktop.file.v1"; $0.totalLength = 1
            $0.mimeType = "application/octet-stream"; $0.contentHeader = .byteHeader(.with { $0.name = "file" })
        }, "gateway", .gcm))
        await fulfillment(of: [cancelled], timeout: 2)
        await fulfillment(of: [disconnected], timeout: 0.2)
        let remote = RemoteParticipant(info: .with { $0.sid = "remote"; $0.identity = "gateway" }, room: room, connectionState: .connected)
        let text = try JSONSerialization.data(withJSONObject: ["schema_version": AssistantCentralTextWire.schema,
            "session_id": "session", "operation": "call_state", "call_id": "chat-still-live", "state": "live"])
        core.room(room, participant: remote, didReceiveData: text, forTopic: AssistantCentralTextWire.outputTopic, encryptionType: .gcm)
        await fulfillment(of: [chat], timeout: 2)
        await core.stop(attemptID: 1)
    }

    func testCameraUploadCancellationAndFailureCloseOnlyItsStream() async throws {
        for cancelled in [false, true] {
            let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
            let room = Room(), gate = ConnectGate()
            let disconnected = expectation(description: "photo failure keeps call room"); disconnected.isInverted = true
            let binding = CentralTransportBinding(sessionID: "session", deviceID: "01900000-0000-7000-8000-000000000001", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
            _ = try core.beginAttempt(attemptID: 1, events: { event in if case .disconnected = event { disconnected.fulfill() } },
                capabilities: AssistantMediaCapabilities(publishableSources: [], canPublishData: true), roomName: "call", centralBinding: binding)
            XCTAssertTrue(core.attachRoom(room, attemptID: 1))
            room.localParticipant._state.mutate { $0.identity = .init(from: "phone"); $0.permissions = ParticipantPermissions(canPublishData: true) }
            let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
            try room._state.mutate { try $0.stage.begin(dependencies); $0.connectionState = .connected; $0.name = "call"; $0.sid = .init(from: "RM_test") }
            let closed = expectation(description: "failed photo stream closes")
            room.outgoingStreamManager = OutgoingStreamManager(packetHandler: { packet in
                if case .streamTrailer = packet.value { closed.fulfill() }
                if case .streamChunk = packet.value {
                    if cancelled {
                        await gate.markStarted(); await gate.waitUntilReleased()
                        try Task.checkCancellation()
                    } else { throw CentralTextError.unavailable }
                }
            }, encryptionProvider: { .gcm })
            let upload = Task {
                var sent = false
                try await core.sendCentralBytes(topic: "paios.assistant.camera.v1", mime: "image/jpeg", attributes: [:], size: 1) {
                    defer { sent = true }
                    return sent ? nil : Data([1])
                }
            }
            if cancelled { await gate.waitUntilStarted(); upload.cancel(); await gate.release() }
            do { try await upload.value; XCTFail("photo failure must reach caller") }
            catch is CancellationError { XCTAssertTrue(cancelled) }
            catch CentralTextError.unavailable { XCTAssertFalse(cancelled) }
            catch { XCTFail("Unexpected photo failure: \(error)") }
            await fulfillment(of: [closed], timeout: 2)
            await fulfillment(of: [disconnected], timeout: 0.1)
            let retained = try await core.currentDataBinding(attemptID: 1)
            XCTAssertEqual(retained.centralBinding, binding)
            await core.stop(attemptID: 1)
        }
    }

    func testFailedNormalUploadCloseRetiresAttachmentInsteadOfReportingSuccess() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), disconnected = expectation(description: "failed trailer retires attachment")
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "01900000-0000-7000-8000-000000000001", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        _ = try core.beginAttempt(attemptID: 1, events: { event in if case .disconnected = event { disconnected.fulfill() } }, capabilities: AssistantMediaCapabilities(publishableSources: [], canPublishData: true), roomName: "desktop", centralBinding: binding)
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        room.localParticipant._state.mutate { $0.identity = .init(from: "mac"); $0.permissions = ParticipantPermissions(canPublishData: true) }
        let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        try room._state.mutate { try $0.stage.begin(dependencies); $0.connectionState = .connected; $0.name = "desktop"; $0.sid = .init(from: "RM_test") }
        room.outgoingStreamManager = OutgoingStreamManager(packetHandler: { packet in
            if case .streamTrailer = packet.value { throw CentralTextError.unavailable }
        }, encryptionProvider: { .gcm })
        do {
            try await core.sendCentralBytes(topic: "paios.desktop.file.v1", mime: "application/octet-stream", attributes: [:], size: 0, next: { nil })
            XCTFail("SDK-suppressed trailer failure must reach the caller")
        } catch CentralTextError.unavailable { }
        catch { XCTFail("Unexpected failure: \(error)") }
        await fulfillment(of: [disconnected], timeout: 2)
        do { _ = try await core.currentDataBinding(attemptID: 1); XCTFail("failed attachment remained usable") }
        catch { }
        await core.stop(attemptID: 1)
    }

    func testI1I15DesktopStreamSenderRequiresCurrentEncryptedGateway() throws {
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "mac", connectionEpoch: "epoch", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        XCTAssertTrue(SystemLiveKitRoomOperator.acceptsCentralSender(binding: binding, sender: "gateway", remotes: [(identity: "gateway", canPublishData: true)], encrypted: true, current: true))
        XCTAssertFalse(SystemLiveKitRoomOperator.acceptsCentralSender(binding: binding, sender: "intruder", remotes: [(identity: "gateway", canPublishData: true)], encrypted: true, current: true))
        XCTAssertFalse(SystemLiveKitRoomOperator.acceptsCentralSender(binding: binding, sender: "gateway", remotes: [(identity: "gateway", canPublishData: true)], encrypted: false, current: true))
        XCTAssertFalse(SystemLiveKitRoomOperator.acceptsCentralSender(binding: binding, sender: "gateway", remotes: [(identity: "gateway", canPublishData: true)], encrypted: true, current: false))
        XCTAssertFalse(SystemLiveKitRoomOperator.acceptsCentralSender(binding: nil, sender: "gateway", remotes: [(identity: "gateway", canPublishData: true)], encrypted: true, current: true))
    }

    func testReplacementCallAudioRestoresReceiverVolumeAfterTwoRetirements() async throws {
        let operation = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), configuration = LKRTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let candidateConnection = await RTC.createPeerConnection(configuration, constraints: LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let connection = try XCTUnwrap(candidateConnection)
        defer { connection.close() }
        let receiverTrack = try XCTUnwrap(connection.addTransceiver(of: .audio)?.receiver.track)
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "phone", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        let attempt = try operation.beginAttempt(attemptID: 1, events: { _ in }, capabilities: .none, roomName: "call", centralBinding: binding)
        XCTAssertTrue(operation.attachRoom(room, attemptID: attempt))
        let remoteInfo = Livekit_ParticipantInfo.with { $0.sid = "remote"; $0.identity = "gateway" }
        let remote = RemoteParticipant(info: remoteInfo, room: room, connectionState: .connected)
        let dependencies = ConnectionDependencies(room: room,
            roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        try room._state.mutate {
            try $0.stage.begin(dependencies)
            $0.remoteParticipants[remote.identity!] = remote; $0.connectionState = .connected
        }
        XCTAssertTrue(SystemLiveKitRoomOperator.isDataChannelEncryptionActive(room.e2eeManager), "Fixture must admit authenticated playback-reset frames")
        func receive(_ fields: [String: Any]) throws {
            let data = try JSONSerialization.data(withJSONObject: fields.merging(["schema_version": "paios.central.text-envelope.v1", "session_id": "session", "call_id": "call"]) { _, value in value })
            operation.room(room, participant: remote, didReceiveData: data, forTopic: AssistantCentralTextWire.outputTopic, encryptionType: .gcm)
        }
        try receive(["operation": "call_state", "state": "live"])
        await operation.setCallPlaybackID("call", attemptID: attempt)
        // The SFU reuses an RTP receiver. New publication wrappers share its existing WebRTC audio source.
        for sid in ["A", "B", "C"] {
            let track = RemoteAudioTrack(name: sid, source: .microphone, track: RTCMediaTrack(receiverTrack), reportStatistics: false)
            let trackInfo = Livekit_TrackInfo.with { $0.sid = sid; $0.type = .audio }
            let publication = RemoteTrackPublication(info: trackInfo, participant: remote)
            await publication.set(track: track)
            remote.add(publication: publication)
            try await track.start()
            operation.room(room, participant: remote, didSubscribeTrack: publication)
            if sid != "C" {
                try receive(["operation": "call_playback_reset", "track_sid": sid])
                XCTAssertEqual(track.volume, 0, "retirement of \(sid) mutes the reused receiver")
            } else {
                XCTAssertEqual(track.volume, 1, "a replacement must play even when its reused receiver was muted")
                try receive(["operation": "call_playback_reset", "track_sid": "B"])
                XCTAssertEqual(track.volume, 1, "a late reset must not mute the live reused receiver")
            }
        }
        let currentTrack = try XCTUnwrap(remote.trackPublications.values.first { $0.sid.stringValue == "C" }?.track as? RemoteAudioTrack)
        await operation.setCallPlaybackID(nil, attemptID: attempt)
        XCTAssertEqual(currentTrack.volume, 0, "local hangup closes playback before server acknowledgement")
        try receive(["operation": "call_state", "state": "live"])
        XCTAssertEqual(currentTrack.volume, 0, "an old call-state packet cannot reopen playback")
        await operation.setCallPlaybackID("next-call", attemptID: attempt)
        XCTAssertEqual(currentTrack.volume, 1, "only the admitted call owner restores playback")
        await operation.stop(attemptID: attempt)
    }

    func testInitialJoinTimeoutRetriesWithinOneConnectionWithoutDisconnectingCaller() async throws {
        let room = FakeLiveKitRoomOperator(connectFailures: [.timedOut, .network])
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let events = ReconnectEventRecorder()
        try await adapter.connect(makeRequest(microphone: false, camera: false)) { events.append($0) }
        let count = await room.connectCount
        XCTAssertEqual(count, 3)
        XCTAssertEqual(events.values, ["connected"])
        await adapter.stop()
    }

    @MainActor
    func testCameraPreviewPrecedesPublicationAndReturnsOnReenableWithoutPublishCallback() async throws {
        let preview = AssistantVideoPreviewModel(), gate = ConnectGate()
        let operation = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider(),
            videoTrackObserver: { preview.update($0) }, cameraActivation: { participant, track, reusing in
                await gate.markStarted(); await gate.waitUntilReleased()
                if !reusing {
                    let info = Livekit_TrackInfo.with { $0.sid = "camera-preview"; $0.source = .camera; $0.type = .video }
                    let publication = LocalTrackPublication(info: info, participant: participant)
                    await publication.set(track: track)
                    participant.add(publication: publication)
                }
            })
        let room = Room()
        _ = room.localParticipant.set(permissions: ParticipantPermissions(canPublish: true))
        let attempt = try operation.beginAttempt(attemptID: 1, events: { _ in }, capabilities: AssistantMediaCapabilities(publishableSources: [.camera], canPublishData: false), roomName: "preview")
        XCTAssertTrue(operation.attachRoom(room, attemptID: attempt))
        let remoteInfo = Livekit_ParticipantInfo.with { $0.sid = "remote"; $0.identity = "gateway" }
        let remote = RemoteParticipant(info: remoteInfo, room: room, connectionState: .connected)
        let remoteTrack = await LocalVideoTrack.createCameraTrack()
        let avatarInfo = Livekit_TrackInfo.with { $0.sid = "avatar"; $0.type = .video }
        let remotePublication = RemoteTrackPublication(info: avatarInfo, participant: remote)
        await remotePublication.set(track: remoteTrack)
        operation.room(room, participant: remote, didPublishTrack: remotePublication)
        let opening = Task { try await operation.setMedia(source: .camera, enabled: true, userInitiated: true, attemptID: attempt) }
        await gate.waitUntilStarted(); await Task.yield()
        let original = try XCTUnwrap(preview.localVideoTrack)
        await gate.release(); try await opening.value
        try await operation.setMedia(source: .camera, enabled: false, userInitiated: true, attemptID: attempt)
        await Task.yield(); XCTAssertNil(preview.localVideoTrack)
        if let publication = room.localParticipant.firstCameraPublication as? LocalTrackPublication {
            operation.room(room, participant: room.localParticipant, didPublishTrack: publication)
        }
        await Task.yield(); XCTAssertNil(preview.localVideoTrack, "late publication notification cannot restore a muted preview")
        XCTAssertTrue(preview.remoteVideoTrack === remoteTrack, "muting the camera preserves the remote avatar")
        try await operation.setMedia(source: .camera, enabled: true, userInitiated: true, attemptID: attempt)
        await Task.yield()
        XCTAssertTrue(preview.localVideoTrack === original, "SDK reuses the publication without another didPublish callback")
        await operation.stop(attemptID: attempt); await Task.yield(); XCTAssertNil(preview.localVideoTrack)
    }

    @MainActor
    func testCameraPublicationFailureOrStopClearsEarlyPreview() async throws {
        for stopping in [false, true] {
            let preview = AssistantVideoPreviewModel(), gate = ConnectGate()
            let operation = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider(),
                videoTrackObserver: { preview.update($0) }, cameraActivation: { _, _, _ in
                    await gate.markStarted(); await gate.waitUntilReleased()
                    if !stopping { throw LiveKitError(.network) }
                })
            let room = Room()
            _ = room.localParticipant.set(permissions: ParticipantPermissions(canPublish: true))
            let attempt = try operation.beginAttempt(attemptID: 1, events: { _ in }, capabilities: AssistantMediaCapabilities(publishableSources: [.camera], canPublishData: false), roomName: "preview")
            XCTAssertTrue(operation.attachRoom(room, attemptID: attempt))
            let opening = Task { try await operation.setMedia(source: .camera, enabled: true, userInitiated: true, attemptID: attempt) }
            await gate.waitUntilStarted(); await Task.yield()
            XCTAssertNotNil(preview.localVideoTrack)
            if stopping { await operation.stop(attemptID: attempt) }
            await gate.release()
            do { try await opening.value; XCTFail("failed or stopped publication must surface its error") }
            catch {
                if stopping { XCTAssertEqual(error as? LiveKitSessionError, .superseded) }
                else { XCTAssertEqual((error as? LiveKitError)?.type, .network) }
            }
            await Task.yield(); XCTAssertNil(preview.localVideoTrack)
            await operation.stop(attemptID: attempt)
        }
    }

    /// M4: the SDK's own microphone off only mutes (the device keeps recording); off unpublishes unless a call keeps
    /// the muted track published, and an off without a track is a no-op.
    func testMicrophoneOffUnpublishesUnlessACallKeepsItMuted() async throws {
        for keep in [false, true] {
            let operation = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
            let room = Room()
            _ = room.localParticipant.set(permissions: ParticipantPermissions(canPublish: true))
            let attempt = try operation.beginAttempt(attemptID: 1, events: { _ in }, capabilities: AssistantMediaCapabilities(publishableSources: [.microphone], canPublishData: false), roomName: "microphone")
            XCTAssertTrue(operation.attachRoom(room, attemptID: attempt))
            let info = Livekit_TrackInfo.with { $0.sid = "microphone"; $0.source = .microphone; $0.type = .audio }
            let publication = LocalTrackPublication(info: info, participant: room.localParticipant)
            let track = await LocalAudioTrack.createTrack()
            await publication.set(track: track)
            room.localParticipant.add(publication: publication)
            try await operation.setMedia(source: .microphone, enabled: false, userInitiated: true, keepPublished: keep, attemptID: attempt)
            XCTAssertEqual(room.localParticipant.localAudioTracks.count, keep ? 1 : 0, "keep=\(keep)")
            XCTAssertEqual(publication.isMuted, keep)
            try await operation.setMedia(source: .microphone, enabled: false, userInitiated: true, attemptID: attempt)
            XCTAssertTrue(room.localParticipant.localAudioTracks.isEmpty, "a call's muted track is unpublished after the call")
            await operation.stop(attemptID: attempt)
        }
    }

    func testDataEncryptionGuardRejectsNoneFrameType() {
        let keyProvider = BaseKeyProvider(isSharedKey: true)
        let manager = E2EEManager(
            options: EncryptionOptions(
                keyProvider: keyProvider,
                encryptionType: .none
            )
        )

        XCTAssertFalse(
            SystemLiveKitRoomOperator
                .isDataChannelEncryptionActive(manager)
        )
        XCTAssertFalse(
            SystemLiveKitRoomOperator
                .isDataChannelEncryptionActive(nil)
        )
    }

    func testDataOnlyReconnectUsesOperatorAndRejectsStaleRooms() async throws {
        let events = ReconnectEventRecorder()
        let operation = SystemLiveKitRoomOperator(
            encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider(),
            reconnectedDataEncryptionVerifier: { _ in true }
        )
        let oldRoom = Room()
        let oldAttempt = try operation.beginAttempt(attemptID: 1, events: { events.append($0) },
            capabilities: .none, roomName: "old")
        XCTAssertTrue(operation.attachRoom(oldRoom, attemptID: oldAttempt))
        let currentRoom = Room()
        let currentAttempt = try operation.beginAttempt(attemptID: 2, events: { events.append($0) },
            capabilities: .none, roomName: "current")
        XCTAssertTrue(operation.attachRoom(currentRoom, attemptID: currentAttempt))
        XCTAssertFalse(operation.attachRoom(oldRoom, attemptID: oldAttempt))
        await operation.stop(attemptID: oldAttempt)
        operation.room(oldRoom, didCompleteReconnectWithMode: .full)
        XCTAssertEqual(events.values, [])
        operation.room(currentRoom, didStartReconnectWithMode: .quick)
        operation.room(currentRoom, didCompleteReconnectWithMode: .quick)
        XCTAssertEqual(events.values, ["resuming", "reconnected", "active"])
        operation.room(currentRoom, didStartReconnectWithMode: .quick)
        operation.room(currentRoom, didUpdateReconnectMode: .full)
        operation.room(currentRoom, didCompleteReconnectWithMode: .full)
        XCTAssertEqual(events.values, ["resuming", "reconnected", "active", "resuming", "reconnecting", "reconnected", "active"])
        await operation.stop(attemptID: currentAttempt)
        operation.room(currentRoom, didCompleteReconnectWithMode: .full)
        XCTAssertEqual(events.values.count, 7)
    }

    func testDataOnlyReconnectFailsClosedWithoutEncryption() async throws {
        let events = ReconnectEventRecorder()
        let operation = SystemLiveKitRoomOperator(
            encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider(),
            reconnectedDataEncryptionVerifier: { _ in false }
        )
        let room = Room()
        let attempt = try operation.beginAttempt(attemptID: 1, events: { events.append($0) },
            capabilities: .none, roomName: "current")
        XCTAssertTrue(operation.attachRoom(room, attemptID: attempt))
        operation.room(room, didCompleteReconnectWithMode: .full)
        XCTAssertEqual(events.values, ["failed"])
        await operation.stop(attemptID: attempt)
    }

    func testGatewayDepartureLeavesTheRoomAndReportsItOnce() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), log = RealtimeEventLog()
        _ = try core.beginAttempt(attemptID: 1, events: log.append, capabilities: .none, roomName: "desktop", centralBinding: gatewayBinding("gateway"))
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        let remotes = try connect(room, remotes: ["gateway", "watch"])
        let gateway = remotes["gateway"]!, watch = remotes["watch"]!
        room._state.mutate { $0.remoteParticipants[Participant.Identity(from: "watch")] = nil }
        core.room(room, participantDidDisconnect: watch)
        // SDK-wide teardowns report the gateway while still listing it; that is the SDK's own disconnect/reconnect.
        core.room(room, participantDidDisconnect: gateway)
        XCTAssertEqual(log.events, [])
        room._state.mutate { $0.remoteParticipants[Participant.Identity(from: "gateway")] = nil }
        core.room(room, participantDidDisconnect: gateway)
        core.room(room, participantDidDisconnect: gateway)
        core.room(room, didDisconnectWithError: nil)
        XCTAssertEqual(log.events, [.disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode)])
        do { _ = try await core.currentDataBinding(attemptID: 1); XCTFail("the client stayed in the room the gateway left") }
        catch { XCTAssertEqual(error as? LiveKitSessionError, .superseded) }
        await core.stop(attemptID: 1)
    }

    func testGatewayDepartureFromAStaleRoomAttemptOrBindingIsIgnored() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let log = RealtimeEventLog(), oldRoom = Room(), currentRoom = Room()
        _ = try core.beginAttempt(attemptID: 1, events: log.append, capabilities: .none, roomName: "old", centralBinding: gatewayBinding("gateway"))
        XCTAssertTrue(core.attachRoom(oldRoom, attemptID: 1))
        let oldGateway = try connect(oldRoom, remotes: ["gateway"])["gateway"]!
        _ = try core.beginAttempt(attemptID: 2, events: log.append, capabilities: .none, roomName: "current", centralBinding: gatewayBinding("gateway-2"))
        XCTAssertTrue(core.attachRoom(currentRoom, attemptID: 2))
        let current = try connect(currentRoom, remotes: ["gateway", "gateway-2"])
        oldRoom._state.mutate { $0.remoteParticipants = [:] }
        core.room(oldRoom, participantDidDisconnect: oldGateway)
        currentRoom._state.mutate { $0.remoteParticipants[Participant.Identity(from: "gateway")] = nil }
        core.room(currentRoom, participantDidDisconnect: current["gateway"]!)
        XCTAssertEqual(log.events, [])
        await core.stop(attemptID: 2)
        currentRoom._state.mutate { $0.remoteParticipants = [:] }
        core.room(currentRoom, participantDidDisconnect: current["gateway-2"]!)
        XCTAssertEqual(log.events, [])
    }

    func testReconnectIntoARoomTheGatewayLeftLosesTheRoom() async throws {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider(),
            reconnectedDataEncryptionVerifier: { _ in true })
        let log = RealtimeEventLog(), room = Room()
        _ = try core.beginAttempt(attemptID: 1, events: log.append, capabilities: .none, roomName: "desktop", centralBinding: gatewayBinding("gateway"))
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        let gateway = try connect(room, remotes: ["gateway"])["gateway"]!
        core.room(room, didStartReconnectWithMode: .quick)
        core.room(room, didCompleteReconnectWithMode: .quick)
        XCTAssertEqual(log.events, [.resuming, .reconnected, .encryptionActive])
        core.room(room, didStartReconnectWithMode: .full)
        // A full reconnect drops every participant while reconnecting: not a departure. The rejoined room lacks the gateway.
        room._state.mutate { $0.remoteParticipants = [:]; $0.connectionState = .reconnecting }
        core.room(room, participantDidDisconnect: gateway)
        room._state.mutate { $0.connectionState = .connected }
        core.room(room, didCompleteReconnectWithMode: .full)
        core.room(room, didDisconnectWithError: nil)
        XCTAssertEqual(log.events, [.resuming, .reconnected, .encryptionActive, .reconnecting, .disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode)])
        await core.stop(attemptID: 1)
    }

    private func gatewayBinding(_ gateway: String) -> CentralTransportBinding {
        CentralTransportBinding(sessionID: "session", deviceID: "mac", connectionEpoch: "1", expectedGatewayIdentity: gateway, maxPacketBytes: 12288)
    }

    private func connect(_ room: Room, remotes: [String]) throws -> [String: RemoteParticipant] {
        let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        return try room._state.mutate { state in
            try state.stage.begin(dependencies); state.connectionState = .connected
            var added: [String: RemoteParticipant] = [:]
            for identity in remotes {
                added[identity] = state.updateRemoteParticipant(info: .with { $0.sid = "PA_" + identity; $0.identity = identity }, room: room)
            }
            return added
        }
    }

    func testRejectsNonWSSBeforeConnecting() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let request = makeRequest(
            url: "https://example.livekit.cloud",
            microphone: false,
            camera: false
        )

        do {
            try await adapter.connect(request) { _ in }
            XCTFail("Expected invalidServerURL")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .invalidServerURL
            )
        }
        let count = await room.connectCount
        XCTAssertEqual(count, 0)
    }

    func testRejectsCameraWithoutBootstrapGrant() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let request = makeRequest(
            microphone: false,
            camera: true,
            allowed: [.microphone]
        )

        do {
            try await adapter.connect(request) { _ in }
            XCTFail("Expected mediaNotGranted")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .mediaNotGranted(.camera)
            )
        }
        let count = await room.connectCount
        XCTAssertEqual(count, 0)
    }

    func testForwardsOnlyExplicitMediaChanges() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(
            makeRequest(
                microphone: true,
                camera: false,
                allowed: [.microphone]
            )
        ) { _ in }

        try await adapter.setMedia(
            source: .microphone,
            enabled: false,
            userInitiated: true
        )

        let calls = await room.mediaCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.source, .microphone)
        XCTAssertEqual(calls.first?.enabled, false)
    }

    func testStopIsIdempotent() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest()) { _ in }

        await adapter.stop()
        await adapter.stop()

        let count = await room.stopCount
        XCTAssertEqual(count, 1)
    }

    func testStopDuringInFlightConnectSupersedesAttempt() async throws {
        let gate = ConnectGate()
        let room = FakeLiveKitRoomOperator(connectGate: gate)
        let adapter = LiveKitSessionAdapter(roomOperator: room)

        let connectTask = Task {
            try await adapter.connect(makeRequest()) { _ in }
        }
        await gate.waitUntilStarted()

        await adapter.stop()
        await gate.release()

        do {
            try await connectTask.value
            XCTFail("Expected superseded")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .superseded
            )
        }

        let stopCount = await room.stopCount
        XCTAssertGreaterThanOrEqual(stopCount, 1)
        do {
            try await adapter.setMedia(
                source: .microphone,
                enabled: true,
                userInitiated: true
            )
            XCTFail("Expected notConnected")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .notConnected
            )
        }
    }

    func testLateConnectSuccessOrFailureCannotStopReplacement() async throws {
        for fails in [false, true] {
            let gate = ConnectGate()
            let room = FakeLiveKitRoomOperator(connectGate: gate, lateConnectError: fails ? .e2eeUnavailable : nil)
            let adapter = LiveKitSessionAdapter(roomOperator: room)
            let old = Task { try await adapter.connect(makeRequest(canPublishData: true)) { _ in } }
            await gate.waitUntilStarted()
            await adapter.stop()
            try await adapter.connect(makeRequest(canPublishData: true)) { _ in }
            await gate.release()
            do { try await old.value; XCTFail("Old connect must be superseded") }
            catch { XCTAssertEqual(error as? LiveKitSessionError, .superseded) }
            do { try await adapter.publishPrompt(AssistantPromptEnvelope(promptID: "018bcfe5-6800-7001-8000-000000000101", text: "B is still connected")) }
            catch { XCTFail("B lost after A's late \(fails ? "failure" : "success"): \(error)") }
            let packets = await room.publishedPackets, stops = await room.stopCount
            XCTAssertEqual(packets.count, 1)
            XCTAssertEqual(stops, 1, "A must not tear down B")
            await adapter.stop()
        }
    }

    func testPublishesClosedWatchPacketReliablyOnSingleTopic() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true)) { _ in }

        try await adapter.publish(makeWorkoutEvent())

        let packets = await room.publishedPackets
        let packet = try XCTUnwrap(packets.first)
        XCTAssertEqual(packets.count, 1)
        XCTAssertEqual(packet.topic, "paios.phase0.demo.event")
        XCTAssertTrue(packet.reliable)
        XCTAssertTrue(packet.destinationIdentities.isEmpty)

        let expectedKeys = [
            "schema_version", "event_type", "event_id", "session_id",
            "trace_id", "occurred_at", "expires_at", "origin",
            "connection", "sequence", "idempotency_key", "payload"
        ]
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: packet.data)
                as? [String: Any]
        )
        XCTAssertEqual(Set(json.keys), Set(expectedKeys))
        let origin = try XCTUnwrap(json["origin"] as? [String: Any])
        let relay = try XCTUnwrap(origin["relay"] as? [String: Any])
        XCTAssertEqual(Set(relay.keys), Set([
            "device_id", "device_class", "transport"
        ]))
        XCTAssertEqual(relay["device_id"] as? String, "iphone_01")
        XCTAssertEqual(relay["device_class"] as? String, "iphone")
        XCTAssertEqual(
            relay["transport"] as? String,
            "watch_connectivity"
        )
        XCTAssertNil(relay["relay_device_id"])
        XCTAssertNil(relay["relay_device_class"])
    }

    func testPublishesPromptPacketOnDedicatedReliableTopic() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true)) { _ in }

        let prompt = AssistantPromptEnvelope(
            promptID: "550e8400-e29b-41d4-a716-446655440000",
            text: "18乘以7是多少？请只回答数字。"
        )
        try await adapter.publishPrompt(prompt)

        let packets = await room.publishedPackets
        let packet = try XCTUnwrap(
            packets.first {
                $0.topic == AssistantPromptEnvelope.topic
            }
        )
        XCTAssertTrue(packet.reliable)
        XCTAssertTrue(packet.destinationIdentities.isEmpty)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: packet.data)
                as? [String: Any]
        )
        XCTAssertEqual(
            Set(json.keys),
            Set(["prompt_id", "text"])
        )
        XCTAssertEqual(
            try AssistantPromptEnvelope.decodeStrict(packet.data),
            prompt
        )
    }

    func testPromptWireUsesUTF8AndWholePacketLimits() throws {
        let valid = AssistantPromptEnvelope(
            promptID: "550e8400-e29b-41d4-a716-446655440000",
            text: "中文🙂"
        )
        let data = try valid.encodedStrict()
        XCTAssertLessThanOrEqual(data.count, 12_288)
        XCTAssertEqual(
            try AssistantPromptEnvelope.decodeStrict(data),
            valid
        )

        let oversized = AssistantPromptEnvelope(
            promptID: "550e8400-e29b-41d4-a716-446655440000",
            text: String(repeating: "你", count: 2_731)
        )
        XCTAssertThrowsError(try oversized.encodedStrict())
    }

    func testResultLegacyFinalAliasStillDecodes() throws {
        let data = Data(
            #"{"stream_id":"prompt-1","sequence":1,"text":"126","final":true}"#
                .utf8
        )
        let envelope = try XCTUnwrap(
            AssistantResultEnvelope.decode(data)
        )
        XCTAssertTrue(envelope.isFinal)
        XCTAssertNil(envelope.errorCode)
    }

    func testDataPublishFailsClosedWithoutEitherDataGrant() async throws {
        let bootstrapRoom = FakeLiveKitRoomOperator()
        let bootstrapAdapter = LiveKitSessionAdapter(
            roomOperator: bootstrapRoom
        )
        try await bootstrapAdapter.connect(makeRequest()) { _ in }

        do {
            try await bootstrapAdapter.publish(makeWorkoutEvent())
            XCTFail("Expected dataNotGranted")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .dataNotGranted
            )
        }
        let bootstrapPackets = await bootstrapRoom.publishedPackets
        XCTAssertTrue(bootstrapPackets.isEmpty)

        let runtimeRoom = FakeLiveKitRoomOperator(
            runtimeCanPublishData: false
        )
        let runtimeAdapter = LiveKitSessionAdapter(roomOperator: runtimeRoom)
        try await runtimeAdapter.connect(
            makeRequest(canPublishData: true)
        ) { _ in }
        do {
            try await runtimeAdapter.publish(makeWorkoutEvent())
            XCTFail("Expected dataNotGranted")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .dataNotGranted
            )
        }
        let runtimePackets = await runtimeRoom.publishedPackets
        XCTAssertTrue(runtimePackets.isEmpty)
    }

    func testDataPublishRejectsParticipantIdentityMismatchBeforeEncoding()
        async throws {
        let room = FakeLiveKitRoomOperator(
            participantIdentity: "iphone_other"
        )
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true)) { _ in }

        do {
            try await adapter.publish(makeWorkoutEvent())
            XCTFail("Expected invalidPublisherBinding")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .invalidPublisherBinding
            )
        }
        let packets = await room.publishedPackets
        XCTAssertTrue(packets.isEmpty)
    }

    func testDataPublishRejectsStoppedSession() async throws {
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true)) { _ in }
        await adapter.stop()

        do {
            try await adapter.publish(makeWorkoutEvent())
            XCTFail("Expected notConnected")
        } catch {
            XCTAssertEqual(error as? LiveKitSessionError, .notConnected)
        }
        let packets = await room.publishedPackets
        XCTAssertTrue(packets.isEmpty)
    }

    func testUnavailableEncryptionProviderFailsClosed() async {
        let provider = UnavailableLiveKitEncryptionOptionsProvider()
        do {
            _ = try await provider.makeEncryptionOptions()
            XCTFail("Expected e2eeUnavailable")
        } catch {
            XCTAssertEqual(
                error as? LiveKitSessionError,
                .e2eeUnavailable
            )
        }
    }

    func testWireFixtureMapsLocalContextWithoutWireFields() throws {
        let fixture = AssistantResultEnvelope(
            streamID: "fixture-stream",
            sequence: 2,
            text: "fixture final",
            isFinal: true,
            sessionID: "local-session-should-not-ship",
            epoch: 99
        )
        let data = try XCTUnwrap(fixture.encoded())
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertNil(json["local_session_id"])
        XCTAssertNil(json["local_epoch"])
        XCTAssertNil(json["session_id"])
        XCTAssertNil(json["epoch"])

        let decoded = try XCTUnwrap(
            AssistantResultEnvelope.decode(data)
        )
        XCTAssertEqual(decoded.sessionID, "fixture-stream")
        XCTAssertEqual(decoded.epoch, 0)

        let mapped = decoded.injectingLocalContext(
            sessionID: "logical-session-1",
            epoch: 1
        )
        XCTAssertEqual(mapped.sessionID, "logical-session-1")
        XCTAssertEqual(mapped.epoch, 1)
        let mappedWire = String(
            data: try XCTUnwrap(mapped.encoded()),
            encoding: .utf8
        )
        XCTAssertNotNil(mappedWire)
        XCTAssertFalse(mappedWire?.contains("epoch") == true)
        XCTAssertFalse(mappedWire?.contains("session_id") == true)
    }

    func testCentralNativeRoomSurfaceIsReliableDirectedAndRejectsWrongReceiveContext() async throws {
        let fixture = try CentralTextTestFixture()
        let room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { _ in })
        let data = try AssistantCentralTextWire.result(processedID: XCTUnwrap(fixture.packet("accepted").fields.value("processed_event_id", as: String.self)))
        try await adapter.publishCentralTextData(data, binding: fixture.binding)
        let published = await room.publishedPackets
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(published[0].data, data)
        XCTAssertEqual(published[0].topic, AssistantCentralTextWire.inputTopic)
        XCTAssertEqual(published[0].destinationIdentities, [fixture.binding.expectedGatewayIdentity])
        XCTAssertTrue(published[0].reliable)
        let ready = try JSONSerialization.data(withJSONObject: ["schema_version": AssistantCentralTextWire.schema,
            "session_id": fixture.binding.sessionID, "operation": "ready"])
        XCTAssertNotNil(SystemLiveKitRoomOperator.centralPacket(ready, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, requiredOperation: "ready", encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(ready, binding: fixture.binding,
            sender: "other", requiredOperation: "ready", encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(ready, binding: fixture.binding,
            sender: nil, requiredOperation: "ready", encrypted: true, current: true))
        let wrongReady = try JSONSerialization.data(withJSONObject: ["schema_version": AssistantCentralTextWire.schema,
            "session_id": "other", "operation": "ready"])
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(wrongReady, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, requiredOperation: "ready", encrypted: true, current: true))
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject:
            ["schema_version": AssistantCentralTextWire.schema, "session_id": fixture.binding.sessionID,
             "operation": "ready", "extra": true])))
        let packet = try fixture.bytes("accepted")
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, requiredOperation: "ready", encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(ready, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, requiredOperation: "ready", encrypted: false, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(ready, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, requiredOperation: "ready", encrypted: true, current: false))
        XCTAssertNotNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: "arbitrary-room-participant", encrypted: true, current: true))
        // Anonymous Rust-SDK packets require the gateway to be the sole server-authorized data publisher.
        let gateway = (identity: fixture.binding.expectedGatewayIdentity, canPublishData: true)
        XCTAssertNotNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [gateway], encrypted: true, current: true))
        XCTAssertNotNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [gateway, ("yimi-avatar", false)], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [gateway, ("other-participant", true)], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [("yimi-avatar", false)], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [("yimi-avatar", true)], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [(fixture.binding.expectedGatewayIdentity, false)], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: nil, remotes: [gateway], encrypted: false, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: "arbitrary-room-participant", remotes: [gateway], encrypted: true, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, encrypted: false, current: true))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: fixture.binding,
            sender: fixture.binding.expectedGatewayIdentity, encrypted: true, current: false))
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: nil,
            sender: fixture.binding.expectedGatewayIdentity, encrypted: true, current: true))
        let small = CentralTransportBinding(sessionID: fixture.binding.sessionID, deviceID: fixture.binding.deviceID,
            connectionEpoch: fixture.binding.connectionEpoch, expectedGatewayIdentity: fixture.binding.expectedGatewayIdentity, maxPacketBytes: 1)
        XCTAssertNil(SystemLiveKitRoomOperator.centralPacket(packet, binding: small,
            sender: fixture.binding.expectedGatewayIdentity, encrypted: true, current: true))
        await adapter.stop()
        do { try await adapter.publishCentralTextData(data, binding: fixture.binding); XCTFail("Stopped room cannot send") }
        catch { XCTAssertEqual(error as? LiveKitSessionError, .notConnected) }
    }

    func testCentralReadyHoldsFormalSendsAndReleasesCallOnce() async throws {
        let fixture = try CentralTextTestFixture()
        let room = FakeLiveKitRoomOperator(automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let join = Task { try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { _ in }) }
        await room.waitUntilConnected()
        let call = try AssistantCentralTextWire.call("call_open", callID: "call-tapped-while-connecting")
        let tap = Task { try await adapter.publishCentralTextData(call, binding: fixture.binding) }
        let location = try AssistantCentralTextWire.locationUpdate(nil)
        let sync = Task { try await adapter.publishCentralTextData(location, binding: fixture.binding) }
        for _ in 0..<20 { await Task.yield() }
        var sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
        try await room.emitReady(sessionID: "wrong-session")
        for _ in 0..<20 { await Task.yield() }
        sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        try await join.value
        try await tap.value
        try await sync.value
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        sent = await room.publishedPackets
        XCTAssertEqual(sent.filter { $0.data == call }.count, 1)
        XCTAssertEqual(sent.filter { $0.data == location }.count, 1)
        await adapter.stop()
    }

    func testCentralReadyDuringJoinIsRetainedAndStopReleasesWaits() async throws {
        let fixture = try CentralTextTestFixture(), gate = ConnectGate()
        let room = FakeLiveKitRoomOperator(connectGate: gate, automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let join = Task { try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { _ in }) }
        await gate.waitUntilStarted()
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        await gate.release()
        try await join.value
        let data = try AssistantCentralTextWire.call("call_open", callID: "old-generation")
        await room.emit(.reconnecting)
        for _ in 0..<20 { await Task.yield() }
        let pending = Task { try await adapter.publishCentralTextData(data, binding: fixture.binding) }
        await adapter.stop()
        do { try await pending.value; XCTFail("Stop releases the old generation") } catch {}
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        let sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
    }

    func testQuickResumeRetainsReadyButFullReconnectWaitsForNewReady() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { _ in })
        let quick = try AssistantCentralTextWire.call("call_open", callID: "quick-resume")
        await room.emit(.resuming)
        for _ in 0..<20 { await Task.yield() }
        let resumeSend = Task { try await adapter.publishCentralTextData(quick, binding: fixture.binding) }
        for _ in 0..<20 { await Task.yield() }
        var sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
        await room.emit(.reconnected)
        await room.emit(.encryptionActive)
        try await resumeSend.value
        let full = try AssistantCentralTextWire.call("call_open", callID: "full-rejoin")
        await room.emit(.reconnecting)
        for _ in 0..<20 { await Task.yield() }
        let fullSend = Task { try await adapter.publishCentralTextData(full, binding: fixture.binding) }
        await room.emit(.reconnected)
        await room.emit(.encryptionActive)
        for _ in 0..<20 { await Task.yield() }
        sent = await room.publishedPackets
        XCTAssertEqual(sent.map(\.data), [quick], "Full reconnect must await new ready even after encryption resumes")
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        try await fullSend.value
        sent = await room.publishedPackets
        XCTAssertEqual(sent.map(\.data), [quick, full])
        await room.emit(.reconnecting)
        for _ in 0..<20 { await Task.yield() }
        let disconnectedSend = Task { try await adapter.publishCentralTextData(full, binding: fixture.binding) }
        for _ in 0..<20 { await Task.yield() }
        await room.emit(.disconnected(errorCode: "network"))
        do { try await disconnectedSend.value; XCTFail("Disconnect must immediately release a fresh-ready wait") }
        catch { XCTAssertEqual(error as? LiveKitSessionError, .notConnected) }
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        sent = await room.publishedPackets
        XCTAssertEqual(sent.map(\.data), [quick, full])
        await adapter.stop()
    }

    func testOwnerReacquisitionRetiresExhaustedRoomAndFencesItsCallbacks() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
        let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder()
        let request = makeRequest(canPublishData: true, centralBinding: fixture.binding, retainsLogicalCall: true)
        try await adapter.connect(request, events: { events.append($0) })
        let oldEvents = await room.currentEvents()
        await room.emit(.disconnected(errorCode: "network"))
        for _ in 0..<20 { await Task.yield() }
        try await adapter.connect(request, events: { events.append($0) })
        let stops = await room.stopCount, connects = await room.connectCount
        XCTAssertEqual(stops, 1); XCTAssertEqual(connects, 2)
        let before = events.values
        oldEvents?(.disconnected(errorCode: "network")); oldEvents?(.encryptionFailed)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(events.values, before, "Exhausted room cannot terminate its replacement")
        try await adapter.setMedia(source: .microphone, enabled: true, userInitiated: true)
        let data = try AssistantCentralTextWire.call("call_video", callID: "same-logical-call", video: false, videoRevision: 1)
        try await adapter.publishCentralTextData(data, binding: fixture.binding)
        let packets = await room.publishedPackets, media = await room.mediaCalls
        XCTAssertEqual(packets.map(\.data), [data]); XCTAssertEqual(media.count, 1)
        await adapter.stop()
    }

    func testLogicalCallDisconnectBeforeReadyReacquiresWithinOriginalConnect() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator(automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder(), completed = ReconnectEventRecorder()
        let connect = Task {
            defer { completed.append(.connected) }
            try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding,
                retainsLogicalCall: true), events: { events.append($0) })
        }
        await room.waitUntilConnected()
        for _ in 0..<20 { await Task.yield() }
        let oldEvents = await room.currentEvents()
        await room.emit(.disconnected(errorCode: "network"))
        for _ in 0..<200 {
            if await room.connectCount == 2 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let connections = await room.connectCount, stops = await room.stopCount
        XCTAssertEqual(connections, 2); XCTAssertEqual(stops, 1)
        XCTAssertTrue(completed.values.isEmpty, "Local exhaustion cannot fail the original opening")
        XCTAssertFalse(events.values.contains("disconnected"))
        let ready = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": AssistantCentralTextWire.schema, "session_id": fixture.binding.sessionID, "operation": "ready"]))
        oldEvents?(.centralText(ready))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(completed.values.isEmpty, "Retired room readiness cannot complete the replacement")
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        try await connect.value
        XCTAssertEqual(completed.values, ["connected"])
        let opening = try AssistantCentralTextWire.call("call_open", callID: "same-pending-opening")
        try await adapter.publishCentralTextData(opening, binding: fixture.binding)
        let packets = await room.publishedPackets
        XCTAssertEqual(packets.map(\.data), [opening])
        await adapter.stop()
    }

    func testMissingFirstAnnouncementUsesOnePolicyBudgetForReadyLossAndNetworkRetries() async throws {
        for networkFailure in [false, true] {
            let fixture = try CentralTextTestFixture()
            var binding = fixture.binding; binding.callRejoinWindowS = 1
            let room = FakeLiveKitRoomOperator(automaticReady: false, connectFailures: networkFailure ? Array(repeating: .network, count: 8) : [])
            let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder()
            let request = makeRequest(canPublishData: true, centralBinding: binding, retainsLogicalCall: true)
            let join = Task { try await adapter.connect(request, events: { events.append($0) }) }
            if !networkFailure {
                await room.waitUntilConnected()
                await room.emit(.disconnected(errorCode: "network"))
            }
            do { try await join.value; XCTFail("Observed permanent loss needs no first call-state deadline to terminate") }
            catch { XCTAssertEqual(error as? AssistantCallRecoveryError, .expired) }
            XCTAssertEqual(events.values.filter { $0 == "budget" }.count, 1, "500ms retries must not rebase the loss budget")
            let stops = await room.stopCount; XCTAssertGreaterThan(stops, 0)
            await adapter.stop()
        }
    }

    func testAnnouncedCallDeadlineBoundsReadyWaitAndPacedNetworkRetries() async throws {
        for networkFailure in [false, true] {
            let fixture = try CentralTextTestFixture()
            let room = FakeLiveKitRoomOperator(automaticReady: false, connectFailures: networkFailure ? [.network, .network] : [])
            let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder()
            do {
                try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding,
                    retainsLogicalCall: true, rejoinDeadline: Date().addingTimeInterval(-1.8)), events: { events.append($0) })
                XCTFail("Server-announced recovery deadline must bound both paths")
            } catch { XCTAssertEqual(error as? AssistantCallRecoveryError, .expired) }
            let connections = await room.connectCount, stops = await room.stopCount
            XCTAssertEqual(connections, 1, "500ms retry must not acquire another room beyond the shared deadline")
            XCTAssertGreaterThanOrEqual(stops, 1); XCTAssertFalse(events.values.contains("disconnected"))
            await adapter.stop()
        }
    }

    func testCallRejoinReadyCancellationStopsOwnedRoom() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator(automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let opening = Task { try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding,
            retainsLogicalCall: true, rejoinDeadline: Date().addingTimeInterval(30)), events: { _ in }) }
        await room.waitUntilConnected(); opening.cancel()
        do { try await opening.value; XCTFail("Owner cancellation must release readiness") } catch is CancellationError { }
        let stops = await room.stopCount; XCTAssertEqual(stops, 1)
        await adapter.stop()
    }

    func testLogicalCallRecoveryOutlivesReadyOperationDeadline() async throws {
        let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator(automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room), events = ReconnectEventRecorder(), joined = ReconnectEventRecorder()
        let loss = expectation(description: "adapter has invalidated old readiness")
        let join = Task {
            defer { joined.append(.connected) }
            try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding,
                retainsLogicalCall: true), events: { event in
                    events.append(event)
                    if event == .reconnecting { loss.fulfill() }
                })
        }
        await room.waitUntilConnected()
        await room.emit(.reconnecting)
        await fulfillment(of: [loss], timeout: 2)
        let data = try AssistantCentralTextWire.call("call_open", callID: "recoverable-dial")
        let pending = Task { try await adapter.publishCentralTextData(data, binding: fixture.binding) }
        try await Task.sleep(nanoseconds: 61_000_000_000)
        do { try await pending.value; XCTFail("Individual send must time out") }
        catch let error as LiveKitError { XCTAssertEqual(error.type, .timedOut) }
        XCTAssertFalse(events.values.contains("disconnected")); XCTAssertTrue(joined.values.isEmpty)
        let stops = await room.stopCount, before = await room.publishedPackets
        XCTAssertEqual(stops, 0); XCTAssertTrue(before.isEmpty)
        await room.emit(.reconnected); await room.emit(.encryptionActive)
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        try await join.value
        try await adapter.publishCentralTextData(data, binding: fixture.binding)
        let after = await room.publishedPackets
        XCTAssertEqual(after.map(\.data), [data]); XCTAssertFalse(events.values.contains("disconnected"))
        await adapter.stop()
    }

    func testCentralReadyTimeoutAndCancellationReleaseHeldSends() async throws {
        let fixture = try CentralTextTestFixture()
        let room = FakeLiveKitRoomOperator(automaticReady: false)
        let adapter = LiveKitSessionAdapter(roomOperator: room)
        let join = Task { try await adapter.connect(makeRequest(canPublishData: true, centralBinding: fixture.binding), events: { _ in }) }
        await room.waitUntilConnected()
        let data = try AssistantCentralTextWire.call("call_open", callID: "cancelled-call")
        let cancelled = Task { try await adapter.publishCentralTextData(data, binding: fixture.binding) }
        cancelled.cancel()
        do { try await cancelled.value; XCTFail("Cancelled send must be released") } catch is CancellationError {}
        let pending = Task { try await adapter.publishCentralTextData(data, binding: fixture.binding) }
        do { try await join.value; XCTFail("Missing ready must fail the connection") }
        catch let error as LiveKitError { XCTAssertEqual(error.type, .timedOut) }
        do { try await pending.value; XCTFail("Timeout must release held sends") } catch {}
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        let sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
    }

    private func makeRequest(
        url: String = "wss://example.livekit.cloud",
        microphone: Bool = false,
        camera: Bool = false,
        allowed: Set<AssistantMediaSource> = [.microphone, .camera],
        canPublishData: Bool = false,
        centralBinding: CentralTransportBinding? = nil,
        retainsLogicalCall: Bool = false,
        rejoinDeadline: Date? = nil
    ) -> AssistantRealtimeConnectRequest {
        AssistantRealtimeConnectRequest(
            details: AssistantConnectionDetails(
                serverURL: URL(string: url)!,
                roomName: "opaque-room",
                participantToken: "opaque-token",
                capabilities: AssistantMediaCapabilities(
                    publishableSources: allowed,
                    canPublishData: canPublishData
                )
            ),
            intent: AssistantStartIntent(
                microphoneEnabled: microphone,
                cameraEnabled: camera,
                locationEnabled: false,
                userInitiated: true
            ),
            centralBinding: centralBinding,
            retainsLogicalCall: retainsLogicalCall,
            rejoinDeadline: rejoinDeadline
        )
    }

    private func makeWorkoutEvent() -> AssistantRealtimeDataEvent {
        let watch = CyclingWatchOriginBinding(
            serverAuthoritativeDeviceID: "watch_01",
            serverAuthoritativeClientInstanceID: "watch_client_01",
            serverAuthoritativeDeviceClass: "apple_watch"
        )!
        let observedAt = Date(timeIntervalSince1970: 1_700_000_000)
        return AssistantRealtimeDataEvent(
            eventID: "018bcfe5-6800-7001-8000-000000000101",
            traceID: "018bcfe5-6800-7002-8000-000000000102",
            occurredAt: observedAt,
            expiresAt: observedAt.addingTimeInterval(3_600),
            origin: .appleWatch(watch),
            sequence: AssistantRealtimeDataSequence(
                streamID: "watch_workout_stream",
                number: 1,
                previousEventID: nil
            ),
            idempotencyKey: "watch-workout:watch_01:workout_001:1",
            payload: .workout(
                AssistantCyclingWorkoutPayload(
                    workoutID: "workout_001",
                    observedAt: observedAt,
                    metrics: [
                        .heartRate(140),
                        .elapsedTime(60)
                    ]
                )
            )
        )
    }
}

actor ConnectGate {
    private var started = false
    private var released = false
    private var startedWaiters: [
        CheckedContinuation<Void, Never>
    ] = []
    private var releaseWaiters: [
        CheckedContinuation<Void, Never>
    ] = []

    func markStarted() {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilStarted() async {
        if started {
            return
        }
        await withCheckedContinuation { continuation in
            startedWaiters.append(continuation)
        }
    }

    func waitUntilReleased() async {
        if released {
            return
        }
        await withCheckedContinuation { continuation in
            releaseWaiters.append(continuation)
        }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

actor FakeLiveKitRoomOperator: LiveKitRoomOperating {
    struct MediaCall: Sendable {
        let source: AssistantMediaSource
        let enabled: Bool
        let userInitiated: Bool
        var keepPublished = false
    }

    struct PublishedPacket: Sendable {
        let data: Data
        let topic: String
        let reliable: Bool
        let destinationIdentities: [String]
    }

    private let connectGate: ConnectGate?
    private let automaticReady: Bool
    private var events: (@Sendable (AssistantRealtimeEvent) -> Void)?
    private let lateConnectError: LiveKitSessionError?
    private let runtimeCanPublishData: Bool
    private let participantIdentity: String
    private var expectedRoomName = "opaque-room"
    private var bootstrapCanPublishData = false
    private var activeAttemptID: UInt64?
    private var connected = false
    private var connectFailures: [LiveKitErrorType]
    private(set) var connectCount = 0
    private(set) var stopCount = 0
    private(set) var mediaCalls: [MediaCall] = []
    private(set) var publishedPackets: [PublishedPacket] = []

    init(
        connectGate: ConnectGate? = nil,
        automaticReady: Bool = true,
        runtimeCanPublishData: Bool = true,
        participantIdentity: String = "iphone_01",
        connectFailures: [LiveKitErrorType] = [],
        lateConnectError: LiveKitSessionError? = nil
    ) {
        self.automaticReady = automaticReady
        self.lateConnectError = lateConnectError
        self.connectFailures = connectFailures
        self.connectGate = connectGate
        self.runtimeCanPublishData = runtimeCanPublishData
        self.participantIdentity = participantIdentity
    }

    func connect(
        _ request: AssistantRealtimeConnectRequest,
        attemptID: UInt64,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws {
        self.events = events
        activeAttemptID = attemptID
        connectCount += 1
        if !connectFailures.isEmpty {
            events(.disconnected(errorCode: "network"))
            throw LiveKitError(connectFailures.removeFirst())
        }
        expectedRoomName = request.details.roomName
        bootstrapCanPublishData =
            request.details.capabilities.canPublishData
        if connectCount == 1 {
            await connectGate?.markStarted()
            await connectGate?.waitUntilReleased()
            if let lateConnectError { throw lateConnectError }
        }
        if activeAttemptID == attemptID { connected = true }
        events(.connected)
        if let binding = request.centralBinding {
            events(.encryptionActive)
            if automaticReady { try emitReady(sessionID: binding.sessionID) }
        }
    }

    func waitUntilConnected() async {
        while !connected { await Task.yield() }
    }

    func emit(_ event: AssistantRealtimeEvent) { events?(event) }
    func emitBurst(_ event: AssistantRealtimeEvent, count: Int) {
        for _ in 0..<count { events?(event) }
    }
    func currentEvents() -> (@Sendable (AssistantRealtimeEvent) -> Void)? { events }

    func emitReady(sessionID: String) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["schema_version": AssistantCentralTextWire.schema,
            "session_id": sessionID, "operation": "ready"])
        events?(.centralText(try AssistantCentralTextWire.decode(bytes)))
    }

    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool,
        attemptID: UInt64
    ) async throws {
        guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
        mediaCalls.append(
            MediaCall(
                source: source,
                enabled: enabled,
                userInitiated: userInitiated,
                keepPublished: keepPublished
            )
        )
    }

    func currentDataBinding(attemptID: UInt64) async throws -> AssistantLiveKitDataBinding {
        guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
        return try AssistantLiveKitDataBinding(
            joinedRoomName: expectedRoomName,
            expectedRoomName: expectedRoomName,
            roomSID: "RM_room_01",
            participantIdentity: participantIdentity,
            participantAttributes: [
                "schema_version": "phase0-demo/0.4",
                "device_id": "iphone_01",
                "device_class": "iphone",
                "client_instance_id": "iphone_client_01"
            ],
            bootstrapCanPublishData: bootstrapCanPublishData,
            runtimeCanPublishData: runtimeCanPublishData,
            roomIsConnected: connected
        )
    }

    func publishData(
        _ data: Data,
        binding: AssistantLiveKitDataBinding,
        attemptID: UInt64
    ) async throws {
        let current = try await currentDataBinding(attemptID: attemptID)
        guard current == binding else {
            throw LiveKitSessionError.invalidPublisherBinding
        }
        publishedPackets.append(
            PublishedPacket(
                data: data,
                topic: AssistantRealtimeDataEvent.topic,
                reliable: AssistantRealtimeDataEvent.reliable,
                destinationIdentities:
                    AssistantRealtimeDataEvent.destinationIdentities
            )
        )
    }

    func publishTextData(_ data: Data, binding: CentralTransportBinding?, attemptID: UInt64) async throws {
        guard activeAttemptID == attemptID else { throw LiveKitSessionError.superseded }
        guard connected, bootstrapCanPublishData, runtimeCanPublishData else { throw LiveKitSessionError.dataNotGranted }
        publishedPackets.append(PublishedPacket(data: data,
            topic: binding == nil ? AssistantPromptEnvelope.topic : AssistantCentralTextWire.inputTopic,
            reliable: true, destinationIdentities: binding.map { [$0.expectedGatewayIdentity] } ?? []))
    }

    func stop(attemptID: UInt64) async {
        guard activeAttemptID == attemptID else { return }
        activeAttemptID = nil
        connected = false
        stopCount += 1
    }
}


private final class ReconnectEventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
    func append(_ event: AssistantRealtimeEvent) {
        lock.lock()
        defer { lock.unlock() }
        switch event {
        case .connected: storage.append("connected")
        case .disconnected: storage.append("disconnected")
        case .reconnecting: storage.append("reconnecting")
        case .callRejoinBudget: storage.append("budget")
        case .resuming: storage.append("resuming")
        case .reconnected: storage.append("reconnected")
        case .encryptionActive: storage.append("active")
        case .encryptionFailed: storage.append("failed")
        default: break
        }
    }
}

private final class RealtimeEventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [AssistantRealtimeEvent] = []
    var events: [AssistantRealtimeEvent] { lock.withLock { storage } }
    func append(_ event: AssistantRealtimeEvent) { lock.withLock { storage.append(event) } }
}
