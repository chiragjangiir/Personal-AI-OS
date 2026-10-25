import CoreLocation
import Foundation
import GRDB
import LiveKit
import XCTest
@testable import HealthKitExporter

final class AssistantSessionTests: XCTestCase {
    func testBannerIdleReconnectDoesNotCreateAnOperation() async throws {
        let fixture = try CentralTextTestFixture(), harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        await harness.realtime.emit(.disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode))
        try await eventually("idle fixture room disconnects") {
            await harness.coordinator.snapshot() == .failed(code: LiveKitSessionAdapter.gatewayLeftCode)
        }
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let fresh = await harness.coordinator.centralTextSnapshot()
        XCTAssertNil(fresh.eventID); XCTAssertNil(fresh.submission)
        XCTAssertTrue(fresh.pendingRenderedACKs.isEmpty)
        XCTAssertFalse(try fresh.needsTypedRecovery)
        _ = await harness.coordinator.stop()
    }

    func testBannerReconnectWithoutPendingSubmit() async throws {
        try await bannerReconnect(pollInFlight: false, acknowledge: false)
    }

    func testBannerReconnectWithResultPollInFlight() async throws {
        try await bannerReconnect(pollInFlight: true, acknowledge: false)
    }

    func testBannerReconnectJustAfterACKReceipt() async throws {
        try await bannerReconnect(pollInFlight: false, acknowledge: true)
    }

    private func bannerReconnect(pollInFlight: Bool, acknowledge: Bool) async throws {
        let fixture = try CentralTextTestFixture(), harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "formal-event", text: "original"))
        await harness.realtime.emitBurst([.centralText(try fixture.packet("accepted")),
            .centralText(try fixture.packet("pending_header"))] + (try fixture.chunks()).map(AssistantRealtimeEvent.centralText))
        try await eventually("fixture reply completes") {
            await harness.coordinator.centralTextSnapshot().presentation?.isFinal == true
        }
        let completed = await harness.coordinator.centralTextSnapshot()
        let displayed = try XCTUnwrap(completed.presentation)
        XCTAssertEqual(completed.submissionDelivery(eventID: "formal-event"), .accepted)
        let observedAt = try XCTUnwrap((fixture.values["input_ack"] as? [String: Any])?["ack"] as? [String: Any])["observed_at"] as! String
        if acknowledge {
            try await harness.coordinator.centralTextConsumed(displayed, observedAt: observedAt)
            await harness.realtime.emit(.centralText(try fixture.packet("ack_receipt")))
            try await eventually("fixture ACK receipt settles") { await harness.coordinator.centralTextSnapshot().ackConfirmed }
        }
        let gate = StopGate()
        var poll: Task<Void, Error>?
        if pollInFlight {
            await harness.realtime.setCentralPublishGate(gate, operation: "result")
            poll = Task { try await harness.coordinator.requestCentralResult() }
            await gate.waitUntilEntered()
        }
        await harness.realtime.emit(.disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode))
        try await eventually("fixture room disconnects") {
            await harness.coordinator.snapshot() == .failed(code: LiveKitSessionAdapter.gatewayLeftCode)
        }
        let next = CentralTransportBinding(sessionID: "new-room", deviceID: fixture.binding.deviceID,
            connectionEpoch: "rebootstrap", expectedGatewayIdentity: fixture.binding.expectedGatewayIdentity, maxPacketBytes: 12288)
        await harness.bootstrap.setCentralBinding(next)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let fresh = await harness.coordinator.centralTextSnapshot()
        XCTAssertNil(fresh.eventID)
        XCTAssertTrue(fresh.pendingRenderedACKs.isEmpty)
        if let poll {
            await gate.release()
            do { try await poll.value; XCTFail("Retired result poll must end as superseded") }
            catch AssistantSessionCoordinatorError.superseded { }
            catch { XCTFail("Settled result poll raised \(error)") }
        }
        // Window activation and row appearance can report an already displayed old reply after reconnect.
        let beforeDisplay = await harness.realtime.centralPackets.count
        do { try await harness.coordinator.centralTextConsumed(displayed, observedAt: observedAt) }
        catch { XCTFail("Display callback raised \(error); source=AssistantCentralTextConsumer.consumedByUI binding guard") }
        let packets = await harness.realtime.centralPackets
        XCTAssertEqual(packets.count, beforeDisplay, "An old display callback sends no ACK into the new room")
        XCTAssertFalse(packets.contains { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["session_id"] as? String == next.sessionID })
        let starts = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(starts, 2)
        _ = await harness.coordinator.stop()
    }

    func testI5PaymentPresenceAttachesWithoutConsumingConversationPackets() async throws {
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.paymentChannel.presence("foreground")
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let payment = await harness.realtime.paymentPackets
        XCTAssertEqual(payment.count, 1)
        let presence = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(payment.first)) as? [String: Any])
        XCTAssertEqual(presence["operation"] as? String, "phone_presence")
        XCTAssertEqual(presence["state"] as? String, "foreground")
        let conversation = await harness.realtime.centralPackets
        XCTAssertTrue(conversation.isEmpty)
        _ = await harness.coordinator.stop()
    }

    func testCyclingUUIDv7UsesUnixMillisecondsVersionAndVariant()
        throws {
        let generator = AssistantUUIDv7Generator(
            clock: {
                Date(timeIntervalSince1970: 1_700_000_000)
            },
            randomBytes: { count in
                [UInt8](repeating: 0xFF, count: count)
            }
        )

        let identifier = try generator.generate()

        assertUUIDv7(identifier)
        let compact = identifier.replacingOccurrences(of: "-", with: "")
        XCTAssertEqual(String(compact.prefix(12)), "018bcfe56800")
    }

    func testCyclingSourceDoesNotUseFoundationUUIDV4Generation()
        throws {
        let entropy = DeterministicUUIDv7Entropy()
        let generator = AssistantUUIDv7Generator(
            clock: {
                Date(timeIntervalSince1970: 1_800_000_000)
            },
            randomBytes: { count in
                entropy.next(count: count)
            }
        )

        let identifiers = try [
            generator.generate(),
            generator.generate()
        ]

        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        for identifier in identifiers {
            assertUUIDv7(identifier)
            let compact = identifier.replacingOccurrences(
                of: "-",
                with: ""
            )
            XCTAssertNotEqual(Array(compact)[12], "4")
        }
    }

    private func assertUUIDv7(_ identifier: String) {
        XCTAssertEqual(
            UUID(uuidString: identifier)?.uuidString.lowercased(),
            identifier
        )
        let compact = identifier.replacingOccurrences(of: "-", with: "")
        XCTAssertEqual(compact.count, 32)
        guard compact.count == 32 else { return }
        let characters = Array(compact)
        XCTAssertEqual(characters[12], "7")
        XCTAssertTrue(
            ["8", "9", "a", "b"].contains(characters[16])
        )
    }

    func testCyclingWatchBindingAcceptsOnlyScopedAppleWatchAuthority() {
        XCTAssertNotNil(
            CyclingWatchOriginBinding(
                serverAuthoritativeDeviceID: "watch_01",
                serverAuthoritativeClientInstanceID: "watch_client_01",
                serverAuthoritativeDeviceClass: "apple_watch"
            )
        )
        XCTAssertNil(
            CyclingWatchOriginBinding(
                serverAuthoritativeDeviceID: "watch_01",
                serverAuthoritativeClientInstanceID: "watch_client_01",
                serverAuthoritativeDeviceClass: "iphone"
            )
        )
        XCTAssertNil(
            CyclingWatchOriginBinding(
                serverAuthoritativeDeviceID: "4C7339A0-local-uuid",
                serverAuthoritativeClientInstanceID: "watch_client_01",
                serverAuthoritativeDeviceClass: "apple_watch"
            )
        )
    }

    func testCyclingControlEnvelopeAndEncryptedRoomAdmissionAreClosed()
        throws {
        let command = AssistantCyclingControlCommand(
            action: .start,
            requestID: "cycling-control-1",
            sequence: 1
        )
        let data = try command.encodedStrict()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data)
                as? [String: Any]
        )

        XCTAssertEqual(
            Set(object.keys),
            Set(["version", "kind", "action", "request_id", "sequence"])
        )
        XCTAssertEqual(
            AssistantCyclingControlCommand.topic,
            "paios.cycling.control.local.v1"
        )
        XCTAssertEqual(
            try AssistantCyclingControlCommand.decodeStrict(data),
            command
        )
        XCTAssertEqual(
            AssistantCyclingControlCommand.admit(
                data: data,
                topic: AssistantCyclingControlCommand.topic,
                isEncrypted: true,
                hasRemoteParticipant: true,
                isCurrentConnectedRoom: true
            ),
            command
        )
        XCTAssertNil(
            AssistantCyclingControlCommand.admit(
                data: data,
                topic: "wrong-topic",
                isEncrypted: true,
                hasRemoteParticipant: true,
                isCurrentConnectedRoom: true
            )
        )
        XCTAssertNil(
            AssistantCyclingControlCommand.admit(
                data: data,
                topic: AssistantCyclingControlCommand.topic,
                isEncrypted: false,
                hasRemoteParticipant: true,
                isCurrentConnectedRoom: true
            )
        )
        XCTAssertNil(
            AssistantCyclingControlCommand.admit(
                data: data,
                topic: AssistantCyclingControlCommand.topic,
                isEncrypted: true,
                hasRemoteParticipant: false,
                isCurrentConnectedRoom: true
            )
        )
        XCTAssertNil(
            AssistantCyclingControlCommand.admit(
                data: data,
                topic: AssistantCyclingControlCommand.topic,
                isEncrypted: true,
                hasRemoteParticipant: true,
                isCurrentConnectedRoom: false
            )
        )
        let malformed = Data(
            #"{"version":1,"kind":"cycling_control","action":"start","request_id":"cycling-control-1","sequence":1,"token":"forbidden"}"#.utf8
        )
        XCTAssertNil(
            AssistantCyclingControlCommand.admit(
                data: malformed,
                topic: AssistantCyclingControlCommand.topic,
                isEncrypted: true,
                hasRemoteParticipant: true,
                isCurrentConnectedRoom: true
            )
        )
    }

    func testCyclingControlIsGenerationAndOrderFencedWithoutRetry()
        async throws {
        let connectGate = StopGate()
        let harness = await Harness.make(
            connectGate: connectGate,
            watchDeliveryStatuses: [.unreachable, .rejected]
        )
        let intent = AssistantStartIntent(
            microphoneEnabled: false,
            cameraEnabled: false,
            locationEnabled: false,
            userInitiated: true
        )
        let start = AssistantCyclingControlCommand(
            action: .start,
            requestID: "cycling-start-1",
            sequence: 1
        )
        let stop = AssistantCyclingControlCommand(
            action: .stop,
            requestID: "cycling-stop-2",
            sequence: 2
        )
        let startTask = Task {
            try await harness.coordinator.start(intent)
        }
        await connectGate.waitUntilEntered()

        await harness.realtime.emit(.cyclingControl(start))
        let beforeEncryption = await harness.watchControl.commandCount
        XCTAssertEqual(beforeEncryption, 0)

        await connectGate.release()
        try await startTask.value
        await harness.realtime.emit(.cyclingControl(start))
        await harness.watchControl.waitForCount(1)
        await harness.realtime.emit(.cyclingControl(start))
        await harness.realtime.emit(
            .cyclingControl(
                AssistantCyclingControlCommand(
                    action: .stop,
                    requestID: "cycling-stale-1",
                    sequence: 1
                )
            )
        )
        let afterDuplicateAndStale =
            await harness.watchControl.commandCount
        XCTAssertEqual(afterDuplicateAndStale, 1)

        await harness.realtime.emit(.cyclingControl(stop))
        await harness.watchControl.waitForCount(2)
        let actions = await harness.watchControl.actions
        XCTAssertEqual(actions, [.start, .stop])

        _ = await harness.coordinator.stop()
        try await harness.coordinator.start(intent)
        await harness.realtime.emit(
            .cyclingControl(
                AssistantCyclingControlCommand(
                    action: .start,
                    requestID: "late-old-generation",
                    sequence: 3
                )
            ),
            handlerIndex: 0
        )
        let afterLateOldGeneration =
            await harness.watchControl.commandCount
        XCTAssertEqual(afterLateOldGeneration, 2)
        _ = await harness.coordinator.stop()
    }

    func testRealtimeControlFailuresMapToStableWhitelistedCodes()
        async throws {
        let cases: [
            (RealtimePublicControlAdapterError, String)
        ] = [
            (.missingCanonicalContext, "realtime_missing_canonical_context"),
            (.missingCanonicalBody, "realtime_missing_canonical_body"),
            (.canonicalBodyTooLarge, "realtime_canonical_body_too_large"),
            (.invalidPublicOrigin, "realtime_invalid_public_origin"),
            (.invalidEndpointURL, "realtime_invalid_endpoint"),
            (.missingBearerCredential, "realtime_missing_bearer"),
            (.invalidBearerCredential, "realtime_invalid_bearer"),
            (.transportFailure, "realtime_transport_failure"),
            (.invalidHTTPResponse, "realtime_http_response_invalid"),
            (.unexpectedHTTPStatus(401), "realtime_http_rejected"),
            (.unexpectedHTTPStatus(401, "CONTROL_CAPABILITY_INVALID"), "realtime_pairing_revoked"),
            (.unexpectedHTTPStatus(403), "realtime_http_rejected"),
            (.unexpectedHTTPStatus(403, "CONTROL_CAPABILITY_DEVICE_MISMATCH"), "realtime_http_rejected"),
            (.unexpectedHTTPStatus(403, "PAIRED_DEVICE_REVOKED"), "realtime_pairing_revoked"),
            (.unexpectedHTTPStatus(422), "realtime_http_rejected"),
            (.responseTooLarge, "realtime_response_too_large"),
            (.bootstrapCancelled, "realtime_bootstrap_cancelled"),
            (.bootstrapSuperseded, "realtime_bootstrap_superseded"),
            (.staleBinding, "realtime_stale_binding"),
            (.e2eeOpenFailed, "realtime_e2ee_open_failed"),
            (.malformedFixture, "realtime_response_mapping_failed"),
            (.unexpectedOperation, "realtime_response_mapping_failed"),
            (.unsupportedFirstSliceOperation, "realtime_response_mapping_failed"),
            (.invalidCommittedStop, "realtime_response_mapping_failed"),
            (.invalidConnectionDetails, "realtime_response_mapping_failed")
        ]

        for (error, expectedCode) in cases {
            let coordinator =
                await ErrorCoordinatorHarness.make(error: error)
            do {
                try await coordinator.start(
                    AssistantStartIntent(userInitiated: true)
                )
                XCTFail("Expected \(expectedCode)")
            } catch {
                // The coordinator exposes only the fixed diagnostic code.
            }
            let snapshot = await coordinator.snapshot()
            XCTAssertEqual(snapshot, .failed(code: expectedCode))
        }
    }

    func testStartRequiresExplicitUserAction() async throws {
        let harness = await Harness.make()
        let intent = AssistantStartIntent(
            microphoneEnabled: false,
            cameraEnabled: false,
            locationEnabled: false,
            userInitiated: false
        )

        do {
            try await harness.coordinator.start(intent)
            XCTFail("Expected requestWasNotUserInitiated")
        } catch {
            XCTAssertEqual(
                error as? AssistantSessionCoordinatorError,
                .requestWasNotUserInitiated
            )
        }
        let bootstrapCount = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(bootstrapCount, 0)
    }

    func testStartRequestsOnlySelectedMediaAndConnects() async throws {
        let harness = await Harness.make()
        try await harness.coordinator.start(
            AssistantStartIntent(
                microphoneEnabled: true,
                cameraEnabled: false,
                locationEnabled: false,
                userInitiated: true
            )
        )

        let permissionRequests = await harness.permissions.requests
        let connectCount = await harness.realtime.connectCount
        let snapshot = await harness.coordinator.snapshot()
        XCTAssertEqual(permissionRequests, [.microphone])
        XCTAssertEqual(connectCount, 1)
        XCTAssertEqual(snapshot, .active(encryptionActive: true))
    }

    func testStopIsIdempotentAndCleansLocalMediaFirst() async throws {
        let harness = await Harness.make()
        try await harness.coordinator.start(
            AssistantStartIntent(
                microphoneEnabled: true,
                userInitiated: true
            )
        )

        let first = await harness.coordinator.stop()
        let second = await harness.coordinator.stop()

        XCTAssertTrue(first.confirmed)
        XCTAssertEqual(first, second)
        let realtimeStopCount = await harness.realtime.stopCount
        let bootstrapStopCount = await harness.bootstrap.stopCount
        let snapshot = await harness.coordinator.snapshot()
        XCTAssertEqual(realtimeStopCount, 1)
        XCTAssertEqual(bootstrapStopCount, 1)
        XCTAssertEqual(snapshot, .stopped(remoteStopConfirmed: true))
    }

    func testUnknownStopRetainsOperationAllowsStartAndExplicitlyRetries() async throws {
        let harness = await Harness.make()
        let intent = AssistantStartIntent(userInitiated: true)
        try await harness.coordinator.start(intent)
        await harness.bootstrap.failNextStop()
        let unknown = await harness.coordinator.stop()
        XCTAssertFalse(unknown.confirmed)
        let pending = await harness.coordinator.pendingStopContext
        XCTAssertEqual(pending?.operationID, intent.operationID)
        let presentation = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(presentation.canStart)
        let confirmed = await harness.coordinator.retryPendingStop()
        XCTAssertTrue(confirmed.confirmed)
        let remaining = await harness.coordinator.pendingStopContext
        let localStops = await harness.realtime.stopCount
        let remoteStops = await harness.bootstrap.stopCount
        XCTAssertNil(remaining)
        XCTAssertEqual(localStops, 1)
        XCTAssertEqual(remoteStops, 2)
    }

    func testStartSupersedesRestoredStopOnlyAfterBootstrapAcceptance() async throws {
        for fails in [false, true] {
            let gate = StopGate()
            let harness = await Harness.make(bootstrapGate: gate)
            let old = AssistantStopContext(operationID: AssistantOperationID(rawValue: "restored-old"),
                roomName: "opaque-room", reasonCode: "app_background")
            await harness.bootstrap.setRestoredStop(old)
            if fails { await harness.bootstrap.failNextBootstrap() }
            let start = Task { try await harness.coordinator.start(AssistantStartIntent(userInitiated: true)) }
            await gate.waitUntilEntered()
            let waiting = await harness.coordinator.pendingStopContext
            XCTAssertEqual(waiting?.operationID, old.operationID, "Bootstrap dispatch does not confirm the old Stop")
            await gate.release()
            if fails {
                do { try await start.value; XCTFail("Expected bootstrap failure") }
                catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .transportFailure) }
            } else { try await start.value }
            let pending = await harness.coordinator.pendingStopContext
            XCTAssertEqual(pending?.operationID, fails ? old.operationID : nil)
        }
    }

    func testStartWaitsForSharedRestorationAndStopCancelsItsAdmission() async throws {
        for reason in [nil, "user_stop", "app_background"] as [String?] {
            let gate = StopGate(), harness = await Harness.make()
            await harness.bootstrap.setRestoredStop(nil, gate: gate)
            let start = Task { try await harness.coordinator.start(AssistantStartIntent(userInitiated: true)) }
            await gate.waitUntilEntered()
            let observer = Task { await harness.coordinator.setObserver { _ in } }
            if reason == "app_background" { await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground) }
            else if let reason { _ = await harness.coordinator.stop(reasonCode: reason) }
            await gate.release()
            do { try await start.value; XCTAssertNil(reason) }
            catch { XCTAssertNotNil(reason); XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
            await observer.value
            let state = await harness.coordinator.snapshot()
            XCTAssertEqual(state, reason == nil ? .active(encryptionActive: true) : .idle)
            let bootstraps = await harness.bootstrap.bootstrapCount
            XCTAssertEqual(bootstraps, reason == nil ? 1 : 0, "Stop must prevent a later bootstrap request")
        }
    }

    func testRestoredStopObserverShowsUnconfirmedUntilExplicitRetry() async throws {
        let harness = await Harness.make()
        let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: "restored-original"),
            roomName: "opaque-room", reasonCode: "user_stop")
        await harness.bootstrap.setRestoredStop(context)
        let probe = StateProbe()
        await harness.coordinator.setObserver { state in Task { await probe.record(state.state) } }
        await probe.waitFor(.stopped(remoteStopConfirmed: false))
        let state = await harness.coordinator.snapshot()
        XCTAssertEqual(state, .stopped(remoteStopConfirmed: false))
        XCTAssertEqual(state.displayName, "本地已停止 · 远端未确认")
        let pending = await harness.coordinator.pendingStopContext
        XCTAssertEqual(pending?.operationID, context.operationID)
        let restoredPresentation = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(restoredPresentation.canRetryRemoteStop)
        XCTAssertTrue(restoredPresentation.canStart)
        let before = await harness.bootstrap.stopCount
        let bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(before, 0)
        XCTAssertEqual(bootstraps, 0)
        let result = await harness.coordinator.retryPendingStop()
        XCTAssertTrue(result.confirmed)
        await probe.waitFor(.stopped(remoteStopConfirmed: true))
        let confirmedPresentation = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(confirmedPresentation.canRetryRemoteStop)
        XCTAssertTrue(confirmedPresentation.canStart)
        let replayed = await harness.bootstrap.lastStopContext
        XCTAssertEqual(replayed?.operationID, context.operationID)
        XCTAssertEqual(replayed?.roomName, context.roomName)
        XCTAssertEqual(replayed?.reasonCode, context.reasonCode)
        let localStops = await harness.realtime.stopCount
        XCTAssertEqual(localStops, 0, "Restoration/retry cannot repeat local teardown")
    }

    func testRestorationFailureBlocksStartUntilExplicitRetryRereadsOwner() async throws {
        let harness = await Harness.make()
        await harness.bootstrap.setRestoreFailure()
        let probe = StateProbe()
        await harness.coordinator.setObserver { state in Task { await probe.record(state.state) } }
        await probe.waitFor(.failed(code: "pending_stop_storage_unavailable"))
        let failedPresentation = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(failedPresentation.canStart)
        XCTAssertTrue(failedPresentation.canRetryRemoteStop)
        do {
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            XCTFail("Unreadable durable ownership cannot be replaced")
        } catch { XCTAssertEqual(error as? AssistantBootstrapError, .remoteStopUnconfirmed) }
        let result = await harness.coordinator.retryPendingStop()
        XCTAssertFalse(result.confirmed)
        let stops = await harness.bootstrap.stopCount
        let bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(stops, 0)
        XCTAssertEqual(bootstraps, 0)
        let failedReads = await harness.bootstrap.restoreCount
        XCTAssertEqual(failedReads, 2)
        await harness.bootstrap.clearRestoreFailure()
        let emptyRecovery = await harness.coordinator.retryPendingStop()
        XCTAssertFalse(emptyRecovery.confirmed)
        let recovered = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(recovered.canStart)
        XCTAssertFalse(recovered.canRetryRemoteStop)
        let recoveredReads = await harness.bootstrap.restoreCount
        let recoveredSends = await harness.bootstrap.stopCount
        XCTAssertEqual(recoveredReads, 3)
        XCTAssertEqual(recoveredSends, 0)
    }

    func testCancelledSealedReplyStopsACKAndLateChunksWithoutBlockingNewExplicitSubmit() async throws {
        let fixture = try CentralTextTestFixture(name: "formal-text-cancelled-envelope.fixture")
        for extent in ["partial", "full"] {
            let packets = try fixture.cancelled(extent)
            let harness = await Harness.make(canPublishData: true)
            await harness.bootstrap.setCentralBinding(fixture.binding)
            try await harness.coordinator.setTextOwner(.centralCandidate)
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            let prompt = AssistantPromptEnvelope(promptID: try XCTUnwrap(packets.submit["event_id"]), text: try XCTUnwrap(packets.submit["text"]))
            try await harness.coordinator.submitPrompt(prompt)
            let displayedCount = try XCTUnwrap(packets.ack["highest_contiguous_seq"] as? Int)
            let displayedReady = expectation(description: "original display " + extent)
            displayedReady.assertForOverFulfill = false
            await harness.coordinator.setCentralTextObserver {
                do { if try $0.presentation?.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self) == displayedCount { displayedReady.fulfill() } } catch { XCTFail("Malformed source callback: \(error)") }
            }
            await harness.realtime.emit(.centralText(packets.accepted))
            await harness.realtime.emit(.centralText(packets.sealedHeader))
            for packet in packets.chunks.prefix(displayedCount) { await harness.realtime.emit(.centralText(packet)) }
            await fulfillment(of: [displayedReady], timeout: 2)
            let ready = await harness.coordinator.centralTextSnapshot()
            var displayed = try XCTUnwrap(ready.presentation)
            try await harness.coordinator.centralTextConsumed(displayed, observedAt: XCTUnwrap(packets.ack["observed_at"] as? String))
            if extent == "partial" {
                let delayedUI = expectation(description: "third packet awaits UI consumption")
                delayedUI.assertForOverFulfill = false
                await harness.coordinator.setCentralTextObserver {
                    do { if try $0.presentation?.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self) == 3 { delayedUI.fulfill() } } catch { XCTFail("Malformed source callback: \(error)") }
                }
                await harness.realtime.emit(.centralText(packets.chunks[2]))
                await fulfillment(of: [delayedUI], timeout: 2)
                let awaitingUI = await harness.coordinator.centralTextSnapshot()
                displayed = try XCTUnwrap(awaitingUI.presentation)
            }
            let interrupted = expectation(description: "source cancellation " + extent)
            interrupted.assertForOverFulfill = false
            await harness.coordinator.setCentralTextObserver {
                do { if try $0.header?.fields.value("reply_phase", as: String.self) == "interrupted" { interrupted.fulfill() } } catch { XCTFail("Malformed source callback: \(error)") }
            }
            await harness.realtime.emit(.centralText(packets.header))
            await fulfillment(of: [interrupted], timeout: 2)
            let beforeForbiddenSends = await harness.realtime.centralPackets.count
            try await harness.coordinator.centralTextConsumed(displayed, observedAt: "2026-10-01T00:00:03.000Z")
            do { try await harness.coordinator.retryCentralRenderedACK(); XCTFail("Cancelled epoch has no pending render ACK") } catch { }
            do { try await harness.coordinator.requestCentralResult(sealed: true); XCTFail("Cancelled epoch cannot fall back from sealed replay") } catch { }
            let afterForbiddenSends = await harness.realtime.centralPackets.count
            XCTAssertEqual(beforeForbiddenSends, afterForbiddenSends)

            // An immutable accepted echo is a queue barrier after the deliberately late controlled packets.
            let acceptedObject = try JSONSerialization.jsonObject(with: packets.accepted.bytes)
            let echo = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: acceptedObject, options: .prettyPrinted))
            let settled = expectation(description: "late packet batch processed " + extent)
            settled.assertForOverFulfill = false
            await harness.coordinator.setCentralTextObserver { if $0.accepted?.bytes == echo.bytes { settled.fulfill() } }
            let visibleSequence = try XCTUnwrap(displayed.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self))
            if visibleSequence < packets.chunks.count {
                await harness.realtime.emit(.centralText(packets.chunks[visibleSequence]))
            }
            await harness.realtime.emit(.centralText(packets.lateChunk))
            await harness.realtime.emit(.centralText(try packets.receiptPacket()))
            await harness.realtime.emit(.centralText(echo))
            await fulfillment(of: [settled], timeout: 2)
            let cancelled = await harness.coordinator.centralTextSnapshot()
            XCTAssertEqual(cancelled.presentation, displayed)
            XCTAssertTrue(cancelled.status.contains("中断"))
            XCTAssertNil(cancelled.renderedACK)
            XCTAssertTrue(try cancelled.canBeginSubmit)
            XCTAssertFalse(try cancelled.canRequestSealedResult)
            try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "next-explicit-" + extent, text: "next explicit source"))
            let next = await harness.coordinator.centralTextSnapshot()
            XCTAssertNil(next.accepted)
            XCTAssertNil(next.header)
            XCTAssertNil(next.presentation, "Explicit new submission must not invent a completion")
            _ = await harness.coordinator.stop()
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            try await harness.coordinator.retryCentralSubmission()
            try await harness.coordinator.submitPrompt(prompt)
            let queued = await harness.coordinator.centralTextSnapshot()
            XCTAssertEqual(queued.eventID, next.eventID, "New submission preserves the unknown foreground source")
            XCTAssertEqual(queued.submissionDelivery(eventID: prompt.promptID), .pending)
            for packet in [packets.accepted, packets.sealedHeader] + packets.chunks + [packets.header] {
                await harness.realtime.emit(.centralText(packet), handlerIndex: 0)
            }
            let restarted = await harness.coordinator.centralTextSnapshot()
            XCTAssertNil(restarted.accepted, "Even matching original source identity cannot revive a retired callback generation")
            XCTAssertNil(restarted.header)
            XCTAssertNil(restarted.presentation)
            _ = await harness.coordinator.stop()
        }
    }

    func testAutomaticCompletionCanArriveBeforeSubmitPublicationReturns() async throws {
        let fixture = try CentralTextTestFixture(name: "automatic-text-envelope.fixture")
        for mode in ["text", "instant"] {
            let packets = try fixture.completion(mode)
            let harness = await Harness.make(canPublishData: true)
            await harness.bootstrap.setCentralBinding(fixture.binding)
            try await harness.coordinator.setTextOwner(.centralCandidate)
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            let delivered = expectation(description: "automatic header during submit " + mode)
            delivered.assertForOverFulfill = false
            await harness.coordinator.setCentralTextObserver {
                if $0.header != nil && (packets.chunks.isEmpty || $0.presentation?.isFinal == true) { delivered.fulfill() }
            }
            let gate = StopGate()
            let events = [.centralText(packets.accepted), .centralText(packets.header)] + packets.chunks.map(AssistantRealtimeEvent.centralText)
            await harness.realtime.setImmediateCentralCompletion(events, gate: gate)
            let submit = AssistantPromptEnvelope(promptID: try XCTUnwrap(packets.submit["event_id"]), text: try XCTUnwrap(packets.submit["text"]))
            let submission = Task { try await harness.coordinator.submitPrompt(submit) }
            await gate.waitUntilEntered()
            await fulfillment(of: [delivered], timeout: 2)
            let current = await harness.coordinator.centralTextSnapshot()
            XCTAssertNotNil(current.header)
            XCTAssertNil(current.renderedACK)
            let published = await harness.realtime.centralPackets
            XCTAssertEqual(published.count, 1, "No result request or render ACK is needed to receive automatic completion")
            if mode == "instant" { XCTAssertTrue(current.status.contains("失败")); XCTAssertNil(current.presentation) }
            else { XCTAssertEqual(current.presentation?.text, "automatic 🔬文字") }
            await gate.release()
            try await submission.value
            _ = await harness.coordinator.stop()
            await harness.realtime.emit(.centralText(packets.header), handlerIndex: 0)
            let closed = await harness.coordinator.centralTextSnapshot()
            XCTAssertNil(closed.binding)
            if mode == "text" { XCTAssertEqual(closed.presentation?.text, current.presentation?.text, "Unrendered final must survive disconnection") }
            else { XCTAssertNil(closed.header); XCTAssertNil(closed.presentation) }
            XCTAssertThrowsError(try closed.retryTypedSubmission(), "A retired callback cannot restore transport readiness")
        }
    }

    func testQwenReplyQueuesDuringForegroundAndCompletesOnlyOnAdmission() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("qwen-busy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let fixture = try CentralTextTestFixture(name: "automatic-text-envelope.fixture"), binding = fixture.binding
        let completion = try fixture.completion("text")
        let harness = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await harness.bootstrap.setCentralBinding(binding)
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: XCTUnwrap(completion.submit["event_id"]), text: XCTUnwrap(completion.submit["text"])))
        let pending = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "source"))
        let callback = try XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=ok"))
        let reply = try XCTUnwrap(database.consumeQwenReply(callback, identity: "owner"))
        let prompt = AssistantPromptEnvelope(promptID: reply.eventID, text: reply.text)
        try await harness.coordinator.submitPrompt(prompt, retained: reply)
        let queued = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(queued.submissionDelivery(eventID: reply.eventID), .pending)
        XCTAssertEqual(try database.pendingQwenReply(identity: "owner"), reply)

        let finished = expectation(description: "original conversation is free")
        finished.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { if $0.presentation?.isFinal == true { finished.fulfill() } }
        await harness.realtime.emitBurst([.centralText(completion.accepted), .centralText(completion.header)] + completion.chunks.map(AssistantRealtimeEvent.centralText))
        await fulfillment(of: [finished], timeout: 2)
        try database.acknowledgeQwenReply(await harness.coordinator.centralTextSnapshot())
        XCTAssertEqual(try database.pendingQwenReply(identity: "owner"), reply, "Another event's admission cannot consume this reply")
        try await harness.coordinator.submitPrompt(prompt, retained: reply)
        try database.acknowledgeQwenReply(await harness.coordinator.centralTextSnapshot())
        XCTAssertEqual(try database.pendingQwenReply(identity: "owner"), reply, "SDK publish is not durable acceptance")

        var accepted = try XCTUnwrap(JSONSerialization.jsonObject(with: completion.accepted.bytes) as? [String: Any])
        accepted["event_id"] = reply.eventID; accepted["processed_event_id"] = "qwen-accepted"
        var admission = try XCTUnwrap(accepted["admission"] as? [String: Any])
        admission["run_id"] = "qwen-run"; admission["run_order"] = 2; admission["idempotency_key"] = "qwen-idempotency"
        accepted["admission"] = admission
        let admitted = expectation(description: "Qwen durably accepted")
        admitted.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver {
            let delivery = $0.submissionDelivery(eventID: reply.eventID)
            if delivery == .accepted || delivery == .queued { admitted.fulfill() }
        }
        await harness.realtime.emit(.centralText(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: accepted))))
        await fulfillment(of: [admitted], timeout: 2)
        try database.acknowledgeQwenReply(await harness.coordinator.centralTextSnapshot())
        XCTAssertNil(try database.pendingQwenReply(identity: "owner"))
    }

    func testQwenReplySurvivesOfflineRelaunchAndReusesTheOriginalSubmitMetadata() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("qwen-relaunch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("pending.sqlite"), database = try AssistantLocalOperationDatabase(url: url)
        let pending = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "source"))
        let callback = try XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=ok"))
        XCTAssertNil(try database.consumeQwenReply(callback, identity: "other-owner"))
        let fix = AssistantLocationObservation(localCaptureID: "original-fix", latitude: 31.2, longitude: 121.4,
            horizontalAccuracy: 10, observedAt: Date(), place: "上海")
        let reply = try XCTUnwrap(database.consumeQwenReply(callback, identity: "owner", location: fix))
        let prompt = AssistantPromptEnvelope(promptID: reply.eventID, text: reply.text)
        let offline = await ErrorCoordinatorHarness.make(error: .transportFailure)
        do { try await offline.submitPrompt(prompt, retained: reply); XCTFail("Offline bootstrap cannot admit a submission") }
        catch RealtimePublicControlAdapterError.transportFailure { }
        let reopened = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(try reopened.pendingQwenReply(identity: "owner"), reply)
        XCTAssertNil(try reopened.pendingQwenReply(identity: "other-owner"))
        XCTAssertNil(try reopened.preserveQwenHandoff(identity: "owner", sourceID: "source"), "A consumed handoff is not reopened on relaunch")

        let binding = try CentralTextTestFixture().binding
        let original = try AssistantCentralTextWire.submit(eventID: reply.eventID, capturedAt: reply.capturedAt, text: reply.text, location: fix)
        let replacement = await Harness.make(canPublishData: true, localDatabase: reopened, ownerIdentity: { ("other-owner", binding.deviceID) })
        await replacement.bootstrap.setCentralBinding(binding)
        do { try await replacement.coordinator.submitPrompt(prompt, retained: reply); XCTFail("A re-pair cannot submit the previous owner's reply") }
        catch CentralTextError.contextChanged { }
        let foreignPackets = await replacement.realtime.centralPackets
        XCTAssertTrue(foreignPackets.isEmpty)
        _ = await replacement.coordinator.stop()
        for _ in 0..<2 {
            let harness = await Harness.make(canPublishData: true, localDatabase: reopened, ownerIdentity: { ("owner", binding.deviceID) })
            await harness.bootstrap.setCentralBinding(binding)
            try await harness.coordinator.submitPrompt(prompt, retained: XCTUnwrap(reopened.pendingQwenReply(identity: "owner")))
            let packets = await harness.realtime.centralPackets
            XCTAssertEqual(packets.first, original, "Relaunch cannot regenerate the event id, captured_at or payload")
            _ = await harness.coordinator.stop()
        }
    }

    func testServerCentralOwnerSelectsTheCentralPathBeforeSDKConnect() async throws {
        let fixture = try CentralTextTestFixture()
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let owner = await harness.coordinator.textOwner
        XCTAssertEqual(owner, .centralCandidate, "The gateway's bootstrap names the text owner")
        let legacy = await harness.realtime.publishedPrompts
        XCTAssertTrue(legacy.isEmpty, "Nothing is ever sent on the legacy topic to a central owner")
    }

    func testServerNamedTransportSelectsTheOwnerAndNeverDoubleSendsLegacy() async throws {
        let legacyServer = await Harness.make(canPublishData: true)
        try await legacyServer.coordinator.start(AssistantStartIntent(userInitiated: true))
        let legacyOwner = await legacyServer.coordinator.textOwner
        XCTAssertEqual(legacyOwner, .legacy, "Without a server-named central transport the session stays legacy")
        let missingPackets = await legacyServer.realtime.centralPackets
        XCTAssertTrue(missingPackets.isEmpty)

        let fixture = try CentralTextTestFixture()
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        let defaultOwner = await harness.coordinator.textOwner
        XCTAssertEqual(defaultOwner, .legacy)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let centralOwner = await harness.coordinator.textOwner
        XCTAssertEqual(centralOwner, .centralCandidate)
        let accepted = expectation(description: "source accepted")
        accepted.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { if $0.accepted != nil { accepted.fulfill() } }
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "formal-event", text: "explicit original"))
        await harness.realtime.emit(.centralText(try fixture.packet("accepted")))
        await fulfillment(of: [accepted], timeout: 2)
        let legacyPackets = await harness.realtime.publishedPrompts
        let centralPackets = await harness.realtime.centralPackets
        XCTAssertTrue(legacyPackets.isEmpty)
        XCTAssertEqual(centralPackets.count, 1)
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(centralPackets[0]), "Submit is not an output packet")
        do { try await harness.coordinator.setTextOwner(.legacy); XCTFail("An active room cannot change execution owner") }
        catch { XCTAssertTrue(error is CentralTextError) }
        let beforeRequest = await harness.realtime.centralPackets.count
        XCTAssertEqual(beforeRequest, 1, "Accepted must not start polling")
        let final = expectation(description: "ordered Unicode final")
        final.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { if $0.presentation?.isFinal == true { final.fulfill() } }
        await harness.realtime.emit(.centralText(try fixture.packet("pending_header")))
        for chunk in try fixture.chunks() { await harness.realtime.emit(.centralText(chunk)) }
        await fulfillment(of: [final], timeout: 3)
        let complete = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(complete.presentation?.text.utf8.count, 240_000)
        XCTAssertNil(complete.renderedACK)
        let automaticPackets = await harness.realtime.centralPackets
        XCTAssertEqual(automaticPackets.count, 1, "Automatic completion requires no result command")
        let displayed = try XCTUnwrap(complete.presentation)
        let input = try XCTUnwrap(fixture.values["input_ack"] as? [String: Any])
        let expectedACK = try XCTUnwrap(input["ack"] as? [String: Any])
        await harness.realtime.failNextCentralSend()
        do {
            try await harness.coordinator.centralTextConsumed(displayed, observedAt: XCTUnwrap(expectedACK["observed_at"] as? String))
            XCTFail("Controlled ACK callback loss must stay unknown")
        } catch { }
        let lost = await harness.coordinator.centralTextSnapshot()
        XCTAssertFalse(lost.ackConfirmed)
        let firstACKCount = await harness.realtime.centralPackets.count
        try await eventually("original render ACK retries automatically") { await harness.realtime.centralPackets.count > firstACKCount }
        let replayed = await harness.realtime.centralPackets
        XCTAssertEqual(replayed.suffix(2).first, replayed.last)
        let acknowledged = expectation(description: "actual ACK receipt tuple")
        await harness.coordinator.setCentralTextObserver { if $0.ackConfirmed { acknowledged.fulfill() } }
        await harness.realtime.emit(.centralText(try fixture.packet("ack_receipt")))
        await fulfillment(of: [acknowledged], timeout: 2)
        _ = await harness.coordinator.stop()
        await harness.realtime.emit(.centralText(try fixture.packet("pending_header")), handlerIndex: 0)
        let closed = await harness.coordinator.centralTextSnapshot()
        XCTAssertNil(closed.binding)
        XCTAssertNil(closed.presentation)
    }

    func testControlEventsRemainOrderedWhenTextBudgetIsFull() async throws {
        let fixture = try CentralTextTestFixture(), ingress = AssistantRealtimeEventIngress(capacity: 1)
        let chunk = try XCTUnwrap(fixture.chunks().first)
        XCTAssertTrue(ingress.yield(.centralText(chunk)))
        XCTAssertFalse(ingress.yield(.centralText(chunk)))
        XCTAssertTrue(ingress.yield(.reconnecting))
        XCTAssertTrue(ingress.yield(.centralText(try fixture.packet("ack_receipt"))))
        XCTAssertTrue(ingress.yield(.disconnected(errorCode: "gateway_left")))
        ingress.close()
        XCTAssertFalse(ingress.yield(.reconnected))
        var order: [String] = []
        for await event in ingress.stream {
            ingress.didDequeue(event)
            switch event {
            case .centralText(let packet): order.append(try XCTUnwrap(packet.fields.value("operation", as: String.self)))
            case .reconnecting: order.append("reconnecting")
            case .disconnected(let code): order.append(try XCTUnwrap(code))
            default: XCTFail("Unexpected event")
            }
        }
        XCTAssertEqual(order, ["text_chunk", "reconnecting", "ack_receipt", "gateway_left"])
        XCTAssertTrue(ingress.takeOverflow())
        XCTAssertFalse(ingress.takeOverflow())
    }

    func testFullTextQueueCannotHideGatewayDeparture() async throws {
        let fixture = try CentralTextTestFixture()
        let harness = await Harness.make(canPublishData: true, realtimeEventCapacity: 1)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.setTextOwner(.centralCandidate)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let text = AssistantRealtimeEvent.centralText(try fixture.packet("pending_header"))
        await harness.realtime.emitBurst(Array(repeating: text, count: 300) + [.disconnected(errorCode: "gateway_left")])
        try await eventually("gateway departure reaches session state") {
            await harness.coordinator.snapshot() == .failed(code: "gateway_left")
        }
        let current = await harness.coordinator.snapshot()
        XCTAssertEqual(current, .failed(code: "gateway_left"))
    }

    func testCentralOverflowRequiresExplicitOriginalDReadAndReconnectKeepsOriginalTuple() async throws {
        let fixture = try CentralTextTestFixture()
        let harness = await Harness.make(canPublishData: true, realtimeEventCapacity: 3)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.setTextOwner(.centralCandidate)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "formal-event", text: "explicit original"))
        let admitted = expectation(description: "admission retained")
        admitted.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { if $0.accepted != nil { admitted.fulfill() } }
        await harness.realtime.emit(.centralText(try fixture.packet("accepted")))
        await fulfillment(of: [admitted], timeout: 2)
        try await harness.coordinator.requestCentralResult()
        let overflow = expectation(description: "explicit callback overflow")
        overflow.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { if $0.status.contains("超限") { overflow.fulfill() } }
        let burst = [.centralText(try fixture.packet("pending_header"))] + (try fixture.chunks()).map(AssistantRealtimeEvent.centralText)
        await harness.realtime.emitBurst(burst)
        await fulfillment(of: [overflow], timeout: 2)
        let preserved = await harness.coordinator.centralTextSnapshot()
        XCTAssertNotNil(preserved.accepted)
        let packets = await harness.realtime.centralPackets
        XCTAssertEqual(packets.count, 2, "Overflow adds no automatic result request or resubmission")
        let stateProbe = StateProbe()
        await harness.coordinator.setObserver { state in Task { await stateProbe.record(state.state) } }
        await harness.realtime.emit(.reconnecting)
        await stateProbe.waitFor(.reconnecting)
        do { try await harness.coordinator.requestCentralResult(); XCTFail("Cannot send while encryption is being revalidated") }
        catch { }
        let resumeProbe = StateProbe()
        await harness.coordinator.setObserver { state in Task { await resumeProbe.record(state.state) } }
        await harness.realtime.emit(.reconnected)
        await harness.realtime.emit(.encryptionActive)
        await resumeProbe.waitFor(.active(encryptionActive: true))
        let afterReconnect = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(afterReconnect.accepted, preserved.accepted)
        XCTAssertEqual(afterReconnect.binding, fixture.binding)
        try await harness.coordinator.requestCentralResult(sealed: true)
        let requested = await harness.realtime.centralPackets
        let originalD = try XCTUnwrap(JSONSerialization.jsonObject(with: requested[1]) as? [String: String])
        let reread = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requested.last)) as? [String: String])
        XCTAssertEqual(originalD["processed_event_id"], reread["processed_event_id"])
        XCTAssertEqual(reread["text_replay"], "sealed", "Recovery is an explicit read of the same original D")
        _ = await harness.coordinator.stop()
    }

    func testConcurrentStopsShareOneInFlightRemoteStop() async throws {
        let stopGate = StopGate()
        let harness = await Harness.make(stopGate: stopGate)
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )

        let first = Task {
            await harness.coordinator.stop()
        }
        await stopGate.waitUntilEntered()

        let second = Task {
            await harness.coordinator.stop()
        }
        await stopGate.release()

        let firstResult = await first.value
        let secondResult = await second.value
        let bootstrapStopCount = await harness.bootstrap.stopCount
        let realtimeStopCount = await harness.realtime.stopCount
        let snapshot = await harness.coordinator.snapshot()
        XCTAssertEqual(firstResult, secondResult)
        XCTAssertEqual(bootstrapStopCount, 1)
        XCTAssertEqual(realtimeStopCount, 1)
        XCTAssertEqual(
            snapshot,
            .stopped(remoteStopConfirmed: true)
        )
    }

    func testStopDuringInFlightConnectInvalidatesStartGeneration() async throws {
        let connectGate = StopGate()
        let harness = await Harness.make(connectGate: connectGate)
        let startTask = Task {
            try await harness.coordinator.start(
                AssistantStartIntent(userInitiated: true)
            )
        }
        await connectGate.waitUntilEntered()

        let stopResult = await harness.coordinator.stop()
        XCTAssertTrue(stopResult.confirmed)
        await connectGate.release()

        do {
            try await startTask.value
            XCTFail("Expected superseded")
        } catch {
            XCTAssertEqual(
                error as? AssistantSessionCoordinatorError,
                .superseded
            )
        }

        let realtimeStopCount = await harness.realtime.stopCount
        let snapshot = await harness.coordinator.snapshot()
        XCTAssertEqual(realtimeStopCount, 1)
        XCTAssertEqual(
            snapshot,
            .stopped(remoteStopConfirmed: true)
        )
    }

    func testStopIgnoresDelayedConnectedEvent() async throws {
        let harness = await Harness.make()
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )

        let result = await harness.coordinator.stop()
        XCTAssertTrue(result.confirmed)

        // This models a RoomDelegate callback queued before Stop completed.
        await harness.realtime.emit(.connected)
        await Task.yield()
        await Task.yield()

        let snapshot = await harness.coordinator.snapshot()
        XCTAssertEqual(
            snapshot,
            .stopped(remoteStopConfirmed: true)
        )
    }

    func testResultObserverAddsLocalContextAndDropsOldGeneration()
        async throws {
        let harness = await Harness.make()
        let probe = ResultProbe()
        await harness.coordinator.setResultObserver { envelope in
            Task {
                await probe.record(envelope)
            }
        }

        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: "wire-stream",
                    sequence: 1,
                    text: "first",
                    isFinal: true
                )
            )
        )
        await probe.waitForCount(1)
        let first = await probe.first()
        XCTAssertEqual(first?.sessionID ?? "", "assistant-logical-session-1")
        XCTAssertEqual(first?.epoch ?? 0, 1)

        _ = await harness.coordinator.stop()
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )

        // This invokes the callback captured by the first connection only.
        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: "wire-stream",
                    sequence: 2,
                    text: "late",
                    isFinal: false
                )
            ),
            handlerIndex: 0
        )
        await Task.yield()
        await Task.yield()
        let count = await probe.count
        XCTAssertEqual(count, 1)
    }

    func testPromptPublishingAllowsTwoStreamsAndRejectsCompletedLateReply()
        async throws {
        let harness = await Harness.make(canPublishData: true)
        let probe = ResultProbe()
        await harness.coordinator.setResultObserver { envelope in
            Task {
                await probe.record(envelope)
            }
        }
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )

        let firstID = "550e8400-e29b-41d4-a716-446655440000"
        let secondID = "550e8400-e29b-41d4-a716-446655440001"
        try await harness.coordinator.submitPrompt(
            AssistantPromptEnvelope(
                promptID: firstID,
                text: "18乘以7是多少？请只回答数字。"
            )
        )
        try await harness.coordinator.submitPrompt(
            AssistantPromptEnvelope(
                promptID: secondID,
                text: "把你上一条结果加9，只回答数字。"
            )
        )
        let publishedPromptIDs =
            await harness.realtime.publishedPrompts.map(\.promptID)
        XCTAssertEqual(publishedPromptIDs, [firstID, secondID])

        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: secondID,
                    sequence: 1,
                    text: "135",
                    isFinal: true
                )
            )
        )
        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: firstID,
                    sequence: 1,
                    text: "126",
                    isFinal: true
                )
            )
        )
        await probe.waitForCount(2)
        let firstProbeCount = await probe.count
        XCTAssertEqual(firstProbeCount, 2)

        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: secondID,
                    sequence: 2,
                    text: "late",
                    isFinal: false
                )
            )
        )
        await Task.yield()
        await Task.yield()
        let lateProbeCount = await probe.count
        XCTAssertEqual(lateProbeCount, 2)
    }

    func testPromptErrorClearsPendingWithoutChangingPromptAdmission()
        async throws {
        let harness = await Harness.make(canPublishData: true)
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        let firstID = "550e8400-e29b-41d4-a716-446655440010"
        let secondID = "550e8400-e29b-41d4-a716-446655440011"
        try await harness.coordinator.submitPrompt(
            AssistantPromptEnvelope(
                promptID: firstID,
                text: "18乘以7是多少？请只回答数字。"
            )
        )
        await harness.realtime.emit(
            .result(
                AssistantResultEnvelope(
                    streamID: firstID,
                    sequence: 1,
                    text: "",
                    isFinal: true,
                    errorCode: "MODEL_FAILED"
                )
            )
        )
        try await harness.coordinator.submitPrompt(
            AssistantPromptEnvelope(
                promptID: secondID,
                text: "把你上一条结果加9，只回答数字。"
            )
        )
        let publishedPromptIDs =
            await harness.realtime.publishedPrompts.map(\.promptID)
        XCTAssertEqual(publishedPromptIDs, [firstID, secondID])
    }

    func testUnexpectedDisconnectCleansBeforeAllowingRestart() async throws {
        let harness = await Harness.make()
        let probe = StateProbe()
        await harness.coordinator.setObserver { state in
            Task {
                await probe.record(state.state)
            }
        }
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )

        await harness.realtime.emit(.disconnected(errorCode: "network"))
        await probe.waitFor(.failed(code: "network"))

        let snapshot = await harness.coordinator.snapshot()
        let realtimeStopCount = await harness.realtime.stopCount
        let bootstrapStopCount = await harness.bootstrap.stopCount
        XCTAssertEqual(
            snapshot,
            .failed(code: "network")
        )
        XCTAssertEqual(realtimeStopCount, 1)
        XCTAssertEqual(bootstrapStopCount, 1)

        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        let connectCount = await harness.realtime.connectCount
        XCTAssertEqual(connectCount, 2)
    }

    func testPermissionFailurePreventsBootstrap() async throws {
        let harness = await Harness.make(
            permissionStatus: .denied
        )

        do {
            try await harness.coordinator.start(
                AssistantStartIntent(
                    cameraEnabled: true,
                    userInitiated: true
                )
            )
            XCTFail("Expected cameraDenied")
        } catch {
            XCTAssertEqual(
                error as? MediaPermissionError,
                .cameraDenied
            )
        }

        let bootstrapCount = await harness.bootstrap.bootstrapCount
        let connectCount = await harness.realtime.connectCount
        XCTAssertEqual(bootstrapCount, 0)
        XCTAssertEqual(connectCount, 0)
    }

    func testStopDuringDelayedBootstrapCancelsAndCannotReactivate()
        async throws {
        let bootstrapGate = StopGate()
        let harness = await Harness.make(bootstrapGate: bootstrapGate)
        let startTask = Task {
            try await harness.coordinator.start(
                AssistantStartIntent(userInitiated: true)
            )
        }
        await bootstrapGate.waitUntilEntered()

        await harness.coordinator.handleLifecycleSignal(.networkPath(AssistantNetworkPathState(
            status: .unsatisfied, isExpensive: false, isConstrained: false, usesWiFi: false, usesCellular: false)))
        let waiting = await harness.coordinator.snapshot()
        XCTAssertEqual(waiting, .bootstrapping, "Initial network observation must not cancel an admitted bootstrap")

        let stopResult = await harness.coordinator.stop()
        XCTAssertFalse(stopResult.confirmed)
        await bootstrapGate.release()

        do {
            try await startTask.value
            XCTFail("Expected superseded")
        } catch {
            XCTAssertEqual(
                error as? AssistantSessionCoordinatorError,
                .superseded
            )
        }
        let providerObservedCancellation =
            await harness.bootstrap.bootstrapCancelledAtReturn
        let invalidationCount =
            await harness.bootstrap.pendingBootstrapInvalidationCount
        let connectCount = await harness.realtime.connectCount
        let snapshot = await harness.coordinator.snapshot()
        XCTAssertTrue(providerObservedCancellation)
        XCTAssertEqual(invalidationCount, 1)
        XCTAssertEqual(connectCount, 0)
        XCTAssertEqual(
            snapshot,
            .stopped(remoteStopConfirmed: false)
        )
    }

