import Foundation
import XCTest
@testable import HealthKitExporter

final class FormalVoiceBoundaryTests: XCTestCase {
    func values() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "formal-voice.fixture", withExtension: "json", subdirectory: "Fixtures/FormalVoice"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    func packet(_ value: Any) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value, options: .sortedKeys))
    }
    func consumer(_ fixture: [String: Any], text: Bool = true) throws -> AssistantCentralTextConsumer {
        let binding = try XCTUnwrap(fixture["trusted_binding"] as? [String: Any])
        var value = AssistantCentralTextConsumer()
        try value.reset(binding: CentralTransportBinding(sessionID: binding["session_id"] as! String,
            deviceID: binding["device_id"] as! String, connectionEpoch: binding["connection_epoch"] as! String,
            expectedGatewayIdentity: binding["expected_gateway_identity"] as! String, maxPacketBytes: 12288,
            voiceTransport: binding["voice_transport"] as? String))
        let submit = fixture["submit"] as! [String: String]
        _ = try value.beginSubmit(eventID: submit["event_id"]!, capturedAt: submit["captured_at"]!, text: submit["text"]!)
        try value.accept(packet(fixture["accepted"]!))
        try value.accept(packet(fixture["header"]!))
        if text { for chunk in fixture["text_chunks"] as! [[String: Any]] { try value.accept(packet(chunk)) } }
        return value
    }
    func playback(_ fixture: [String: Any]) async throws -> CentralVoicePlayback {
        let packet = try packet(fixture["voice"]!), bytes = Data(base64Encoded: fixture["wav_base64"] as! String)!
        let stream = AsyncThrowingStream<Data, Error> { c in c.yield(bytes.prefix(31)); c.yield(bytes.dropFirst(31)); c.finish() }
        let resource = try await CentralVoiceFile.receive(stream, audio: XCTUnwrap((try packet.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self))))
        addTeardownBlock { resource.remove(); XCTAssertFalse(FileManager.default.fileExists(atPath: resource.file.path)) }
        try resource.validate(chunk: XCTUnwrap((try packet.fields.value("chunk", as: CentralBody.self))))
        return CentralVoicePlayback(packet: packet, resource: resource)
    }
    func testStreamedWAVsPlayInOrderAndKeepDelayedCumulativeACKsBoundToTheirChunk() async throws {
        var original = try values(), header = original["header"] as! [String: Any]
        header["voice_status"] = "pending"; header["pending_voice_chunk_count"] = 1
        original["header"] = header
        var value = try consumer(original)
        var chunks: [CentralVoicePlayback] = []
        for seq in 1...3 {
            var fixture = original, envelope = original["voice"] as! [String: Any]
            var chunk = envelope["chunk"] as! [String: Any]
            chunk["seq"] = seq; chunk["final"] = false
            envelope["chunk"] = chunk; fixture["voice"] = envelope
            chunks.append(try await playback(fixture))
        }
        try value.receiveVoice(chunks[0])
        let first = try XCTUnwrap(value.takeVoicePlayback())
        for next in chunks.dropFirst() {
            try value.accept(packet(header))
            try value.receiveVoice(next)
        }
        XCTAssertNil(try value.takeVoicePlayback(), "arrival cannot interrupt the current WAV")
        header["voice_status"] = "ready"; header["pending_voice_chunk_count"] = 0
        try value.accept(packet(header))
        var acknowledgements: [Data] = []
        acknowledgements.append(try XCTUnwrap(value.voiceCompleted(first, successfully: true, observedAt: "2026-10-01T00:00:01.000Z")))
        for seq in 2...3 {
            let next = try XCTUnwrap(value.takeVoicePlayback())
            XCTAssertEqual(try next.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self), seq)
            acknowledgements.append(try XCTUnwrap(value.voiceCompleted(next, successfully: true, observedAt: "2026-10-01T00:00:0\(seq).000Z")))
        }
        XCTAssertNil(try value.takeVoicePlayback())
        XCTAssertEqual(value.pendingRenderedACKs, [acknowledgements[2]], "the latest original cumulative ACK covers earlier played chunks")
        for seq in [1, 3, 2] {
            var receipt = original["ack_receipt"] as! [String: Any]
            var ack = (try JSONSerialization.jsonObject(with: acknowledgements[seq - 1]) as! [String: Any])["ack"] as! [String: Any]
            XCTAssertEqual(ack["highest_contiguous_seq"] as? Int, seq)
            ack["receipt_ref"] = "streamed-played-\(seq)"; receipt["receipt"] = ack
            try value.accept(packet(receipt))
        }
        XCTAssertTrue(value.pendingRenderedACKs.isEmpty, "late earlier receipts cannot undo the final confirmation")
        var replay = original, envelope = original["voice"] as! [String: Any]
        var chunk = envelope["chunk"] as! [String: Any]
        chunk["seq"] = 3; chunk["final"] = true; envelope["chunk"] = chunk; replay["voice"] = envelope
        let duplicate = try await playback(replay)
        try value.receiveVoice(duplicate)
        XCTAssertFalse(FileManager.default.fileExists(atPath: duplicate.resource.file.path))
        XCTAssertNil(try value.takeVoicePlayback(), "final marker replay never repeats speech")
    }
    func testCompleteWAVPlaysOnceAndRetainsItsPlayedACKUntilReceipt() async throws {
        let fixture = try values(), audio = try await playback(fixture)
        let chunk = try XCTUnwrap(audio.packet.fields.value("chunk", as: CentralBody.self))
        XCTAssertEqual(try chunk.value("seq", as: Int.self), 1)
        XCTAssertEqual(try chunk.value("final", as: Bool.self), true)
        var value = try consumer(fixture)
        try value.receiveVoice(audio)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        let ack = try XCTUnwrap(value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:01.000Z"))
        XCTAssertEqual(value.pendingRenderedACKs, [ack])
        var receipt = fixture["ack_receipt"] as! [String: Any]
        var played = (try JSONSerialization.jsonObject(with: ack) as! [String: Any])["ack"] as! [String: Any]
        XCTAssertEqual(played["highest_contiguous_seq"] as? Int, 1)
        played["receipt_ref"] = "complete-wav-played"; receipt["receipt"] = played
        try value.accept(packet(receipt))
        XCTAssertTrue(value.pendingRenderedACKs.isEmpty)
        let duplicate = try await playback(fixture)
        try value.receiveVoice(duplicate)
        XCTAssertFalse(FileManager.default.fileExists(atPath: duplicate.resource.file.path))
        XCTAssertNil(try value.takeVoicePlayback(), "final marker replay never repeats speech")
    }
    func testReplayTransferFailurePreservesCurrentPlaybackFactForExplicitReplay() async throws {
        let fixture = try values(), audio = try await playback(fixture)
        var value = try consumer(fixture)
        try value.receiveVoice(audio)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        try value.voiceFailed(audio.packet)
        let ack = try XCTUnwrap(value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        XCTAssertEqual(value.pendingRenderedACKs, [ack], "a replay transfer failure cannot erase speech that completed")
        XCTAssertTrue(value.canRetryVoicePlayback)
        try value.retryVoicePlayback()
        try value.receiveVoice(audio)
        XCTAssertNil(try value.takeVoicePlayback(), "explicit replay must skip the successfully played chunk")
    }
    func testVoiceOnlyUsesSamePlayerAndPlayedACKWithoutCaption() async throws {
        var fixture = try values()
        var header = fixture["header"] as! [String: Any]
        header["reply_mode"] = "voice"
        header["text_chunk_count"] = 0
        header["pending_text_chunk_count"] = 0
        header["rendered_text_through_seq"] = 0
        fixture["header"] = header
        var value = try consumer(fixture, text: false)
        let audio = try await playback(fixture)
        try value.receiveVoice(audio)
        XCTAssertNil(value.presentation)
        let admitted = try XCTUnwrap(value.takeVoicePlayback())
        let ack = try XCTUnwrap(value.voiceCompleted(admitted, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: ack) as! [String: Any])["operation"] as? String, "ack")
        XCTAssertNil(value.presentation)
    }
    func testStartedVoiceWithoutACKCannotAutoplayAfterWarmReset() async throws {
        var fixture = try values()
        var value = try consumer(fixture)
        let shown = try XCTUnwrap(value.presentation)
        let rendered = try XCTUnwrap(value.consumedByUI(shown, observedAt: "2026-10-01T00:00:00.000Z"))
        let ackBody = try JSONSerialization.jsonObject(with: rendered) as! [String: Any]
        var textReceipt = ackBody["ack"] as! [String: Any]
        textReceipt["receipt_ref"] = "source-text-rendered"
        let originalReceipt = fixture["ack_receipt"] as! [String: Any]
        var receipt = originalReceipt
        receipt["receipt"] = textReceipt
        try value.accept(packet(receipt))
        var header = fixture["header"] as! [String: Any]
        header["pending_text_chunk_count"] = 0
        header["rendered_text_through_seq"] = header["text_chunk_count"]
        fixture["header"] = header
        try value.accept(packet(header))
        let audio = try await playback(fixture)
        try value.receiveVoice(audio)
        XCTAssertNotNil(try value.takeVoicePlayback())
        // Started, no natural completion, no voice ACK. Text has confirmed ACK.
        let binding = try XCTUnwrap(value.binding)
        try value.reset(binding: nil)
        try value.reset(binding: binding)
        try value.receiveVoice(audio)
        XCTAssertNil(try value.takeVoicePlayback(), "unknown prior playback must never autoplay")
        XCTAssertFalse(value.pendingRenderedACKs.contains { String(data: $0, encoding: .utf8)?.contains("played") == true })
    }
    func testCanonicalRejectsPrimitiveNullMissingAndNestedControlTypes() throws {
        let fixture = try values()
        for (key, invalid) in [("reply_epoch", true as Any), ("reply_epoch", 1.5), ("reply_epoch", NSNull()), ("text_chunk_count", "1")] {
            var header = fixture["header"] as! [String: Any]
            header[key] = invalid
            XCTAssertThrowsError(try packet(header))
        }
        var missing = fixture["header"] as! [String: Any]
        missing.removeValue(forKey: "reply_epoch")
        XCTAssertThrowsError(try packet(missing))
        var voice = fixture["voice"] as! [String: Any]
        var chunk = voice["chunk"] as! [String: Any]
        chunk["final"] = 1
        voice["chunk"] = chunk
        XCTAssertThrowsError(try packet(voice))
        let accepted = fixture["accepted"] as! [String: Any]
        let control: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "control_receipt",
            "session_id": accepted["session_id"]!, "processed_event_id": accepted["processed_event_id"]!,
            "control_id": "source-control", "requested_operation": "cancel_playback",
            "receipt": ["playback_status": "unknown", "receipt": ["status": 2, "reply_epoch": true]]]
        XCTAssertThrowsError(try packet(control))
    }
    func testCanonicalHeaderRejectsIntegerAboveSafeRange() throws {
        let fixture = try values()
        var header = fixture["header"] as! [String: Any]
        header["reply_epoch"] = 9_007_199_254_740_993
        XCTAssertThrowsError(try packet(header))
    }
    func testImmutableOriginalIntegerInOpenReceiptKeepsSourceValue() throws {
        let fixture = try values()
        let accepted = fixture["accepted"] as! [String: Any]
        let sourceEpoch = 9_007_199_254_740_993
        let control: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "control_receipt",
            "session_id": accepted["session_id"]!, "processed_event_id": accepted["processed_event_id"]!,
            "control_id": "source-control", "requested_operation": "retry_voice",
            "receipt": ["voice_status": "ready", "voice_error": NSNull(), "reply_epoch": 1, "arrival_seq": sourceEpoch]]
        let decoded = try packet(control)
        let receipt = try XCTUnwrap((try decoded.fields.value("receipt", as: CentralBody.self)))
        XCTAssertEqual((try receipt.value("arrival_seq", as: Int.self)), sourceEpoch)
    }
    private func independentFixture(_ round: Int, epoch: Int = 1) throws -> [String: Any] {
        let original = try values(), accepted = original["accepted"] as! [String: Any]
        let header = original["header"] as! [String: Any]
        let serialized = String(data: try JSONSerialization.data(withJSONObject: original), encoding: .utf8)!
        let unique = serialized.replacingOccurrences(of: accepted["processed_event_id"] as! String, with: "d:" + String(format: "%064d", round))
            .replacingOccurrences(of: accepted["event_id"] as! String, with: "explicit-voice-\(round)")
            .replacingOccurrences(of: header["run_id"] as! String, with: "explicit-run-\(round)")
            .replacingOccurrences(of: header["reply_id"] as! String, with: "reply:" + String(format: "%064d", round))
            .replacingOccurrences(of: "\"reply_epoch\":1", with: "\"reply_epoch\":\(epoch)")
        return try JSONSerialization.jsonObject(with: Data(unique.utf8)) as! [String: Any]
    }
    private func startAndConfirmText(_ value: inout AssistantCentralTextConsumer, fixture: [String: Any]) throws {
        let submit = fixture["submit"] as! [String: String]
        try value.cancelVoice() // Original coordinator order.
        _ = try value.beginSubmit(eventID: submit["event_id"]!, capturedAt: submit["captured_at"]!, text: submit["text"]!)
        XCTAssertNil(value.header, "explicit new D must not inherit a warm header")
        try value.accept(packet(fixture["accepted"]!))
        try value.accept(packet(fixture["header"]!))
        for text in fixture["text_chunks"] as! [[String: Any]] { try value.accept(packet(text)) }
        let shown = try XCTUnwrap(value.presentation)
        let bytes = try XCTUnwrap(value.consumedByUI(shown, observedAt: "2026-10-01T00:00:00.000Z"))
        var receipt = fixture["ack_receipt"] as! [String: Any]
        var body = (try JSONSerialization.jsonObject(with: bytes) as! [String: Any])["ack"] as! [String: Any]
        body["receipt_ref"] = "source-text-confirmed"; receipt["receipt"] = body
        try value.accept(packet(receipt))
    }
    private func retainedCount(_ value: AssistantCentralTextConsumer) throws -> Int {
        let raw = try XCTUnwrap(Mirror(reflecting: value).children.first(where: { $0.label == "retained" }))
        return Mirror(reflecting: raw.value).children.count
    }
    func testRepeatedStartedThenCancelledVoiceCannotPermanentlyBlockNewExplicitSubmit() async throws {
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        var terminalHeader: [String: Any]?
        for round in 1...33 {
            let fixture = try independentFixture(round)
            XCTAssertTrue(try value.canBeginSubmit)
            try startAndConfirmText(&value, fixture: fixture)
            let audio = try await playback(fixture)
            try value.receiveVoice(audio)
            _ = try XCTUnwrap(value.takeVoicePlayback())
            try value.cancelVoice()
            XCTAssertTrue(value.pendingRenderedACKs.isEmpty)
            XCTAssertTrue(try value.canBeginSubmit)
            XCTAssertLessThanOrEqual(try retainedCount(value), 16)
            if round == 32 { terminalHeader = fixture["header"] as? [String: Any] }
        }
        let evicted = try independentFixture(1)
        XCTAssertThrowsError(try value.accept(packet(evicted["header"]!)), "old evicted D cannot become current")
        var cancelledHeader = try XCTUnwrap(terminalHeader)
        cancelledHeader["reply_phase"] = "interrupted"; cancelledHeader["reply_status"] = "partial"
        cancelledHeader["result_status"] = "interrupted"; cancelledHeader["result_revision"] = 2
        cancelledHeader["rendered_text_through_seq"] = 1; cancelledHeader["pending_text_chunk_count"] = 0
        let before = try retainedCount(value)
        try value.accept(packet(cancelledHeader))
        XCTAssertEqual(try retainedCount(value), before - 1, "source cancellation ends old retry purpose")
        XCTAssertThrowsError(try value.accept(packet(cancelledHeader)))
    }
    func testNewDWithRepeatedAndDifferentEpochsReallyStartsIndependentRunAndReply() async throws {
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        for (index, epoch) in [1, 1, 2].enumerated() {
            let fixture = try independentFixture(index + 1, epoch: epoch)
            try startAndConfirmText(&value, fixture: fixture)
            let audio = try await playback(fixture)
            try value.receiveVoice(audio)
            XCTAssertNotNil(try XCTUnwrap(value.takeVoicePlayback()))
            XCTAssertEqual(try value.header?.fields.value("reply_epoch", as: Int.self), epoch)
        }
    }
    func testRealPlayedACKCapacityPreservesBytesAndOriginalReceiptReleasesOneSlot() async throws {
        var value = AssistantCentralTextConsumer(), bytes: [Data] = []
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        for round in 1...17 {
            let fixture = try independentFixture(round)
            try startAndConfirmText(&value, fixture: fixture)
            let audio = try await playback(fixture)
            try value.receiveVoice(audio)
            let admitted = try XCTUnwrap(value.takeVoicePlayback())
            bytes.append(try XCTUnwrap(value.voiceCompleted(admitted, successfully: true, observedAt: "2026-10-01T00:00:00.000Z")))
        }
        try value.cancelVoice()
        XCTAssertFalse(try value.canPromotePending, "real unconfirmed ACKs must not be evicted")
        XCTAssertEqual(Set(value.pendingRenderedACKs), Set(bytes))
        XCTAssertEqual(try retainedCount(value), 16)
        let first = try independentFixture(1)
        var receipt = first["ack_receipt"] as! [String: Any]
        var body = (try JSONSerialization.jsonObject(with: bytes[0]) as! [String: Any])["ack"] as! [String: Any]
        body["receipt_ref"] = "source-played-confirmed"; receipt["receipt"] = body
        try value.accept(packet(receipt))
        XCTAssertTrue(try value.canPromotePending)
        XCTAssertEqual(Set(value.pendingRenderedACKs), Set(bytes.dropFirst()))
    }
    func testPendingAndReconcileRequiredTTSKeepCapacityUntilOriginalSourceClosesGeneration() throws {
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        for round in 1...17 {
            var fixture = try independentFixture(round)
            var header = fixture["header"] as! [String: Any]
            header["voice_status"] = round % 2 == 0 ? "reconcile_required" : "pending"
            fixture["header"] = header
            try startAndConfirmText(&value, fixture: fixture)
        }
        try value.cancelVoice()
        XCTAssertFalse(try value.canPromotePending, "unknown generation must not be evicted")
        XCTAssertTrue(value.pendingRenderedACKs.isEmpty)
        XCTAssertEqual(try retainedCount(value), 16)
        var closed = try independentFixture(1)["header"] as! [String: Any]
        closed["voice_status"] = "failed"; closed["voice_error"] = "SOURCE_TTS_FAILURE"
        closed["result_revision"] = 2; closed["rendered_text_through_seq"] = 1; closed["pending_text_chunk_count"] = 0
        try value.accept(packet(closed))
        XCTAssertTrue(try value.canPromotePending, "original source closure releases its generation slot")
    }
    func testRetiredPendingTTSQueryUsesOriginalResultAllowlistAndCanReleaseBlockedCapacity() throws {
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        for round in 1...17 {
            var fixture = try independentFixture(round)
            var header = fixture["header"] as! [String: Any]
            header["voice_status"] = round % 2 == 0 ? "reconcile_required" : "pending"
            fixture["header"] = header
            try startAndConfirmText(&value, fixture: fixture)
        }
        XCTAssertFalse(try value.canPromotePending)
        XCTAssertEqual(try value.retainedVoiceResultIDs.count, 16)
        let oldID = try XCTUnwrap(value.retainedVoiceResultIDs.first)
        let current = value.header
        let bytes = try value.requestRetainedResult(processedID: oldID)
        let request = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        XCTAssertEqual(request["operation"] as? String, "result")
        XCTAssertEqual(request["processed_event_id"] as? String, oldID)
        XCTAssertNil(request["text_replay"])
        XCTAssertEqual(value.header, current)
        XCTAssertThrowsError(try value.requestRetainedResult(processedID: "foreign-D"))
        XCTAssertThrowsError(try value.requestRetainedResult(processedID: ""))
        XCTAssertThrowsError(try value.requestRetainedResult(processedID: "d:" + String(format: "%064d", 17)))
        var closed = try independentFixture(1)["header"] as! [String: Any]
        closed["voice_status"] = "failed"; closed["voice_error"] = "SOURCE_TTS_FAILURE"
        closed["result_revision"] = 2; closed["rendered_text_through_seq"] = 1; closed["pending_text_chunk_count"] = 0
        try value.accept(packet(closed))
        XCTAssertTrue(try value.canBeginSubmit)
        XCTAssertEqual(try retainedCount(value), 15)
        XCTAssertFalse(try value.canPromotePending, "the current voice generation remains pending")
        XCTAssertTrue(value.status.contains("failed"))
        XCTAssertFalse(try value.retainedVoiceResultIDs.contains(oldID))
        XCTAssertEqual(value.header, current)
        XCTAssertTrue(value.pendingRenderedACKs.isEmpty)
    }
    func testRetiredPendingQuerySurvivesSameScopeReconnectButRejectsChangedScope() throws {
        let original = try values(), trusted = try XCTUnwrap(consumer(original).binding)
        var value = AssistantCentralTextConsumer()
        try value.reset(binding: trusted)
        for round in 1...2 {
            var fixture = try independentFixture(round)
            var header = fixture["header"] as! [String: Any]; header["voice_status"] = "pending"
            fixture["header"] = header; try startAndConfirmText(&value, fixture: fixture)
        }
        let oldID = try XCTUnwrap(value.retainedVoiceResultIDs.first)
        try value.reset(binding: nil)
        XCTAssertThrowsError(try value.requestRetainedResult(processedID: oldID))
        let next = CentralTransportBinding(sessionID: trusted.sessionID, deviceID: trusted.deviceID, connectionEpoch: "2",
            expectedGatewayIdentity: trusted.expectedGatewayIdentity, maxPacketBytes: trusted.maxPacketBytes, voiceTransport: trusted.voiceTransport)
        try value.reset(binding: next)
        XCTAssertNil(value.eventID)
        XCTAssertEqual(try value.retainedVoiceResultIDs, [oldID])
        _ = try value.requestRetainedResult(processedID: oldID)
        var closed = try independentFixture(1)["header"] as! [String: Any]
        closed["voice_status"] = "failed"; closed["voice_error"] = "SOURCE_TTS_FAILURE"
        closed["result_revision"] = 2; closed["rendered_text_through_seq"] = 1; closed["pending_text_chunk_count"] = 0
        var wrong = value
        try wrong.reset(binding: CentralTransportBinding(sessionID: trusted.sessionID, deviceID: "other-device", connectionEpoch: "3",
            expectedGatewayIdentity: trusted.expectedGatewayIdentity, maxPacketBytes: trusted.maxPacketBytes, voiceTransport: trusted.voiceTransport))
        XCTAssertTrue(try wrong.retainedVoiceResultIDs.isEmpty)
        XCTAssertThrowsError(try wrong.requestRetainedResult(processedID: oldID))
        var gateway = value
        try gateway.reset(binding: CentralTransportBinding(sessionID: trusted.sessionID, deviceID: trusted.deviceID, connectionEpoch: "3",
            expectedGatewayIdentity: "other-gateway", maxPacketBytes: trusted.maxPacketBytes, voiceTransport: trusted.voiceTransport))
        XCTAssertThrowsError(try gateway.requestRetainedResult(processedID: oldID))
        try value.accept(packet(closed))
        XCTAssertTrue(try value.retainedVoiceResultIDs.isEmpty)
        XCTAssertNil(value.header)
        XCTAssertNil(value.accepted)
        XCTAssertNil(value.presentation)
        XCTAssertTrue(value.pendingRenderedACKs.isEmpty)
    }
    func testRejectedRetiredResultQueryPreservesPendingFactAndCurrentPresentation() throws {
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        for round in 1...2 {
            var fixture = try independentFixture(round)
            var header = fixture["header"] as! [String: Any]; header["voice_status"] = "pending"
            fixture["header"] = header; try startAndConfirmText(&value, fixture: fixture)
        }
        let oldID = try XCTUnwrap(value.retainedVoiceResultIDs.first), current = value.header
        _ = try value.requestRetainedResult(processedID: oldID)
        let rejection: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "rejected",
            "session_id": "continuity", "processed_event_id": oldID, "request_operation": "result",
            "control_id": NSNull(), "event_id": NSNull(), "error_code": "SOURCE_REVOKED"]
        try value.accept(packet(rejection))
        XCTAssertEqual(try value.retainedVoiceResultIDs, [oldID])
        XCTAssertEqual(value.header, current)
        XCTAssertTrue(value.status.contains("SOURCE_REVOKED"))
    }
    func testRetiredReadyQueryAndLateVoiceCannotChangeCurrentPlaybackOwner() async throws {
        var old = try independentFixture(1)
        var oldHeader = old["header"] as! [String: Any]
        oldHeader["voice_status"] = "pending"; old["header"] = oldHeader
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        try startAndConfirmText(&value, fixture: old)
        let current = try independentFixture(2)
        try startAndConfirmText(&value, fixture: current)
        let activeAudio = try await playback(current)
        try value.receiveVoice(activeAudio)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        let activeHeader = value.header
        let oldID = try XCTUnwrap(value.retainedVoiceResultIDs.first)
        _ = try value.requestRetainedResult(processedID: oldID)
        oldHeader["voice_status"] = "ready"; oldHeader["result_revision"] = 2
        oldHeader["rendered_text_through_seq"] = 1; oldHeader["pending_text_chunk_count"] = 0
        try value.accept(packet(oldHeader))
        XCTAssertTrue(value.status.contains("ready"))
        XCTAssertEqual(value.header, activeHeader)
        XCTAssertTrue(try value.retainedVoiceResultIDs.isEmpty)
        XCTAssertFalse(value.pendingRenderedACKs.contains { String(data: $0, encoding: .utf8)?.contains("played") == true })
        let staleAudio = try await playback(old)
        try value.receiveVoice(staleAudio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staleAudio.resource.file.path))
        XCTAssertNil(try value.takeVoicePlayback())
        XCTAssertEqual(value.header, activeHeader)
        let completed = try XCTUnwrap(value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        let ack = try JSONSerialization.jsonObject(with: completed) as! [String: Any]
        XCTAssertEqual(ack["processed_event_id"] as? String, (current["accepted"] as! [String: Any])["processed_event_id"] as? String)
    }
    func testSameEventDifferentDVoiceCannotCancelCurrentPlayback() async throws {
        let current = try independentFixture(2)
        var value = try consumer(current)
        let activeAudio = try await playback(current)
        try value.receiveVoice(activeAudio)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        var stale = try independentFixture(1)
        var voice = stale["voice"] as! [String: Any]
        voice["event_id"] = (current["accepted"] as! [String: Any])["event_id"]!
        stale["voice"] = voice
        let staleAudio = try await playback(stale)
        try value.receiveVoice(staleAudio)
        XCTAssertNil(try value.takeVoicePlayback())
        XCTAssertNotNil(try value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
    }
    func testDuplicateFileIsReleasedButCurrentResourceAndConflictRuleRemain() async throws {
        let current = try independentFixture(2)
        var value = try consumer(current)
        let activeAudio = try await playback(current)
        try value.receiveVoice(activeAudio)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        try value.receiveVoice(activeAudio)
        XCTAssertTrue(FileManager.default.fileExists(atPath: playing.resource.file.path))
        let duplicate = try await playback(current)
        try value.receiveVoice(duplicate)
        XCTAssertFalse(FileManager.default.fileExists(atPath: duplicate.resource.file.path))
        var conflict = current
        var voice = conflict["voice"] as! [String: Any]
        var chunk = voice["chunk"] as! [String: Any]
        chunk["route_version"] = "conflicting-route"; voice["chunk"] = chunk; conflict["voice"] = voice
        let conflicting = try await playback(conflict)
        XCTAssertThrowsError(try value.receiveVoice(conflicting))
        XCTAssertFalse(FileManager.default.fileExists(atPath: conflicting.resource.file.path))
        XCTAssertNotNil(try value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
    }
    func testRetiredPendingUnknownAndInterruptedFeedbackKeepsCurrentBody() throws {
        var old = try independentFixture(1)
        var oldHeader = old["header"] as! [String: Any]
        oldHeader["voice_status"] = "pending"; old["header"] = oldHeader
        var value = AssistantCentralTextConsumer()
        let initial = try consumer(values())
        try value.reset(binding: initial.binding)
        try startAndConfirmText(&value, fixture: old)
        try startAndConfirmText(&value, fixture: independentFixture(2))
        let currentHeader = value.header, currentBody = value.presentation
        let oldID = try XCTUnwrap(value.retainedVoiceResultIDs.first)
        _ = try value.requestRetainedResult(processedID: oldID)
        try value.accept(packet(oldHeader))
        XCTAssertTrue(value.status.contains("pending"))
        oldHeader["voice_status"] = "reconcile_required"; oldHeader["result_revision"] = 2
        try value.accept(packet(oldHeader))
        XCTAssertTrue(value.status.contains("reconcile_required"))
        XCTAssertEqual(try value.retainedVoiceResultIDs, [oldID])
        _ = try value.requestRetainedResult(processedID: oldID)
        oldHeader["reply_phase"] = "interrupted"; oldHeader["result_revision"] = 3
        try value.accept(packet(oldHeader))
        XCTAssertTrue(value.status.contains("interrupted"))
        XCTAssertTrue(try value.retainedVoiceResultIDs.isEmpty)
        XCTAssertEqual(value.header, currentHeader)
        XCTAssertEqual(value.presentation, currentBody)
        XCTAssertFalse(value.pendingRenderedACKs.contains { String(data: $0, encoding: .utf8)?.contains("played") == true })
    }
    func testGetterWrongRequestedTypeThrowsWithoutTrap() throws {
        let fixture = try values()
        let header = try packet(fixture["header"]!)
        XCTAssertThrowsError(try header.fields.value("reply_epoch", as: String.self))
        XCTAssertThrowsError(try header.fields.value("reply_epoch", as: CentralBody.self))
        XCTAssertNil(try header.fields.value("missing_optional", as: Int.self))
    }
    func testGenerationRetryRequiresFailedCurrentEpochAndVoiceCapability() throws {
        var fixture = try values()
        var value = try consumer(fixture)
        XCTAssertFalse(try value.canRetryVoiceGeneration)
        var header = fixture["header"] as! [String: Any]
        header["voice_status"] = "failed"
        fixture["header"] = header
        try value.accept(packet(header))
        XCTAssertTrue(try value.canRetryVoiceGeneration)
        XCTAssertNotNil(try value.requestControl("retry_voice", controlID: "explicit-retry"))
        try value.cancelVoice()
        XCTAssertFalse(try value.canRetryVoiceGeneration)
        XCTAssertThrowsError(try value.requestControl("retry_voice", controlID: "explicit-retry"))
        var binding = fixture["trusted_binding"] as! [String: Any]
        binding.removeValue(forKey: "voice_transport")
        fixture["trusted_binding"] = binding
        let textOnly = try consumer(fixture)
        XCTAssertFalse(try textOnly.canRetryVoiceGeneration)
    }
    func testActualNodeOUTWAVToConsumerFakeCompletionToOriginalPlayedACK() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture)
        try consumer.receiveVoice(playback)
        let admitted = try XCTUnwrap(consumer.takeVoicePlayback())
        XCTAssertEqual(admitted, playback)
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty, "received WAV is not played")
        // Controlled callback only. This does not invoke AVAudioPlayer or a speaker.
        let player = FakePlayer()
        var ack: Data?
        player.play(playback) { success in
            ack = try? consumer.voiceCompleted(playback, successfully: success, observedAt: "2026-10-01T00:00:00.000Z")
        }
        XCTAssertNil(ack)
        player.finish(true)
        let actual = try JSONSerialization.jsonObject(with: XCTUnwrap(ack)) as! [String: Any]
        XCTAssertEqual(actual["ack"] as? NSDictionary, fixture["ack"] as? NSDictionary, "original OUT identity/seq/epoch/route retained")
        XCTAssertEqual(consumer.pendingRenderedACKs, [ack!])
        try consumer.receiveVoice(playback)
        XCTAssertNil(try consumer.takeVoicePlayback(), "lost ACK cannot restart playback")
        try consumer.accept(packet(fixture["ack_receipt"]!))
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
    }
    func testByteCompletionBeforeTextWaitsForOriginalTextProof() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture, text: false)
        try consumer.receiveVoice(playback)
        XCTAssertNil(try consumer.takeVoicePlayback())
        for chunk in fixture["text_chunks"] as! [[String: Any]] { try consumer.accept(packet(chunk)) }
        XCTAssertEqual(try consumer.takeVoicePlayback(), playback)
    }
    func testTargetRouteEpochAndTextRangeMismatchCannotStartPlayer() async throws {
        let fixture = try values(), resource = try await playback(fixture).resource
        for field in ["target_device_id", "route_version", "reply_epoch", "text_range"] {
            var envelope = fixture["voice"] as! [String: Any], chunk = envelope["chunk"] as! [String: Any]
            chunk[field] = field == "reply_epoch" ? 2 : field == "text_range" ? ["start": 0, "end": 99] : "forged"
            envelope["chunk"] = chunk
            var consumer = try consumer(fixture)
            try consumer.receiveVoice(CentralVoicePlayback(packet: packet(envelope), resource: resource))
            XCTAssertThrowsError(try consumer.takeVoicePlayback(), field)
            XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
        }
    }
    func testLocalStopRejectsLateCompletionAndRetransmittedSameEpoch() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture)
        try consumer.receiveVoice(playback); _ = try consumer.takeVoicePlayback()
        let bytes = try consumer.requestControl("cancel_playback", controlID: "local-stop")
        XCTAssertFalse(bytes.isEmpty)
        XCTAssertNil(consumer.playingVoice, "local playback window invalid before cloud receipt")
        XCTAssertThrowsError(try consumer.voiceCompleted(playback, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        try consumer.receiveVoice(playback)
        XCTAssertNil(try consumer.takeVoicePlayback())
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
    }
    func testNativeFailureNeedsExplicitOriginalWAVRetryAndNeverCreatesPlayed() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture)
        try consumer.receiveVoice(playback); _ = try consumer.takeVoicePlayback()
        XCTAssertNil(try consumer.voiceCompleted(playback, successfully: false, observedAt: ""))
        XCTAssertTrue(consumer.canRetryVoicePlayback)
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
        try consumer.receiveVoice(playback)
        XCTAssertNil(try consumer.takeVoicePlayback())
        try consumer.retryVoicePlayback()
        try consumer.receiveVoice(playback)
        XCTAssertEqual(try consumer.takeVoicePlayback(), playback)
    }
    func testWarmReconnectRetainsExactPlayedACKButCannotAutoplay() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture)
        try consumer.receiveVoice(playback); _ = try consumer.takeVoicePlayback()
        let ack = try XCTUnwrap(consumer.voiceCompleted(playback, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        let binding = consumer.binding!
        try consumer.reset(binding: nil)
        try consumer.reset(binding: binding)
        XCTAssertEqual(consumer.pendingRenderedACKs, [ack])
        try consumer.receiveVoice(playback)
        XCTAssertNil(try consumer.takeVoicePlayback())
        try consumer.accept(packet(fixture["ack_receipt"]!))
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
    }
    func testPlayedACKRetentionAcrossNextSubmissionUsesOriginalOwner() async throws {
        let fixture = try values(), playback = try await playback(fixture)
        var consumer = try consumer(fixture)
        try consumer.receiveVoice(playback); _ = try consumer.takeVoicePlayback()
        let ack = try XCTUnwrap(consumer.voiceCompleted(playback, successfully: true, observedAt: "2026-10-01T00:00:00.000Z"))
        _ = try consumer.beginSubmit(eventID: "next-submit", capturedAt: "2026-10-01T00:00:00.000Z", text: "next")
        XCTAssertEqual(consumer.pendingRenderedACKs, [ack])
        try consumer.accept(packet(fixture["ack_receipt"]!))
        XCTAssertTrue(consumer.pendingRenderedACKs.isEmpty)
    }
    func testTruncatedOrWrongHashReaderRemovesOnlyItsNewTemporaryResource() async throws {
        let fixture = try values(), packet = try packet(fixture["voice"]!), audio = try XCTUnwrap((try packet.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self)))
        let before = try FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path).filter { $0.hasPrefix("paios-formal-voice-") }.sorted()
        for bytes in [Data([1, 2]), Data(repeating: 0, count: (try audio.value("bytes", as: Int.self))!)] {
            let stream = AsyncThrowingStream<Data, Error> { c in c.yield(bytes); c.finish() }
            do { _ = try await CentralVoiceFile.receive(stream, audio: audio); XCTFail("invalid WAV bytes") } catch {}
        }
        let after = try FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path).filter { $0.hasPrefix("paios-formal-voice-") }.sorted()
        XCTAssertEqual(after, before)
        let resource = try await playback(fixture).resource
        for field in ["sample_rate", "channels", "duration_ms"] {
            var envelope = fixture["voice"] as! [String: Any], chunk = envelope["chunk"] as! [String: Any]
            if field == "duration_ms" {
                var declaredAudio = chunk["audio"] as! [String: Any]
                declaredAudio[field] = (declaredAudio[field] as! Int) + 1
                chunk["audio"] = declaredAudio
            } else { chunk[field] = field == "channels" ? 2 : 48000 }
            envelope["chunk"] = chunk
            let declared = try XCTUnwrap(self.packet(envelope).fields.value("chunk", as: CentralBody.self))
            XCTAssertThrowsError(try resource.validate(chunk: declared), field)
        }
    }
}
private final class FakePlayer {
    var callback: ((Bool) -> Void)?
    func play(_ value: CentralVoicePlayback, completed: @escaping (Bool) -> Void) { callback = completed }
    func finish(_ success: Bool) { let current = callback; callback = nil; current?(success) }
}