#if canImport(WatchConnectivity)
    func testWatchMetricsRetireLegacyRelayAndOneShotLocation() async throws {
        let harness = await Harness.make(canPublishData: true)
        try await harness.coordinator.start(AssistantStartIntent(locationEnabled: true, userInitiated: true))
        await harness.coordinator.handleCyclingMetric(makeCyclingMetric(sequence: 1))
        await harness.coordinator.handleCyclingMetric(makeCyclingMetric(sequence: 2))
        let events = await harness.realtime.publishedEvents
        let requests = await harness.location.requestCount
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(requests, 0)
    }

    private func makeCyclingMetric(
        sequence: UInt64
    ) -> WatchCyclingMetricEnvelope {
        WatchCyclingMetricEnvelope(
            sequence: sequence,
            observedAt: Date(
                timeIntervalSince1970: 1_700_000_000 + Double(sequence)
            ),
            workoutID: "cycling_workout_01",
            heartRateBPM: 140 + Double(sequence),
            activeEnergyKcal: 10 + Double(sequence),
            distanceM: 100 * Double(sequence),
            elapsedS: 60 * Double(sequence),
            cadenceSPM: 80 + Double(sequence),
            cyclingSpeedMPS: 8
        )
    }
#endif

    func testSecondSessionStopsOnInterruptionAndNetworkLoss() async throws {
        let harness = await Harness.make()
        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        _ = await harness.coordinator.stop()

        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        await harness.coordinator.handleLifecycleSignal(
            .audioInterruptionBegan
        )
        let afterInterruption = await harness.coordinator.snapshot()
        XCTAssertEqual(
            afterInterruption,
            .stopped(remoteStopConfirmed: true)
        )

        try await harness.coordinator.start(
            AssistantStartIntent(userInitiated: true)
        )
        await harness.coordinator.handleNetworkPath(
            AssistantNetworkPathState(
                status: .unsatisfied,
                isExpensive: false,
                isConstrained: false,
                usesWiFi: false,
                usesCellular: false
            )
        )
        let afterNetworkLoss = await harness.coordinator.snapshot()
        XCTAssertEqual(
            afterNetworkLoss,
            .stopped(remoteStopConfirmed: true)
        )
    }
}

private final class RecordingRingback: CallRingbackPlaying, @unchecked Sendable {
    private let lock = NSLock(); private var log: [String] = []
    var events: [String] { lock.lock(); defer { lock.unlock() }; return log }
    func start() { lock.lock(); log.append("start"); lock.unlock() }
    func stop() { lock.lock(); log.append("stop"); lock.unlock() }
}

private struct Harness {
    let coordinator: AssistantSessionCoordinator
    let bootstrap: FakeBootstrapProvider
    let realtime: FakeRealtimeTransport
    let permissions: FakePermissionProvider
    let location: FakeLocationProvider
    let watchControl: FakeWatchControlSender

    @MainActor
    static func make(
        permissionStatus: AssistantPermissionStatus = .authorized,
        stopGate: StopGate? = nil,
        connectGate: StopGate? = nil,
        bootstrapGate: StopGate? = nil,
        canPublishData: Bool = false,
        transport: (any AssistantRealtimeTransporting)? = nil,
        dataPublishFailures: Int = 0,
        watchDeliveryStatuses: [AssistantWatchControlDeliveryStatus] = [],
        contactsSync: AssistantContactsSync = AssistantContactsSync(),
        ownerDataPairing: @escaping @Sendable () throws -> RealtimeDevicePairing? = { nil },
        localWakeCapture: (start: @Sendable () throws -> Void, stop: @Sendable () throws -> Void) = ({}, {}),
        realtimeEventCapacity: Int = AssistantRealtimeEventIngress.maximumQueuedEvents,
        voiceSendWait: UInt64 = 10_000_000_000,
        voiceTurnSleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        callDialTimeout: UInt64 = 20_000_000_000,
        ringback: (any CallRingbackPlaying)? = nil,
        artc: (any ARTCCallClient)? = nil,
        localDatabase: AssistantLocalOperationDatabase? = nil,
        voiceIdentityAuth: String = "face_id",
        authenticateVoiceIdentity: @escaping @Sendable () async throws -> Void = { try await CentralVoiceBiometrics.faceID() },
        ownerIdentity: (@Sendable () throws -> (identity: String, deviceID: String)?)? = nil
    ) -> Harness {
        let details = AssistantConnectionDetails(
            serverURL: URL(string: "wss://example.livekit.cloud")!,
            roomName: "opaque-room",
            participantToken: "opaque-token",
            capabilities: AssistantMediaCapabilities(
                publishableSources: [.microphone, .camera],
                canPublishData: canPublishData
            )
        )
        let bootstrap = FakeBootstrapProvider(
            details: details,
            stopGate: stopGate,
            bootstrapGate: bootstrapGate
        )
        let realtime = FakeRealtimeTransport(
            connectGate: connectGate,
            dataPublishFailures: dataPublishFailures
        )
        let permissions = FakePermissionProvider(status: permissionStatus)
        let location = FakeLocationProvider()
        let watchControl = FakeWatchControlSender(
            statuses: watchDeliveryStatuses
        )
        let coordinator = AssistantSessionCoordinator(
            bootstrapProvider: bootstrap,
            realtime: transport ?? realtime,
            mediaPermissions: permissions,
            locationService: location,
            receipts: AppleReceiptStore(),
            watchControl: watchControl,
            contactsSync: contactsSync, ownerDataPairing: ownerDataPairing, localWakeCapture: localWakeCapture,
            realtimeEventCapacity: realtimeEventCapacity,
            voiceSendConfirmationWait: voiceSendWait,
            voiceTurnSleep: voiceTurnSleep,
            callDialTimeout: callDialTimeout,
            ringback: ringback,
            artc: artc,
            localDatabase: localDatabase,
            voiceIdentityAuth: voiceIdentityAuth,
            authenticateVoiceIdentity: authenticateVoiceIdentity,
            careIdentity: ownerIdentity ?? { localDatabase == nil ? nil : ("owner-pairing", "phone-voice") }
        )
        return Harness(
            coordinator: coordinator,
            bootstrap: bootstrap,
            realtime: realtime,
            permissions: permissions,
            location: location,
            watchControl: watchControl
        )
    }
}


private actor FakeWatchControlSender: AssistantWatchControlSending {
    private var commands: [AssistantCyclingControlCommand] = []
    private var statuses: [AssistantWatchControlDeliveryStatus]

    init(statuses: [AssistantWatchControlDeliveryStatus] = []) {
        self.statuses = statuses
    }

    var commandCount: Int {
        commands.count
    }

    var actions: [AssistantCyclingControlAction] {
        commands.map(\.action)
    }

    func sendCyclingControl(
        _ command: AssistantCyclingControlCommand
    ) async -> AssistantWatchControlDeliveryStatus {
        commands.append(command)
        if statuses.isEmpty {
            return .accepted
        }
        return statuses.removeFirst()
    }

    func waitForCount(_ count: Int) async {
        while commands.count < count {
            await Task.yield()
        }
    }
}
private final class DeterministicUUIDv7Entropy: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt8 = 0

    func next(count: Int) -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        value &+= 1
        return [UInt8](repeating: value, count: count)
    }
}

private actor StopGate {
    private var entered = false
    private var released = false
    private var enteredWaiters: [
        CheckedContinuation<Void, Never>
    ] = []
    private var releaseWaiters: [
        CheckedContinuation<Void, Never>
    ] = []

    func markEntered() {
        entered = true
        let waiters = enteredWaiters
        enteredWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilEntered() async {
        if entered {
            return
        }
        await withCheckedContinuation { continuation in
            enteredWaiters.append(continuation)
        }
    }

    func waitForRelease() async {
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

private actor StateProbe {
    private var states: [AssistantSessionState] = []
    private var waiters: [
        (AssistantSessionState, CheckedContinuation<Void, Never>)
    ] = []

    func record(_ state: AssistantSessionState) {
        states.append(state)
        let matching = waiters.filter { $0.0 == state }
        waiters.removeAll { $0.0 == state }
        matching.forEach { $0.1.resume() }
    }

    func waitFor(_ state: AssistantSessionState) async {
        if states.contains(state) {
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append((state, continuation))
        }
    }
}

private actor ResultProbe {
    private var envelopes: [AssistantResultEnvelope] = []

    var count: Int {
        envelopes.count
    }

    func record(_ envelope: AssistantResultEnvelope) {
        envelopes.append(envelope)
    }

    func first() -> AssistantResultEnvelope? {
        envelopes.first
    }

    func waitForCount(_ count: Int) async {
        while envelopes.count < count {
            await Task.yield()
        }
    }
}

private struct ErrorCoordinatorHarness {
    @MainActor
    static func make(
        error: RealtimePublicControlAdapterError
    ) -> AssistantSessionCoordinator {
        AssistantSessionCoordinator(
            bootstrapProvider: ThrowingBootstrapProvider(error: error),
            realtime: FakeRealtimeTransport(),
            mediaPermissions: FakePermissionProvider(
                status: .authorized
            ),
            locationService: FakeLocationProvider(),
            receipts: AppleReceiptStore(),
            careIdentity: { nil }
        )
    }
}

private actor ThrowingBootstrapProvider: AssistantBootstrapProviding,
    AssistantBootstrapInvalidating {
    private let error: RealtimePublicControlAdapterError

    init(error: RealtimePublicControlAdapterError) {
        self.error = error
    }

    func bootstrap(
        for intent: AssistantStartIntent
    ) async throws -> AssistantConnectionDetails {
        throw error
    }

    func stop(
        _ context: AssistantStopContext
    ) async throws -> AssistantRemoteStopResult {
        AssistantRemoteStopResult(
            confirmed: false,
            opaqueReference: nil
        )
    }

    func invalidatePendingBootstrap() {}
}

private actor FakeBootstrapProvider: AssistantBootstrapProviding,
    AssistantBootstrapInvalidating {
    private let details: AssistantConnectionDetails
    private let stopGate: StopGate?
    private let bootstrapGate: StopGate?
    private(set) var bootstrapCount = 0
    private(set) var refreshCount = 0
    private var reconnectDeadlines: [Date?] = []
    private var reconnectGate: StopGate?
    func setReconnectDeadlines(_ deadlines: [Date?], gate: StopGate? = nil) { reconnectDeadlines = deadlines; reconnectGate = gate }
    private var reconnectError: AssistantCallRecoveryError?
    func rejectReconnectBinding(_ error: AssistantCallRecoveryError? = .bindingGone("LEASE_REVOKED")) { reconnectError = error }
    func reconnectDetails(_ existing: AssistantConnectionDetails, for intent: AssistantStartIntent, callID: String?) async throws -> AssistantConnectionDetails {
        refreshCount += 1
        if let reconnectError { throw reconnectError }
        let token = "refreshed-token-\(refreshCount)", deadline = reconnectDeadlines.isEmpty ? nil : reconnectDeadlines.removeFirst()
        if let gate = reconnectGate { reconnectGate = nil; await gate.markEntered(); await gate.waitForRelease() }
        return AssistantConnectionDetails(serverURL: existing.serverURL, roomName: existing.roomName,
            participantToken: token, capabilities: existing.capabilities, callRejoinDeadline: deadline)
    }
    private(set) var stopCount = 0
    private var centralBinding: CentralTransportBinding?
    func setCentralBinding(_ binding: CentralTransportBinding) { centralBinding = binding }
    func centralTransportBinding() async throws -> CentralTransportBinding? { centralBinding }
    private var restoredStop: AssistantStopContext?
    private var restoreFails = false
    private var restoreGate: StopGate?
    private(set) var restoreCount = 0
    private(set) var lastStopContext: AssistantStopContext?
    func setRestoredStop(_ context: AssistantStopContext?, gate: StopGate? = nil) {
        restoredStop = context; restoreGate = gate
    }
    func setRestoreFailure() { restoreFails = true }
    func clearRestoreFailure() { restoreFails = false }
    func restorePendingStop() async throws -> AssistantStopContext? {
        restoreCount += 1
        if let gate = restoreGate {
            restoreGate = nil
            await gate.markEntered()
            await gate.waitForRelease()
        }
        if restoreFails { throw AssistantLocalOperationDatabaseError.corruptRow }
        return restoredStop
    }
    private var nextBootstrapFails = false
    func failNextBootstrap() { nextBootstrapFails = true }
    private var nextStopFails = false
    func failNextStop() { nextStopFails = true }
    private(set) var bootstrapCancelledAtReturn = false
    private(set) var pendingBootstrapInvalidationCount = 0

    init(
        details: AssistantConnectionDetails,
        stopGate: StopGate? = nil,
        bootstrapGate: StopGate? = nil
    ) {
        self.details = details
        self.stopGate = stopGate
        self.bootstrapGate = bootstrapGate
    }

    func bootstrap(for intent: AssistantStartIntent) async throws
        -> AssistantConnectionDetails {
        bootstrapCount += 1
        await bootstrapGate?.markEntered()
        await bootstrapGate?.waitForRelease()
        bootstrapCancelledAtReturn = Task.isCancelled
        if nextBootstrapFails { nextBootstrapFails = false; throw RealtimePublicControlAdapterError.transportFailure }
        restoredStop = nil
        return details
    }

    func stop(_ context: AssistantStopContext) async throws
        -> AssistantRemoteStopResult {
        stopCount += 1
        lastStopContext = context
        if nextStopFails {
            nextStopFails = false
            throw URLError(.networkConnectionLost)
        }
        await stopGate?.markEntered()
        await stopGate?.waitForRelease()
        return AssistantRemoteStopResult(
            confirmed: true,
            opaqueReference: "opaque-stop-ref"
        )
    }

    func invalidatePendingBootstrap() async {
        pendingBootstrapInvalidationCount += 1
    }
}

private actor FakeRealtimeTransport: AssistantRealtimeTransporting,
    AssistantRealtimeDataPublishing,
    AssistantRealtimePromptPublishing, AssistantCentralTextPublishing, AssistantCameraRequestTransport {
    private(set) var cameraRequests: [(frameID: String, camera: String)] = []
    func captureRequestedFrame(frameID: String, camera: String) { cameraRequests.append((frameID, camera)) }
    private var defersEncryptionReady = false
    func deferEncryptionReady() { defersEncryptionReady = true }
    private let connectGate: StopGate?
    private var remainingDataPublishFailures: Int
    private(set) var connectCount = 0
    private(set) var connectedTokens: [String] = []
    private(set) var connectRequests: [AssistantRealtimeConnectRequest] = []
    private(set) var rejoinDeadline: Date?
    func setCallRejoinDeadline(_ announced: Date?, callActive: Bool) { rejoinDeadline = announced }
    private(set) var playedCentralVoice: [Data] = []
    private var centralVoicePlayObserver: (@Sendable (Int) -> Void)?
    func setCentralVoicePlayObserver(_ observer: @escaping @Sendable (Int) -> Void) { centralVoicePlayObserver = observer }
    func playCentralVoice(_ playback: CentralVoicePlayback, binding: CentralTransportBinding) async throws {
        guard connected, binding == centralBinding else { throw CentralTextError.contextChanged() }
        playedCentralVoice.append(try Data(contentsOf: playback.resource.file))
        centralVoicePlayObserver?(playedCentralVoice.count)
    }
    private var connectFailures = 0
    func failNextConnects(_ count: Int) { connectFailures = count }
    private(set) var stopCount = 0
    private(set) var mediaChanges: [AssistantMediaSource] = []
    private(set) var publishAttempts = 0
    private(set) var publishedEvents: [AssistantRealtimeDataEvent] = []
    private(set) var publishedPrompts: [AssistantPromptEnvelope] = []
    private(set) var centralPackets: [Data] = []
    private(set) var captureMuteEvents: [Bool] = []
    func setCaptureMuted(_ muted: Bool) { captureMuteEvents.append(muted) }
    private(set) var paymentPackets: [Data] = []
    private var centralBinding: CentralTransportBinding?
    private var nextCentralSendFails = false
    private var moveAutoAck = true
    private var movePublished: (@Sendable (Data) -> Void)?
    func observeMovePublishes(autoAck: Bool, _ observer: @escaping @Sendable (Data) -> Void) {
        moveAutoAck = autoAck; movePublished = observer
    }
    private var immediateCentralCompletion: [AssistantRealtimeEvent] = []
    private var centralCompletionGate: StopGate?
    func setImmediateCentralCompletion(_ events: [AssistantRealtimeEvent], gate: StopGate) {
        immediateCentralCompletion = events
        centralCompletionGate = gate
    }
    func failNextCentralSend() { nextCentralSendFails = true }
    /// The transport refuses the next `count` publishes of `operation` before anything leaves (a room that cannot send).
    private var refusedCentral: [String: Int] = [:]
    private(set) var refusedCentralPackets: [Data] = []
    func refuseCentral(_ operation: String, times count: Int) { refusedCentral[operation] = count }
    private var centralPublishGate: (StopGate, String)?
    func setCentralPublishGate(_ gate: StopGate, operation: String) { centralPublishGate = (gate, operation) }
    private var centralPrepareGate: StopGate?
    func setCentralPrepareGate(_ gate: StopGate) { centralPrepareGate = gate }
    private(set) var preparedCentralVoiceEvents: [String?] = []
    private(set) var observedCentralVoiceEvents: Set<String> = []
    func observeCentralVoice(eventIDs: Set<String>) async throws { observedCentralVoiceEvents = eventIDs }
    func prepareCentralVoice(eventID: String?) async throws {
        preparedCentralVoiceEvents.append(eventID)
        await centralPrepareGate?.markEntered()
        await centralPrepareGate?.waitForRelease()
    }
    func publishCentralTextData(_ data: Data, binding: CentralTransportBinding) async throws {
        guard connected, canPublishData, binding == centralBinding else { throw CentralTextError.contextChanged() }
        let operation = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["operation"] as? String
        if operation == "phone_presence" || operation?.hasPrefix("payment_") == true {
            paymentPackets.append(data)
            return
        }
        if let operation, let refused = refusedCentral[operation], refused > 0 {
            refusedCentral[operation] = refused - 1
            refusedCentralPackets.append(data)
            throw LiveKitSessionError.notConnected
        }
        centralPackets.append(data)
        let fails = nextCentralSendFails; nextCentralSendFails = false
        if let (gate, expected) = centralPublishGate, operation == expected {
            centralPublishGate = nil
            await gate.markEntered()
            await gate.waitForRelease()
        }
        if !immediateCentralCompletion.isEmpty {
            let events = immediateCentralCompletion
            immediateCentralCompletion = []
            emitBurst(events)
            await centralCompletionGate?.markEntered()
            await centralCompletionGate?.waitForRelease()
        }
        if fails { throw URLError(.networkConnectionLost) }
        if operation == "ride_state" || operation == "nav_state" {
            movePublished?(data)
            if moveAutoAck,
               let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let id = body["lifecycle_id"] as? String {
                let ack: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "session_id": binding.sessionID,
                                           "operation": "move_ack", "lifecycle_id": id]
                emitBurst([.centralText(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: ack)))])
            }
        }
    }
    func emitBurst(_ events: [AssistantRealtimeEvent]) {
        for event in events { eventHandlers.forEach { $0(event) } }
    }
    private var connected = false
    private var mediaPublishGate: StopGate?
    private var gatedMediaSource = AssistantMediaSource.camera
    private var mediaDisableGate: StopGate?
    func setMediaDisableGate(_ gate: StopGate?) { mediaDisableGate = gate }
    func setMediaPublishGate(_ gate: StopGate?, source: AssistantMediaSource = .camera) {
        mediaPublishGate = gate; gatedMediaSource = source
    }
    private var connectCompletionGate: StopGate?
    private var lateConnectFailure = false
    func failNextConnectAfterActivation() { lateConnectFailure = true }
    func holdNextConnectCompletion(_ gate: StopGate) { connectCompletionGate = gate }
    private var canPublishData = false
    private var eventHandlers: [
        @Sendable (AssistantRealtimeEvent) -> Void
    ] = []

    init(
        connectGate: StopGate? = nil,
        dataPublishFailures: Int = 0
    ) {
        self.connectGate = connectGate
        self.remainingDataPublishFailures = dataPublishFailures
    }

    func connect(
        _ request: AssistantRealtimeConnectRequest,
        events: @escaping @Sendable (AssistantRealtimeEvent) -> Void
    ) async throws {
        connectCount += 1
        connectRequests.append(request)
        connectedTokens.append(request.details.participantToken)
        if connectFailures > 0 {
            connectFailures -= 1
            throw URLError(.networkConnectionLost)
        }
        canPublishData = request.details.capabilities.canPublishData
        centralBinding = request.centralBinding
        eventHandlers.append(events)
        await connectGate?.markEntered()
        await connectGate?.waitForRelease()
        connected = true
        events(.connected)
        events(.encryptionPreparing)
        if !defersEncryptionReady { events(.encryptionActive) }
        if let gate = connectCompletionGate {
            connectCompletionGate = nil
            await gate.markEntered(); await gate.waitForRelease()
            if Task.isCancelled { connected = false; throw CancellationError() }
        }
        if lateConnectFailure { lateConnectFailure = false; connected = false; throw URLError(.networkConnectionLost) }
    }

    func emit(_ event: AssistantRealtimeEvent) async {
        let handlers = eventHandlers
        handlers.forEach { $0(event) }
        await Task.yield()
        await Task.yield()
    }

    func emit(
        _ event: AssistantRealtimeEvent,
        handlerIndex: Int
    ) async {
        guard eventHandlers.indices.contains(handlerIndex) else {
            return
        }
        eventHandlers[handlerIndex](event)
        await Task.yield()
        await Task.yield()
    }

    /// "microphone:on" / "camera:off" (an unpublish) / "microphone:mute" (kept published); a failed attempt ends with "!".
    private(set) var mediaEvents: [String] = []
    private var failingDisables = 0
    private var cameraDisableFails = false
    func failNextDisables(_ count: Int) { failingDisables = count }
    func setCameraDisableFails(_ enabled: Bool) { cameraDisableFails = enabled }

    func setMedia(
        source: AssistantMediaSource,
        enabled: Bool,
        userInitiated: Bool,
        keepPublished: Bool
    ) async throws {
        if source == gatedMediaSource, enabled, let gate = mediaPublishGate {
            await gate.markEntered()
            await gate.waitForRelease()
        }

        if !enabled, let gate = mediaDisableGate {
            await gate.markEntered(); await gate.waitForRelease()
        }
        mediaChanges.append(source)
        let event = (source == .camera ? "camera:" : "microphone:") + (enabled ? "on" : keepPublished ? "mute" : "off")
        if !enabled, failingDisables > 0 || source == .camera && cameraDisableFails {
            if failingDisables > 0 { failingDisables -= 1 }
            mediaEvents.append(event + "!")
            throw LiveKitSessionError.notConnected
        }
        mediaEvents.append(event)
    }

    func publish(_ event: AssistantRealtimeDataEvent) async throws {
        publishAttempts += 1
        guard connected else {
            throw LiveKitSessionError.notConnected
        }
        guard canPublishData else {
            throw LiveKitSessionError.dataNotGranted
        }
        if remainingDataPublishFailures > 0 {
            remainingDataPublishFailures -= 1
            throw LiveKitSessionError.invalidDataEvent
        }
        publishedEvents.append(event)
    }

    func publishPrompt(_ prompt: AssistantPromptEnvelope) async throws {
        guard connected else {
            throw LiveKitSessionError.notConnected
        }
        guard canPublishData else {
            throw LiveKitSessionError.dataNotGranted
        }
        _ = try prompt.encodedStrict()
        publishedPrompts.append(prompt)
    }

    private var stopObserver: (@Sendable () -> Void)?
    func setStopObserver(_ callback: @escaping @Sendable () -> Void) { stopObserver = callback }
    func stop() async {
        stopObserver?()
        connected = false
        stopCount += 1
    }
}