extension FormalVoiceBoundaryTests {
    func testQueuedVoiceBytesWaitForForegroundPlayedReceipt() async throws {
        let original = try values()
        var value = try consumer(original)
        let originalDisplayed = try XCTUnwrap(value.presentation)
        XCTAssertNil(value.renderedACK, "Speech can play while chat is hidden")
        let first = try await playback(original)
        try value.receiveVoice(first)
        let playing = try XCTUnwrap(value.takeVoicePlayback())
        let oldEvent = value.eventID
        XCTAssertFalse(try value.canPromotePending)
        _ = try value.beginSubmit(eventID: "voice-queued-next", capturedAt: "2026-10-17T00:00:00.000Z", text: "下一句")
        var next = original
        var nextHeader = next["header"] as! [String: Any]
        nextHeader["reply_mode"] = "voice"; nextHeader["text_chunk_count"] = 0
        nextHeader["pending_text_chunk_count"] = 0; nextHeader["rendered_text_through_seq"] = 0
        next["header"] = nextHeader
        for key in ["accepted", "header", "voice"] {
            var fields = next[key] as! [String: Any]
            fields["event_id"] = "voice-queued-next"; fields["processed_event_id"] = "d-voice-queued-next"
            if var admission = fields["admission"] as? [String: Any] {
                admission["idempotency_key"] = "queue-next"; fields["admission"] = admission
            }
            next[key] = fields
        }
        try value.accept(packet(next["accepted"]!)); try value.accept(packet(next["header"]!))
        let queued = try await playback(next)
        try value.receiveVoice(queued)
        XCTAssertEqual(value.eventID, oldEvent)
        XCTAssertTrue(FileManager.default.fileExists(atPath: queued.resource.file.path))
        XCTAssertNil(try value.takeVoicePlayback())
        let ack = try XCTUnwrap(value.voiceCompleted(playing, successfully: true, observedAt: "2026-10-17T00:00:01.000Z"))
        var receipt = original["ack_receipt"] as! [String: Any]
        var played = (try JSONSerialization.jsonObject(with: ack) as! [String: Any])["ack"] as! [String: Any]
        played["receipt_ref"] = "queue-old-played"; receipt["receipt"] = played
        try value.accept(packet(receipt))
        XCTAssertEqual(value.eventID, "voice-queued-next")
        XCTAssertEqual(try value.takeVoicePlayback(), queued)
        let delayedACK = try XCTUnwrap(value.consumedByUI(originalDisplayed, observedAt: "2026-10-17T00:00:02.000Z"))
        let delayed = try XCTUnwrap(JSONSerialization.jsonObject(with: delayedACK) as? [String: Any])
        XCTAssertEqual(delayed["processed_event_id"] as? String, (original["accepted"] as! [String: Any])["processed_event_id"] as? String)
        XCTAssertEqual(value.eventID, "voice-queued-next", "Delayed original text consumption cannot reclaim playback")
    }
}