private actor FakePermissionProvider: MediaPermissionProviding {
    private let status: AssistantPermissionStatus
    private(set) var requests: [AssistantMediaSource] = []
    private(set) var completedAuthorizations = 0
    private var gate: StopGate?
    /// Holds every authorization until released (a permission prompt the user has not answered yet).
    func setGate(_ gate: StopGate?) { self.gate = gate }

    init(status: AssistantPermissionStatus) {
        self.status = status
    }

    func snapshot() async -> AssistantMediaPermissionSnapshot {
        AssistantMediaPermissionSnapshot(
            camera: status,
            microphone: status
        )
    }

    func authorize(
        source: AssistantMediaSource,
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus {
        requests.append(source)
        if let gate {
            await gate.markEntered()
            await gate.waitForRelease()
        }
        guard userInitiated else {
            throw MediaPermissionError.requestWasNotUserInitiated
        }
        guard status == .authorized else {
            if source == .camera {
                throw MediaPermissionError.cameraDenied
            }
            throw MediaPermissionError.microphoneDenied
        }
        completedAuthorizations += 1
        return status
    }
}

@MainActor
private final class FakeLocationProvider: AssistantLocationProviding,
    @unchecked Sendable {
    private(set) var requestCount = 0
    private(set) var authorizationCount = 0
    var oneShotGate: StopGate?
    var authorizationGate: StopGate?
    var deniesAuthorization = false
    var status = AssistantPermissionStatus.authorized
    var oneShotError: Error?
    var cachedAge: Int? = nil

    func cachedFixAgeMilliseconds() -> Int? { cachedAge }

    func authorizationStatus() -> AssistantPermissionStatus {
        status
    }

    func requestWhenInUseAuthorization(
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus {
        authorizationCount += 1
        guard userInitiated else {
            throw AssistantLocationError.requestWasNotUserInitiated
        }
        let denied = deniesAuthorization
        await authorizationGate?.markEntered()
        await authorizationGate?.waitForRelease()
        if denied { throw AssistantLocationError.permissionDenied }
        return .authorized
    }

    func requestOneShot(
        userInitiated: Bool
    ) async throws -> AssistantLocationObservation {
        requestCount += 1
        if let oneShotGate {
            await oneShotGate.markEntered()
            await oneShotGate.waitForRelease()
        }
        if let oneShotError { throw oneShotError }
        return AssistantLocationObservation(
            localCaptureID: "local",
            latitude: 31.2304,
            longitude: 121.4737,
            horizontalAccuracy: 12.5,
            observedAt: Date(timeIntervalSince1970: 1_700_000_100)
        )
    }
}

// MARK: - Audit 26aab9c8 batch 2: the coordinator owns session and media intent

extension AssistantSessionTests {
    func testLocationRevocationDuringMediaPermissionDoesNotAskForLocation() async throws {
        let gate = StopGate(), harness = await Harness.make()
        await harness.permissions.setGate(gate)
        let start = Task { try await harness.coordinator.start(AssistantStartIntent(microphoneEnabled: true, locationEnabled: true, userInitiated: true)) }
        await gate.waitUntilEntered()
        await harness.coordinator.setLocationConsent(false)
        await gate.release()
        try await start.value
        let requests = await harness.location.authorizationCount
        XCTAssertEqual(requests, 0)
        _ = await harness.coordinator.stop()
    }

    func testNewLocationChoiceSurvivesOlderDeniedAuthorization() async throws {
        let gate = StopGate(), harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await MainActor.run { harness.location.deniesAuthorization = true; harness.location.authorizationGate = gate }
        let starting = Task { try await harness.coordinator.start(AssistantStartIntent(locationEnabled: true, userInitiated: true)) }
        await gate.waitUntilEntered()
        harness.coordinator.setLocationConsent(false)
        let consent = harness.coordinator.setLocationConsent(true)
        await gate.release()
        try await starting.value
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "current-location-choice", text: "latest choice"),
            location: AssistantLocationObservation(localCaptureID: "new-fix", latitude: 31, longitude: 121, horizontalAccuracy: 5, observedAt: Date()), consent: consent)
        let requests = await sent(harness)
        XCTAssertNotNil(requests.last?["location"], "An older permission result must not revoke a newer owner choice")
        _ = await harness.coordinator.stop()
    }

    func testUnknownTypedAdmissionRetriesEnvelopeAndFetchesOriginalResultAutomatically() async throws {
        let fixture = try CentralTextTestFixture(), harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let input = try XCTUnwrap(fixture.values["input_submit"] as? [String: String])
        await harness.realtime.failNextCentralSend()
        do {
            try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: XCTUnwrap(input["event_id"]), text: XCTUnwrap(input["text"])))
            XCTFail("Controlled publication failure must stay unknown")
        } catch is URLError { }
        try await eventually("same envelope resubmitted without owner intervention") { await harness.realtime.centralPackets.count >= 2 }
        let requests = await harness.realtime.centralPackets
        XCTAssertEqual(requests[0], requests[1])
        await harness.realtime.emit(.centralText(try fixture.packet("accepted")))
        try await eventually("original admitted result fetched automatically") { await operations(harness).contains("result") }
        let sentRequests = await sent(harness)
        let result = try XCTUnwrap(sentRequests.first { $0["operation"] as? String == "result" })
        XCTAssertEqual(result["processed_event_id"] as? String, try fixture.packet("accepted").fields.value("processed_event_id", as: String.self))
        do { try await harness.coordinator.requestCentralControl("cancel_run", eventID: "retired-dialog-request"); XCTFail("A stale owner dialog cannot cancel the current request") }
        catch CentralTextError.contextChanged { }
        let currentOperations = await operations(harness)
        XCTAssertFalse(currentOperations.contains("cancel_run"))
        _ = await harness.coordinator.stop()
    }

    func testVoiceCleanupCannotPublishAnOldControlThroughReplacementSession() async throws {
        let fixture = try CentralTextTestFixture(), harness = await Harness.make(canPublishData: true), gate = StopGate()
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "formal-event", text: "original"))
        let admitted = expectation(description: "original admission"), header = expectation(description: "original header")
        admitted.assertForOverFulfill = false; header.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver {
            if $0.accepted != nil { admitted.fulfill() }
            if $0.header != nil { header.fulfill() }
        }
        await harness.realtime.emit(.centralText(try fixture.packet("accepted")))
        await fulfillment(of: [admitted], timeout: 2)
        try await harness.coordinator.requestCentralResult()
        await harness.realtime.emit(.centralText(try fixture.packet("pending_header")))
        await fulfillment(of: [header], timeout: 2)
        let original = await harness.coordinator.centralTextSnapshot()
        _ = try XCTUnwrap(original.header)
        await harness.realtime.setCentralPrepareGate(gate)
        let old = Task { try await harness.coordinator.requestCentralControl("cancel_playback") }
        await gate.waitUntilEntered()
        _ = await harness.coordinator.stop()
        try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
        await gate.release()
        do { try await old.value; XCTFail("Retired control must not enter B") }
        catch { guard case CentralTextError.contextChanged = error else { return XCTFail("Wrong retired control error: \(error)") } }
        let sent = await operations(harness)
        XCTAssertFalse(sent.contains("cancel_playback"))
        _ = await harness.coordinator.stop()
    }

    func testRevokedLocationCannotRideTypedPublishAfterAwaitOrReenable() async throws {
        let gate = StopGate(), harness = await Harness.make(canPublishData: true)
        let binding = CentralTransportBinding(sessionID: "continuity", deviceID: "phone-voice", connectionEpoch: "1",
            expectedGatewayIdentity: "controlled-source-gateway", maxPacketBytes: 12_288, voiceTransport: AssistantCentralTextWire.voiceTransport)
        await harness.bootstrap.setCentralBinding(binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let consent = await harness.coordinator.setLocationConsent(true)
        await harness.realtime.setCentralPrepareGate(gate)
        let sending = Task { try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "location-race", text: "use my request"),
            location: AssistantLocationObservation(localCaptureID: "old-fix", latitude: 31, longitude: 121, horizontalAccuracy: 5, observedAt: Date()), consent: consent) }
        await gate.waitUntilEntered()
        await harness.coordinator.setLocationConsent(false)
        await harness.coordinator.setLocationConsent(true)
        await gate.release()
        try await sending.value
        let requests = await sent(harness)
        let request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request["text"] as? String, "use my request")
        XCTAssertNil(request["location"], "Re-enabling does not authorise a fix from the revoked generation")
        _ = await harness.coordinator.stop()
    }

    func testTerminalReconnectSettlesWaiterAndNextTapStartsFresh() async throws {
        for failure in [AssistantRealtimeEvent.disconnected(errorCode: "terminal"), .encryptionFailed] {
            let harness = try await centralHarness()
            await harness.realtime.emit(.reconnecting)
            try await eventually("reconnect") { await harness.coordinator.snapshot() == .reconnecting }
            let settled = expectation(description: "waiting tap settles")
            let waiting = Task {
                do { try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true)); XCTFail("Terminal failure must end this wait") }
                catch { settled.fulfill() }
            }
            try await Task.sleep(nanoseconds: 20_000_000)
            await harness.realtime.emit(failure)
            await fulfillment(of: [settled], timeout: 2)
            await waiting.value
            try await eventually("terminal cleanup") { if case .failed = await harness.coordinator.snapshot() { return true }; return false }
            try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
            let starts = await harness.realtime.connectCount
            XCTAssertEqual(starts, 2)
            _ = await harness.coordinator.stop()
        }
    }

    func testTerminalFailureDoesNotWaitForAnUnfinishedSDKStartOrRestore() async throws {
        for reconnect in [false, true] {
            let gate = StopGate(), restore = StopGate(), harness = await Harness.make(connectGate: gate, canPublishData: true)
            await harness.bootstrap.setCentralBinding(Self.centralBinding)
            await harness.bootstrap.setRestoredStop(nil, gate: restore)
            let settled = expectation(description: "tap settles before SDK connect returns")
            let original = Task {
                do { try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true)); XCTFail("Terminal connection cannot accept the tap") }
                catch { settled.fulfill() }
            }
            await restore.waitUntilEntered()
            await restore.release()
            await gate.waitUntilEntered()
            if reconnect {
                await harness.realtime.emit(.reconnecting)
                try await eventually("first Start reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
            }
            await harness.realtime.emit(reconnect ? .encryptionFailed : .disconnected(errorCode: "terminal"))
            await fulfillment(of: [settled], timeout: 2)
            await original.value
            try await eventually("terminal cleanup complete") { if case .failed = await harness.coordinator.snapshot() { return true }; return false }
            let replacement = Task { try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true)) }
            try await eventually("next tap starts while old SDK await remains") { await harness.realtime.connectCount == 2 }
            await gate.release()
            try await replacement.value
            let state = await harness.coordinator.snapshot()
            XCTAssertEqual(state, .active(encryptionActive: true))
            _ = await harness.coordinator.stop()
        }
    }

    func testColdCareSafePersistsBeforeReadinessRetriesSameIDAndRetiresOnlyOnReceipt() async throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? FileManager.default.temporaryDirectory.path).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("care.sqlite"), gate = StopGate()
        let database = try AssistantLocalOperationDatabase(url: url)
        let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, localDatabase: database)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        _ = try await harness.coordinator.careSafe(identity: "owner-pairing")
        await gate.waitUntilEntered()
        let pending: AssistantLocalCareSafe
        do {
            let reopened = try AssistantLocalOperationDatabase(url: url)
            pending = try XCTUnwrap(reopened.pendingCareSafe(identity: "owner-pairing"))
            XCTAssertNil(try reopened.pendingCareSafe(identity: "another-owner"))
        }
        let before = await sent(harness)
        XCTAssertTrue(before.isEmpty)
        do { _ = try await harness.coordinator.careSafe(identity: "another-owner"); XCTFail("Old-owner notification must not borrow this pairing") } catch { }
        await gate.release()
        try await eventually("care sent after ready") { await operations(harness).contains("care_safe") }
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "care-chat", text: "stay with me"))
        try await eventually("care retries the persisted control", seconds: 5) {
            await operations(harness).filter { $0 == "care_safe" }.count >= 2
        }
        let connections = await harness.realtime.connectCount
        XCTAssertEqual(connections, 1, "Chat must preserve the care action's session pairing")
        let retries = await sent(harness).filter { $0["operation"] as? String == "care_safe" }
        XCTAssertGreaterThanOrEqual(retries.count, 2)
        XCTAssertEqual(Set(retries.compactMap { $0["control_id"] as? String }), [pending.controlID])
        XCTAssertNotNil(try database.pendingCareSafe(identity: "owner-pairing"))
        await harness.realtime.emit(.centralText(try central(["operation": "care_safe_ack", "control_id": pending.controlID, "cancelled": 1])))
        try await eventually("care acknowledged") { try database.pendingCareSafe(identity: "owner-pairing") == nil }
        let outcome = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(outcome.careSafePending)
        XCTAssertTrue(outcome.careSafeStatus?.contains("已取消") == true)
        _ = try await harness.coordinator.careSafe(identity: "owner-pairing")
        let next = try XCTUnwrap(database.pendingCareSafe(identity: "owner-pairing"))
        XCTAssertNotEqual(next.controlID, pending.controlID)
        try await Task.sleep(nanoseconds: 2_100_000_000)
        XCTAssertNotNil(try database.pendingCareSafe(identity: "owner-pairing"), "The prior ACK must not complete a new owner action")
        await harness.realtime.emit(.centralText(try central(["operation": "rejected", "request_operation": "care_safe", "control_id": next.controlID,
            "event_id": NSNull(), "processed_event_id": NSNull(), "error_code": "CARE_NOT_AVAILABLE"])))
        try await eventually("care rejected") { try database.pendingCareSafe(identity: "owner-pairing") == nil }
        let rejected = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(rejected.careSafeStatus?.contains("未接受") == true)
        _ = await harness.coordinator.stop()
    }

    func testPersistedCareSafeResumesOnRelaunchAndCannotCrossReusedDevicePairing() async throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? FileManager.default.temporaryDirectory.path).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("care.sqlite"), pairing = TestPairing()
        let original: AssistantLocalCareSafe
        do {
            let stored = try AssistantLocalOperationDatabase(url: url)
            original = try stored.preserveCareSafe(identity: "owner-pairing", deviceID: "phone-voice")
        }
        let database = try AssistantLocalOperationDatabase(url: url)
        let harness = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { pairing.snapshot() })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.coordinator.setObserver { _ in }
        try await eventually("persisted care sent without another tap") { await operations(harness).contains("care_safe") }
        pairing.change("new-pairing")
        _ = try await harness.coordinator.careSafe(identity: "new-pairing")
        let replacement = try XCTUnwrap(database.pendingCareSafe(identity: "new-pairing"))
        try await eventually("care uses a new session for a new pairing") { await harness.realtime.connectCount == 2 }
        try await eventually("new pairing care sent") { await sent(harness).contains { $0["control_id"] as? String == replacement.controlID } }
        await harness.realtime.emit(.centralText(try central(["operation": "care_safe_ack", "control_id": original.controlID, "cancelled": 1])), handlerIndex: 0)
        XCTAssertNotNil(try database.pendingCareSafe(identity: "new-pairing"))
        await harness.realtime.emit(.centralText(try central(["operation": "care_safe_ack", "control_id": replacement.controlID, "cancelled": 1])))
        try await eventually("new owner care acknowledged") { try database.pendingCareSafe(identity: "new-pairing") == nil }
        XCTAssertNotNil(try database.pendingCareSafe(identity: "owner-pairing"))
        _ = await harness.coordinator.stop()
    }

    func testPairingChangeWhileBootstrapWaitsCannotBindOldSessionToNewOwner() async throws {
        let gate = StopGate(), pairing = TestPairing()
        let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, ownerIdentity: { pairing.snapshot() })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        let starting = Task { try await harness.coordinator.start(AssistantStartIntent(userInitiated: true)) }
        await gate.waitUntilEntered()
        pairing.change("new-pairing")
        await gate.release()
        do { try await starting.value; XCTFail("A bootstrap cannot change its owner after admission") }
        catch CentralTextError.contextChanged { }
        let connections = await harness.realtime.connectCount
        XCTAssertEqual(connections, 0)
    }

    func testErrandCancelUsesExactCurrentOwnerJobAndRejectsReplacementOwner() async throws {
        let pairing = TestPairing()
        let harness = await Harness.make(canPublishData: true, ownerIdentity: { pairing.snapshot() })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        await harness.realtime.emit(.centralText(try central(["operation": "errand_progress", "errands": [[
            "job_id": "job-000000000001", "title": "取餐", "app": "test", "state": "running",
            "started_at": "2026-10-16T00:00:00.000Z", "step": 1, "max_steps": 3]]])))
        try await eventually("errand projection") { await harness.coordinator.centralTextSnapshot().errands.first?.id == "job-000000000001" }
        try await harness.coordinator.cancelErrand("job-000000000001", identity: "owner-pairing")
        pairing.change("new-pairing")
        do { try await harness.coordinator.cancelErrand("job-000000000001", identity: "owner-pairing"); XCTFail("stale owner cannot cancel") }
        catch CentralTextError.contextChanged { }
        let requests = await sent(harness).filter { $0["operation"] as? String == "errand_cancel" }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["job_id"] as? String, "job-000000000001")
        _ = await harness.coordinator.stop()
    }

    func testQuestionSelectionSendsOneExactOwnerConversationRequest() async throws {
        let harness = await Harness.make(canPublishData: true, ownerIdentity: { ("owner-pairing", "phone-voice") })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        await harness.realtime.emit(.centralText(try central(["operation": "gesture_card", "card_id": "choice", "question": "哪一个？",
            "expires_at": "2099-01-01T00:00:00.000Z", "options": [["id": "a", "label": "甲", "lines": []],
                ["id": "b", "label": "乙", "lines": []]]])))
        try await eventually("question projection") { await harness.coordinator.centralTextSnapshot().ownerVoice.questionCard?.id == "choice" }
        let source = await harness.coordinator.centralTextSnapshot()
        let card = try XCTUnwrap(source.ownerVoice.questionCard)
        let selection = AssistantQuestionSelection(identity: "owner-pairing", cardID: "choice", optionID: "b")
        let text = try selection.text(for: card, now: Date())
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "answer", text: text), question: selection)
        let requests = await sent(harness).filter { $0["event_id"] as? String == "answer" }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["text"] as? String, "就选第2项：乙（仅选择，不授权付款、身份或记忆写入）")
        _ = await harness.coordinator.stop()
    }

    func testQuestionSelectionRejectsOwnerChangeDuringVoicePreparation() async throws {
        let pairing = TestPairing(), gate = StopGate()
        let harness = await Harness.make(canPublishData: true, ownerIdentity: { pairing.snapshot() })
        var binding = Self.centralBinding
        binding.voiceTransport = AssistantCentralTextWire.voiceTransport
        await harness.bootstrap.setCentralBinding(binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        await harness.realtime.emit(.centralText(try central(["operation": "gesture_card", "card_id": "choice", "question": "哪一个？",
            "expires_at": "2099-01-01T00:00:00.000Z", "options": [["id": "a", "label": "甲", "lines": []], ["id": "b", "label": "乙", "lines": []]]])))
        try await eventually("question projection") { await harness.coordinator.centralTextSnapshot().ownerVoice.questionCard?.id == "choice" }
        let source = await harness.coordinator.centralTextSnapshot()
        let card = try XCTUnwrap(source.ownerVoice.questionCard)
        let selection = AssistantQuestionSelection(identity: "owner-pairing", cardID: "choice", optionID: "a")
        let prompt = AssistantPromptEnvelope(promptID: "answer", text: try selection.text(for: card, now: Date()))
        await harness.realtime.setCentralPrepareGate(gate)
        let send = Task { try await harness.coordinator.submitPrompt(prompt, question: selection) }
        await gate.waitUntilEntered()
        pairing.change("new-pairing")
        await gate.release()
        do { try await send.value; XCTFail("selection cannot borrow a replacement owner") }
        catch CentralTextError.contextChanged { }
        let packets = await sent(harness)
        XCTAssertFalse(packets.contains { $0["event_id"] as? String == "answer" })
        _ = await harness.coordinator.stop()
    }

    private static let centralBinding = CentralTransportBinding(sessionID: "continuity", deviceID: "phone-voice",
        connectionEpoch: "1", expectedGatewayIdentity: "controlled-source-gateway", maxPacketBytes: 12_288, deviceClass: "iphone", callRejoinWindowS: 120)

    private func retainedLifecycle(_ coordinator: AssistantSessionCoordinator) async -> AssistantMediaLifecycle {
        let lifecycle = AssistantMediaLifecycle()
        await lifecycle.setRetainer { reason in await coordinator.retainsSession(for: reason) }
        await lifecycle.setStopHandler { reason in _ = await coordinator.stop(reasonCode: reason) }
        await lifecycle.markRunning()
        return lifecycle
    }

    private func centralHarness(voiceSendWait: UInt64 = 10_000_000_000,
                                callDialTimeout: UInt64 = 20_000_000_000,
                                ringback: (any CallRingbackPlaying)? = nil, artc: (any ARTCCallClient)? = nil,
                                formalVoice: Bool = false, callRejoinWindowS: Int? = 120,
                                voiceIdentityAuth: String = "face_id", deviceClass: String = "iphone",
                                authenticateVoiceIdentity: @escaping @Sendable () async throws -> Void = { try await CentralVoiceBiometrics.faceID() }) async throws -> Harness {
        let harness = await Harness.make(canPublishData: true, voiceSendWait: voiceSendWait, callDialTimeout: callDialTimeout, ringback: ringback, artc: artc, voiceIdentityAuth: voiceIdentityAuth,
                                        authenticateVoiceIdentity: authenticateVoiceIdentity)
        let original = Self.centralBinding
        let binding = CentralTransportBinding(sessionID: original.sessionID, deviceID: original.deviceID,
            connectionEpoch: original.connectionEpoch, expectedGatewayIdentity: original.expectedGatewayIdentity,
            maxPacketBytes: original.maxPacketBytes, deviceClass: deviceClass, voiceTransport: formalVoice ? AssistantCentralTextWire.voiceTransport : nil,
            callRejoinWindowS: callRejoinWindowS)
        await harness.bootstrap.setCentralBinding(binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        return harness
    }

    func testCameraRejectionOnlyEndsItsMatchingRequestAfterPreviousTimeout() async throws {
        let harness = try await centralHarness()
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": "old-frame",
            "expires_at_ms": Int64(Date().addingTimeInterval(0.5).timeIntervalSince1970 * 1000)])))
        try await eventually("old camera request uploaded") { await harness.realtime.cameraRequests.count == 1 }
        try await eventually("old camera request timed out") { !(await harness.coordinator.presentationSnapshot()).cameraRequestVisible }
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": "new-frame"])))
        try await eventually("new camera request uploaded") { await harness.realtime.cameraRequests.count == 2 }
        var rejection: [String: Any] = ["operation": "rejected", "request_operation": "camera_frame",
            "control_id": NSNull(), "event_id": NSNull(), "processed_event_id": NSNull(), "error_code": "CAMERA_CAPTURE_FAILED"]
        await harness.realtime.emit(.centralText(try central(rejection)))
        rejection["frame_id"] = "old-frame"
        await harness.realtime.emit(.centralText(try central(rejection)))
        let stillOpen = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(stillOpen.cameraRequestVisible)
        rejection["frame_id"] = "new-frame"
        await harness.realtime.emit(.centralText(try central(rejection)))
        try await eventually("matching rejection ends camera request") { !(await harness.coordinator.presentationSnapshot()).cameraRequestVisible }
        _ = await harness.coordinator.stop()
    }

    func testCameraRequestOpensRearPreviewAndRetainsUntilEnded() async throws {
        let harness = try await centralHarness()
        let frameID = UUID().uuidString.lowercased()
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": frameID])))
        try await eventually("rear frame uploaded") { await harness.realtime.cameraRequests.count == 1 }
        let requests = await harness.realtime.cameraRequests
        XCTAssertEqual(requests.first?.frameID, frameID)
        XCTAssertEqual(requests.first?.camera, "back")
        let open = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(open.cameraRequestVisible)
        XCTAssertEqual(open.media.camera, .on)
        await harness.coordinator.endCameraRequest()
        let ended = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(ended.cameraRequestVisible)
        XCTAssertEqual(ended.media.camera, .off)
        let failures = await sent(harness).filter { $0["operation"] as? String == "camera_capture_failed" }
        XCTAssertTrue(failures.isEmpty, "Ending a fulfilled view must not reject its archived photo")
        _ = await harness.coordinator.stop()
    }

    func testInactiveCameraRequestReportsUnavailableThenResumesSameFrame() async throws {
        let harness = try await centralHarness()
        await harness.coordinator.setAppActive(false)
        let frameID = UUID().uuidString.lowercased()
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": frameID, "camera": "back"])))
        try await eventually("inactive response") { await operations(harness).contains("camera_capture_failed") }
        let failure = await sent(harness).last
        XCTAssertEqual(failure?["frame_id"] as? String, frameID)
        XCTAssertEqual(failure?["error_code"] as? String, "CAMERA_APP_INACTIVE")
        let inactive = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(inactive.cameraRequestVisible)
        XCTAssertEqual(inactive.media.camera, .off)
        let before = await harness.realtime.cameraRequests.count
        XCTAssertEqual(before, 0)
        await harness.coordinator.setAppActive(true)
        try await eventually("pending frame resumed") { await harness.realtime.cameraRequests.count == 1 }
        let resumed = await harness.realtime.cameraRequests.first?.frameID
        XCTAssertEqual(resumed, frameID)
        await harness.coordinator.endCameraRequest()
        _ = await harness.coordinator.stop()
    }

    func testCameraReplayBeforeEncryptionReadyWaitsForExistingActiveTransition() async throws {
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.realtime.deferEncryptionReady()
        let starting = Task { try await harness.coordinator.start(AssistantStartIntent(userInitiated: true)) }
        try await eventually("transport awaiting encryption readiness") { await harness.coordinator.snapshot() == .encryptionPreparing }
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": UUID().uuidString.lowercased()])))
        await harness.realtime.emit(.encryptionActive)
        try await starting.value
        try await eventually("early replay captures after active") { await harness.realtime.cameraRequests.count == 1 }
        let failures = await sent(harness).filter { $0["operation"] as? String == "camera_capture_failed" }
        XCTAssertTrue(failures.isEmpty)
        let snapshot = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(snapshot.cameraRequestVisible)
        await harness.coordinator.endCameraRequest()
        _ = await harness.coordinator.stop()
    }

    func testRepeatedCameraRequestKeepsSameCaptureWithoutBusyResponse() async throws {
        let harness = try await centralHarness()
        let packet = try central(["operation": "camera_capture_once", "frame_id": UUID().uuidString.lowercased()])
        await harness.realtime.emit(.centralText(packet))
        try await eventually("original frame uploaded") { await harness.realtime.cameraRequests.count == 1 }
        await harness.realtime.emit(.centralText(packet))
        let otherFrame = UUID().uuidString.lowercased()
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": otherFrame])))
        try await eventually("later distinct request reports busy") {
            await self.sent(harness).contains { $0["frame_id"] as? String == otherFrame && $0["error_code"] as? String == "CAMERA_REQUEST_BUSY" }
        }
        let captures = await harness.realtime.cameraRequests.count
        let failures = await sent(harness).filter { $0["operation"] as? String == "camera_capture_failed" }
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(failures.count, 1)
        XCTAssertEqual(failures.first?["frame_id"] as? String, otherFrame)
        await harness.coordinator.endCameraRequest()
        _ = await harness.coordinator.stop()
    }

    func testCameraRequestTimeoutReportsBeforePermissionResolvesAndNeverCapturesLate() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        await harness.permissions.setGate(gate)
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": UUID().uuidString.lowercased()])))
        await gate.waitUntilEntered()
        let closing = Task { await harness.coordinator.endCameraRequest(code: "CAMERA_REQUEST_TIMEOUT") }
        try await eventually("timeout reported while permission remains suspended") {
            await self.sent(harness).contains { $0["error_code"] as? String == "CAMERA_REQUEST_TIMEOUT" }
        }
        let closed = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(closed.cameraRequestVisible)
        XCTAssertEqual(closed.media.camera, .off)
        let before = await harness.permissions.completedAuthorizations
        XCTAssertEqual(before, 0, "The timeout must be observable before permission resolves")
        await gate.release()
        await closing.value
        let events = await harness.realtime.mediaEvents
        let captures = await harness.realtime.cameraRequests.count
        XCTAssertFalse(events.contains("camera:on"))
        XCTAssertEqual(captures, 0)
        _ = await harness.coordinator.stop()
    }

    func testExpiredCameraRequestDoesNotOpenOrAskForPermission() async throws {
        let harness = try await centralHarness()
        let changesBefore = await harness.realtime.mediaChanges.count
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once",
            "frame_id": UUID().uuidString.lowercased(), "expires_at_ms": Int64(Date().timeIntervalSince1970 * 1000) - 1])))
        try await eventually("expired response") { await operations(harness).contains("camera_capture_failed") }
        let response = await sent(harness).last
        XCTAssertEqual(response?["error_code"] as? String, "CAMERA_REQUEST_TIMEOUT")
        let captures = await harness.realtime.cameraRequests.count
        let changesAfter = await harness.realtime.mediaChanges.count
        let snapshot = await harness.coordinator.presentationSnapshot()
        XCTAssertEqual(captures, 0)
        XCTAssertEqual(changesAfter, changesBefore)
        XCTAssertFalse(snapshot.cameraRequestVisible)
        _ = await harness.coordinator.stop()
    }

    func testEndedPendingCameraRequestCannotResumeOnActivation() async throws {
        let harness = try await centralHarness()
        await harness.coordinator.setAppActive(false)
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": UUID().uuidString.lowercased()])))
        try await eventually("pending request admitted") { await operations(harness).contains("camera_capture_failed") }
        await harness.coordinator.endCameraRequest(code: "CAMERA_REQUEST_TIMEOUT")
        await harness.coordinator.setAppActive(true)
        let captures = await harness.realtime.cameraRequests.count
        let snapshot = await harness.coordinator.presentationSnapshot()
        XCTAssertEqual(captures, 0)
        XCTAssertFalse(snapshot.cameraRequestVisible)
        _ = await harness.coordinator.stop()
    }

    func testCameraRequestReusesPublishedCallCameraAndEndKeepsCallCamera() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let openedCall = await harness.coordinator.centralTextSnapshot().call
        let callID = try XCTUnwrap(openedCall.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "live"])))
        try await eventually("live call") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        try await harness.coordinator.setCallCamera(true)
        let changesBefore = await harness.realtime.mediaChanges.count
        let connectsBefore = await harness.realtime.connectCount
        await harness.realtime.emit(.centralText(try central(["operation": "camera_capture_once", "frame_id": UUID().uuidString.lowercased()])))
        try await eventually("call camera frame uploaded") { await harness.realtime.cameraRequests.count == 1 }
        await harness.coordinator.endCameraRequest()
        let changesAfter = await harness.realtime.mediaChanges.count
        let connectsAfter = await harness.realtime.connectCount
        let camera = await harness.coordinator.presentationSnapshot().media.camera
        XCTAssertEqual(changesAfter, changesBefore, "Shared capture must neither republish nor stop the call camera")
        XCTAssertEqual(connectsAfter, connectsBefore)
        let retainedCall = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(retainedCall.id, callID)
        XCTAssertEqual(retainedCall.state, "live")
        XCTAssertEqual(camera, .on)
        _ = await harness.coordinator.stop()
    }

    func testNavigationStandbyRelaunchConnectsWithoutMediaAndRetainsUntilDisabled() async throws {
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.coordinator.setNavigationStandby(true)
        try await harness.coordinator.ensureActive(AssistantStartIntent(locationEnabled: true, userInitiated: true))
        _ = await harness.coordinator.stop(reasonCode: "network_unavailable")
        await harness.coordinator.handleNetworkPath(.init(status: .satisfied, isExpensive: false,
            isConstrained: false, usesWiFi: false, usesCellular: true))
        let bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(bootstraps, 2)
        XCTAssertTrue(harness.coordinator.locationChoice().enabled)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        let active = await harness.coordinator.snapshot(), current = await media(harness)
        XCTAssertEqual(active, .active(encryptionActive: true))
        XCTAssertEqual(current.microphone, .off); XCTAssertEqual(current.camera, .off)
        await harness.coordinator.setNavigationStandby(false)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        let ended = await harness.coordinator.snapshot()
        XCTAssertEqual(ended, .stopped(remoteStopConfirmed: true))
    }

    private func central(_ fields: [String: Any]) throws -> CentralTextPacket {
        var body = fields
        body["schema_version"] = AssistantCentralTextWire.schema
        body["session_id"] = "continuity"
        if fields["operation"] as? String == "camera_capture_once", fields["expires_at_ms"] == nil {
            body["expires_at_ms"] = Int64(Date().addingTimeInterval(20).timeIntervalSince1970 * 1000)
        }
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body, options: .sortedKeys))
    }

    private func sent(_ harness: Harness) async -> [[String: Any]] {
        await harness.realtime.centralPackets.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    private func operations(_ harness: Harness) async -> [String] {
        await sent(harness).compactMap { $0["operation"] as? String }
    }
    func testRideFeedbackUsesCurrentRideSourceOrderNullsAndClearsOnEnd() async throws {
        let harness = try await centralHarness()
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "start", "requested_by": "voice"])))
        try await eventually("ride started") { await self.operations(harness).contains("ride_state") }
        let packets = await sent(harness)
        let rideID = try XCTUnwrap(packets.first { $0["operation"] as? String == "ride_state" }?["ride_id"] as? String)
        func feedback(_ id: String, _ at: String, zone: Any, text: Any, limit: Any) throws -> CentralTextPacket {
            try central(["operation": "ride_feedback", "ride_id": id, "at": at,
                         "hr_zone": zone, "text": text, "max_hr_bpm": limit])
        }
        await harness.realtime.emit(.centralText(try feedback(rideID, "2026-10-17T00:00:02.000Z", zone: 5, text: "源端提醒", limit: 160)))
        try await eventually("source feedback projected") {
            await harness.coordinator.presentationSnapshot().rideFeedback?.text == "源端提醒"
        }
        await harness.realtime.emit(.centralText(try feedback(rideID, "2026-10-17T00:00:01.000Z", zone: 1, text: "旧提醒", limit: 120)))
        await harness.realtime.emit(.centralText(try feedback(UUID().uuidString.lowercased(), "2026-10-17T00:00:03.000Z", zone: 1, text: "旧骑行", limit: 120)))
        await harness.coordinator.watchBecameUnreachable()
        let retained = await harness.coordinator.presentationSnapshot().rideFeedback
        XCTAssertEqual(retained?.hr_zone, 5)
        XCTAssertEqual(retained?.max_hr_bpm, 160)
        await harness.realtime.emit(.centralText(try feedback(rideID, "2026-10-17T00:00:04.000Z", zone: NSNull(), text: NSNull(), limit: NSNull())))
        try await eventually("source nulls projected") {
            await harness.coordinator.presentationSnapshot().rideFeedback?.at == "2026-10-17T00:00:04.000Z"
        }
        let empty = await harness.coordinator.presentationSnapshot().rideFeedback
        XCTAssertNil(empty?.hr_zone); XCTAssertNil(empty?.text); XCTAssertNil(empty?.max_hr_bpm)
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "stop", "requested_by": "voice"])))
        try await eventually("ride feedback cleared") { await harness.coordinator.presentationSnapshot().rideFeedback == nil }
        await harness.realtime.emit(.centralText(try feedback(rideID, "2026-10-17T00:00:05.000Z", zone: 5, text: "迟到提醒", limit: 160)))
        let ended = await harness.coordinator.presentationSnapshot().rideFeedback
        XCTAssertNil(ended)
        _ = await harness.coordinator.stop()
    }

    func testRideAndNavigationFormalControlsFuseMetricsAndKeepIndependentStops() async throws {
        let harness = try await centralHarness()
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "start", "requested_by": "voice"])))
        try await eventually("ride started") { await self.operations(harness).contains("ride_state") }
        let route: [String: Any] = ["operation": "nav_route", "coordinate_system": "wgs84", "nav_id": "nav-1", "revision": 1, "mode": "bicycling",
            "destination": ["name": "终点", "lat": 0, "lng": 0.01], "total_m": 1000, "total_s": 200,
            "steps": [["index": 0, "maneuver": "arrive", "instruction": "到达", "distance_m": 1000, "duration_s": 200,
                "maneuver_location": ["lat": 0, "lng": 0.01], "polyline": [["lat": 0, "lng": 0], ["lat": 0, "lng": 0.01]]]]]
        await harness.realtime.emit(.centralText(try central(route)))
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: Date(), workoutID: "failed-attempt",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .failed))
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: Date(), workoutID: "watch-1",
            heartRateBPM: 145, activeEnergyKcal: 12, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started))
        try await eventually("ride navigation frame") {
            let now = Date()
            await harness.coordinator.handleMoveSensor(.fix(MoveFix(position: .init(lat: 0, lng: 0.001, accuracy_m: 5), at: now, speedKmh: 20)))
            await harness.coordinator.handleMoveSensor(.tick(now))
            return await self.sent(harness).last?["nav"] != nil
        }
        let frames = await sent(harness), frame = try XCTUnwrap(frames.last)
        XCTAssertEqual((frame["ride"] as? [String: Any])?["hr_bpm"] as? Double, 145)
        for status in [AssistantNetworkStatus.unsatisfied, .satisfied] {
            await harness.coordinator.handleLifecycleSignal(.networkPath(.init(status: status, isExpensive: false, isConstrained: false, usesWiFi: true, usesCellular: false)))
        }
        await harness.coordinator.handleMoveSensor(.tick(Date()))
        let resumedFrame = await sent(harness).last
        XCTAssertNotNil(resumedFrame?["ride"]); XCTAssertNotNil(resumedFrame?["nav"])
        let retained = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertTrue(retained)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "stop", "requested_by": "voice"])))
        try await eventually("ride ended and watch asked to stop") {
            let packets = await self.sent(harness), count = await harness.watchControl.commandCount
            return packets.contains { $0["state"] as? String == "ended" } && count > 0
        }
        await harness.coordinator.handleMoveSensor(.tick(Date()))
        let packets = await sent(harness), navigation = try XCTUnwrap(packets.last)
        XCTAssertNil(navigation["ride"]); XCTAssertNotNil(navigation["nav"])
        await harness.realtime.emit(.centralText(try central(["operation": "nav_control", "nav_id": "nav-1", "action": "stop"])))
        try await eventually("navigation cancelled") { await self.sent(harness).last?["state"] as? String == "cancelled" }
        let count = await sent(harness).count
        await harness.coordinator.handleMoveSensor(.tick(Date()))
        let after = await sent(harness).count, legacy = await harness.realtime.publishedEvents
        XCTAssertEqual(after, count); XCTAssertTrue(legacy.isEmpty)
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 3, observedAt: Date(), workoutID: "delayed-phone-start",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .phone))
        let resumed = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertFalse(resumed)
        try await eventually("delayed launch stopped") { await harness.watchControl.commandCount == 2 }
        let finalCount = await sent(harness).count
        XCTAssertEqual(finalCount, count)
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "start", "requested_by": "voice"])))
        try await eventually("new ride started") { await self.sent(harness).last?["state"] as? String == "started" }
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 4, observedAt: Date().addingTimeInterval(-60), workoutID: "watch-1",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .phone))
        try await eventually("old workout stopped during new ride") { await harness.watchControl.commandCount == 3 }
        let newRideActive = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertTrue(newRideActive)
        await harness.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "stop", "requested_by": "voice"])))
        try await eventually("new ride ended") { await self.sent(harness).last?["state"] as? String == "ended" }
    }
    func testMoveEndStopsAndRetriesAfterLocalPersistenceFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-write-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("pending.sqlite")
        let database = try AssistantLocalOperationDatabase(url: url), binding = Self.centralBinding
        let gate = StopGate()
        let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await harness.bootstrap.setCentralBinding(binding)
        let at = Date()
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: at, workoutID: "write-failure",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch))
        await gate.waitUntilEntered()
        let injection = try DatabaseQueue(path: url.path)
        let durableStart = try database.moveCheckpoint(identity: "owner")
        try await injection.write { try $0.execute(sql: "CREATE TRIGGER fail_move_write BEFORE INSERT ON move_outbox BEGIN SELECT RAISE(FAIL, 'injected move write failure'); END") }
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: at.addingTimeInterval(1), workoutID: "write-failure",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended, workoutOrigin: .watch))
        let active = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertFalse(active, "A failed disk write cannot keep an ended workout locally active")
        XCTAssertEqual(try database.pendingMoveEvents(identity: "owner").count, 1)
        XCTAssertEqual(try database.moveCheckpoint(identity: "owner"), durableStart, "A tombstone cannot commit before its end intent")
        try await injection.write { try $0.execute(sql: "DROP TRIGGER fail_move_write") }
        let ended = expectation(description: "retained end retries after disk recovery")
        ended.assertForOverFulfill = false
        await harness.realtime.observeMovePublishes(autoAck: true) { data in
            if (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["state"] as? String == "ended" { ended.fulfill() }
        }
        await gate.release()
        await harness.coordinator.handleNetworkPath(.init(status: .satisfied, isExpensive: false, isConstrained: false, usesWiFi: true, usesCellular: false))
        await fulfillment(of: [ended], timeout: 5)
        _ = await harness.coordinator.stop()
    }

    func testMoveRetainedStartPrecedesEndWhenNextWriteRecovers() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-order-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("pending.sqlite")
        let database = try AssistantLocalOperationDatabase(url: url), binding = Self.centralBinding
        let injection = try DatabaseQueue(path: url.path), gate = StopGate()
        let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await harness.bootstrap.setCentralBinding(binding)
        try await injection.write { try $0.execute(sql: "CREATE TRIGGER fail_move_start BEFORE INSERT ON move_outbox BEGIN SELECT RAISE(FAIL, 'injected start write failure'); END") }
        let at = Date()
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: at, workoutID: "write-order",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch))
        XCTAssertTrue(try database.pendingMoveEvents(identity: "owner").isEmpty)
        try await injection.write { try $0.execute(sql: "DROP TRIGGER fail_move_start") }
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: at.addingTimeInterval(1), workoutID: "write-order",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended, workoutOrigin: .watch))
        let states = try database.pendingMoveEvents(identity: "owner").map { record in
            (try JSONSerialization.jsonObject(with: record.bytes) as? [String: Any])?["state"] as? String
        }
        XCTAssertEqual(states, ["started", "ended"], "Later successful writes must atomically preserve predecessors before the terminal checkpoint")
        await gate.release()
        _ = await harness.coordinator.stop()
    }

    func testMoveCapacityReservesTerminalIntentBeforeAcceptingAnotherStart() async throws {
        for count in [255, 254] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-reserve-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite")), binding = Self.centralBinding
            let event = MoveEvent.navState(NavState(nav_id: "old", state: "cancelled", at: Date()))
            try database.preserveMoveEvents((0..<count).map { _ in try MoveLifecycleRecord(event: event, identity: "owner", sourceSession: nil) })
            let gate = StopGate()
            let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
            await harness.bootstrap.setCentralBinding(binding)
            let at = Date()
            for (sequence, state) in [(UInt64(1), WatchCyclingWorkoutState.started), (UInt64(2), .ended)] {
                await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: sequence, observedAt: at.addingTimeInterval(Double(sequence)), workoutID: "terminal-slot",
                    heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: Double(sequence), cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: state, workoutOrigin: .watch))
                if state == .started {
                    let active = await harness.coordinator.retainsSession(for: "app_background")
                    XCTAssertEqual(active, count == 254, "A new activity needs room for its terminal intent")
                }
            }
            let pending = try database.pendingMoveEvents(identity: "owner")
            XCTAssertEqual(pending.count, count == 254 ? 256 : 255)
            if count == 254 {
                let final = try XCTUnwrap(pending.last)
                XCTAssertEqual((try JSONSerialization.jsonObject(with: final.bytes) as? [String: Any])?["state"] as? String, "ended")
            }
            let active = await harness.coordinator.retainsSession(for: "app_background")
            XCTAssertFalse(active)
            await gate.release()
            _ = await harness.coordinator.stop()
        }
    }

    func testCorruptCheckpointCannotAdoptPreviousOwnersRideOnRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-owner-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let pairing = TestPairing(), binding = Self.centralBinding
        let harness = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { pairing.snapshot() })
        await harness.bootstrap.setCentralBinding(binding)
        let at = Date()
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: at, workoutID: "old-owner-workout",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch))
        try database.saveMoveCheckpoint(data: Data("corrupt".utf8), identity: "new-owner")
        pairing.change("new-owner")
        for sequence in UInt64(2)...3 {
            await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: sequence, observedAt: at.addingTimeInterval(1), workoutID: "old-owner-workout",
                heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended, workoutOrigin: .watch))
        }
        XCTAssertTrue(try database.pendingMoveEvents(identity: "new-owner").isEmpty)
        XCTAssertEqual(try database.moveCheckpoint(identity: "new-owner"), Data("corrupt".utf8), "failed restore cannot overwrite another owner's checkpoint")
        _ = await harness.coordinator.stop()
    }

    func testMoveStartAndEndSurviveBootstrapFailureAndRecoverWithoutSensorTicks() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-bootstrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let binding = Self.centralBinding
        let harness = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await harness.bootstrap.setCentralBinding(binding)
        await harness.bootstrap.failNextBootstrap()
        let failed = expectation(description: "bootstrap failed before any lifecycle delivery")
        failed.assertForOverFulfill = false
        await harness.coordinator.setObserver { snapshot in if case .failed = snapshot.state { failed.fulfill() } }
        let at = Date()
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: at, workoutID: "recover-workout",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch))
        await fulfillment(of: [failed], timeout: 5)
        XCTAssertEqual(try database.pendingMoveEvents(identity: "owner").count, 1)
        let ended = expectation(description: "ended intent delivered after recovery")
        ended.assertForOverFulfill = false
        await harness.realtime.observeMovePublishes(autoAck: true) { bytes in
            let fields = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
            if fields?["state"] as? String == "ended" { ended.fulfill() }
        }
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: at.addingTimeInterval(1), workoutID: "recover-workout",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended, workoutOrigin: .watch))
        await harness.coordinator.handleNetworkPath(.init(status: .satisfied, isExpensive: false, isConstrained: false, usesWiFi: true, usesCellular: false))
        await fulfillment(of: [ended], timeout: 5)
        let states = await sent(harness).filter { $0["operation"] as? String == "ride_state" }.compactMap { $0["state"] as? String }
        XCTAssertEqual(states, ["started", "ended"])
        _ = await harness.coordinator.stop()
    }

    func testMoveLifecyclePersistsUntilBusinessAckAndReplaysAfterColdStartWithoutMetrics() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let binding = Self.centralBinding
        let first = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await first.bootstrap.setCentralBinding(binding)
        try await first.coordinator.start(AssistantStartIntent(userInitiated: true))
        let sent = expectation(description: "lifecycle published without acknowledgement")
        sent.assertForOverFulfill = false
        await first.realtime.observeMovePublishes(autoAck: false) { _ in sent.fulfill() }
        await first.realtime.emit(.centralText(try central(["operation": "ride_control", "action": "start", "requested_by": "voice"])))
        await fulfillment(of: [sent], timeout: 5)
        let pending = try database.pendingMoveEvents(identity: "owner")
        XCTAssertEqual(pending.count, 1, "SDK publication cannot remove a lifecycle intent")
        let original = try XCTUnwrap(pending.first)
        XCTAssertTrue(try database.pendingMoveEvents(identity: "other-owner").isEmpty)
        _ = await first.coordinator.stop()

        let second = await Harness.make(canPublishData: true, localDatabase: database, ownerIdentity: { ("owner", binding.deviceID) })
        await second.bootstrap.setCentralBinding(binding)
        let replayed = expectation(description: "cold-start replay without a sensor tick")
        replayed.assertForOverFulfill = false
        await second.realtime.observeMovePublishes(autoAck: false) { data in
            XCTAssertEqual(data, original.bytes); replayed.fulfill()
        }
        try await second.coordinator.start(AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [replayed], timeout: 5)
        XCTAssertEqual(try database.pendingMoveEvents(identity: "owner").map(\.id), pending.map(\.id))
        let acknowledged = expectation(description: "business ACK removes only the matching owner event")
        acknowledged.assertForOverFulfill = false
        await second.coordinator.setObserver { _ in
            if (try? database.pendingMoveEvents(identity: "owner").isEmpty) == true { acknowledged.fulfill() }
        }
        await second.realtime.emit(.centralText(try central(["operation": "move_ack", "lifecycle_id": original.id])))
        await fulfillment(of: [acknowledged], timeout: 5)
        _ = await second.coordinator.stop()
    }

    func testWatchEndAppliesDuringBootstrapAndStateMessagesStayOrdered() async throws {
        let gate = StopGate(), harness = await Harness.make(bootstrapGate: gate, canPublishData: true), now = Date()
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 1, observedAt: now, workoutID: "watch-1",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 0, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch))
        await gate.waitUntilEntered()
        await harness.coordinator.handleCyclingMetric(WatchCyclingMetricEnvelope(sequence: 2, observedAt: now.addingTimeInterval(1), workoutID: "watch-1",
            heartRateBPM: nil, activeEnergyKcal: 1, distanceM: nil, elapsedS: 1, cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .ended, workoutOrigin: .watch))
        let retained = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertFalse(retained)
        await gate.release()
        try await eventually("watch lifecycle states sent") { await self.sent(harness).last?["state"] as? String == "ended" }
        let states = await sent(harness).filter { $0["operation"] as? String == "ride_state" }.compactMap { $0["state"] as? String }
        XCTAssertEqual(states, ["started", "ended"])
    }

    private func media(_ harness: Harness) async -> AssistantMediaSnapshot {
        await harness.coordinator.presentationSnapshot().media
    }

    private func eventually(_ what: String, seconds: Int = 2, _ condition: () async throws -> Bool) async throws {
        for _ in 0..<(seconds * 100) {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for " + what)
    }

    private static let artcMedia: [String: String] = ["provider": "artc", "app_id": "app", "channel_id": "channel",
        "user_id": "owner", "token": "test-only-credential", "token_expire_at": "1800003600"]

    @MainActor
    func testLegacyMediaIsRejectedWithoutReleasingForegroundMicrophone() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "media": Self.artcMedia, "video_revision": 0])))
        try await eventually("legacy asks for voice") {
            await self.sent(harness).contains { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }
        }
        XCTAssertTrue(rtc.joins.isEmpty)
        let publications = await harness.realtime.mediaEvents
        XCTAssertEqual(publications, ["microphone:on"])
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertTrue(call.isActive); XCTAssertEqual(call.id, id)
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testComponentAudioAndCameraUseGatewayAndLeaveRestoresLegacyPath() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live", "video": false, "video_revision": 0])))
        try await eventually("voice readiness while acquiring renderer preserves owner video intent") {
            let snapshot = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
            return snapshot.videoCallRequested && call.state == "live"
        }
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
        try await eventually("component gateway audio and camera") {
            let media = await harness.realtime.mediaEvents
            return media == ["microphone:on", "camera:on"]
        }
        XCTAssertEqual(rtc.joins.first?.audio_input, "gateway")
        XCTAssertFalse(rtc.cameraOn)
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        await harness.coordinator.releaseMedia(.camera, for: .call)
        XCTAssertEqual(rtc.media, [])
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed"])))
        try await eventually("component video left") { rtc.leaves == 1 }
        try await harness.coordinator.startCall(video: false)
        let media = await harness.realtime.mediaEvents
        XCTAssertEqual(media.last, "microphone:on")
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testComponentBackgroundKeepsSameVoiceCallAndForegroundNeedsOwnerVideoAction() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
        try await eventually("camera live") { await harness.realtime.mediaEvents.contains("camera:on") }
        rtc.emit(.firstFrame)
        try await eventually("video live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        try await eventually("LiveKit capture unmuted after avatar first frame") { await harness.realtime.captureMuteEvents.last == false }
        let lifecycle = await retainedLifecycle(harness.coordinator)
        await harness.coordinator.handleLifecycleSignal(.audioInterruptionBegan)
        await lifecycle.handle(.audioInterruptionBegan)
        await lifecycle.handle(.audioInterruptionEnded(shouldResume: true))
        let retainedVideo = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(retainedVideo.id, id); XCTAssertTrue(retainedVideo.isActive); XCTAssertEqual(rtc.leaves, 0)
        await harness.realtime.emit(.centralText(try central(["operation": "call_playback_reset", "call_id": id, "target": "avatar"])))
        try await eventually("avatar queue flushed without voice retirement") { rtc.flushes == 1 }
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        await lifecycle.handle(.appDidEnterBackground)
        let downgraded = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(downgraded.id, id); XCTAssertTrue(downgraded.isActive); XCTAssertEqual(rtc.leaves, 1)
        var events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "camera:on", "camera:off"])
        let requests = await sent(harness)
        XCTAssertEqual(requests.last?["operation"] as? String, "call_video")
        XCTAssertEqual(requests.last?["call_id"] as? String, id); XCTAssertEqual(requests.last?["video"] as? Bool, false)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live", "video": false, "video_revision": 1])))
        await harness.coordinator.handleLifecycleSignal(.appBecameActive)
        let voice = await harness.coordinator.centralTextSnapshot().call
        XCTAssertNil(voice.media); XCTAssertFalse(voice.videoFrameRendered); XCTAssertEqual(rtc.joins.count, 1)
        try await harness.coordinator.setCallVideo(true)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 2])))
        try await eventually("owner reopened video") { let events = await harness.realtime.mediaEvents; return rtc.joins.count == 2 && events.last == "camera:on" }
        events = await harness.realtime.mediaEvents
        XCTAssertEqual(events.filter { $0.hasPrefix("microphone:") }, ["microphone:on"])
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        let muted = await harness.realtime.mediaEvents
        XCTAssertEqual(muted.last, "microphone:mute", "静音 keeps the call's track published"); XCTAssertEqual(rtc.media, [])
        let connects = await harness.realtime.connectCount
        XCTAssertEqual(connects, 1)
        await harness.realtime.failNextCentralSend()
        do { try await harness.coordinator.setCallVideo(false); XCTFail("Failed renderer downgrade must surface") }
        catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
        let cleaned = await media(harness), stillActive = await harness.coordinator.centralTextSnapshot().call.isActive
        XCTAssertEqual(rtc.leaves, 2); XCTAssertEqual(cleaned.camera, .off); XCTAssertEqual(cleaned.microphone, .off)
        XCTAssertTrue(stillActive)
        let offCount = await sent(harness).filter { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }.count
        let pendingPackets = await sent(harness)
        let offRevision = try XCTUnwrap(pendingPackets.last?["video_revision"] as? Int)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": offRevision - 1])))
        for expected in [offCount + 1, offCount + 2] {
            try await eventually("off resent on healthy connection despite stale ACK") {
                await self.sent(harness).filter { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }.count >= expected
            }
        }
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": offRevision])))
        await harness.realtime.emit(.reconnecting)
        try await eventually("ACK then reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        try await eventually("encrypted again") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        let acknowledged = await sent(harness).filter { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }.count
        XCTAssertEqual(acknowledged, offCount + 2)

        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testVoiceToComponentVideoKeepsPublishedMicrophone() async throws {
        for muted in [false, true] {
            let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
            try await harness.coordinator.startCall(video: false)
            let opened = await harness.coordinator.centralTextSnapshot().call
            let id = try XCTUnwrap(opened.id)
            let liveHandled = expectation(description: "voice live event completed media handling")
            await harness.coordinator.setCentralTextObserver { state in
                if state.call.id == id, state.call.state == "live" { liveHandled.fulfill() }
            }
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
            await fulfillment(of: [liveHandled], timeout: 2)
            await harness.coordinator.setCentralTextObserver(nil)
            if muted { await harness.coordinator.releaseMedia(.microphone, for: .call) }
            try await harness.coordinator.setCallVideo(true)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": false, "error_code": "VIDU_COMPONENT_CREATE_FAILED", "video_revision": 1])))
            try await eventually("create failure leaves the same voice call") { await harness.coordinator.presentationSnapshot().componentVideoFailure }
            let initialFailure = await harness.coordinator.presentationSnapshot()
            XCTAssertEqual(initialFailure.callFailure, "VIDU_COMPONENT_CREATE_FAILED"); XCTAssertFalse(initialFailure.videoCallRequested)
            XCTAssertTrue(rtc.joins.isEmpty)
            try await harness.coordinator.setCallVideo(true)
            var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "connecting", "video": true, "media": credentials, "video_revision": 2])))
            try await eventually("video preserves microphone intent") { let events = await harness.realtime.mediaEvents; return rtc.joins.count == 1 && events.last == "camera:on" }
            let events = await harness.realtime.mediaEvents, microphone = await media(harness).microphone
            let microphoneEvents = muted ? ["microphone:on", "microphone:mute"] : ["microphone:on"]
            XCTAssertEqual(events, microphoneEvents + ["camera:on"])
            XCTAssertEqual(microphone, muted ? .off : .on)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": false, "error_code": "VIDU_COMPONENT_ENDED", "video_revision": 2])))
            try await eventually("renderer failure cleans video without closing voice") {
                let snapshot = await harness.coordinator.presentationSnapshot()
                return rtc.leaves == 1 && snapshot.media.camera == .off && snapshot.componentVideoFailure
            }
            let after = await harness.realtime.mediaEvents, snapshot = await harness.coordinator.presentationSnapshot()
            let call = await harness.coordinator.centralTextSnapshot().call
            XCTAssertEqual(after, microphoneEvents + ["camera:on", "camera:off"])
            XCTAssertEqual(snapshot.callFailure, "VIDU_COMPONENT_ENDED"); XCTAssertFalse(snapshot.videoCallRequested)
            XCTAssertEqual(snapshot.media.microphone, muted ? .off : .on)
            XCTAssertEqual(call.id, id); XCTAssertEqual(call.state, "live"); XCTAssertNil(call.media)
            let requests = await sent(harness)
            XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_video" }.compactMap { $0["video_revision"] as? Int }, [1, 2])
            XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
            XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false })
            try await harness.coordinator.setCallVideo(true)
            rtc.failJoin = muted
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": true, "media": credentials, "video_revision": 3])))
            if !muted {
                try await eventually("local RTC joined before failure") { rtc.joins.count == 2 }
                await harness.realtime.failNextCentralSend()
                rtc.emit(.failed)
            }
            let expectedCode = muted ? ComponentVideoFailureCode.rtcFailed.rawValue : ComponentVideoFailureCode.stopFailed.rawValue
            try await eventually("local RTC failure preserves voice and surfaces stop failure") {
                let snapshot = await harness.coordinator.presentationSnapshot()
                return rtc.leaves == 2 && snapshot.media.camera == .off && snapshot.callFailure == expectedCode
            }
            let localFailure = await harness.coordinator.presentationSnapshot(), voice = await harness.coordinator.centralTextSnapshot().call
            XCTAssertTrue(localFailure.componentVideoFailure); XCTAssertEqual(localFailure.media.microphone, muted ? .off : .on)
            XCTAssertEqual(voice.id, id); XCTAssertEqual(voice.state, "live"); XCTAssertNil(voice.media)
            let failedRequests = await sent(harness), mediaEvents = await harness.realtime.mediaEvents
            XCTAssertTrue(failedRequests.contains { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false })
            XCTAssertFalse(failedRequests.contains { $0["operation"] as? String == "call_close" })
            XCTAssertEqual(mediaEvents.filter { $0.hasPrefix("microphone:") }, microphoneEvents)
            rtc.failJoin = false
            try await harness.coordinator.setCallVideo(true)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": true, "media": credentials, "video_revision": 5])))
            try await eventually("owner retries video on same voice call") { rtc.joins.count == 3 }
            let retried = await harness.coordinator.presentationSnapshot()
            XCTAssertFalse(retried.componentVideoFailure)
            _ = await harness.coordinator.stop()
        }
    }

    @MainActor
    func testBackgroundPendingDialOpensVoiceAndNeverStartsCaptureInBackground() async throws {
        for microphonePending in [true, false] {
            let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc), gate = StopGate()
            if microphonePending { await harness.permissions.setGate(gate) }
            let location: (@Sendable () async -> AssistantLocationObservation?)?
            if microphonePending { location = nil }
            else { location = { await gate.markEntered(); await gate.waitForRelease(); return nil } }
            let opening = Task { try await harness.coordinator.startCall(video: true, location: location) }
            await gate.waitUntilEntered()
            let lifecycle = await retainedLifecycle(harness.coordinator)
            await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
            await lifecycle.handle(.appDidEnterBackground)
            await gate.release()
            if microphonePending {
                try await eventually("permission returned with capture still parked") { await harness.permissions.completedAuthorizations > 0 }
                let events = await harness.realtime.mediaEvents
                XCTAssertEqual(events, [])
            }
            let background = await harness.coordinator.presentationSnapshot()
            XCTAssertTrue(background.isDialing); XCTAssertFalse(background.videoCallRequested)
            await harness.coordinator.handleLifecycleSignal(.appBecameActive)
            _ = try await opening.value
            let requests = await sent(harness), open = try XCTUnwrap(requests.last { $0["operation"] as? String == "call_open" })
            XCTAssertNil(open["video"]); XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_video" })
            let id = try XCTUnwrap(open["call_id"] as? String)
            var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
            let after = await harness.coordinator.presentationSnapshot()
            XCTAssertFalse(after.videoCallRequested); XCTAssertTrue(rtc.joins.isEmpty)
            let events = await harness.realtime.mediaEvents
            XCTAssertEqual(events, ["microphone:on"])
            _ = await harness.coordinator.stop()
        }
    }

    @MainActor
    func testComponentBackgroundCancelsPendingCameraJoinAndIgnoresLateARTCEvents() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc), gate = StopGate()
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.realtime.setMediaPublishGate(gate)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
        await gate.waitUntilEntered()
        let lifecycle = await retainedLifecycle(harness.coordinator)
        let background = Task {
            await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
            await lifecycle.handle(.appDidEnterBackground)
        }
        try await eventually("video intent withdrawn while join waits") { !(await harness.coordinator.presentationSnapshot()).videoCallRequested }
        try await eventually("renderer downgrade sent before camera gate release") {
            await self.sent(harness).contains { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }
        }
        XCTAssertEqual(rtc.leaves, 0)
        rtc.emit(.firstFrame); rtc.emit(.failed)
        await harness.coordinator.handleLifecycleSignal(.appBecameActive)
        let ownerRetry = Task { try await harness.coordinator.setCallVideo(true) }
        await gate.release()
        await background.value
        try await ownerRetry.value
        let call = await harness.coordinator.centralTextSnapshot().call, media = await self.media(harness)
        XCTAssertEqual(call.id, id); XCTAssertTrue(call.isActive); XCTAssertFalse(call.videoFrameRendered)
        XCTAssertEqual(media.camera, .off); XCTAssertEqual(media.microphone, .on)
        XCTAssertEqual(rtc.joins.count, 1); XCTAssertEqual(rtc.leaves, 1)
        let requests = await sent(harness)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_video" }.compactMap { $0["video"] as? Bool }, [false, true])
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live", "video": false, "video_revision": 1])))
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 2])))
        try await eventually("owner retry survives older downgrade ACK") { rtc.joins.count == 2 }
        _ = await harness.coordinator.stop()
    }

    func testOffSupersedesOnStillAwaitingCameraPermission() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        try await harness.coordinator.startCall(video: false)
        await harness.permissions.setGate(gate)
        let enabling = Task { try await harness.coordinator.setCallVideo(true) }
        await gate.waitUntilEntered()
        try await harness.coordinator.setCallVideo(false)
        await gate.release()
        do { try await enabling.value; XCTFail("Older ON must be superseded") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let updates = await sent(harness).filter { $0["operation"] as? String == "call_video" }
        XCTAssertEqual(updates.compactMap { $0["video"] as? Bool }, [false])
        XCTAssertEqual(updates.last?["video_revision"] as? Int, 2)
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testDelayedVoiceOnlyStateDoesNotEraseNewVideoIntent() async throws {
        for explicitOff in [false, true] {
            let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
            try await harness.coordinator.startCall(video: false)
            let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
            if explicitOff { try await harness.coordinator.setCallVideo(false) }
            try await harness.coordinator.setCallVideo(true)
            let revision = explicitOff ? 2 : 1
            // An earlier voice-only opening/off ACK arrives after the owner's new ON request.
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": false, "video_revision": revision - 1])))
            var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "connecting", "video": true, "video_revision": revision, "media": credentials])))
            try await eventually("new video intent joins despite delayed voice state") { rtc.joins.count == 1 }
            let current = await harness.coordinator.presentationSnapshot()
            XCTAssertTrue(current.videoCallRequested)
            _ = await harness.coordinator.stop()
        }
    }

    func testServerVideoFailureKeepsAcknowledgedRevisionAndAcceptsLaterLiveState() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": false, "error_code": "VIDU_COMPONENT_CREATE_FAILED", "video_revision": 0])))
        try await eventually("server video failure projected") {
            await harness.coordinator.presentationSnapshot().componentVideoFailure
        }
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        try await eventually("same acknowledged revision advances to live") {
            await harness.coordinator.centralTextSnapshot().call.state == "live"
        }
        try await Task.sleep(nanoseconds: 1_100_000_000)
        let cleanup = await sent(harness)
        XCTAssertFalse(cleanup.contains { $0["operation"] as? String == "call_video" })
        try await harness.coordinator.setCallVideo(true)
        let commands = await sent(harness).filter { $0["operation"] as? String == "call_video" }
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?["video_revision"] as? Int, 1)
        _ = await harness.coordinator.stop()
    }

    private func announceRejoinDeadline(_ date: Date, on harness: Harness) async throws -> String {
        let before = await harness.coordinator.centralTextSnapshot(), id = try XCTUnwrap(before.call.id)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0, "rejoin_deadline": formatter.string(from: date)])))
        try await eventually("server recovery authority accepted") {
            let after = await harness.coordinator.centralTextSnapshot()
            return after.revision > before.revision && after.call.rejoinDeadline != nil
        }
        return id
    }

    func testManualVoiceCallUsesAdvertisedPolicyOnMacAndIPhone() async throws {
        for device in ["mac", "iphone"] {
            if device == "mac" {
                // DesktopCallEngine.start applies this before entering the shared coordinator.
                try AudioManager.shared.setPlatformVoiceProcessingAllowed(true)
            }
            let harness = try await centralHarness(formalVoice: true, deviceClass: device)
            try await harness.coordinator.startCall(video: false, camera: false)
            let packets = await sent(harness).filter { $0["operation"] as? String == "call_open" }
            XCTAssertEqual(packets.count, 1, device)
            let id = try XCTUnwrap(packets.first?["call_id"] as? String)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "live", "video": false, "video_revision": 0])))
            try await eventually("\(device) receives the authoritative live state") {
                await harness.coordinator.centralTextSnapshot().call.state == "live"
            }
            let presentation = await harness.coordinator.presentationSnapshot()
            XCTAssertNil(presentation.callFailure, device)
            let media = await harness.realtime.mediaEvents
            XCTAssertEqual(media, ["microphone:on"], device)
            try await harness.coordinator.endCall()
            let ended = await harness.realtime.mediaEvents
            XCTAssertEqual(ended.last, "microphone:off", device)
            _ = await harness.coordinator.stop()
        }
    }

    func testCallOpeningRequiresReliableBootstrapRecoveryPolicy() async throws {
        for device in ["mac", "iphone"] {
            if device == "mac" { try AudioManager.shared.setPlatformVoiceProcessingAllowed(true) }
            let harness = try await centralHarness(formalVoice: true, callRejoinWindowS: nil, deviceClass: device)
            try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "chat", text: "hello"))
            do { try await harness.coordinator.startCall(video: false, camera: false); XCTFail(device) }
            catch CentralTextError.unavailable { }
            let call = await harness.coordinator.centralTextSnapshot().call, packets = await sent(harness)
            XCTAssertFalse(call.isActive, device)
            XCTAssertTrue(packets.contains { $0["operation"] as? String == "submit" }, device)
            XCTAssertFalse(packets.contains { $0["operation"] as? String == "call_open" }, device)
            let media = await harness.realtime.mediaEvents
            XCTAssertEqual(media, ["microphone:on", "microphone:off"], device)
            let state = await harness.coordinator.snapshot()
            XCTAssertEqual(state, .active(encryptionActive: true), device)
            _ = await harness.coordinator.stop()
        }
    }

    /// Regression: the gateway's participant left mid video call; the iPhone refreshed the dead binding for 2.5 minutes.
    func testGatewayLeavingDuringACallEndsTheBindingAndOneFreshBootstrapReconnects() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let open = await harness.coordinator.centralTextSnapshot().call, bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertTrue(open.isActive)
        await harness.realtime.emit(.disconnected(errorCode: LiveKitSessionAdapter.gatewayLeftCode))
        try await eventually("the dead binding fails at once") {
            await harness.coordinator.snapshot() == .failed(code: LiveKitSessionAdapter.gatewayLeftCode)
        }
        let refreshes = await harness.bootstrap.refreshCount, stop = await harness.bootstrap.lastStopContext
        let ended = await harness.coordinator.centralTextSnapshot().call, connects = await harness.realtime.connectCount
        XCTAssertEqual(refreshes, 0, "a binding whose gateway left is never refreshed")
        XCTAssertFalse(ended.isActive); XCTAssertEqual(stop?.reasonCode, "realtime_disconnected")
        // The session owner's restart (Mac: reconnect on .failed; iPhone: reconnectAfterGatewayLoss) is a plain start.
        try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
        let after = await harness.bootstrap.bootstrapCount, refreshesAfter = await harness.bootstrap.refreshCount
        let connectsAfter = await harness.realtime.connectCount
        XCTAssertEqual(after, bootstraps + 1, "exactly one fresh bootstrap")
        XCTAssertEqual(refreshesAfter, 0); XCTAssertEqual(connectsAfter, connects + 1)
        _ = await harness.coordinator.stop()
    }

    func testDroppedFirstCallStateUsesFrozenPolicyBudgetOnlyAfterTransportLoss() async throws {
        let harness = try await centralHarness(callRejoinWindowS: 1)
        try await harness.coordinator.startCall(video: false)
        try await Task.sleep(nanoseconds: 3_100_000_000)
        let opening = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(opening.state, "opening"); XCTAssertNil(opening.rejoinDeadline)
        XCTAssertTrue(opening.isActive, "Healthy opening outlives recovery window plus margin")
        await harness.realtime.failNextConnects(99)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("loss budget delivered to transport") { await harness.realtime.rejoinDeadline != nil }
        let frozenDeadline = await harness.realtime.rejoinDeadline
        let beforePacket = await harness.coordinator.centralTextSnapshot().revision
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": try XCTUnwrap(opening.id),
            "state": "opening", "video": false, "video_revision": 0])))
        try await Task.sleep(nanoseconds: 1_200_000_000)
        let afterPacket = await harness.coordinator.centralTextSnapshot().revision
        XCTAssertEqual(afterPacket, beforePacket, "Disconnected recovery ignores central packets until readiness")
        let forwardedDeadline = await harness.realtime.rejoinDeadline
        XCTAssertEqual(forwardedDeadline, frozenDeadline, "A state without a deadline preserves the transport recovery budget")
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await Task.sleep(nanoseconds: 1_900_000_000)
        try await eventually("first frozen loss budget expires despite duplicate loss") { await harness.coordinator.snapshot().canStart }
        let snapshot = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
        let packets = await sent(harness)
        XCTAssertFalse(call.isActive); XCTAssertEqual(snapshot.media.microphone, .off); XCTAssertNil(snapshot.callFailure)
        XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.count, 1)
    }

    func testGrowingRefreshCannotExtendSameLossAndFreshCredentialsStillApply() async throws {
        let harness = try await centralHarness(callRejoinWindowS: 1)
        try await harness.coordinator.startCall(video: false)
        let opening = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opening.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
        try await eventually("live call recovery has its own loss budget") {
            await harness.coordinator.centralTextSnapshot().call.state == "live"
        }
        // Retries back off (0.5–1 s, 1–2 s, 2–4 s, 4–8 s): the fourth refresh lands within 15 s.
        let first = Date().addingTimeInterval(20), shorter = first.addingTimeInterval(-2)
        await harness.bootstrap.setReconnectDeadlines([first, nil, first.addingTimeInterval(30), shorter])
        await harness.realtime.failNextConnects(99)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("first qualified deadline replaces fallback") { await harness.realtime.rejoinDeadline == first }
        try await eventually("later refresh credential used despite extension", seconds: 8) { await harness.realtime.connectedTokens.contains("refreshed-token-3") }
        let retained = await harness.realtime.rejoinDeadline, projected = await harness.coordinator.centralTextSnapshot().call.rejoinDeadline
        XCTAssertEqual(retained, first); XCTAssertEqual(projected, first, "A missing deadline or later extension cannot reset qualification")
        try await eventually("earlier authoritative deadline shortens the same budget", seconds: 10) { await harness.realtime.rejoinDeadline == shorter }
        try await Task.sleep(for: .seconds(max(0, shorter.addingTimeInterval(2.1).timeIntervalSinceNow)))
        try await eventually("frozen budget ends the call normally") { await harness.coordinator.snapshot().canStart }
        let context = await harness.bootstrap.lastStopContext, media = await media(harness), snapshot = await harness.coordinator.presentationSnapshot()
        XCTAssertEqual(context?.reasonCode, "network"); XCTAssertEqual(media.microphone, .off); XCTAssertNil(snapshot.callFailure)
    }

    /// Regression: a failing recovery refreshed about once a second for 2.5 minutes. Retries follow the shared backoff.
    func testFailingCallRecoveryRetriesBackOff() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        await harness.realtime.failNextConnects(99)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await Task.sleep(for: .milliseconds(4_500))
        // Backoff: refreshes by 0.5–1 s, 1.5–3 s, 3.5–7 s, so two or three by 4.5 s; a fixed 1 s cadence makes four.
        let refreshes = await harness.bootstrap.refreshCount
        XCTAssertTrue((2...3).contains(refreshes), "\(refreshes) refreshes in 4.5 s")
        _ = await harness.coordinator.stop()
    }

    func testLateRefreshFromRecoveredLossCannotSetNextLossBudget() async throws {
        let harness = try await centralHarness(callRejoinWindowS: 1), gate = StopGate()
        try await harness.coordinator.startCall(video: false)
        let next = Date().addingTimeInterval(7)
        await harness.bootstrap.setReconnectDeadlines([next.addingTimeInterval(30), next], gate: gate)
        await harness.realtime.failNextConnects(99)
        await harness.realtime.emit(.disconnected(errorCode: "network")); await gate.waitUntilEntered()
        await harness.realtime.emit(.encryptionActive)
        try await eventually("encrypted readiness resets the old loss") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("new loss frozen") { await harness.coordinator.snapshot() == .reconnecting }
        let estimate = await harness.realtime.rejoinDeadline
        await gate.release()
        try await Task.sleep(nanoseconds: 100_000_000)
        let afterOldReply = await harness.realtime.rejoinDeadline
        XCTAssertEqual(afterOldReply, estimate)
        try await eventually("current loss accepts its first qualified deadline") { await harness.realtime.rejoinDeadline == next }
        try await eventually("current refresh credential reaches connect") { await harness.realtime.connectedTokens.contains("refreshed-token-2") }
        let tokens = await harness.realtime.connectedTokens
        XCTAssertFalse(tokens.contains("refreshed-token-1")); XCTAssertTrue(tokens.contains("refreshed-token-2"))
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupServerProvenBindingGoneReleasesOnlyDeadSession() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true); try await harness.coordinator.startCall(video: false)
        await harness.bootstrap.rejectReconnectBinding()
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("offline before hangup") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall()
        try await eventually("server-proven gone releases old obligation") { await harness.coordinator.snapshot().canStart }
        let stops = await harness.bootstrap.stopCount
        XCTAssertEqual(stops, 0, "No global remote Stop is sent for an already-gone binding")
        await harness.bootstrap.rejectReconnectBinding(nil)
        try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.startCall(video: false)
        try await eventually("standing ambient resumes on new session") { await self.media(harness).ambient == .on }
        let current = await media(harness), opens = await operations(harness)
        XCTAssertEqual(current.ambient, .on); XCTAssertEqual(opens.filter { $0 == "call_open" }.count, 2)
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupMissingBindingRequiresConfirmedExactScopeStop() async throws {
        for confirmed in [false, true] {
            let harness = try await centralHarness()
            try await harness.coordinator.setAmbient(true); try await harness.coordinator.startCall(video: false)
            await harness.bootstrap.rejectReconnectBinding(.bindingMissing)
            if !confirmed { await harness.bootstrap.failNextStop() }
            await harness.realtime.emit(.disconnected(errorCode: "network"))
            try await eventually("offline") { await harness.coordinator.snapshot() == .reconnecting }
            try await harness.coordinator.endCall()
            if confirmed {
                try await eventually("exact old binding verified retired") { await harness.coordinator.snapshot().canStart }
                let stops = await harness.bootstrap.stopCount
                XCTAssertEqual(stops, 1)
                await harness.bootstrap.rejectReconnectBinding(nil)
                try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
                try await eventually("ambient choice survives exact old stop") { await self.media(harness).ambient == .on }
                try await harness.coordinator.startCall(video: false)
            } else {
                try await eventually("unconfirmed scoped stop parks resolution") { await harness.realtime.stopCount > 0 }
                do { try await harness.coordinator.startCall(video: false); XCTFail("Missing runtime entry alone is not terminal proof") }
                catch CentralTextError.unavailable { }
                await harness.bootstrap.rejectReconnectBinding(nil)
                try await harness.coordinator.endCall()
                try await eventually("same persisted scoped stop completes") { await harness.coordinator.snapshot().canStart }
                let stops = await harness.bootstrap.stopCount, refreshes = await harness.bootstrap.refreshCount
                XCTAssertEqual(stops, 2); XCTAssertEqual(refreshes, 1, "Do not switch back to refresh while durable Stop is unresolved")
                try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
                try await harness.coordinator.startCall(video: false)
            }
            _ = await harness.coordinator.stop()
        }
    }

    func testOfflineHangupExpiredBudgetReconcilesOnNetworkReturnWithoutRenewal() async throws {
        let harness = try await centralHarness(callRejoinWindowS: 1)
        try await harness.coordinator.setAmbient(true); try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.realtime.failNextConnects(99)
        await harness.bootstrap.setReconnectDeadlines([Date().addingTimeInterval(1.3)])
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("offline before hangup") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall()
        try await eventually("successful refresh reaches room connect") { await harness.realtime.connectCount >= 2 }
        try await Task.sleep(nanoseconds: 2_600_000_000) // Cross the accepted deadline and existing RTT margin.
        try await eventually("budget ends and dead room is retired") { await harness.realtime.stopCount > 0 }
        let before = await harness.bootstrap.refreshCount
        let frozen = await harness.coordinator.centralTextSnapshot().call.rejoinDeadline
        await harness.realtime.failNextConnects(0)
        await harness.coordinator.handleNetworkPath(AssistantNetworkPathState(status: .satisfied, isExpensive: false, isConstrained: false, usesWiFi: true, usesCellular: false))
        try await harness.coordinator.endCall()
        try await eventually("network return drains original close") { await self.operations(harness).contains("call_close") }
        let requests = await harness.realtime.connectRequests, refreshes = await harness.bootstrap.refreshCount
        let packets = await sent(harness), close = try XCTUnwrap(packets.first { $0["operation"] as? String == "call_close" })
        XCTAssertGreaterThan(refreshes, before); XCTAssertEqual(close["call_id"] as? String, id)
        XCTAssertEqual(close["reason"] as? String, "button")
        XCTAssertFalse(try XCTUnwrap(requests.last).retainsLogicalCall); XCTAssertNil(requests.last?.rejoinDeadline)
        XCTAssertNotNil(frozen)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed", "reason": "network"])))
        try await eventually("terminal replay settles obligation") { await harness.coordinator.centralTextSnapshot().call.state == "closed" }
        try await harness.coordinator.startCall(video: false)
        let captures = await media(harness), stops = await harness.bootstrap.stopCount
        XCTAssertEqual(captures.ambient, .on); XCTAssertEqual(stops, 0)
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupSDKRecoveryExpiryRepublishesStandingAmbientWithoutNetworkChange() async throws {
        let harness = try await centralHarness(callRejoinWindowS: 1)
        try await harness.coordinator.setAmbient(true); try await harness.coordinator.startCall(video: false)
        await harness.realtime.emit(.reconnecting) // No final SDK disconnected event to mark tracks unknown.
        try await eventually("SDK recovery pending") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall()
        try await Task.sleep(nanoseconds: 3_200_000_000) // Loss window plus existing RTT margin.
        try await eventually("expired SDK room retired") { await harness.realtime.stopCount > 0 }
        try await eventually("close drained before restored capture") { await self.operations(harness).contains("call_close") }
        try await eventually("ambient republished on replacement room") {
            await harness.realtime.mediaEvents.filter { $0 == "microphone:on" }.count == 2
        }
        let captures = await media(harness)
        XCTAssertEqual(captures.ambient, .on)
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupLocalOrAuthRejectionKeepsIntentForLaterReconciliation() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true); try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.bootstrap.rejectReconnectBinding(.bindingRejected)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("offline") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall()
        try await eventually("auth failure retires only failed room") { await harness.realtime.stopCount > 0 }
        do { try await harness.coordinator.startCall(video: false); XCTFail("Local/auth failure is not proof of call termination") }
        catch CentralTextError.unavailable { }
        await harness.bootstrap.rejectReconnectBinding(nil)
        try await harness.coordinator.endCall()
        try await eventually("repeat hangup reconciles without new call budget") { await self.operations(harness).contains("call_close") }
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed"])))
        try await eventually("matching ACK") { await harness.coordinator.centralTextSnapshot().call.state == "closed" }
        try await harness.coordinator.startCall(video: false)
        let stops = await harness.bootstrap.stopCount, capture = await media(harness)
        XCTAssertEqual(stops, 0); XCTAssertEqual(capture.ambient, .on)
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupReplaysOriginalCloseOnceAndPreservesAmbient() async throws {
        for ambient in [false, true] {
            let harness = try await centralHarness()
            if ambient { try await harness.coordinator.setAmbient(true) }
            try await harness.coordinator.startCall(video: false)
            let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
            await harness.realtime.emit(.reconnecting)
            try await eventually("link lost") { await harness.coordinator.snapshot() == .reconnecting }
            let deadline = await harness.realtime.rejoinDeadline
            try await harness.coordinator.endCall(reason: "button")
            try await harness.coordinator.endCall(reason: "error")
            let local = await harness.coordinator.centralTextSnapshot().call, before = await operations(harness)
            let retained = await harness.realtime.rejoinDeadline
            let keepsSession = await harness.coordinator.retainsSession(for: "app_background")
            XCTAssertTrue(keepsSession, "Pending close retains its original session after local UI ends")
            XCTAssertFalse(local.isActive); XCTAssertFalse(before.contains("call_close")); XCTAssertEqual(retained, deadline)
            let afterHangup = await media(harness)
            XCTAssertEqual(afterHangup.microphone, ambient ? .on : .off)
            await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
            try await eventually("original close delivered on readiness") { await self.operations(harness).filter { $0 == "call_close" }.count == 1 }
            await harness.realtime.emit(.encryptionActive) // Duplicate readiness is not another loss or close.
            let packets = await sent(harness), close = try XCTUnwrap(packets.first { $0["operation"] as? String == "call_close" })
            XCTAssertEqual(close["call_id"] as? String, id); XCTAssertEqual(close["reason"] as? String, "button")
            XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.count, 1)
            // Publication is not ACK; unrelated terminal and closing states cannot release this intent.
            for state in [["call_id": "another-call", "state": "closed"], ["call_id": id, "state": "closing"]] {
                await harness.realtime.emit(.centralText(try central(["operation": "call_state"].merging(state) { _, next in next })))
            }
            let retry = Task { try await harness.coordinator.startCall(video: false) }
            try await eventually("redial waits without discarding the original close") {
                await harness.coordinator.presentationSnapshot().isDialing
            }
            try await harness.coordinator.endCall()
            do { _ = try await retry.value; XCTFail("Hang-up cancels the waiting redial") }
            catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed", "reason": "button"])))
            try await eventually("matching close ACK accepted") { await harness.coordinator.centralTextSnapshot().call.state == "closed" }
            await harness.realtime.emit(.reconnecting); await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
            try await eventually("unrelated session remains active") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
            let finalMedia = await media(harness), stops = await harness.bootstrap.stopCount
            let finalOps = await operations(harness)
            XCTAssertEqual(finalOps.filter { $0 == "call_close" }.count, 1); XCTAssertEqual(stops, 0)
            XCTAssertEqual(finalMedia.microphone, ambient ? .on : .off)
            try await harness.coordinator.startCall(video: false) // Matching terminal releases the original intent.
            _ = await harness.coordinator.stop()
        }
    }

    func testOfflineHangupKeepsReplacementRecoveryAndClosesBeforeAmbientTraffic() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        try await harness.coordinator.setAmbient(true)
        try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("replacement recovery scheduled") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall(); try await harness.coordinator.endCall()
        await harness.realtime.setImmediateCentralCompletion([
            .centralText(try central(["operation": "call_state", "call_id": id, "state": "closed", "reason": "button"]))
        ], gate: gate)
        try await eventually("replacement sent retained close") { await self.operations(harness).contains("call_close") }
        await gate.waitUntilEntered()
        let closeOps = await operations(harness), recovering = await harness.coordinator.snapshot()
        XCTAssertEqual(closeOps.filter { $0 == "call_close" }.count, 1)
        XCTAssertEqual(recovering, .reconnecting, "Close precedes active transition and its control/media traffic")
        await gate.release()
        try await eventually("replacement recovered and terminal ACK settled") {
            let state = await harness.coordinator.snapshot(), call = await harness.coordinator.centralTextSnapshot().call
            return state == .active(encryptionActive: true) && call.state == "closed"
        }
        let ops = await operations(harness), captures = await media(harness)
        let connects = await harness.realtime.connectCount, stops = await harness.bootstrap.stopCount
        XCTAssertEqual(connects, 2); XCTAssertEqual(stops, 0); XCTAssertEqual(captures.ambient, .on)
        XCTAssertEqual(ops.filter { $0 == "call_open" }.count, 1); XCTAssertEqual(ops.filter { $0 == "call_close" }.count, 1)
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testHangupPublishesCloseBeforeBlockedRendererLeaveCompletes() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc), gate = StopGate()
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": true, "video_revision": 0, "media": credentials])))
        try await eventually("renderer joined") { rtc.joins.count == 1 }
        rtc.leaveGate = gate
        defer { Task { await gate.release() } }
        let ending = Task { try await harness.coordinator.endCall() }
        try await eventually("close published independently of renderer leave") { await self.operations(harness).contains("call_close") }
        let local = await harness.coordinator.centralTextSnapshot().call
        XCTAssertFalse(local.isActive)
        await gate.release(); try await ending.value
        let ops = await operations(harness)
        XCTAssertEqual(ops.filter { $0 == "call_close" }.count, 1)
        _ = await harness.coordinator.stop()
    }

    func testFailedCallCloseDetachesPaymentAndLateRecoveryCannotReattachAfterStop() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        try await harness.coordinator.startCall(video: false)
        let detached = expectation(description: "payment detached on failed close publication")
        let noOutput = expectation(description: "detached payment never delivers output")
        noOutput.isInverted = true
        await harness.coordinator.paymentChannel.setObserver { event in
            if case .detached = event { detached.fulfill() }
            if case .output = event { noOutput.fulfill() }
        }
        await harness.bootstrap.setReconnectDeadlines([], gate: gate)
        await harness.realtime.failNextCentralSend()
        do { try await harness.coordinator.endCall(); XCTFail("Expected the failed close publication") }
        catch { }
        try await eventually("failed close starts credential recovery") { await harness.bootstrap.refreshCount > 0 }
        await fulfillment(of: [detached], timeout: 2)
        let packet = try central(["operation": "payment_receipt", "control_id": "ctl-1", "ok": true])
        let accepted = await harness.coordinator.paymentChannel.accept(packet)
        XCTAssertTrue(accepted, "Detached payment namespace stays consumed without delivering output")
        do {
            _ = try await harness.coordinator.paymentChannel.request(Data(), id: "ctl-1", timeout: 1)
            XCTFail("Detached payment cannot dispatch a request")
        } catch AssistantPaymentChannelError.notDispatched(_) { }
        _ = await harness.coordinator.stop()
        let before = await harness.realtime.paymentPackets.count
        await gate.release()
        try await Task.sleep(nanoseconds: 100_000_000)
        let after = await harness.realtime.paymentPackets.count
        let acceptedAfterStop = await harness.coordinator.paymentChannel.accept(packet)
        XCTAssertEqual(after, before, "Late recovery cannot reattach or republish payment presence")
        XCTAssertTrue(acceptedAfterStop)
        await fulfillment(of: [noOutput], timeout: 0.1)
    }

    func testRedialWaitsForPreviousCallTerminalReceipt() async throws {
        let harness = try await centralHarness(callDialTimeout: 5_000_000_000)
        try await harness.coordinator.startCall(video: false)
        let first = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(first.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
        try await eventually("first call is live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        try await harness.coordinator.endCall()
        let closedRequests = await sent(harness)
        XCTAssertEqual(closedRequests.filter { $0["operation"] as? String == "call_close" }.count, 1)
        let retry = Task { try await harness.coordinator.startCall(video: false) }
        defer { retry.cancel() }
        try await eventually("redial waits for the previous terminal receipt") {
            await harness.coordinator.presentationSnapshot().isDialing
        }
        let waiting = await sent(harness)
        XCTAssertEqual(waiting.filter { $0["operation"] as? String == "call_open" }.count, 1)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed"])))
        _ = try await retry.value
        let requests = await sent(harness)
        let ids = requests.filter { $0["operation"] as? String == "call_open" }.compactMap { $0["call_id"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(Set(ids).count, 2, "A new dial must have its own call ID")
        let next = try XCTUnwrap(ids.last)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": next, "state": "live"])))
        try await eventually("second call reaches live") {
            let call = await harness.coordinator.centralTextSnapshot().call
            return call.id == next && call.state == "live"
        }
        _ = await harness.coordinator.stop()
    }

    func testRedialDeadlineCoversUnacknowledgedClose() async throws {
        let harness = try await centralHarness(callDialTimeout: 500_000_000)
        try await harness.coordinator.startCall(video: false)
        let call = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(call.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
        try await eventually("first call is live") {
            await harness.coordinator.centralTextSnapshot().call.state == "live"
        }
        try await harness.coordinator.endCall()
        do { try await harness.coordinator.startCall(video: false); XCTFail("Unacknowledged close cannot wait beyond the dial deadline") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let snapshot = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(snapshot.isDialing)
        XCTAssertEqual(snapshot.callFailure, "连接超时，请重试")
        let requests = await sent(harness)
        XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_open" }.count, 1)
        _ = await harness.coordinator.stop()
    }

    func testOfflineHangupFailedPublicationRetainsIntentUntilMatchingTerminal() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        try await harness.coordinator.setCallVideo(false) // Close replay is independent of the video revision fence.
        await harness.realtime.emit(.reconnecting)
        try await eventually("offline") { await harness.coordinator.snapshot() == .reconnecting }
        try await harness.coordinator.endCall()
        await harness.realtime.failNextCentralSend()
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        try await eventually("failed close attempt retained") { await self.operations(harness).filter { $0 == "call_close" }.count == 1 }
        // No injected SDK or server event: failed publication itself uses the existing recovery owner.
        try await eventually("failed close recovers and republishes without another owner action") { await self.operations(harness).filter { $0 == "call_close" }.count == 2 }
        let local = await harness.coordinator.centralTextSnapshot().call
        XCTAssertFalse(local.isActive)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "failed"])))
        try await eventually("terminal failure acknowledges pending close") { await harness.coordinator.centralTextSnapshot().call.state == "failed" }
        try await harness.coordinator.startCall(video: false)
        let stops = await harness.bootstrap.stopCount
        XCTAssertEqual(stops, 0)
        _ = await harness.coordinator.stop()
    }

    func testAnnouncedRejoinDeadlineAppliesOnlyToRecoveryAndEndsNormally() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        _ = try await announceRejoinDeadline(Date().addingTimeInterval(-1.8), on: harness)
        try await Task.sleep(nanoseconds: 300_000_000)
        let healthy = await harness.coordinator.centralTextSnapshot().call
        XCTAssertTrue(healthy.isActive, "A healthy call has no deadline watcher")
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("expired server recovery budget closes normally") { await harness.coordinator.snapshot().canStart }
        let snapshot = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
        let connections = await harness.realtime.connectCount, refreshes = await harness.bootstrap.refreshCount
        XCTAssertFalse(call.isActive); XCTAssertEqual(snapshot.media.microphone, .off); XCTAssertNil(snapshot.callFailure)
        XCTAssertEqual(connections, 1); XCTAssertEqual(refreshes, 0)
        if case .failed = snapshot.state { XCTFail("Network ending is a normal call closure") }
    }

    func testSuccessfulRejoinCancelsExpiryWhileSameCallContinues() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let id = try await announceRejoinDeadline(Date().addingTimeInterval(0.2), on: harness)
        let announced = await harness.coordinator.centralTextSnapshot().call.rejoinDeadline
        _ = try await announceRejoinDeadline(Date().addingTimeInterval(-20), on: harness)
        let delayed = await harness.coordinator.centralTextSnapshot().call.rejoinDeadline
        XCTAssertEqual(delayed, announced, "A delayed older state cannot shorten the server-issued lease")
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("same call reacquired before deadline") { await harness.realtime.connectCount == 2 }
        try await eventually("rejoined encrypted") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        try await Task.sleep(nanoseconds: 1_400_000_000)
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(call.id, id); XCTAssertTrue(call.isActive); XCTAssertNil(call.rejoinDeadline)
        await harness.realtime.failNextConnects(99)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await Task.sleep(nanoseconds: 100_000_000)
        let nextLoss = await harness.coordinator.centralTextSnapshot().call
        XCTAssertTrue(nextLoss.isActive, "A later loss starts a fresh policy window, not the previous recovered deadline")
        _ = await harness.coordinator.stop()
    }

    func testRevokedBindingEndsRecoveryNormallyAndAllowsTextFollowup() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        _ = try await announceRejoinDeadline(Date().addingTimeInterval(30), on: harness)
        await harness.bootstrap.rejectReconnectBinding()
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("binding rejection ends retries") { await harness.coordinator.snapshot().canStart }
        let snapshot = await harness.coordinator.presentationSnapshot(), count = await harness.bootstrap.refreshCount
        XCTAssertNil(snapshot.callFailure); XCTAssertEqual(snapshot.media.microphone, .off); XCTAssertEqual(count, 1)
        if case .failed = snapshot.state { XCTFail("Binding rejection must not open the call failure dialog") }
        try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "after-network", text: "继续用文字聊"))
        let packets = await sent(harness)
        XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertTrue(packets.contains { $0["operation"] as? String == "submit" })
        _ = await harness.coordinator.stop()
    }

    func testServerNetworkClosureReplayPreservesReadyTextConnection() async throws {
        let harness = try await centralHarness(), completion = StopGate()
        try await harness.coordinator.startCall(video: false)
        let id = try await announceRejoinDeadline(Date().addingTimeInterval(30), on: harness)
        await harness.realtime.holdNextConnectCompletion(completion)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        await completion.waitUntilEntered()
        try await eventually("replay transport ready") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed", "reason": "network"])))
        try await eventually("server network closure projected") { await harness.coordinator.centralTextSnapshot().call.state == "closed" }
        await completion.release()
        for _ in 0..<20 { await Task.yield() }
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "after-replay", text: "继续文字聊"))
        let snapshot = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertNil(snapshot.callFailure); XCTAssertEqual(call.reason, "network"); XCTAssertFalse(call.isActive)
        _ = await harness.coordinator.stop()
    }

    func testMacFirstJoinFailureRecoversWithoutAnActiveSnapshotOrSecondStart() async throws {
        let harness = await Harness.make(canPublishData: true)
        var binding = Self.centralBinding; binding.deviceClass = "mac"
        await harness.bootstrap.setCentralBinding(binding)
        await harness.realtime.failNextConnects(1)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        let state = await harness.coordinator.snapshot(), connects = await harness.realtime.connectCount
        let bootstraps = await harness.bootstrap.bootstrapCount, media = await harness.realtime.mediaEvents
        XCTAssertEqual(state, .active(encryptionActive: true))
        XCTAssertEqual(connects, 2); XCTAssertEqual(bootstraps, 1); XCTAssertTrue(media.isEmpty)
        _ = await harness.coordinator.stop()
    }

    func testLateStartNetworkFailureRecoversAcceptedBindingBeforeReturning() async throws {
        let harness = await Harness.make(canPublishData: true), gate = StopGate()
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.realtime.holdNextConnectCompletion(gate)
        await harness.realtime.failNextConnectAfterActivation()
        let start = Task { try await harness.coordinator.start(AssistantStartIntent(microphoneEnabled: true, cameraEnabled: true, userInitiated: true)) }
        await gate.waitUntilEntered()
        try await eventually("initial encrypted activation") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await gate.release()
        try await start.value
        let state = await harness.coordinator.snapshot(), connections = await harness.realtime.connectCount
        let bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(state, .active(encryptionActive: true))
        XCTAssertEqual(connections, 2); XCTAssertEqual(bootstraps, 1)
        let media = await harness.realtime.mediaEvents
        XCTAssertEqual(media, ["microphone:on", "camera:on"])
        _ = await harness.coordinator.stop()
    }

    func testLateStartRecoveryRejectionReleasesStartWaiter() async throws {
        let harness = await Harness.make(canPublishData: true), gate = StopGate()
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.bootstrap.rejectReconnectBinding(.bindingRejected)
        await harness.realtime.holdNextConnectCompletion(gate)
        await harness.realtime.failNextConnectAfterActivation()
        let finished = expectation(description: "late start failure propagated")
        let start = Task {
            do {
                try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
                XCTFail("rejected recovery returned success")
            } catch { }
            finished.fulfill()
        }
        await gate.waitUntilEntered()
        try await eventually("initial encrypted activation") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await gate.release()
        await fulfillment(of: [finished], timeout: 3)
        try await eventually("rejection cleanup completed") { await harness.coordinator.snapshot() == .failed(code: "reconnect_rejected") }
        let bootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(bootstraps, 1)
        start.cancel()
        _ = await harness.coordinator.stop()
    }

    /// SDK recovery can stop producing callbacks without leaving the gateway room. No UI input or send follows.
    func testSilentClientRecoveryTimeoutReconnectsWithoutUserAction() async throws {
        var clients: [(Harness, FakeLiveKitRoomOperator)] = []
        let losses: [[AssistantRealtimeEvent]] = [[.resuming], [.resuming, .reconnected]]
        for events in losses {
            let fixture = try CentralTextTestFixture(), room = FakeLiveKitRoomOperator()
            let adapter = LiveKitSessionAdapter(roomOperator: room)
            let harness = await Harness.make(canPublishData: true, transport: adapter)
            await harness.bootstrap.setCentralBinding(fixture.binding)
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            try await eventually("initial ready sync completed") {
                let packets = await room.publishedPackets
                return try packets.contains { (try JSONSerialization.jsonObject(with: $0.data) as? [String: Any])?["operation"] as? String == "turns_sync" }
            }
            for event in events { await room.emit(event) }
            let expected: AssistantSessionState = events.count == 1 ? .reconnecting : .encryptionPreparing
            try await eventually("client alone marks connection lost") { await harness.coordinator.snapshot() == expected }
            let before = await room.stopCount
            XCTAssertEqual(before, 0, "no client leave was requested")
            clients.append((harness, room))
        }
        // Exercise the production deadline, with no pending operation and with transport restored but no E2EE callback.
        try await Task.sleep(for: .seconds(61))
        for (harness, room) in clients {
            try await eventually("existing recovery owner reconnects the silent client") {
                let connects = await room.connectCount
                let state = await harness.coordinator.snapshot()
                return connects == 2 && state == .active(encryptionActive: true)
            }
            let bootstraps = await harness.bootstrap.bootstrapCount
            XCTAssertEqual(bootstraps, 1, "accepted binding is refreshed, not replaced")
            let refreshes = await harness.bootstrap.refreshCount
            XCTAssertEqual(refreshes, 1)
            _ = await harness.coordinator.stop()
        }
    }

    func testCentralTextDisconnectRefreshesSameBindingWithoutBootstrapOrCall() async throws {
        for code in [nil, "network", "realtime_event_queue_overflow", "desktop_stream_failed"] as [String?] {
            let harness = try await centralHarness()
            let binding = await harness.coordinator.centralTextSnapshot().binding
            await harness.realtime.emit(.disconnected(errorCode: code))
            try await eventually("control connection waits for recovery") { await harness.coordinator.snapshot() == .reconnecting }
            try await eventually("control connection reacquired") { await harness.realtime.connectCount == 2 }
            try await eventually("control connection encrypted") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
            let restored = await harness.coordinator.centralTextSnapshot().binding
            let bootstraps = await harness.bootstrap.bootstrapCount
            let requests = await sent(harness)
            XCTAssertEqual(restored, binding)
            XCTAssertEqual(bootstraps, 1)
            XCTAssertFalse(requests.contains { ["call_open", "call_close"].contains($0["operation"] as? String ?? "") })
            _ = await harness.coordinator.stop()
        }
    }

    func testSDKDisconnectReacquiresSameCallWithPacedRetriesAndRestoresMicrophone() async throws {
        let harness = try await centralHarness(formalVoice: true)
        try await harness.coordinator.startCall(video: false)
        let before = await harness.coordinator.centralTextSnapshot().call
        let bootstraps = await harness.bootstrap.bootstrapCount
        await harness.realtime.failNextConnects(1)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("logical call waits for transport") { await harness.coordinator.snapshot() == .reconnecting }
        let during = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(during.id, before.id); XCTAssertTrue(during.isActive)
        try await Task.sleep(nanoseconds: 100_000_000)
        let immediate = await harness.realtime.connectCount
        XCTAssertEqual(immediate, 1, "No tight acquisition loop")
        try await eventually("first paced attempt") { await harness.realtime.connectCount == 2 }
        try await eventually("transport reacquired") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        try await eventually("microphone republished on fresh room") { await harness.realtime.mediaEvents == ["microphone:on", "microphone:on"] }
        let after = await harness.coordinator.centralTextSnapshot().call
        let requests = await sent(harness), currentBootstraps = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(after.id, before.id); XCTAssertTrue(after.isActive)
        XCTAssertEqual(currentBootstraps, bootstraps)
        let tokens = await harness.realtime.connectedTokens
        XCTAssertEqual(Array(tokens.dropFirst()), ["refreshed-token-1", "refreshed-token-2"])
        #if SWIFT_PACKAGE
        let voiceBundle = Bundle.module
        #else
        let voiceBundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(voiceBundle.url(forResource: "formal-voice.fixture", withExtension: "json", subdirectory: "Fixtures/FormalVoice"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        func reply(_ value: Any) throws -> CentralTextPacket {
            var body = try XCTUnwrap(value as? [String: Any])
            if body["event_id"] != nil { body["event_id"] = "errand:job-0123456789ab" }
            if var chunk = body["chunk"] as? [String: Any], chunk["event_id"] != nil {
                chunk["event_id"] = "errand:job-0123456789ab"; body["chunk"] = chunk
            }
            return try central(body)
        }
        for value in [fixture["accepted"]!, fixture["header"]!] + (fixture["text_chunks"] as! [Any]) {
            await harness.realtime.emit(.centralText(try reply(value)))
        }
        let packet = try reply(fixture["voice"]!), bytes = try XCTUnwrap(Data(base64Encoded: fixture["wav_base64"] as! String))
        let audio = try XCTUnwrap(packet.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self))
        let resource = try await CentralVoiceFile.receive(AsyncThrowingStream<Data, Error> { $0.yield(bytes); $0.finish() }, audio: audio)
        defer { resource.remove() }
        await harness.realtime.emit(.centralVoice(CentralVoicePlayback(packet: packet, resource: resource)))
        try await eventually("reply WAV reaches phone playback after recovery") { await harness.realtime.playedCentralVoice == [bytes] }
        XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testDisconnectBeforeRecoveryConnectReturnsReacquiresAgain() async throws {
        let harness = try await centralHarness(), completion = StopGate()
        try await harness.coordinator.startCall(video: false)
        let before = await harness.coordinator.centralTextSnapshot().call
        await harness.realtime.holdNextConnectCompletion(completion)
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        await completion.waitUntilEntered()
        try await eventually("replacement encryption active before connect returns") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("second exhaustion consumed before connect returns") { await harness.coordinator.snapshot() == .reconnecting }
        await completion.release()
        try await eventually("second replacement acquired") { await harness.realtime.connectCount == 3 }
        try await eventually("second replacement encrypted") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        let after = await harness.coordinator.centralTextSnapshot().call, requests = await sent(harness)
        XCTAssertEqual(after.id, before.id); XCTAssertTrue(after.isActive)
        XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testOldRoomMicrophonePublicationCannotSettleReplacementRoom() async throws {
        let harness = try await centralHarness(), publication = StopGate()
        try await harness.coordinator.startCall(video: false)
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        await harness.realtime.setMediaPublishGate(publication, source: .microphone)
        let unmute = Task { try await harness.coordinator.acquireMedia(.microphone, for: .call) }
        await publication.waitUntilEntered()
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("replacement room acquired") { await harness.realtime.connectCount == 2 }
        try await eventually("replacement encrypted while old publication pending") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        await publication.release()
        try await unmute.value
        try await eventually("microphone published on replacement despite old success") {
            await harness.realtime.mediaEvents == ["microphone:on", "microphone:mute", "microphone:on", "microphone:on"]
        }
        let snapshot = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(snapshot.media.microphone, .on); XCTAssertTrue(call.isActive)
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testDisconnectDuringPendingVideoOffReusesItsRevisionWithoutBlockingRecovery() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc), leaving = StopGate()
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
        try await eventually("component camera published") { await harness.realtime.mediaEvents.contains("camera:on") }
        rtc.leaveGate = leaving
        let off = Task { try await harness.coordinator.setCallVideo(false) }
        await leaving.waitUntilEntered()
        try await eventually("owner OFF sent") { await self.sent(harness).contains { $0["operation"] as? String == "call_video" } }
        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("transport recovery proceeds before old video leave") {
            let connections = await harness.realtime.connectCount
            let state = await harness.coordinator.snapshot()
            return connections == 2 && state == .active(encryptionActive: true)
        }
        let updates = await sent(harness).filter { $0["operation"] as? String == "call_video" }
        XCTAssertFalse(updates.isEmpty)
        XCTAssertTrue(updates.allSatisfy { $0["video_revision"] as? Int == 1 && $0["video"] as? Bool == false })
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 1])))
        await leaving.release()
        try await off.value
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(call.id, id); XCTAssertTrue(call.isActive); XCTAssertEqual(call.state, "live")
        _ = await harness.coordinator.stop()
    }

    func testServerCallFailureAndAppExitFenceTransportRecovery() async throws {
        for cause in ["server_failure", "app_exit"] {
            let harness = try await centralHarness()
            try await harness.coordinator.startCall(video: false)
            let opened = await harness.coordinator.centralTextSnapshot().call
            let id = try XCTUnwrap(opened.id)
            if cause == "server_failure" {
                await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "failed"])))
            } else {
                await harness.realtime.emit(.disconnected(errorCode: "network"))
                try await eventually("recovery before owner termination") { await harness.coordinator.snapshot() == .reconnecting }
                _ = await harness.coordinator.stop(reasonCode: "app_exit")
            }
            try await eventually("terminal cause releases call microphone") {
                let call = await harness.coordinator.centralTextSnapshot().call
                let media = await harness.coordinator.presentationSnapshot().media
                return !call.isActive && media.microphone == .off
            }
            try await Task.sleep(nanoseconds: 1_100_000_000)
            let connects = await harness.realtime.connectCount
            XCTAssertEqual(connects, 1, cause + " must cancel pending room acquisition")
            _ = await harness.coordinator.stop()
        }
    }

    @MainActor
    func testComponentReconnectDetachesVideoWithoutClosingCall() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        var media = Self.artcMedia; media["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": media, "video_revision": 0])))
        try await eventually("component joined") { rtc.joins.count == 1 }
        await harness.realtime.failNextCentralSend()
        await harness.realtime.emit(.reconnecting)
        try await eventually("video left while reconnecting") {
            let state = await harness.coordinator.snapshot()
            return state == .reconnecting && rtc.leaves == 1
        }
        let during = await harness.coordinator.presentationSnapshot(), call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(call.id, id); XCTAssertTrue(call.isActive)
        XCTAssertFalse(during.videoCallRequested); XCTAssertEqual(during.media.microphone, .on)
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        try await eventually("recovered") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        let requests = await sent(harness)
        XCTAssertEqual(requests.filter { $0["operation"] as? String == "call_video" && $0["video"] as? Bool == false }.count, 1)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    @MainActor
    func testDisabledVideoVoiceBackgroundKeepsForegroundMicrophone() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        // Omitted video configuration acknowledges voice-only and supplies no media credentials.
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "error_code": "VIDEO_CALL_DISABLED", "video_revision": 0])))
        try await eventually("disabled video live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        try await eventually("disabled video acknowledged") { !(await harness.coordinator.presentationSnapshot()).videoCallRequested }
        let openingIntent = await harness.coordinator.presentationSnapshot().videoCallRequested
        XCTAssertFalse(openingIntent)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        let call = await harness.coordinator.centralTextSnapshot().call, events = await harness.realtime.mediaEvents
        XCTAssertEqual(call.id, id); XCTAssertTrue(call.isActive)
        XCTAssertEqual(events, ["microphone:on"]); XCTAssertTrue(rtc.joins.isEmpty)
        let requests = await sent(harness)
        XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testBackgroundLiveKitVideoDowngradeKeepsCallMicrophone() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: true)
        let opened = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
        try await eventually("camera published") { await self.media(harness).camera == .on }
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        try await eventually("background camera released") { await self.media(harness).camera == .off }
        let current = await media(harness), call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(current.microphone, .on); XCTAssertEqual(current.camera, .off)
        XCTAssertTrue(call.isActive); XCTAssertEqual(call.id, id)
        await harness.coordinator.handleLifecycleSignal(.appBecameActive)
        let events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "camera:on", "camera:off"])
        _ = await harness.coordinator.stop()
    }

    /// APP-02 (trigger B): a remote close/failure of the call ends its media too.
    func testRemoteCallCloseRevokesTheCallsMedia() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let openedCall = await harness.coordinator.centralTextSnapshot().call
        let callID = try XCTUnwrap(openedCall.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "live"])))
        try await eventually("live call") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "failed"])))
        try await eventually("microphone released") { await self.media(harness).microphone == .off }
        let events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "microphone:off"])
        let reason = await media(harness).revokedReason
        XCTAssertEqual(reason, "call_failed")
    }

    /// A voice call ends only on hang-up or app termination, so backgrounding keeps it and its microphone.
    func testVoiceCallKeepsRunningInTheBackground() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let callID = try XCTUnwrap(opened.id)
        let lifecycle = await retainedLifecycle(harness.coordinator)
        await harness.coordinator.handleLifecycleSignal(.audioInterruptionBegan)
        await lifecycle.handle(.audioInterruptionBegan)
        await lifecycle.handle(.audioInterruptionEnded(shouldResume: true))
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "live"])))
        try await eventually("live call") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        let retained = await harness.coordinator.retainsSession(for: "app_background")
        XCTAssertTrue(retained)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        await lifecycle.handle(.appDidEnterBackground)
        await harness.coordinator.handleLifecycleSignal(.audioInterruptionBegan)
        await lifecycle.handle(.audioInterruptionBegan)
        await harness.coordinator.handleLifecycleSignal(.audioInterruptionEnded(shouldResume: true))
        await lifecycle.handle(.audioInterruptionEnded(shouldResume: true))
        let resumed = await harness.coordinator.centralTextSnapshot().call
        let events = await harness.realtime.mediaEvents, lifecycleState = await lifecycle.snapshot()
        XCTAssertEqual(resumed.id, callID); XCTAssertEqual(resumed.state, "live")
        XCTAssertEqual(events, ["microphone:on"]); XCTAssertEqual(lifecycleState, .running)
        let microphone = await media(harness).microphone
        XCTAssertEqual(microphone, .on)
        let ops = await operations(harness)
        XCTAssertFalse(ops.contains("call_close")); XCTAssertFalse(ops.contains("call_video"))
        try await harness.coordinator.endCall()
        _ = await harness.coordinator.stop()
    }

    /// The ringback plays from the tap until central says the call is live, and stops on hang-up or failure too.
    func testRingbackPlaysUntilCentralReportsTheCallLive() async throws {
        let ringback = RecordingRingback()
        let harness = try await centralHarness(ringback: ringback)
        try await harness.coordinator.startCall(video: false)
        XCTAssertEqual(ringback.events, ["start"], "ringing from the tap, no second start while opening")
        let opened = await harness.coordinator.centralTextSnapshot().call
        let callID = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "opening"])))
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "live"])))
        try await eventually("ringback stopped") { ringback.events == ["start", "stop"] }
        try await harness.coordinator.endCall()
        XCTAssertEqual(ringback.events, ["start", "stop"], "a live call hung up later does not ring again")

        let failing = RecordingRingback()
        let second = try await centralHarness(ringback: failing)
        try await second.coordinator.startCall(video: false)
        let call2 = await second.coordinator.centralTextSnapshot().call
        let id2 = try XCTUnwrap(call2.id)
        await second.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id2, "state": "failed"])))
        try await eventually("ringback stopped on failure") { failing.events == ["start", "stop"] }

        let hung = RecordingRingback()
        let third = try await centralHarness(ringback: hung)
        try await third.coordinator.startCall(video: false)
        try await third.coordinator.endCall()
        XCTAssertEqual(hung.events, ["start", "stop"], "hang-up while connecting silences it")
    }

    func testDialDeadlineFencesConnectionBeforeItReturns() async throws {
        let gate = StopGate(), ringback = RecordingRingback()
        let harness = await Harness.make(connectGate: gate, canPublishData: true,
                                         callDialTimeout: 100_000_000, ringback: ringback)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        let opening = Task { try await harness.coordinator.startCall(video: false) }
        await gate.waitUntilEntered()
        try await eventually("dial expires while connection remains blocked") {
            let snapshot = await harness.coordinator.presentationSnapshot()
            return !snapshot.isDialing && snapshot.callFailure == "连接超时，请重试"
        }
        XCTAssertEqual(ringback.events, ["start", "stop"])
        await gate.release()
        do { _ = try await opening.value; XCTFail("expired dial must be fenced") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let ops = await operations(harness), media = await harness.realtime.mediaEvents
        XCTAssertFalse(ops.contains("call_open")); XCTAssertFalse(media.contains("microphone:on"))
        _ = await harness.coordinator.stop()
    }

    func testDialDeadlineStopsPresentationBeforeMicrophonePublicationReturns() async throws {
        let harness = try await centralHarness(callDialTimeout: 100_000_000), gate = StopGate()
        await harness.realtime.setMediaPublishGate(gate, source: .microphone)
        let opening = Task { try await harness.coordinator.startCall(video: false) }
        await gate.waitUntilEntered()
        try await eventually("blocked publication cannot hold dialing UI") {
            let snapshot = await harness.coordinator.presentationSnapshot()
            return !snapshot.isDialing && snapshot.callFailure == "连接超时，请重试"
        }
        await gate.release()
        do { _ = try await opening.value; XCTFail("late publication must not open a call") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let ops = await operations(harness)
        XCTAssertFalse(ops.contains("call_open"))
        try await eventually("late microphone is released") { await self.media(harness).microphone == .off }
        _ = await harness.coordinator.stop()
    }

    func testDialDeadlineWaitsForCentralLiveAfterCallOpen() async throws {
        let harness = try await centralHarness(callDialTimeout: 100_000_000)
        try await harness.coordinator.startCall(video: false)
        let initial = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(initial.isDialing)
        try await eventually("call_open without live expires") {
            let snapshot = await harness.coordinator.presentationSnapshot()
            return !snapshot.isDialing && snapshot.callFailure == "连接超时，请重试"
        }
        try await eventually("expired opening retires the room") { await harness.realtime.stopCount > 0 }
        _ = await harness.coordinator.stop()
    }

    func testDialDeadlineIncludesPreviousCleanupAndHangupCancelsWaitingRetry() async throws {
        for cancel in [false, true] {
            let harness = try await centralHarness(callDialTimeout: cancel ? 5_000_000_000 : 100_000_000), gate = StopGate()
            try await harness.coordinator.startCall(video: false)
            await harness.realtime.setMediaDisableGate(gate)
            let ending = Task { try await harness.coordinator.endCall() }
            await gate.waitUntilEntered()
            let retry = Task { try await harness.coordinator.startCall(video: false) }
            try await eventually("retry starts one continuous dial while cleanup is blocked") {
                await harness.coordinator.presentationSnapshot().isDialing
            }
            let cancelled: Task<Void, Error>? = cancel ? Task { try await harness.coordinator.endCall() } : nil
            try await eventually("waiting retry is bounded or cancelled before the old cleanup returns") {
                let snapshot = await harness.coordinator.presentationSnapshot()
                return !snapshot.isDialing && (cancel || snapshot.callFailure == "连接超时，请重试")
            }
            await harness.realtime.setMediaDisableGate(nil)
            await gate.release()
            try await ending.value; try await cancelled?.value
            do { _ = try await retry.value; XCTFail("ended retry must not open after old cleanup") }
            catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
            let packets = await sent(harness)
            XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.count, 1)
            _ = await harness.coordinator.stop()
        }
    }

    func testDialTimeoutAndHangupRetireStalledCaptureSoRetryDoesNotWaitForOldPublication() async throws {
      for hangUp in [false, true] {
        let harness = try await centralHarness(callDialTimeout: hangUp ? 5_000_000_000 : 500_000_000), gate = StopGate()
        await harness.realtime.setMediaPublishGate(gate, source: .microphone)
        let old = Task { try await harness.coordinator.startCall(video: false) }
        await gate.waitUntilEntered()
        let ending: Task<Void, Error>? = hangUp ? Task { try await harness.coordinator.endCall() } : nil
        try await eventually("cancellation retires the session without draining stalled publication") {
            let state = await harness.coordinator.snapshot(), stops = await harness.realtime.stopCount
            return state.canStart && stops > 0
        }
        try await ending?.value
        await harness.realtime.setMediaPublishGate(nil, source: .microphone)
        try await harness.coordinator.startCall(video: false)
        let call = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(call.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
        try await eventually("retry is live while the old publish is still blocked") {
            await harness.coordinator.centralTextSnapshot().call.state == "live"
        }
        await gate.release()
        do { _ = try await old.value; XCTFail("old dial cannot adopt retry capture") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let snapshot = await harness.coordinator.presentationSnapshot(), capture = await media(harness)
        XCTAssertNil(snapshot.callFailure); XCTAssertFalse(snapshot.isDialing)
        XCTAssertEqual(capture.microphone, .on)
        _ = await harness.coordinator.stop()
      }
    }

    func testCentralLiveCancelsDialDeadline() async throws {
        let harness = try await centralHarness(callDialTimeout: 200_000_000)
        try await harness.coordinator.startCall(video: false)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live", "mode": "manual", "conversation_mode": "chat"])))
        try await eventually("call becomes live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        try await Task.sleep(nanoseconds: 300_000_000)
        let snapshot = await harness.coordinator.presentationSnapshot(), ops = await operations(harness)
        XCTAssertFalse(snapshot.isDialing); XCTAssertNil(snapshot.callFailure)
        XCTAssertFalse(ops.contains("call_close"))
        try await harness.coordinator.endCall()
        let ended = await operations(harness), stopped = await harness.bootstrap.stopCount
        XCTAssertEqual(ended.filter { $0 == "call_close" }.count, 1)
        XCTAssertEqual(stopped, 0, "An accepted N13 live state permits hang-up without retiring the room by dial timeout")
        _ = await harness.coordinator.stop()
    }

    func testCentralFailureReasonIsPreservedForVoiceAndVideo() async throws {
        for video in [false, true] {
          for (reason, code, message) in [
            ("error", "VOICE_CALL_BUSY", "已有通话正在进行，请先挂断后重试"),
            ("error", "VOICE_CALL_OPEN_FAILED", "通话连接失败，请重试"),
            ("error", "MEDIA_CAPTURE_NOT_CONNECTED", "麦克风未连接，请重试"),
            ("network", nil, "通话连接已断开，请重拨")
          ] as [(String, String?, String)] {
            let harness = try await centralHarness()
            try await harness.coordinator.startCall(video: video)
            let opened = await harness.coordinator.centralTextSnapshot().call
            let id = try XCTUnwrap(opened.id)
            if code == "VOICE_CALL_OPEN_FAILED" {
                await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                                                                      "state": "closed", "reason": "error"])))
                try await eventually("late failure follows the server close") {
                    await harness.coordinator.centralTextSnapshot().call.state == "closed"
                }
            }
            var fields: [String: Any] = ["operation": "call_state", "call_id": id, "state": "failed", "reason": reason]
            if let code { fields["error_code"] = code }
            await harness.realtime.emit(.centralText(try central(fields)))
            try await eventually("authoritative reason reaches presentation") {
                await harness.coordinator.presentationSnapshot().callFailure == message
            }
            let failed = await harness.coordinator.centralTextSnapshot().call
            XCTAssertEqual(failed.reason, reason); XCTAssertEqual(failed.errorCode, code)
            _ = await harness.coordinator.stop()
          }
        }
    }

    func testCallTapDuringLaunchSharesConnectionAndRingsBeforeItConnects() async throws {
        let gate = StopGate(), ringback = RecordingRingback()
        let harness = await Harness.make(bootstrapGate: gate, canPublishData: true, ringback: ringback)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        let launch = Task { try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true)) }
        await gate.waitUntilEntered()
        let opening = Task { try await harness.coordinator.startCall(video: false) }
        let message = Task { try await harness.coordinator.submitPrompt(
            AssistantPromptEnvelope(promptID: "typed-while-connecting", text: "这句先留着")) }
        try await eventually("ringing during bootstrap") { ringback.events == ["start"] }
        let before = await harness.realtime.mediaEvents
        XCTAssertFalse(before.contains("microphone:on"))
        await gate.release()
        try await launch.value
        _ = try await opening.value
        try await message.value
        let ops = await operations(harness), count = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(count, 1)
        XCTAssertEqual(ops.filter { $0 == "call_open" }.count, 1)
        XCTAssertEqual(ops.filter { $0 == "submit" }.count, 1, "the waiting typed message is delivered once")
        XCTAssertEqual(ringback.events, ["start"], "one continuous ringback across session and call setup")
        try await harness.coordinator.endCall()
    }

    func testCallTapDuringReadyWaitUsesTransportGateAndOpensOnce() async throws {
        let room = FakeLiveKitRoomOperator(automaticReady: false)
        let transport = LiveKitSessionAdapter(roomOperator: room)
        let fixture = try CentralTextTestFixture(), ringback = RecordingRingback()
        let harness = await Harness.make(canPublishData: true, transport: transport, ringback: ringback)
        await harness.bootstrap.setCentralBinding(fixture.binding)
        let launch = Task { try await harness.coordinator.ensureActive(AssistantStartIntent(userInitiated: true)) }
        await room.waitUntilConnected()
        let tap = Task { try await harness.coordinator.startCall(video: false) }
        try await eventually("ringing while waiting for gateway ready") { ringback.events == ["start"] }
        var sent = await room.publishedPackets
        XCTAssertTrue(sent.isEmpty)
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        try await launch.value
        _ = try await tap.value
        try await room.emitReady(sessionID: fixture.binding.sessionID)
        sent = await room.publishedPackets
        let calls = try sent.filter {
            (try JSONSerialization.jsonObject(with: $0.data) as? [String: Any])?["operation"] as? String == "call_open"
        }
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(ringback.events, ["start"])
        _ = await harness.coordinator.stop()
    }

    func testHangUpDuringConnectionCannotOpenOrCaptureLater() async throws {
        let gate = StopGate(), ringback = RecordingRingback()
        let harness = await Harness.make(connectGate: gate, canPublishData: true, ringback: ringback)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        let opening = Task { try await harness.coordinator.startCall(video: true) }
        await gate.waitUntilEntered()
        XCTAssertEqual(ringback.events, ["start"])
        try await harness.coordinator.endCall()
        XCTAssertEqual(ringback.events, ["start", "stop"])
        await gate.release()
        do { _ = try await opening.value; XCTFail("a hang-up must cancel the waiting call") }
        catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
        let ops = await operations(harness), media = await harness.realtime.mediaEvents
        XCTAssertFalse(ops.contains("call_open"))
        XCTAssertFalse(media.contains("microphone:on"))
        XCTAssertFalse(media.contains("camera:on"))
        let state = await harness.coordinator.snapshot()
        XCTAssertEqual(state, .active(encryptionActive: true), "hang-up leaves the text connection usable")
        _ = await harness.coordinator.stop()
        let stopped = await harness.coordinator.snapshot()
        XCTAssertEqual(stopped, .stopped(remoteStopConfirmed: true), "a cancelled dial cannot swallow a later session stop")
    }

    func testConnectionFailureStopsDialingAndRetryOpensOnce() async throws {
        let ringback = RecordingRingback()
        let harness = await Harness.make(canPublishData: true, ringback: ringback)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        await harness.bootstrap.failNextBootstrap()
        do { _ = try await harness.coordinator.startCall(video: false); XCTFail("bootstrap failure must surface") }
        catch { }
        XCTAssertEqual(ringback.events, ["start", "stop"])
        let failed = await harness.coordinator.presentationSnapshot()
        XCTAssertNotNil(failed.callFailure)
        try await harness.coordinator.startCall(video: false)
        let retried = await harness.coordinator.presentationSnapshot(), ops = await operations(harness)
        XCTAssertNil(retried.callFailure)
        XCTAssertEqual(ops.filter { $0 == "call_open" }.count, 1)
        try await harness.coordinator.endCall()
    }

    func testRingbackToneIsAWellFormedLoopOfOneSecondOnAndTwoAndAHalfOff() throws {
        let wav = CallRingbackTone.wav()
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(wav.count, 44 + Int(3.5 * 16_000) * 2)
        let samples = wav.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertGreaterThan(samples[8_000...8_400].map { abs(Int($0)) }.max() ?? 0, 2_000, "tone in the first second")
        XCTAssertEqual(samples[17_000...50_000].map { abs(Int($0)) }.max(), 0, "silence for the rest")
        XCTAssertEqual(samples[0], 0, "faded in: no click")
    }

    /// APP-05 (trigger B): hanging up while the call still waits (permission) cancels the attempt entirely.
    func testCameraOffOrHangUpDuringPublishCannotReenableLateCamera() async throws {
        for hangUp in [false, true] {
            let harness = try await centralHarness()
            try await harness.coordinator.startCall(video: false)
            let gate = StopGate()
            await harness.realtime.setMediaPublishGate(gate)
            let opening = Task { try await harness.coordinator.acquireMedia(.camera, for: .call) }
            await gate.waitUntilEntered()
            let during = await media(harness)
            XCTAssertEqual(during.camera, .opening)
            let closing = Task {
                if hangUp { try await harness.coordinator.endCall() }
                else { await harness.coordinator.releaseMedia(.camera, for: .call) }
            }
            try await eventually("camera intent withdrawn") { await self.media(harness).camera == .off }
            await gate.release()
            try await closing.value
            do { try await opening.value; XCTFail("withdrawn camera publish must be superseded") }
            catch { XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded) }
            let after = await media(harness), events = await harness.realtime.mediaEvents
            XCTAssertEqual(after.camera, .off)
            XCTAssertEqual(events.filter { $0.hasPrefix("camera:") }, ["camera:on", "camera:off"], "hangUp=\(hangUp), events=\(events)")
            XCTAssertEqual(events.filter { $0.hasPrefix("microphone:") },
                hangUp ? ["microphone:on", "microphone:off"] : ["microphone:on"])
        }
    }

    @MainActor
    func testRecoveryFencesDialBeforeBlockedCameraCleanup() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        let openingGate = StopGate(), cameraGate = StopGate()
        await harness.realtime.failNextCentralSend()
        await harness.realtime.setImmediateCentralCompletion([.connected], gate: openingGate)
        await harness.realtime.setMediaPublishGate(cameraGate)
        let opening = Task { try await harness.coordinator.startCall(video: true) }
        await openingGate.waitUntilEntered()
        let dial = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(dial.id)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "video_revision": 0, "media": credentials])))
        await cameraGate.waitUntilEntered()
        await harness.realtime.emit(.reconnecting)
        try await eventually("recovery visible before camera cleanup completes") {
            await harness.coordinator.snapshot() == .reconnecting
        }
        await openingGate.release()
        let during = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(during.id, id); XCTAssertTrue(during.isActive)
        await cameraGate.release()
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        _ = try await opening.value
        let packets = await sent(harness)
        XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.compactMap { $0["call_id"] as? String }, [id, id])
        XCTAssertFalse(packets.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testOpeningPublicationFailureDuringRecoveryKeepsSameDial() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        await harness.realtime.failNextCentralSend()
        await harness.realtime.setImmediateCentralCompletion([.reconnecting], gate: gate)
        let opening = Task { try await harness.coordinator.startCall(video: false) }
        await gate.waitUntilEntered()
        try await eventually("publication reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
        let first = await harness.coordinator.centralTextSnapshot().call
        await gate.release()
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        _ = try await opening.value
        let packets = await sent(harness), current = await harness.coordinator.centralTextSnapshot().call
        let opens = packets.filter { $0["operation"] as? String == "call_open" }
        XCTAssertEqual(opens.count, 2)
        XCTAssertEqual(opens.compactMap { $0["call_id"] as? String }, [first.id, first.id].compactMap { $0 })
        XCTAssertEqual(current.id, first.id); XCTAssertTrue(current.isActive)
        XCTAssertFalse(packets.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testOpeningLocationCompletionWaitsForRecovery() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        let opening = Task {
            try await harness.coordinator.startCall(video: false, location: {
                await gate.markEntered(); await gate.waitForRelease(); return nil
            })
        }
        await gate.waitUntilEntered()
        await harness.realtime.emit(.reconnecting)
        try await eventually("dial reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
        await gate.release()
        await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
        _ = try await opening.value
        let packets = await sent(harness)
        XCTAssertEqual(packets.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertEqual(packets.first { $0["operation"] as? String == "call_open" }?["video_revision"] as? Int, 0)
        XCTAssertFalse(packets.contains { $0["operation"] as? String == "call_close" })
        _ = await harness.coordinator.stop()
    }

    func testHangUpWhileTheCallIsOpeningOpensNothing() async throws {
        let harness = try await centralHarness()
        let gate = StopGate()
        await harness.permissions.setGate(gate)
        let opening = Task { try await harness.coordinator.startCall(video: true) }
        await gate.waitUntilEntered()
        let hangUp = Task { try await harness.coordinator.endCall() }
        try await eventually("intent withdrawn") { await self.media(harness).microphone == .off }
        await gate.release()
        try await hangUp.value
        do {
            _ = try await opening.value
            XCTFail("The opening attempt must end with the hang-up")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
        let ops = await operations(harness)
        XCTAssertFalse(ops.contains("call_open"), "No call is opened after the hang-up")
        let events = await harness.realtime.mediaEvents
        XCTAssertFalse(events.contains("microphone:on"), "The reconciler re-checks the intent after the prompt")
        XCTAssertFalse(events.contains("camera:on"))
        let current = await media(harness)
        XCTAssertEqual(current.microphone, .off)
        XCTAssertEqual(current.camera, .off)
    }

    /// APP-05 (trigger A): a lift before the window opened (permission prompt) is never lost.
    func testALiftBeforeTheVoiceWindowOpensRecordsNothing() async throws {
        let harness = try await centralHarness()
        let gate = StopGate()
        await harness.permissions.setGate(gate)
        let press = Task { try await harness.coordinator.pressVoiceTurn(1) }
        await gate.waitUntilEntered()
        let committed = try await harness.coordinator.releaseVoiceTurn(1, cancel: false)
        XCTAssertFalse(committed)
        await gate.release()
        do {
            try await press.value
            XCTFail("A released press must not open a window")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
        let ops = await operations(harness)
        XCTAssertFalse(ops.contains("voice_open"))
        let events = await harness.realtime.mediaEvents
        XCTAssertFalse(events.contains("microphone:on"))
        do {
            try await harness.coordinator.pressVoiceTurn(1)
            XCTFail("A late begin of the released press is refused")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
        try await harness.coordinator.pressVoiceTurn(2)
        let reopened = await operations(harness)
        XCTAssertEqual(reopened, ["voice_open"], "The next press works normally")
    }

    /// APP-06: the hold-to-talk microphone closes once the window is cut; an unanswered voice_send is resent
    /// unchanged once, then shown as unconfirmed; a retry resends the same bytes and the D's admission settles it.
    func testVoiceSendWithoutConfirmationIsResentUnchangedAndSettledByAdmission() async throws {
        let harness = try await centralHarness(voiceSendWait: 150_000_000)
        try await harness.coordinator.pressVoiceTurn(1)
        let openedTurn = await harness.coordinator.centralTextSnapshot().voiceTurn
        let operation = try XCTUnwrap(openedTurn.operationID)
        func status(_ value: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            try central(["operation": "voice_status", "operation_id": operation, "source_status": value]
                .merging(extra) { $1 })
        }
        await harness.realtime.emit(.centralText(try status("recording")))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        let recordingMedia = await media(harness)
        XCTAssertEqual(recordingMedia.microphone, .on)

        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        try await eventually("commit") { await self.operations(harness).contains("voice_commit") }
        await harness.realtime.emit(.centralText(try status("pending", ["event_id": "voice-source-event"])))
        try await eventually("window cut releases the microphone") { await self.media(harness).microphone == .off }
        try await eventually("candidates requested") { await self.operations(harness).contains("voice_candidates") }
        let digest = String(repeating: "a", count: 64)
        await harness.realtime.emit(.centralText(try status("candidates", ["candidates": [[
            "candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
            "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": "帮我记下明天早上八点骑行。", "transcript_sha256": digest]]])))
        let committed = try await release.value
        XCTAssertTrue(committed)
        let readyTurn = await harness.coordinator.centralTextSnapshot().voiceTurn
        let candidate = try XCTUnwrap(readyTurn.candidates.first)

        await harness.realtime.emit(.reconnecting)
        try await eventually("reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
        let send = Task { try await harness.coordinator.sendVoiceTurn(candidate) }
        let during = await operations(harness)
        XCTAssertFalse(during.contains("voice_send"), "the spoken request waits for the connection")
        await harness.realtime.emit(.reconnected)
        await harness.realtime.emit(.encryptionActive)
        try await send.value
        var turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(turn.phase, .unconfirmed)
        XCTAssertFalse(turn.isActive, "An unknown outcome is shown, not left spinning in sending")
        let released = try await harness.coordinator.centralTextSnapshot().canBeginSubmit
        XCTAssertTrue(released, "An unconfirmed turn is terminal: typing and voice stay available")
        var packets = await harness.realtime.centralPackets
        let sends = packets.filter { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["operation"] as? String == "voice_send" }
        XCTAssertEqual(sends.count, 2, "One bounded resend")
        XCTAssertEqual(Set(sends).count, 1, "The resend is the identical original packet")

        let retry = Task { try await harness.coordinator.retryVoiceSend() }
        try await eventually("retried") {
            await harness.realtime.centralPackets.filter { $0 == sends[0] }.count == 3
        }
        await harness.realtime.emit(.centralText(try central(["operation": "accepted", "event_id": "voice-source-event",
            "processed_event_id": "d:5ed299c64d2fea735e22c6da8e9250529a90a5eab1e1ae6b0cfd78d1ce66c3ee",
            "admission": ["state": "pending", "run_id": NSNull(),
                          "idempotency_key": "paios:7ffd89b1d082a1dbdd36d3d728e64d387304232b3c13c5789e71daf8b67c8211"]])))
        try await retry.value
        turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(turn.phase, .sent, "The D's admission proves the voice_send landed")
        packets = await harness.realtime.centralPackets
        XCTAssertEqual(packets.filter { $0 == sends[0] }.count, 3, "Never a new event or a fourth send")
    }

    /// Every start is a new source session. A voice turn still waiting on its send ends unconfirmed on its own line, and
    /// the next session takes typing and voice at once (never locked by the old request).
    func testSessionResetDuringVoiceSendEndsItUnconfirmedAndKeepsChatUsable() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.pressVoiceTurn(1)
        let opened = await harness.coordinator.centralTextSnapshot()
        let operation = try XCTUnwrap(opened.voiceTurn.operationID)
        func status(_ value: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            try central(["operation": "voice_status", "operation_id": operation, "source_status": value].merging(extra) { $1 })
        }
        await harness.realtime.emit(.centralText(try status("recording")))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        try await eventually("commit") { await self.operations(harness).contains("voice_commit") }
        await harness.realtime.emit(.centralText(try status("pending", ["event_id": "voice-source-event"])))
        let digest = String(repeating: "a", count: 64)
        try await eventually("candidates requested") { await self.operations(harness).contains("voice_candidates") }
        await harness.realtime.emit(.centralText(try status("candidates", ["candidates": [[
            "candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
            "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": "帮我记下明天早上八点骑行。", "transcript_sha256": digest]]])))
        _ = try await release.value
        let ready = await harness.coordinator.centralTextSnapshot()
        let candidate = try XCTUnwrap(ready.voiceTurn.candidates.first)
        let send = Task { try await harness.coordinator.sendVoiceTurn(candidate) }
        try await eventually("voice_send left") { await self.operations(harness).contains("voice_send") }

        _ = await harness.coordinator.stop()
        let old = Self.centralBinding
        let next = CentralTransportBinding(sessionID: "next-session", deviceID: old.deviceID, connectionEpoch: "2",
            expectedGatewayIdentity: old.expectedGatewayIdentity, maxPacketBytes: old.maxPacketBytes, deviceClass: old.deviceClass,
            callRejoinWindowS: old.callRejoinWindowS)
        await harness.bootstrap.setCentralBinding(next)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await send.value
        let consumer = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(consumer.voiceTurn.phase, .unconfirmed, "the old send is shown as unknown, never as failed")
        XCTAssertTrue(try consumer.canBeginSubmit)
        do { try await harness.coordinator.retryVoiceSend(); XCTFail("voice_send never moves to another session") }
        catch CentralTextError.unavailable { }
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "typed-after-reset", text: "帮我记下明天早上八点骑行。"))
        let typed = await sent(harness).last
        XCTAssertEqual(typed?["operation"] as? String, "submit")
        XCTAssertEqual(typed?["event_id"] as? String, "typed-after-reset")
        try await harness.coordinator.pressVoiceTurn(2)
        let reopened = await operations(harness)
        XCTAssertEqual(reopened.last, "voice_open", "push-to-talk opens a new window")
        _ = await harness.coordinator.stop()
    }

    /// Type, switch apps before the reply finishes, come back: the background stop ends the
    /// session and the start opens a new one. The old request ends there (admitted: delivered; otherwise unknown) and
    /// typing submits at once, with no decision to make first.
    func testBackgroundRestartIntoANewSessionNeverLocksTyping() async throws {
        for admitted in [false, true] {
            let harness = try await centralHarness()
            try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "typed-before-background", text: "明天早上八点提醒我骑行"))
            if admitted {
                await harness.realtime.emit(.centralText(try central(["operation": "accepted", "event_id": "typed-before-background",
                    "processed_event_id": "d:typed-before-background", "admission": ["state": "running", "run_id": "run-typed",
                    "idempotency_key": "paios:typed-before-background"]])))
                try await eventually("admitted") { await harness.coordinator.centralTextSnapshot().accepted != nil }
            }
            let held = try await harness.coordinator.centralTextSnapshot().canBeginSubmit
            XCTAssertTrue(held, "a reply in flight does not block network admission")

            _ = await harness.coordinator.stop()
            let old = Self.centralBinding
            await harness.bootstrap.setCentralBinding(CentralTransportBinding(sessionID: "next-session", deviceID: old.deviceID,
                connectionEpoch: "2", expectedGatewayIdentity: old.expectedGatewayIdentity, maxPacketBytes: old.maxPacketBytes,
                deviceClass: old.deviceClass, callRejoinWindowS: old.callRejoinWindowS))
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            let consumer = await harness.coordinator.centralTextSnapshot()
            XCTAssertEqual(consumer.submissionDelivery(eventID: "typed-before-background"), admitted ? .accepted : .unconfirmed)
            XCTAssertTrue(try consumer.canBeginSubmit)
            XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
            let before = await sent(harness).count
            try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "typed-after-restart", text: "明天早上八点提醒我骑行"))
            let after = await sent(harness)
            XCTAssertEqual(after.count, before + 1, "nothing from the old session is resent into the new one")
            XCTAssertEqual(after.last?["operation"] as? String, "submit")
            XCTAssertEqual(after.last?["event_id"] as? String, "typed-after-restart")
            _ = await harness.coordinator.stop()
        }
    }

    #if SWIFT_PACKAGE
    func testPlayedACKFailureStillPlaysNextSegmentAndRetriesIdenticalACK() async throws {
        let harness = try await centralHarness(formalVoice: true)
        let fixtures = FormalVoiceBoundaryTests()
        var fixture = try fixtures.values(), header = fixture["header"] as! [String: Any]
        header["voice_status"] = "pending"; header["pending_voice_chunk_count"] = 1
        fixture["header"] = header
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "voice-source-event", text: "原用户文字"))
        for body in [fixture["accepted"]!, fixture["header"]!] + (fixture["text_chunks"] as! [Any]) {
            await harness.realtime.emit(.centralText(try fixtures.packet(body)))
        }
        var chunks: [CentralVoicePlayback] = []
        defer { chunks.forEach { $0.resource.remove() } }
        for sequence in 1...3 {
            var envelope = fixture["voice"] as! [String: Any], chunk = envelope["chunk"] as! [String: Any]
            chunk["seq"] = sequence; chunk["final"] = false
            envelope["chunk"] = chunk; fixture["voice"] = envelope
            chunks.append(try await fixtures.playback(fixture))
        }
        let firstPlayed = expectation(description: "first segment started")
        await harness.realtime.setCentralVoicePlayObserver { count in if count == 1 { firstPlayed.fulfill() } }
        for chunk in chunks { await harness.realtime.emit(.centralVoice(chunk)) }
        await fulfillment(of: [firstPlayed], timeout: 2)
        let secondPlayed = expectation(description: "ACK failure cannot block second segment")
        await harness.realtime.setCentralVoicePlayObserver { count in if count == 2 { secondPlayed.fulfill() } }
        await harness.realtime.refuseCentral("ack", times: 1)
        await harness.realtime.emit(.centralVoiceFinished(chunks[0], true))
        await fulfillment(of: [secondPlayed], timeout: 2)
        let failedPackets = await harness.realtime.refusedCentralPackets
        let originalACK = try XCTUnwrap(failedPackets.first)
        let afterFailure = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(afterFailure.pendingRenderedACKs, [originalACK])
        try await harness.coordinator.retryCentralRenderedACK()
        let sentPackets = await harness.realtime.centralPackets
        XCTAssertTrue(sentPackets.contains(originalACK), "same bytes, timestamp and watermark must be retried")
        let ackBody = try XCTUnwrap(JSONSerialization.jsonObject(with: originalACK) as? [String: Any])
        XCTAssertEqual((ackBody["ack"] as? [String: Any])?["highest_contiguous_seq"] as? Int, 1)
        _ = await harness.coordinator.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: chunks[2].resource.file.path), "stop releases the queued WAV")
    }

    #endif

    func testOldReleaseCannotCommitReplacementWindowAfterTailBarrier() async throws {
        let tail = StopGate()
        let harness = await Harness.make(canPublishData: true, voiceTurnSleep: { nanos in
            if nanos == 300_000_000 { await tail.markEntered(); await tail.waitForRelease() }
            else { try Task.checkCancellation(); await Task.yield() }
        })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.pressVoiceTurn(1)
        let originalValue = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        let original = try XCTUnwrap(originalValue)
        let recording = expectation(description: "original recording")
        await harness.coordinator.setCentralTextObserver { consumer in
            if consumer.voiceTurn.operationID == original, consumer.voiceTurn.phase == .recording { recording.fulfill() }
        }
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": original, "source_status": "recording"])))
        await fulfillment(of: [recording], timeout: 2)
        await harness.coordinator.setCentralTextObserver(nil)
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        await tail.waitUntilEntered()
        // A second press must not own or close the first press's window when open is refused.
        do { try await harness.coordinator.pressVoiceTurn(2); XCTFail("active turn must reject another press") } catch {}
        let afterRejectedPress = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(afterRejectedPress.operationID, original, "rejected press leaves the existing window intact")
        // Explicit close permits a third press; the old tail is deliberately cancellation-insensitive.
        try await harness.coordinator.closeVoiceTurn()
        try await harness.coordinator.pressVoiceTurn(3)
        let replacementValue = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        let replacement = try XCTUnwrap(replacementValue)
        let nextRecording = expectation(description: "replacement recording")
        await harness.coordinator.setCentralTextObserver { consumer in
            if consumer.voiceTurn.operationID == replacement, consumer.voiceTurn.phase == .recording { nextRecording.fulfill() }
        }
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": replacement, "source_status": "recording"])))
        await fulfillment(of: [nextRecording], timeout: 2)
        await harness.coordinator.setCentralTextObserver(nil)
        await tail.release()
        // An old task must finish without waiting for or timing out the new turn.
        release.cancel()
        _ = try? await release.value
        let current = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(current.operationID, replacement)
        XCTAssertEqual(current.phase, .recording)
        let packets = await sent(harness)
        XCTAssertFalse(packets.contains { ($0["operation"] as? String) == "voice_commit" && ($0["operation_id"] as? String) == replacement })
        XCTAssertFalse(packets.contains { ($0["operation"] as? String) == "voice_close" && ($0["operation_id"] as? String) == replacement })
        let held = await harness.coordinator.presentationSnapshot().media.microphone
        XCTAssertEqual(held, .on, "old cleanup cannot release the new press's microphone")
        _ = try await harness.coordinator.releaseVoiceTurn(3, cancel: true)
        _ = await harness.coordinator.stop()
    }

    func testCancelledReleaseClosesOnlyItsOriginalWindow() async throws {
        let tail = StopGate()
        let harness = await Harness.make(canPublishData: true, voiceTurnSleep: { nanos in
            if nanos == 300_000_000 { await tail.markEntered(); await tail.waitForRelease() }
            else { try Task.checkCancellation(); await Task.yield() }
        })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.pressVoiceTurn(1)
        let operation = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        let recording = expectation(description: "recording")
        await harness.coordinator.setCentralTextObserver { consumer in
            if consumer.voiceTurn.phase == .recording { recording.fulfill() }
        }
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": try XCTUnwrap(operation), "source_status": "recording"])))
        await fulfillment(of: [recording], timeout: 2)
        await harness.coordinator.setCentralTextObserver(nil)
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        await tail.waitUntilEntered()
        release.cancel()
        await tail.release()
        _ = try? await release.value
        let packets = await sent(harness)
        XCTAssertTrue(packets.contains { ($0["operation"] as? String) == "voice_close" && ($0["operation_id"] as? String) == operation },
            "cancelling the completion still closes its own central recording window")
        XCTAssertFalse(packets.contains { ($0["operation"] as? String) == "voice_commit" })
        _ = await harness.coordinator.stop()
    }

    func testOldOpeningTimeoutCannotExpireReplacementWindow() async throws {
        let opening = StopGate()
        let harness = await Harness.make(canPublishData: true, voiceTurnSleep: { nanos in
            if nanos == 50_000_000 { await opening.markEntered(); await opening.waitForRelease() }
            else { await Task.yield() }
        })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.pressVoiceTurn(1)
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        await opening.waitUntilEntered()
        try await harness.coordinator.closeVoiceTurn()
        try await harness.coordinator.pressVoiceTurn(2)
        let operation = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        await opening.release()
        _ = try? await release.value
        let current = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(current.operationID, operation)
        XCTAssertEqual(current.phase, .opening, "old bounded open wait cannot expire the new window")
        let packets = await sent(harness)
        XCTAssertFalse(packets.contains { ($0["operation"] as? String) == "voice_close" && ($0["operation_id"] as? String) == operation })
        let held = await harness.coordinator.presentationSnapshot().media.microphone
        XCTAssertEqual(held, .on)
        _ = try await harness.coordinator.releaseVoiceTurn(2, cancel: true)
        _ = await harness.coordinator.stop()
    }

    func testOldCommitPublisherFailureCannotExpireNewSessionWindow() async throws {
        let publication = StopGate()
        let harness = await Harness.make(canPublishData: true, voiceTurnSleep: { _ in await Task.yield() })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.pressVoiceTurn(1)
        let originalValue = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        let original = try XCTUnwrap(originalValue)
        let recording = expectation(description: "original recording")
        await harness.coordinator.setCentralTextObserver { consumer in
            if consumer.voiceTurn.operationID == original, consumer.voiceTurn.phase == .recording { recording.fulfill() }
        }
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": original, "source_status": "recording"])))
        await fulfillment(of: [recording], timeout: 2)
        await harness.coordinator.setCentralTextObserver(nil)
        await harness.realtime.failNextCentralSend()
        await harness.realtime.setCentralPublishGate(publication, operation: "voice_commit")
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        await publication.waitUntilEntered()
        _ = await harness.coordinator.stop()
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.pressVoiceTurn(2)
        let replacementValue = await harness.coordinator.centralTextSnapshot().voiceTurn.operationID
        let replacement = try XCTUnwrap(replacementValue)
        await publication.release()
        _ = try? await release.value
        let current = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(current.operationID, replacement)
        XCTAssertEqual(current.phase, .opening, "late old publish failure must not expire the replacement")
        let packets = await sent(harness)
        XCTAssertFalse(packets.contains { ($0["operation"] as? String) == "voice_close" && ($0["operation_id"] as? String) == replacement })
        let held = await harness.coordinator.presentationSnapshot().media.microphone
        XCTAssertEqual(held, .on)
        _ = try await harness.coordinator.releaseVoiceTurn(2, cancel: true)
        _ = await harness.coordinator.stop()
    }

    /// M4 (A6): outside a call the microphone track exists only while a press holds it. The press publishes it before
    /// the window opens, the tail of a release is captured before it closes, and the next press republishes it.
    func testHoldToTalkPublishesBeforeOpeningAndUnpublishesOnceTheWindowIsCut() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        func voiceOps() async -> [String] { await operations(harness).filter { $0.hasPrefix("voice_") } }
        func status(_ value: String, _ extra: [String: Any] = [:]) async throws -> CentralTextPacket {
            let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
            let operation = try XCTUnwrap(turn.operationID)
            return try central(["operation": "voice_status", "operation_id": operation, "source_status": value].merging(extra) { $1 })
        }
        await harness.realtime.setMediaPublishGate(gate, source: .microphone)
        let press = Task { try await harness.coordinator.pressVoiceTurn(1) }
        await gate.waitUntilEntered()
        var ops = await voiceOps()
        XCTAssertEqual(ops, [], "No window opens before the microphone is published")
        await gate.release()
        try await press.value
        ops = await voiceOps()
        var events = await harness.realtime.mediaEvents
        XCTAssertEqual(ops, ["voice_open"]); XCTAssertEqual(events, ["microphone:on"])
        await harness.realtime.emit(.centralText(try await status("recording")))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }

        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        try await eventually("commit") { await voiceOps().contains("voice_commit") }
        events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on"], "The tail frames are still captured until central cuts the window")
        await harness.realtime.emit(.centralText(try await status("pending", ["event_id": "voice-source-event"])))
        try await eventually("cut window unpublishes") { await harness.realtime.mediaEvents == ["microphone:on", "microphone:off"] }
        let released = await media(harness)
        XCTAssertEqual(released.microphone, .off)
        let digest = String(repeating: "a", count: 64)
        await harness.realtime.emit(.centralText(try await status("candidates", ["candidates": [[
            "candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
            "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": "明天八点提醒我。", "transcript_sha256": digest]]])))
        let committed = try await release.value
        XCTAssertTrue(committed)

        try await harness.coordinator.pressVoiceTurn(2)
        events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "microphone:off", "microphone:on"], "The next press republishes")
        ops = await voiceOps()
        XCTAssertEqual(ops.last, "voice_open")
        _ = await harness.coordinator.stop()
    }

    /// Regression: after `pending` the coordinator drops the hold-to-talk microphone, and the first
    /// poll after it is the turn's only way forward. A poll the transport refuses must not end the turn silently: the
    /// poll is retried, the transcript arrives and the turn reaches `ready`.
    func testARefusedCandidatesPollIsRetriedAndTheTurnReachesItsTranscript() async throws {
        let harness = try await centralHarness()
        func voiceOps() async -> [String] { await operations(harness).filter { $0.hasPrefix("voice_") } }
        func status(_ value: String, _ extra: [String: Any] = [:]) async throws -> CentralTextPacket {
            let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
            let operation = try XCTUnwrap(turn.operationID)
            return try central(["operation": "voice_status", "operation_id": operation, "source_status": value].merging(extra) { $1 })
        }
        try await harness.coordinator.pressVoiceTurn(1)
        await harness.realtime.emit(.centralText(try await status("recording")))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        try await eventually("commit") { await voiceOps().contains("voice_commit") }
        await harness.realtime.refuseCentral("voice_candidates", times: 1)
        await harness.realtime.emit(.centralText(try await status("pending", ["event_id": "voice-source-event"])))
        try await eventually("cut window unpublishes") { await harness.realtime.mediaEvents.last == "microphone:off" }
        for _ in 0..<300 where !(await voiceOps().contains("voice_candidates")) { try await Task.sleep(nanoseconds: 10_000_000) }
        let polled = await voiceOps()
        XCTAssertTrue(polled.contains("voice_candidates"), "the poll is retried after a refused publish: \(polled)")
        let digest = String(repeating: "a", count: 64)
        await harness.realtime.emit(.centralText(try await status("candidates", ["candidates": [[
            "candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
            "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": "一百二十三加四百五十六等于多少", "transcript_sha256": digest]]])))
        let committed = try? await release.value
        let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(committed, true)
        XCTAssertEqual(turn.phase, .ready, "the turn reaches its transcript instead of hanging in \(turn.phase)")
        _ = await harness.coordinator.stop()
    }

    /// Any other end of the wait (here: the commit itself cannot be sent) settles the turn as failed with a reason the
    /// UI shows, closes the window, and frees the button: the next press opens a new window.
    func testAnUnsentCommitFailsTheTurnVisiblyAndTheNextPressWorks() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.pressVoiceTurn(1)
        let opened = await harness.coordinator.centralTextSnapshot().voiceTurn
        let operation = try XCTUnwrap(opened.operationID)
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": operation, "source_status": "recording"])))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        await harness.realtime.refuseCentral("voice_commit", times: 1)
        do { _ = try await harness.coordinator.releaseVoiceTurn(1, cancel: false); XCTFail("the unsent commit is reported") } catch {}
        let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(turn.phase, .failed, "an unsent commit must not leave the turn waiting")
        XCTAssertNotNil(turn.unsentOutcome)
        try await eventually("microphone released") { await harness.realtime.mediaEvents.last == "microphone:off" }
        try await harness.coordinator.pressVoiceTurn(2)
        let opens = await operations(harness).filter { $0 == "voice_open" }
        XCTAssertEqual(opens.count, 2, "the next press opens a new window")
        _ = await harness.coordinator.stop()
    }

    /// A window that heard nothing ends as 「没听清」 in Core (one rule for every app) and central's window is closed.
    func testAnEmptyTranscriptEndsTheTurnAsNoSpeechAndClosesTheWindow() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.pressVoiceTurn(1)
        let opened = await harness.coordinator.centralTextSnapshot().voiceTurn
        let operation = try XCTUnwrap(opened.operationID)
        func status(_ value: String, _ extra: [String: Any] = [:]) throws -> CentralTextPacket {
            try central(["operation": "voice_status", "operation_id": operation, "source_status": value].merging(extra) { $1 })
        }
        await harness.realtime.emit(.centralText(try status("recording")))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        let release = Task { try await harness.coordinator.releaseVoiceTurn(1, cancel: false) }
        try await eventually("commit") { await self.operations(harness).contains("voice_commit") }
        await harness.realtime.emit(.centralText(try status("pending", ["event_id": "voice-source-event"])))
        try await eventually("poll") { await self.operations(harness).contains("voice_candidates") }
        let digest = String(repeating: "a", count: 64)
        await harness.realtime.emit(.centralText(try status("candidates", ["candidates": [[
            "candidate_ref": "voice-candidate:one", "candidate_revision": digest, "window_ref": "voice-window:one",
            "selected_input_sha256": digest, "authorization": "unknown", "kind": "transcript",
            "transcript": " ", "transcript_sha256": digest]]])))
        _ = try await release.value
        try await eventually("window closed") { await self.operations(harness).contains("voice_close") }
        let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        XCTAssertEqual(turn.phase, .failed)
        XCTAssertEqual(turn.unsentOutcome, "没听清，请按住再说一次")
        _ = await harness.coordinator.stop()
    }

    /// A cancelled or unopened press unpublishes too; after a room replacement the next press publishes on the new room.
    func testCancelledPressUnpublishesAndThePressAfterAReconnectRepublishes() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.pressVoiceTurn(1)
        let turn = await harness.coordinator.centralTextSnapshot().voiceTurn
        let operation = try XCTUnwrap(turn.operationID)
        await harness.realtime.emit(.centralText(try central(["operation": "voice_status", "operation_id": operation,
            "source_status": "recording"])))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().voiceTurn.phase == .recording }
        let committed = try await harness.coordinator.releaseVoiceTurn(1, cancel: true)
        XCTAssertFalse(committed)
        try await eventually("cancel unpublishes") { await harness.realtime.mediaEvents == ["microphone:on", "microphone:off"] }
        let ops = await operations(harness)
        XCTAssertTrue(ops.contains("voice_close"))

        await harness.realtime.emit(.disconnected(errorCode: "network"))
        try await eventually("replacement room") { await harness.realtime.connectCount == 2 }
        try await eventually("replacement active") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
        var events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "microphone:off"], "A reconnect does not republish a released microphone")
        try await harness.coordinator.pressVoiceTurn(2)
        events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "microphone:off", "microphone:on"])
        _ = try await harness.coordinator.releaseVoiceTurn(2, cancel: true)
        try await eventually("unpublished again") { await harness.realtime.mediaEvents.last == "microphone:off" }
        _ = await harness.coordinator.stop()
    }

    /// 随身模式 keeps its published microphone through a press; a call's 静音 mutes and only the hang-up unpublishes.
    func testCompanionKeepsTheTrackAndACallMutesUntilHangUp() async throws {
        let companion = try await centralHarness()
        try await companion.coordinator.setAmbient(true)
        try await companion.coordinator.pressVoiceTurn(1)
        _ = try await companion.coordinator.releaseVoiceTurn(1, cancel: true)
        let kept = await media(companion), ambientEvents = await companion.realtime.mediaEvents
        XCTAssertEqual(kept.microphone, .on); XCTAssertEqual(ambientEvents, ["microphone:on"])
        _ = await companion.coordinator.stop()

        for remote in [false, true] {
            let harness = try await centralHarness()
            try await harness.coordinator.startCall(video: false)
            let opened = await harness.coordinator.centralTextSnapshot().call
            let id = try XCTUnwrap(opened.id)
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "live"])))
            await harness.coordinator.releaseMedia(.microphone, for: .call)
            var events = await harness.realtime.mediaEvents
            XCTAssertEqual(events, ["microphone:on", "microphone:mute"])
            if remote { await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id, "state": "closed"]))) }
            else { try await harness.coordinator.endCall() }
            try await eventually("ended call unpublishes its muted track") {
                await harness.realtime.mediaEvents == ["microphone:on", "microphone:mute", "microphone:off"]
            }
            events = await harness.realtime.mediaEvents
            let after = await media(harness)
            XCTAssertEqual(after.microphone, .off, "remote=\(remote) events=\(events)")
            _ = await harness.coordinator.stop()
        }
    }

    func testNetworkUnavailableRetainsCallAndContinuousMicrophone() async throws {
        for ambient in [false, true] {
            let harness = try await centralHarness()
            if ambient { try await harness.coordinator.setAmbient(true) }
            else { try await harness.coordinator.startCall(video: false) }
            let before = await harness.realtime.mediaEvents
            let callID = await harness.coordinator.centralTextSnapshot().call.id
            let lifecycle = await retainedLifecycle(harness.coordinator)
            let path = AssistantNetworkPathState(status: .unsatisfied, isExpensive: false,
                isConstrained: false, usesWiFi: true, usesCellular: false)
            await harness.coordinator.handleLifecycleSignal(.networkPath(path))
            await lifecycle.handle(.networkPath(path))
            let lifecycleState = await lifecycle.snapshot()
            XCTAssertEqual(lifecycleState, .running)
            await harness.realtime.emit(.reconnecting)
            try await eventually("recoverable reconnect") { await harness.coordinator.snapshot() == .reconnecting }
            let during = await media(harness), retainedID = await harness.coordinator.centralTextSnapshot().call.id
            XCTAssertEqual(during.microphone, .on); XCTAssertEqual(retainedID, callID)
            await harness.realtime.emit(.reconnected); await harness.realtime.emit(.encryptionActive)
            try await eventually("recovered") { await harness.coordinator.snapshot() == .active(encryptionActive: true) }
            let after = await harness.realtime.mediaEvents, stops = await harness.realtime.stopCount
            XCTAssertEqual(after, before); XCTAssertEqual(stops, 0)
            let requests = await sent(harness)
            XCTAssertFalse(requests.contains { $0["operation"] as? String == "call_close" })
            _ = await harness.coordinator.stop()
        }
    }

    func testMutePresentationUsesConfirmedMediaPhasesAndApprovedVoiceOver() {
        let phases: [AssistantMediaPhase] = [.closing, .unknown, .off, .opening, .on]
        let expected: [AssistantCallMuteState] = [.muting, .failed, .confirmed, .unmuting, .unmuted]
        let states = phases.map(AssistantCallMuteState.init)
        XCTAssertEqual(states, expected)
        XCTAssertEqual(states.map(\.statusText), ["正在静音", "静音未确认", "已静音", "正在取消静音", "麦克风已开"])
        XCTAssertEqual(states.map(\.actionText), ["正在静音", "重试静音", "取消静音", "正在取消静音", "静音"])
        XCTAssertEqual(states.map(\.announcementText), [
            "正在静音，请稍候。",
            "静音未确认。你仍可能被听到。重试静音，或结束通话。",
            "已静音。按钮，取消静音。",
            "正在取消静音，请稍候。",
            "麦克风已开。"
        ])
    }

    func testMuteShowsPendingThenFailedAndRetriesBeforeConfirmedUnmute() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        try await harness.coordinator.startCall(video: false)
        await harness.realtime.setMediaDisableGate(gate)
        await harness.realtime.failNextDisables(1)
        let mute = Task { await harness.coordinator.releaseMedia(.microphone, for: .call) }
        await gate.waitUntilEntered()
        let pending = await media(harness)
        XCTAssertEqual(AssistantCallMuteState(pending.microphone), .muting)
        await gate.release()
        let failed = await mute.value
        XCTAssertFalse(failed)
        let unknown = await media(harness)
        XCTAssertEqual(AssistantCallMuteState(unknown.microphone), .failed)
        await harness.realtime.setMediaDisableGate(nil)
        let retried = await harness.coordinator.releaseMedia(.microphone, for: .call)
        XCTAssertTrue(retried)
        let confirmed = await media(harness)
        XCTAssertEqual(AssistantCallMuteState(confirmed.microphone), .confirmed)
        let unmuteGate = StopGate()
        await harness.realtime.setMediaPublishGate(unmuteGate, source: .microphone)
        let unmute = Task { try await harness.coordinator.acquireMedia(.microphone, for: .call) }
        await unmuteGate.waitUntilEntered()
        let opening = await media(harness)
        XCTAssertEqual(AssistantCallMuteState(opening.microphone), .unmuting)
        XCTAssertNotEqual(AssistantCallMuteState(opening.microphone), .unmuted)
        await unmuteGate.release()
        try await unmute.value
        let unmuted = await media(harness)
        XCTAssertEqual(AssistantCallMuteState(unmuted.microphone), .unmuted)
        try await harness.coordinator.endCall()
        _ = await harness.coordinator.stop()
    }

    /// H-01: a mute during a reconnect reaches the transport; a failed unpublish is reconciled after the reconnect.
    func testAMuteDuringReconnectIsAppliedAndReconciledAfterwards() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        await harness.realtime.emit(.reconnecting)
        try await eventually("reconnecting") { await harness.coordinator.snapshot() == .reconnecting }
        await harness.realtime.failNextDisables(1)
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        let during = await media(harness)
        XCTAssertEqual(during.microphone, .unknown, "An unconfirmed unpublish is not shown as off")
        await harness.realtime.emit(.reconnected)
        await harness.realtime.emit(.encryptionActive)
        try await eventually("reconciled") { await self.media(harness).microphone == .off }
        let events = await harness.realtime.mediaEvents
        XCTAssertEqual(events, ["microphone:on", "microphone:mute!", "microphone:mute"])
    }

    /// 随身模式: a standing choice every running session applies. It keeps capturing in the background, pauses with a
    /// call's 静音, comes back on unmute and hang-up, and turning it off releases the microphone.
    func testFirstAmbientTapConnectsAndCapturesWithoutSecondTap() async throws {
        let harness = await Harness.make(canPublishData: true)
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.setAmbient(true, startIntent: AssistantStartIntent(userInitiated: true))
        let current = await media(harness)
        let count = await harness.bootstrap.bootstrapCount
        XCTAssertEqual(count, 1)
        XCTAssertEqual(current.ambient, .on)
        XCTAssertEqual(current.microphone, .on)
    }

    func testAmbientHoldsTheMicrophoneAcrossBackgroundAndCallMute() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true)
        var current = await media(harness)
        XCTAssertEqual(current.microphone, .on); XCTAssertEqual(current.ambient, .on)
        let backgroundKept = await harness.coordinator.retainsSession(for: "app_background")
        let interruptionKept = await harness.coordinator.retainsSession(for: "audio_interruption")
        XCTAssertTrue(backgroundKept); XCTAssertFalse(interruptionKept)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        current = await media(harness)
        XCTAssertEqual(current.microphone, .on, "随身模式 keeps capturing in the background")
        let state = await harness.coordinator.snapshot()
        XCTAssertEqual(state, .active(encryptionActive: true))
        try await harness.coordinator.startCall(video: false)
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        try await eventually("muted") { await self.media(harness).microphone == .off }
        current = await media(harness)
        XCTAssertEqual(current.ambient, .paused, "静音 silences the ambient hold too")
        try await harness.coordinator.acquireMedia(.microphone, for: .call)
        current = await media(harness)
        XCTAssertEqual(current.ambient, .on)
        try await harness.coordinator.endCall()
        current = await media(harness)
        XCTAssertEqual(current.microphone, .on, "hanging up keeps 随身模式")
        try await harness.coordinator.setAmbient(false)
        try await eventually("released") { await self.media(harness).microphone == .off }
        current = await media(harness)
        XCTAssertEqual(current.ambient, .off)
    }

    func testBackgroundMutedCallHangupResumesExistingAmbientCaptureWithoutServerState() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true)
        try await harness.coordinator.startCall(video: false)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        await harness.coordinator.releaseMedia(.microphone, for: .call)
        try await harness.coordinator.endCall()
        let resumed = expectation(description: "ambient microphone publication reconciled")
        resumed.assertForOverFulfill = false
        await harness.coordinator.setObserver { snapshot in
            if snapshot.media.microphone == .on, snapshot.media.ambient == .on { resumed.fulfill() }
        }
        await fulfillment(of: [resumed], timeout: 2)
        let current = await media(harness)
        XCTAssertEqual(current.microphone, .on); XCTAssertEqual(current.ambient, .on)
        try await harness.coordinator.setAmbient(false)
        _ = await harness.coordinator.stop()
    }

    func testServerAmbientCallReusesMicAndEndReturnsToListening() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": "ambient-1", "state": "live", "mode": "ambient"])))
        try await eventually("ambient call") { await harness.coordinator.centralTextSnapshot().call.isActive }
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(call.id, "ambient-1")
        XCTAssertTrue(call.isAmbient)
        let opened = await operations(harness)
        XCTAssertFalse(opened.contains("call_open"))
        try await harness.coordinator.endCall()
        let after = await media(harness)
        XCTAssertEqual(after.microphone, .on)
        XCTAssertEqual(after.ambient, .on)
        let closed = await operations(harness)
        XCTAssertTrue(closed.contains("call_close"))
    }

    func testCentralLocationRequestDoesNotBlockEventsAndRevocationRepliesNull() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        harness.coordinator.setLocationConsent(true)
        await MainActor.run { harness.location.oneShotGate = gate }
        await harness.realtime.emit(.centralText(try central(["operation": "location_request", "request_id": "care:1"])))
        await gate.waitUntilEntered()
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": "ambient-location", "state": "live", "mode": "ambient"])))
        try await eventually("call event consumed while GPS waits") { await harness.coordinator.centralTextSnapshot().call.isActive }
        harness.coordinator.setLocationConsent(false)
        await gate.release()
        try await eventually("correlated location loss") { await self.sent(harness).contains { $0["request_id"] as? String == "care:1" } }
        let replies = await sent(harness)
        let reply = try XCTUnwrap(replies.first { $0["request_id"] as? String == "care:1" })
        XCTAssertTrue(reply["location"] is NSNull)
        let authorizations = await MainActor.run { harness.location.authorizationCount }
        XCTAssertEqual(authorizations, 0, "Central requests never ask permission")
        _ = await harness.coordinator.stop()
    }

    func testCentralLocationRequestSaysWhyThereIsNoFix() async throws {
        let cases: [(AssistantPermissionStatus, Bool, Error?, String)] = [
            (.authorized, false, nil, "sharing_off"), (.denied, true, nil, "permission_denied"),
            (.restricted, true, nil, "permission_restricted"), (.notDetermined, true, nil, "permission_not_determined"),
            (.authorized, true, CLError(.network), "network"), (.authorized, true, CLError(.locationUnknown), "location_unknown"),
            (.authorized, true, AssistantLocationError.unavailable(.timeout), "timeout"),
            (.authorized, true, AssistantLocationError.unavailable(.reducedAccuracy), "reduced_accuracy")]
        for (index, (status, consent, failure, expected)) in cases.enumerated() {
            let harness = try await centralHarness(), id = "care:why\(index)"
            harness.coordinator.setLocationConsent(consent)
            await MainActor.run { harness.location.status = status; harness.location.oneShotError = failure; harness.location.cachedAge = 240_000 }
            await harness.realtime.emit(.centralText(try central(["operation": "location_request", "request_id": id])))
            try await eventually("reply \(id)") { await self.sent(harness).contains { $0["request_id"] as? String == id } }
            let replies = await sent(harness)
            let reply = try XCTUnwrap(replies.first { $0["request_id"] as? String == id })
            XCTAssertTrue(reply["location"] is NSNull)
            XCTAssertEqual(reply["unavailable_reason"] as? String, expected)
            if consent { XCTAssertEqual(reply["cached_fix_age_ms"] as? Int, 240_000) }
            else { XCTAssertTrue(reply["cached_fix_age_ms"] is NSNull) }
            _ = await harness.coordinator.stop()
        }
    }

    func testCentralLocationRequestWithAFixCarriesNoReason() async throws {
        let harness = try await centralHarness()
        harness.coordinator.setLocationConsent(true)
        await harness.realtime.emit(.centralText(try central(["operation": "location_request", "request_id": "care:fix"])))
        try await eventually("fix reply") { await self.sent(harness).contains { $0["request_id"] as? String == "care:fix" } }
        let replies = await sent(harness)
        let reply = try XCTUnwrap(replies.first { $0["request_id"] as? String == "care:fix" })
        XCTAssertFalse(reply["location"] is NSNull)
        XCTAssertNil(reply["unavailable_reason"])
        _ = await harness.coordinator.stop()
    }

    func testCentralLocationRequestDropsRetiredSessionAndReturnsNullWithoutConsent() async throws {
        let harness = try await centralHarness()
        await harness.realtime.emit(.centralText(try central(["operation": "location_request", "request_id": "care:denied"])))
        try await eventually("denied reply") { await self.sent(harness).contains { $0["request_id"] as? String == "care:denied" } }
        let denied = await sent(harness)
        XCTAssertTrue(denied.last?["location"] is NSNull)
        let requests = await MainActor.run { harness.location.requestCount }
        XCTAssertEqual(requests, 0)
        let gate = StopGate()
        harness.coordinator.setLocationConsent(true)
        await MainActor.run { harness.location.oneShotGate = gate }
        await harness.realtime.emit(.centralText(try central(["operation": "location_request", "request_id": "care:retired"])))
        await gate.waitUntilEntered()
        _ = await harness.coordinator.stop()
        await gate.release()
        for _ in 0..<20 { await Task.yield() }
        let replies = await sent(harness)
        XCTAssertFalse(replies.contains { $0["request_id"] as? String == "care:retired" })
    }

    func testVoiceIdentityWaitsForBiometricsAndRechecksPendingPrompt() async throws {
        for removedDuringAuthentication in [false, true] {
            let gate = StopGate(), id = String(repeating: "c", count: 64)
            let harness = try await centralHarness(authenticateVoiceIdentity: { await gate.markEntered(); await gate.waitForRelease() })
            let prompt: [String: Any] = ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 60_000, "text": "帮我叫车"]
            await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": [prompt]])))
            try await eventually("identity prompt") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.count == 1 }
            let confirming = Task { try await harness.coordinator.confirmVoice(id) }
            await gate.waitUntilEntered()
            let before = await operations(harness)
            XCTAssertFalse(before.contains("voice_confirm"), "no request before biometric success")
            let initialDeadline = await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.first?.deadline
            if removedDuringAuthentication {
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": []])))
                try await eventually("prompt removed") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.isEmpty }
            } else {
                var refreshed = prompt; refreshed["expires_in_ms"] = 59_000
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": [refreshed]])))
                try await eventually("same identity prompt refreshed") {
                    let deadline = await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.first?.deadline
                    return deadline != nil && deadline != initialDeadline
                }
            }
            await gate.release()
            if removedDuringAuthentication {
                do { try await confirming.value; XCTFail("a removed prompt cannot be confirmed") }
                catch { XCTAssertEqual(error as? CentralTextError, .unavailable) }
                let after = await operations(harness); XCTAssertFalse(after.contains("voice_confirm"))
            } else {
                try await eventually("authenticated request") { await self.operations(harness).contains("voice_confirm") }
                let request = await sent(harness).last { $0["operation"] as? String == "voice_confirm" }
                XCTAssertEqual(request?["auth"] as? String, "face_id")
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": []])))
                try await eventually("snapshot removed card") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.isEmpty }
                let unacknowledged = await harness.coordinator.centralTextSnapshot().ownerVoice
                XCTAssertNotNil(unacknowledged.confirming[id], "snapshot removal cannot settle the awaiting coordinator")
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": "approve"])))
                try await confirming.value
            }
            _ = await harness.coordinator.stop()
        }
    }

    func testMacTouchIDConfirmsOnlyAfterSuccessAndRetainsPromptOnFailureOrUnavailable() async throws {
        for failure in [nil, "VOICE_CONFIRMATION_TOUCH_ID_FAILED", "VOICE_CONFIRMATION_TOUCH_ID_UNAVAILABLE"] as [String?] {
            let gate = StopGate(), id = String(repeating: "d", count: 64)
            let harness = try await centralHarness(voiceIdentityAuth: "touch_id", deviceClass: "mac", authenticateVoiceIdentity: {
                await gate.markEntered(); await gate.waitForRelease()
                if let failure { throw CentralVoiceprintFailure(code: failure) }
            })
            let prompt: [String: Any] = ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 60_000, "text": "整理这份文件"]
            await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": [prompt]])))
            try await eventually("Mac identity card") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.count == 1 }
            let confirming = Task { try await harness.coordinator.confirmVoice(id) }
            await gate.waitUntilEntered()
            let before = await operations(harness)
            XCTAssertFalse(before.contains("voice_confirm"), "Touch ID must complete before a request is sent")
            await gate.release()
            if let failure {
                do { try await confirming.value; XCTFail("failed or unavailable Touch ID cannot confirm identity") }
                catch { XCTAssertEqual((error as? CentralVoiceprintFailure)?.code, failure) }
                let refused = await operations(harness)
                XCTAssertFalse(refused.contains("voice_confirm"))
                let retained = await harness.coordinator.centralTextSnapshot().ownerVoice
                XCTAssertEqual(retained.confirmations.map(\.id), [id]); XCTAssertTrue(retained.confirming.isEmpty)
            } else {
                try await eventually("Touch ID confirmation request") { await self.operations(harness).contains("voice_confirm") }
                let request = await sent(harness).last { $0["operation"] as? String == "voice_confirm" }
                XCTAssertEqual(request?["confirmation_id"] as? String, id)
                XCTAssertEqual(request?["auth"] as? String, "touch_id"); XCTAssertNil(request?["choice"])
                let waiting = await harness.coordinator.centralTextSnapshot().ownerVoice
                XCTAssertEqual(waiting.confirmations.map(\.id), [id]); XCTAssertNotNil(waiting.confirming[id])
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": []])))
                await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": "approve"])))
                try await confirming.value
            }
            _ = await harness.coordinator.stop()
        }
    }

    func testVoiceIdentityBiometricRefusalSendsNothingAndNativeApprovalsBypassIt() async throws {
        for code in ["VOICE_CONFIRMATION_FACE_ID_FAILED", "VOICE_CONFIRMATION_FACE_ID_UNAVAILABLE"] {
            let harness = try await centralHarness(authenticateVoiceIdentity: { throw CentralVoiceprintFailure(code: code) })
            let id = String(repeating: "a", count: 64)
            let prompt: [String: Any] = ["confirmation_id": id, "event_id": "voice-confirm:" + id, "expires_in_ms": 60_000, "text": "帮我叫车"]
            await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": [prompt]])))
            try await eventually("identity prompt") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.count == 1 }
            do { try await harness.coordinator.confirmVoice(id); XCTFail("biometric refusal must fail") }
            catch { XCTAssertEqual((error as? CentralVoiceprintFailure)?.code, code) }
            let refused = await operations(harness); XCTAssertFalse(refused.contains("voice_confirm"))
            let retained = await harness.coordinator.centralTextSnapshot().ownerVoice
            XCTAssertEqual(retained.confirmations.count, 1); XCTAssertTrue(retained.confirming.isEmpty)
            var approval = prompt; approval["kind"] = "native_approval"
            await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmations", "confirmations": [approval]])))
            try await eventually("native approval") { await harness.coordinator.centralTextSnapshot().ownerVoice.confirmations.first?.isNativeApproval == true }
            let deciding = Task { try await harness.coordinator.confirmVoice(id, choice: .deny) }
            try await eventually("native request") { await self.operations(harness).contains("voice_confirm") }
            let request = await sent(harness).last { $0["operation"] as? String == "voice_confirm" }
            XCTAssertEqual(request?["choice"] as? String, "deny"); XCTAssertNil(request?["auth"])
            await harness.realtime.emit(.centralText(try central(["operation": "voice_confirmation_decided", "confirmation_id": id, "choice": "deny"])))
            try await deciding.value
            _ = await harness.coordinator.stop()
        }
    }

    /// APP-03: leaving enrollment while permission is pending withdraws its microphone intent.
    func testCancelledVoiceprintCannotOpenAfterPermissionCompletes() async throws {
        let harness = try await centralHarness()
        let gate = StopGate()
        await harness.permissions.setGate(gate)
        let opening = Task { try await harness.coordinator.pressVoiceprintSample(1) }
        await gate.waitUntilEntered()
        _ = try await harness.coordinator.releaseVoiceprintSample(1, cancel: true)
        let withdrawn = await media(harness)
        XCTAssertEqual(withdrawn.microphone, .off)
        await gate.release()
        do {
            try await opening.value
            XCTFail("Cancelled enrollment must not open a window")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
        let ops = await operations(harness)
        let events = await harness.realtime.mediaEvents
        XCTAssertFalse(ops.contains("voiceprint_open"))
        XCTAssertFalse(events.contains("microphone:on"))
        do {
            try await harness.coordinator.pressVoiceprintSample(1)
            XCTFail("A late begin for the cancelled press must be refused")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
    }

    /// Cancel during the release wait stops that sentence and preserves another microphone owner.
    func testVoiceprintCancellationStopsReleaseWithoutDroppingAmbient() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.setAmbient(true)
        try await harness.coordinator.pressVoiceprintSample(1)
        let packets = await sent(harness)
        let operation = try XCTUnwrap(packets.last?["operation_id"] as? String)
        await harness.realtime.emit(.centralText(try central(["operation": "voiceprint_sample", "operation_id": operation, "status": "recording"])))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().ownerVoice.voiceprint.phase == .recording }
        let measuring = Task { try await harness.coordinator.releaseVoiceprintSample(1, cancel: false) }
        try await eventually("measuring") { await self.operations(harness).contains("voiceprint_commit") }
        _ = try await harness.coordinator.releaseVoiceprintSample(1, cancel: true)
        do {
            _ = try await measuring.value
            XCTFail("Cancelled enrollment must stop waiting for measurement")
        } catch {
            XCTAssertEqual(error as? AssistantSessionCoordinatorError, .superseded)
        }
        let ops = await operations(harness)
        XCTAssertTrue(ops.contains("voiceprint_commit"))
        let retained = await media(harness)
        XCTAssertEqual(retained.microphone, .on)
        try await harness.coordinator.setAmbient(false)
        try await eventually("enrollment holder withdrawn") { await self.media(harness).microphone == .off }
    }

    /// 录入我的声音: a sentence holds the microphone only for its window; the commit returns central's measurement.
    func testVoiceprintSentenceHoldsTheMicrophoneOnlyForItsWindow() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.pressVoiceprintSample(1)
        let packets = await sent(harness)
        let open = try XCTUnwrap(packets.last)
        XCTAssertEqual(open["operation"] as? String, "voiceprint_open")
        let operation = try XCTUnwrap(open["operation_id"] as? String)
        let during = await media(harness)
        XCTAssertEqual(during.microphone, .on)
        await harness.realtime.emit(.centralText(try central(["operation": "voiceprint_sample", "operation_id": operation, "status": "recording"])))
        try await eventually("recording") { await harness.coordinator.centralTextSnapshot().ownerVoice.voiceprint.phase == .recording }
        let release = Task { try await harness.coordinator.releaseVoiceprintSample(1, cancel: false) }
        try await eventually("commit") { await self.operations(harness).contains("voiceprint_commit") }
        let sampleID = "vps-0f8fad5b-d9cb-469f-a165-70867728950e"
        await harness.realtime.emit(.centralText(try central(["operation": "voiceprint_sample", "operation_id": operation, "status": "measured",
                                                              "sample_id": sampleID, "speech_ms": 2400, "quality": "ok"])))
        let sample = try await release.value
        XCTAssertEqual(sample, CentralVoiceprintSample(sampleID: sampleID, speechMS: 2400, quality: .ok))
        try await eventually("microphone released") { await self.media(harness).microphone == .off }
    }

    /// H-05: a request sent during a (minimised) call never ends the call's state.
    func testARequestDuringACallKeepsTheCall() async throws {
        let harness = try await centralHarness()
        try await harness.coordinator.startCall(video: false)
        let openedCall = await harness.coordinator.centralTextSnapshot().call
        let callID = try XCTUnwrap(openedCall.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": callID, "state": "live"])))
        try await eventually("live call") { await harness.coordinator.centralTextSnapshot().call.isActive }
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "typed-during-call", text: "顺便记一下"))
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertTrue(call.isActive)
        XCTAssertEqual(call.id, callID)
        let current = await media(harness)
        XCTAssertEqual(current.microphone, .on)
    }

    /// APP-14: a refused location never blocks the session.
    func testRefusedLocationDoesNotBlockTheSession() async throws {
        let harness = await Harness.make(canPublishData: true)
        await MainActor.run { harness.location.deniesAuthorization = true }
        try await harness.coordinator.start(AssistantStartIntent(locationEnabled: true, userInitiated: true))
        let state = await harness.coordinator.snapshot()
        XCTAssertEqual(state, .active(encryptionActive: true))
    }
}