extension FormalVoiceBoundaryTests {
    func testDiscardingPendingObservationRemovesItsBufferedWAV() async throws {
        for changedOwner in [false, true] {
            let original = try values(), next = try independentFixture(changedOwner ? 402 : 401)
            var value = try consumer(original)
            let first = try await playback(original)
            try value.receiveVoice(first)
            _ = try XCTUnwrap(value.takeVoicePlayback())
            let submit = next["submit"] as! [String: String]
            _ = try value.beginSubmit(eventID: submit["event_id"]!, capturedAt: submit["captured_at"]!, text: submit["text"]!)
            try value.accept(packet(next["accepted"]!)); try value.accept(packet(next["header"]!))
            let buffered = try await playback(next)
            try value.receiveVoice(buffered)
            XCTAssertTrue(FileManager.default.fileExists(atPath: buffered.resource.file.path))
            try value.reset(binding: changedOwner ? value.binding : nil, generation: changedOwner ? 2 : nil,
                ownerPairingIdentity: changedOwner ? "another-owner" : nil)
            XCTAssertFalse(FileManager.default.fileExists(atPath: buffered.resource.file.path), "changedOwner=\(changedOwner)")
        }
    }

    func testReconnectDiscardsUnplayedBufferWithoutBlockingLaterReply() async throws {
        let fixture = try values()
        var value = try consumer(fixture)
        let textACK = try XCTUnwrap(value.consumedByUI(XCTUnwrap(value.presentation), observedAt: "2026-10-17T00:00:00.000Z"))
        var receipt = fixture["ack_receipt"] as! [String: Any]
        var rendered = (try JSONSerialization.jsonObject(with: textACK) as! [String: Any])["ack"] as! [String: Any]
        rendered["receipt_ref"] = "text-before-unplayed-reset"; receipt["receipt"] = rendered
        try value.accept(packet(receipt))
        XCTAssertTrue(value.ackConfirmed)
        let audio = try await playback(fixture)
        try value.receiveVoice(audio)
        XCTAssertFalse(try value.canPromotePending)
        let binding = try XCTUnwrap(value.binding)
        try value.reset(binding: nil, generation: 2)
        try value.reset(binding: binding, generation: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: audio.resource.file.path))
        XCTAssertNil(try value.takeVoicePlayback(), "Reconnect does not automatically replay discarded speech")
        XCTAssertTrue(try value.canPromotePending, "Discarded buffered speech cannot hold later replies forever")
        XCTAssertTrue(value.canRetryVoicePlayback, "The original WAV remains explicitly retryable")
        try value.retryVoicePlayback()
        XCTAssertNoThrow(try value.requestResult(sealed: true))
    }
}