private final class TestPairing: @unchecked Sendable {
    private let lock = NSLock()
    private var identity = "owner-pairing"
    func change(_ identity: String) { lock.lock(); defer { lock.unlock() }; self.identity = identity }
    func snapshot() -> (identity: String, deviceID: String)? {
        lock.lock(); defer { lock.unlock() }; return (identity, "phone-voice")
    }
}

@MainActor
private final class RecordingARTC: ARTCCallClient {
    var joins: [CentralCall.Media] = [], media: [String] = []
    var leaves = 0, flips = 0, flushes = 0, cameraOn = false, failJoin = false
    private var events: (@Sendable (ARTCCallEvent) -> Void)?
    private var joinEvents: [@Sendable (ARTCCallEvent) -> Void] = []
    func join(_ credentials: CentralCall.Media, camera: Bool, events: @escaping @Sendable (ARTCCallEvent) -> Void) throws {
        joins.append(credentials); cameraOn = camera; self.events = events
        joinEvents.append(events)
        if failJoin { throw CentralTextError.unavailable }
    }
    func setMedia(_ source: AssistantMediaSource, enabled: Bool) throws {
        media.append((source == .camera ? "camera:" : "microphone:") + (enabled ? "on" : "off"))
    }
    func switchCamera() throws -> Bool { flips += 1; return flips % 2 == 1 }
    func flushPlayback() { flushes += 1 }
    var leaveGate: StopGate?
    func leave() async {
        leaves += 1
        if let gate = leaveGate { await gate.markEntered(); await gate.waitForRelease() }
    }
    func emit(_ event: ARTCCallEvent) { events?(event) }
    func emit(_ event: ARTCCallEvent, fromJoin index: Int) { joinEvents[index](event) }
}


extension AssistantSessionTests {
    func testTimelineAcceptAndPublicationFailuresReachTerminalObserverOnce() async throws {
        let harness = try await centralHarness()
        let baseline: [String: Any] = ["operation": "timeline_items", "head_seq": 1, "has_more": false,
            "items": [["seq": 1, "item_id": "me-one", "kind": "owner", "via": "text", "text": "one", "at": "2026-10-15T00:00:00.000Z"]]]
        await harness.realtime.emit(.centralText(try central(baseline)))
        try await eventually("timeline baseline committed") { await harness.coordinator.terminalSnapshot().lastSeq == 1 }
        for publicationFailure in [false, true] {
            await harness.realtime.emit(.centralText(try central(["operation": "ready"])))
            try await eventually("timeline request active") { await harness.coordinator.terminalSnapshot().requestID != nil }
            let active = await harness.coordinator.terminalSnapshot()
            let request = try XCTUnwrap(active.requestID)
            let failure = expectation(description: "one terminal failure observation")
            await harness.coordinator.setTerminalObserver { state in if state.syncFailed { failure.fulfill() } }
            var fields: [String: Any] = ["operation": "timeline_items", "head_seq": 3, "has_more": true, "request_id": request, "items": [], "page_end": true]
            if publicationFailure {
                await harness.realtime.refuseCentral("timeline_sync", times: 1)
                fields["items"] = [["seq": 2, "item_id": "me-two", "kind": "owner", "via": "text", "text": "two", "at": "2026-10-15T00:00:00.000Z"]]
            }
            await harness.realtime.emit(.centralText(try central(fields)))
            await fulfillment(of: [failure], timeout: 2)
            let state = await harness.coordinator.terminalSnapshot()
            XCTAssertTrue(state.syncFailed)
            XCTAssertNil(state.requestID)
            await harness.coordinator.setTerminalObserver(nil)
        }
        _ = await harness.coordinator.stop()
    }
}

extension AssistantSessionTests {
    @MainActor
    func testIndependentCallCameraKeepsVoiceAndNeverRequestsAvatarByDefault() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc, formalVoice: true)
        let camera = try await harness.coordinator.startCall(video: false, camera: true)
        XCTAssertTrue(camera)
        let opening = await sent(harness).first { $0["operation"] as? String == "call_open" }
        XCTAssertNotEqual(opening?["video"] as? Bool, true)
        let call = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(call.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        try await eventually("voice call live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        let observed1 = await media(harness).camera
        XCTAssertEqual(observed1, .on)
        try await harness.coordinator.setCallVideo(false)
        let observed2 = await media(harness).camera
        XCTAssertEqual(observed2, .on, "avatar OFF cannot withdraw independent camera")
        let observed3 = await media(harness).microphone
        XCTAssertEqual(observed3, .on)
        XCTAssertTrue(rtc.joins.isEmpty)
        try await harness.coordinator.setCallCamera(false)
        let observed4 = await media(harness).camera
        XCTAssertEqual(observed4, .off)
        let observed5 = await harness.coordinator.centralTextSnapshot().call.id
        XCTAssertEqual(observed5, id)
        try await harness.coordinator.endCall()
        let observed6 = await media(harness).microphone
        XCTAssertEqual(observed6, .off)
    }

    @MainActor
    func testIndependentCameraSurvivesAvatarJoinFailureAndStopsOnBackground() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: false, camera: true)
        let call = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(call.id)
        try await harness.coordinator.setCallVideo(true)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "media": credentials, "video_revision": 1])))
        try await eventually("avatar joined") { !rtc.joins.isEmpty }
        rtc.emit(.failed)
        try await eventually("avatar retired") { await harness.coordinator.presentationSnapshot().videoCallRequested == false }
        let observed7 = await media(harness).camera
        XCTAssertEqual(observed7, .on)
        let observed8 = await media(harness).microphone
        XCTAssertEqual(observed8, .on)
        await harness.coordinator.handleLifecycleSignal(.appDidEnterBackground)
        let observed9 = await media(harness).camera
        XCTAssertEqual(observed9, .off)
        let observed10 = await media(harness).microphone
        XCTAssertEqual(observed10, .on)
        try await harness.coordinator.endCall()
    }
}


extension AssistantSessionTests {
    @MainActor
    func testCameraOffDuringInitialPublishPreservesVoiceCall() async throws {
        let harness = try await centralHarness(), gate = StopGate()
        await harness.realtime.setMediaPublishGate(gate)
        let starting = Task { try await harness.coordinator.startCall(video: false, camera: true) }
        await gate.waitUntilEntered()
        let call = await harness.coordinator.centralTextSnapshot().call
        let closing = Task { try await harness.coordinator.setCallCamera(false) }
        try await eventually("camera intent withdrawn") { await self.media(harness).camera == .off }
        await gate.release()
        try await closing.value
        let cameraOn = try await starting.value
        XCTAssertFalse(cameraOn)
        let current = await harness.coordinator.centralTextSnapshot().call, captured = await media(harness)
        XCTAssertEqual(current.id, call.id)
        XCTAssertTrue(current.isActive)
        XCTAssertEqual(captured.camera, .off)
        XCTAssertEqual(captured.microphone, .on)
        try await harness.coordinator.endCall()
    }

    @MainActor
    func testAvatarJoinDoesNotReplacePendingIndependentCameraOwner() async throws {
        for cameraOff in [false, true] {
            let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc), gate = StopGate()
            await harness.realtime.setMediaPublishGate(gate)
            let starting = Task { try await harness.coordinator.startCall(video: false, camera: true) }
            await gate.waitUntilEntered()
            let call = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(call.id)
            try await harness.coordinator.setCallVideo(true)
            var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
            await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
                "state": "connecting", "media": credentials, "video_revision": 1])))
            try await eventually("avatar joined with camera publication pending") { !rtc.joins.isEmpty }
            rtc.emit(.firstFrame)
            try await eventually("avatar rendered") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
            let closing: Task<Void, Error>? = cameraOff ? Task { try await harness.coordinator.setCallCamera(false) } : nil
            if cameraOff { try await eventually("camera intent withdrawn") { await self.media(harness).camera == .off } }
            await gate.release()
            try await closing?.value
            let cameraOn = try await starting.value
            XCTAssertEqual(cameraOn, !cameraOff)
            let current = await harness.coordinator.centralTextSnapshot().call
            let snapshot = await harness.coordinator.presentationSnapshot()
            XCTAssertEqual(current.id, id)
            XCTAssertEqual(current.state, "live")
            XCTAssertTrue(snapshot.videoCallRequested, "camera OFF cannot fail avatar reception")
            XCTAssertEqual(snapshot.media.camera, cameraOff ? .off : .on)
            XCTAssertEqual(snapshot.media.microphone, .on)
            XCTAssertEqual(rtc.leaves, 0)
            try await harness.coordinator.endCall()
        }
    }
}


extension AssistantSessionTests {
    @MainActor
    func testAvatarHangupPreservesFailedLiveKitCameraCleanupForRetry() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc)
        try await harness.coordinator.startCall(video: true)
        let call = await harness.coordinator.centralTextSnapshot().call, id = try XCTUnwrap(call.id)
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "connecting", "video": true, "media": credentials, "video_revision": 0])))
        try await eventually("gateway camera published") { await self.media(harness).camera == .on }
        let leaving = StopGate()
        rtc.leaveGate = leaving
        await harness.realtime.setCameraDisableFails(true)
        let ending = Task { try await harness.coordinator.endCall() }
        await leaving.waitUntilEntered()
        try await eventually("camera disable failure retained") { await self.media(harness).camera == .unknown }
        await leaving.release()
        try await ending.value
        let failed = await media(harness)
        XCTAssertEqual(failed.camera, .unknown, "renderer cleanup cannot erase LiveKit's unfinished camera cleanup")
        await harness.realtime.setCameraDisableFails(false)
        await harness.coordinator.releaseMedia(.camera, for: .call)
        let settled = await media(harness), events = await harness.realtime.mediaEvents
        XCTAssertEqual(settled.camera, .off)
        let cameraEvents = events.filter { $0.hasPrefix("camera:") }
        XCTAssertEqual(cameraEvents.first, "camera:on")
        XCTAssertEqual(cameraEvents.last, "camera:off")
        XCTAssertFalse(cameraEvents.dropFirst().dropLast().isEmpty)
        XCTAssertTrue(cameraEvents.dropFirst().dropLast().allSatisfy { $0 == "camera:off!" })
        _ = await harness.coordinator.stop()
    }
}


extension AssistantSessionTests {
    func testQueuedPromptDoesNotPrepareOrCancelForegroundVoice() async throws {
        let harness = try await centralHarness(formalVoice: true)
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "formal-voice.fixture", withExtension: "json", subdirectory: "Fixtures/FormalVoice"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let submit = try XCTUnwrap(fixture["submit"] as? [String: String])
        let event = try XCTUnwrap(submit["event_id"])
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: event, text: "第一句"))
        await harness.realtime.emit(.centralText(try central(fixture["accepted"] as! [String: Any])))
        await harness.realtime.emit(.centralText(try central(fixture["header"] as! [String: Any])))
        try await eventually("foreground voice is pending") { await harness.coordinator.centralTextSnapshot().header != nil }
        let before = await harness.realtime.preparedCentralVoiceEvents.count
        try await harness.coordinator.submitPrompt(AssistantPromptEnvelope(promptID: "queued-voice-next", text: "下一句"))
        let after = await harness.realtime.preparedCentralVoiceEvents.count
        let observed = await harness.realtime.observedCentralVoiceEvents
        let current = await harness.coordinator.centralTextSnapshot()
        XCTAssertEqual(after, before, "Enqueueing must not invalidate readers or stop the foreground player")
        XCTAssertEqual(current.eventID, event)
        XCTAssertEqual(observed, [event, "queued-voice-next"])
        _ = await harness.coordinator.stop()
    }
}

extension AssistantSessionTests {
    @MainActor
    func testExplicitAvatarWaitsForAcknowledgementAndFrameWithoutChangingCameraOrCall() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc, formalVoice: true)
        let cameraOn = try await harness.coordinator.startCall(video: false, camera: true)
        XCTAssertTrue(cameraOn)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        try await eventually("independent camera call live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        let initial = await harness.coordinator.presentationSnapshot()
        XCTAssertFalse(initial.videoCallRequested)
        XCTAssertEqual(initial.media.camera, .on)
        XCTAssertTrue(rtc.joins.isEmpty)
        let initialRequests = await sent(harness)
        XCTAssertFalse(initialRequests.contains { $0["operation"] as? String == "call_avatar" && $0["avatar"] as? Bool == true })

        try await harness.coordinator.setCallAvatar(true)
        let requests = await sent(harness)
        let enable = try XCTUnwrap(requests.last { $0["operation"] as? String == "call_avatar" })
        XCTAssertEqual(enable["call_id"] as? String, id)
        XCTAssertEqual(enable["avatar"] as? Bool, true)
        let revision = try XCTUnwrap(enable["avatar_revision"] as? Int)
        let waiting = await harness.coordinator.centralTextSnapshot().call
        XCTAssertFalse(waiting.videoFrameRendered)
        XCTAssertTrue(rtc.joins.isEmpty, "sending the request is not renderer confirmation")
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        await harness.realtime.emit(.centralText(try central(["operation": "call_transcript", "call_id": id,
            "turn": 98, "role": "assistant", "final": true, "text": "pending-avatar-voice-update-consumed"])))
        try await eventually("voice update retained while avatar is pending") {
            await harness.coordinator.centralTextSnapshot().call.lines.contains { $0.text == "pending-avatar-voice-update-consumed" }
        }
        let afterVoiceUpdate = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(afterVoiceUpdate.videoCallRequested, "voice receipts cannot cancel pending avatar intent")
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        await harness.realtime.emit(.centralText(try central(["operation": "call_avatar_state", "call_id": id, "state": "live",
            "avatar": true, "avatar_revision": revision, "media": credentials])))
        try await eventually("explicit avatar renderer joined") { rtc.joins.count == 1 }
        let acknowledged = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(acknowledged.avatar, true)
        XCTAssertFalse(acknowledged.videoFrameRendered, "ACK alone cannot show the avatar as on")
        rtc.emit(.firstFrame)
        try await eventually("explicit avatar first frame") { await harness.coordinator.centralTextSnapshot().call.videoFrameRendered }
        let rendered = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(rendered.videoCallRequested)
        XCTAssertEqual(rendered.media.camera, .on)
        XCTAssertEqual(rendered.media.microphone, .on)

        try await harness.coordinator.setCallAvatar(false)
        let afterOff = await harness.coordinator.centralTextSnapshot().call
        let mediaAfterOff = await media(harness)
        XCTAssertEqual(afterOff.id, id)
        XCTAssertEqual(afterOff.state, "live")
        XCTAssertFalse(afterOff.videoFrameRendered)
        XCTAssertEqual(mediaAfterOff.camera, .on)
        XCTAssertEqual(mediaAfterOff.microphone, .on)
        XCTAssertEqual(rtc.leaves, 1)
        let offRequests = await sent(harness)
        let disable = try XCTUnwrap(offRequests.last { $0["operation"] as? String == "call_avatar" })
        XCTAssertEqual(disable["avatar"] as? Bool, false)
        XCTAssertNil(disable["control_id"], "legacy OFF stays readable without the paid-appearance extension")
        XCTAssertNil(disable["confirmed_quote"])
        let offRevision = try XCTUnwrap(disable["avatar_revision"] as? Int)
        XCTAssertGreaterThan(offRevision, revision)
        await harness.realtime.emit(.centralText(try central(["operation": "call_avatar_state", "call_id": id, "state": "live",
            "avatar": true, "avatar_revision": revision, "media": credentials])))
        // A subsequent marker on the same event stream proves the stale ACK was consumed first.
        await harness.realtime.emit(.centralText(try central(["operation": "call_transcript", "call_id": id,
            "turn": 99, "role": "assistant", "final": true, "text": "late-avatar-ack-consumed"])))
        try await eventually("stale avatar ACK consumed") {
            await harness.coordinator.centralTextSnapshot().call.lines.contains { $0.text == "late-avatar-ack-consumed" }
        }
        let afterStale = await harness.coordinator.centralTextSnapshot().call
        XCTAssertNil(afterStale.media)
        XCTAssertEqual(afterStale.state, "live")
        XCTAssertEqual(rtc.joins.count, 1, "a stale ON receipt must not rejoin after explicit OFF")
        await harness.realtime.emit(.centralText(try central(["operation": "call_avatar_state", "call_id": id, "state": "live",
            "avatar": false, "avatar_revision": offRevision])))
        try await eventually("avatar off acknowledged") { await harness.coordinator.centralTextSnapshot().call.avatar == false }
        let finalCall = await harness.coordinator.centralTextSnapshot().call
        XCTAssertEqual(finalCall.id, id)
        XCTAssertEqual(finalCall.state, "live")
        let finalRequests = await sent(harness)
        XCTAssertEqual(finalRequests.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertFalse(finalRequests.contains { $0["operation"] as? String == "call_close" })
        try await harness.coordinator.endCall()
        _ = await harness.coordinator.stop()
    }
}

extension AssistantSessionTests {
    @MainActor
    func testAvatarQuoteRejectionClosesOnlyAvatarAndLateRejectionCannotCancelNewIntent() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc, formalVoice: true)
        try await harness.coordinator.startCall(video: false, camera: true)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        try await eventually("quote rejection voice call live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        let quote = AssistantAppearanceQuote(quote_id: "stale-quote", price_text: "旧费用", scope_text: "本次通话")
        try await harness.coordinator.setCallAvatar(true, quote: quote)
        let requests = await sent(harness)
        let enable = try XCTUnwrap(requests.last { $0["operation"] as? String == "call_avatar" })
        let revision = try XCTUnwrap(enable["avatar_revision"] as? Int)
        let controlID = try XCTUnwrap(enable["control_id"] as? String)
        XCTAssertEqual(controlID, "\(revision):\(id)")
        XCTAssertEqual((enable["confirmed_quote"] as? [String: String])?["quote_id"], quote.quote_id)
        let rejection: [String: Any] = ["operation": "rejected", "request_operation": "call_avatar",
            "control_id": controlID, "error_code": "CALL_AVATAR_QUOTE_CHANGED",
            "event_id": NSNull(), "processed_event_id": NSNull()]
        await harness.realtime.emit(.centralText(try central(rejection)))
        try await eventually("current quote rejection disables avatar") {
            await harness.coordinator.presentationSnapshot().callFailure == "CALL_AVATAR_QUOTE_CHANGED"
        }
        try await eventually("rejection cleanup uses a higher revision") {
            await self.sent(harness).contains { $0["operation"] as? String == "call_avatar" &&
                $0["avatar"] as? Bool == false && ($0["avatar_revision"] as? Int ?? 0) > revision }
        }
        let rejected = await harness.coordinator.presentationSnapshot()
        let callAfterRejection = await harness.coordinator.centralTextSnapshot().call
        XCTAssertFalse(rejected.videoCallRequested)
        XCTAssertFalse(callAfterRejection.videoFrameRendered)
        XCTAssertEqual(callAfterRejection.id, id)
        XCTAssertEqual(callAfterRejection.state, "live")
        XCTAssertEqual(rejected.media.camera, .on)
        XCTAssertEqual(rejected.media.microphone, .on)
        XCTAssertTrue(rtc.joins.isEmpty, "rejection cannot report renderer success")

        let freshQuote = AssistantAppearanceQuote(quote_id: "fresh-quote", price_text: "新费用", scope_text: "本次通话")
        try await harness.coordinator.setCallAvatar(true, quote: freshQuote)
        await harness.realtime.emit(.centralText(try central(rejection)))
        await harness.realtime.emit(.centralText(try central(["operation": "call_transcript", "call_id": id,
            "turn": 100, "role": "assistant", "final": true, "text": "late-quote-rejection-consumed"])))
        try await eventually("late rejection consumed") {
            await harness.coordinator.centralTextSnapshot().call.lines.contains { $0.text == "late-quote-rejection-consumed" }
        }
        let afterLate = await harness.coordinator.presentationSnapshot()
        XCTAssertTrue(afterLate.videoCallRequested, "an older rejected control ID cannot cancel the new intent")
        XCTAssertNil(afterLate.callFailure)
        XCTAssertEqual(afterLate.media.camera, .on)
        XCTAssertEqual(afterLate.media.microphone, .on)
        let finalRequests = await sent(harness)
        XCTAssertEqual(finalRequests.filter { $0["operation"] as? String == "call_open" }.count, 1)
        XCTAssertFalse(finalRequests.contains { $0["operation"] as? String == "call_close" })
        try await harness.coordinator.endCall()
        _ = await harness.coordinator.stop()
    }
}

extension AssistantSessionTests {
    @MainActor
    func testRetiredAvatarRendererCallbacksCannotAffectReplacementOnSameCall() async throws {
        let rtc = RecordingARTC(), harness = try await centralHarness(artc: rtc, formalVoice: true)
        try await harness.coordinator.startCall(video: false, camera: true)
        let opened = await harness.coordinator.centralTextSnapshot().call
        let id = try XCTUnwrap(opened.id)
        await harness.realtime.emit(.centralText(try central(["operation": "call_state", "call_id": id,
            "state": "live", "video": false, "video_revision": 0])))
        try await eventually("renderer fence voice call live") { await harness.coordinator.centralTextSnapshot().call.state == "live" }
        var credentials = Self.artcMedia; credentials["audio_input"] = "gateway"
        for join in 1...2 {
            try await harness.coordinator.setCallAvatar(true)
            let requests = await sent(harness)
            let enable = try XCTUnwrap(requests.last { $0["operation"] as? String == "call_avatar" })
            let revision = try XCTUnwrap(enable["avatar_revision"] as? Int)
            await harness.realtime.emit(.centralText(try central(["operation": "call_avatar_state", "call_id": id,
                "state": "live", "avatar": true, "avatar_revision": revision, "media": credentials])))
            try await eventually("renderer join \(join)") { rtc.joins.count == join }
            if join == 1 { try await harness.coordinator.setCallAvatar(false) }
        }
        let staleEvent = expectation(description: "retired renderer cannot render or stop replacement")
        staleEvent.isInverted = true
        staleEvent.assertForOverFulfill = false
        await harness.coordinator.setCentralTextObserver { state in
            if state.call.videoFrameRendered || state.call.media == nil { staleEvent.fulfill() }
        }
        rtc.emit(.firstFrame, fromJoin: 0)
        rtc.emit(.failed, fromJoin: 0)
        await fulfillment(of: [staleEvent], timeout: 0.2)
        await harness.coordinator.setCentralTextObserver(nil)
        let waiting = await harness.coordinator.presentationSnapshot()
        let call = await harness.coordinator.centralTextSnapshot().call
        XCTAssertTrue(waiting.videoCallRequested)
        XCTAssertFalse(call.videoFrameRendered)
        XCTAssertEqual(waiting.media.camera, .on)
        XCTAssertEqual(waiting.media.microphone, .on)
        XCTAssertEqual(rtc.leaves, 1)
        rtc.emit(.firstFrame, fromJoin: 1)
        try await eventually("only replacement renderer can provide first frame") {
            await harness.coordinator.centralTextSnapshot().call.videoFrameRendered
        }
        try await harness.coordinator.endCall()
        _ = await harness.coordinator.stop()
    }
}


extension AssistantSessionTests {
    func testExplicitAvatarAppearanceOptionsRespectCurrentSession() async throws {
        let harness = await Harness.make(canPublishData: true, ownerIdentity: { ("owner-pairing", "phone-voice") })
        await harness.bootstrap.setCentralBinding(Self.centralBinding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.requestAppearanceOptions()
        let requests = await sent(harness)
        let request = try XCTUnwrap(requests.last { $0["operation"] as? String == "avatar_options" })
        let requestID = try XCTUnwrap(request["request_id"] as? String)
        let stale: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "session_id": "another-session",
            "operation": "avatar_options_state", "request_id": requestID, "photo_upload_available": false,
            "looks": [["look_id": "stale", "style": "旧会话", "image_url": "https://assets.example/stale.jpg", "focus": ["x": 0.5, "y": 0.4]]]]
        await harness.realtime.emit(.centralText(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: stale))))
        await harness.realtime.emit(.centralText(try central(["operation": "avatar_options_state",
            "request_id": requestID, "photo_upload_available": false, "looks": []])))
        try await eventually("only the current session supplies appearance options") {
            let state = await harness.coordinator.terminalSnapshot().appearance
            return state.options?.looks == [] && !state.busy
        }
        _ = await harness.coordinator.stop()
    }
}


extension AssistantSessionTests {
    func testExt13UnpairStopsLocalWakeBeforeRTCAndDoesNotRestoreIt() async throws {
        for reason in ["desktop_unpaired", "pairing_changed", "user_stop", "desktop_reconnect"] {
            let capture = Ext13CaptureLog()
            let harness = await Harness.make(localWakeCapture: ({ capture.append("capture-start") }, { capture.append("capture-stop") }))
            await harness.realtime.setStopObserver { capture.append("rtc-stop") }
            try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
            try await harness.coordinator.setWakeEnabled(true)
            // Finish native detector initialization before this short test can exit the process.
            try await eventually("local detector initialized", seconds: 60) {
                await harness.coordinator.presentationSnapshot().media.wake == .waitingForAudio
            }
            _ = await harness.coordinator.stop(reasonCode: reason)
            let snapshot = await harness.coordinator.presentationSnapshot()
            let log = capture.values
            if reason == "desktop_reconnect" {
                XCTAssertTrue(snapshot.media.wakeArmed)
                XCTAssertFalse(log.contains("capture-stop"), "A reconnect retains the authorized wake capture")
                try await harness.coordinator.setWakeEnabled(false)
            } else {
                XCTAssertFalse(snapshot.media.wakeArmed, reason)
                XCTAssertEqual(log, ["capture-start", "capture-stop", "rtc-stop"], reason)
            }
            try await harness.coordinator.setWakeEnabled(false)
        }
    }

    func testExt13ContactsDisableFencesSendAfterSuspendedAccessCheck() async throws {
        let fixture = try CentralTextTestFixture(), gate = StopGate()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = Ext13ContactsSource(gate: gate)
        let sync = AssistantContactsSync(source: source, directory: directory)
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test",
            deviceID: fixture.binding.deviceID, userID: "test-owner", token: "test-token",
            governance: .init(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [], purposeTokenRefs: [], capabilityGrantRefs: []),
            media: ["data"], pairedAt: "2026-10-24T00:00:00Z")
        let harness = await Harness.make(canPublishData: true, contactsSync: sync, ownerDataPairing: { pairing })
        await harness.bootstrap.setCentralBinding(fixture.binding)
        try await harness.coordinator.start(AssistantStartIntent(userInitiated: true))
        try await harness.coordinator.setContactsEnabled(true)
        await gate.waitUntilEntered()
        try await harness.coordinator.setContactsEnabled(false)
        await gate.release()
        // The suspended OS access check ignores cancellation, as a completed permission callback may do.
        try await Task.sleep(nanoseconds: 100_000_000)
        let packets = await harness.realtime.centralPackets
        XCTAssertFalse(packets.contains { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["operation"] as? String == "contacts_batch" })
        let enabled = try await sync.isEnabled(identity: CentralOwnerDataIdentity.pairing(pairing))
        XCTAssertFalse(enabled)
        _ = await harness.coordinator.stop()
    }
}

private final class Ext13CaptureLog: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [String] = []
    func append(_ value: String) { lock.withLock { log.append(value) } }
    var values: [String] { lock.withLock { log } }
}

private actor Ext13ContactsSource: AssistantContactsReading {
    let gate: StopGate
    init(gate: StopGate) { self.gate = gate }
    func requestAccess() {}
    func snapshot() -> AssistantContactsSnapshot {
        .init(contacts: [.init(id: "contact", name: "Test", phones: [], relations: [])], limited: false)
    }
    func verifyAccess(limited: Bool) async throws { await gate.markEntered(); await gate.waitForRelease() }
}
