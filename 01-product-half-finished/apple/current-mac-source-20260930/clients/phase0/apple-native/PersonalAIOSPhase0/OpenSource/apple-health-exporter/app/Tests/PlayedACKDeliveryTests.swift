import Foundation
import XCTest
@testable import HealthKitExporter

extension FormalVoiceBoundaryTests {
    func testPlayedACKFailureThenReconnectOrCancelReleasesQueuedWAVWithoutReplaying() async throws {
        for reconnect in [false, true] {
            var fixture = try values(), header = fixture["header"] as! [String: Any]
            header["voice_status"] = "pending"; header["pending_voice_chunk_count"] = 1
            fixture["header"] = header
            var value = try consumer(fixture)
            let binding = try XCTUnwrap(value.binding)
            var chunks: [CentralVoicePlayback] = []
            for sequence in 1...2 {
                var envelope = fixture["voice"] as! [String: Any]
                var chunk = envelope["chunk"] as! [String: Any]
                chunk["seq"] = sequence; chunk["final"] = false
                envelope["chunk"] = chunk; fixture["voice"] = envelope
                chunks.append(try await playback(fixture))
            }
            try value.receiveVoice(chunks[0])
            let first = try XCTUnwrap(value.takeVoicePlayback())
            try value.receiveVoice(chunks[1])
            let ack = try XCTUnwrap(value.voiceCompleted(first, successfully: true,
                observedAt: "2026-10-01T00:00:01.000Z"))
            value.reportPlayedACKDeliveryFailure(CentralTextError.unavailable)
            if reconnect {
                try value.reset(binding: nil, generation: 2)
                try value.reset(binding: binding, generation: 3)
            } else {
                try value.cancelVoice()
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: chunks[1].resource.file.path),
                "ending the playback window must release every owned queued WAV")
            XCTAssertEqual(value.pendingRenderedACKs, [ack], "recovery resends the original played fact")
            XCTAssertNil(try value.takeVoicePlayback(), "reconnect and cancellation never replay completed speech")
            XCTAssertThrowsError(try value.voiceCompleted(first, successfully: true,
                observedAt: "2026-10-01T00:00:02.000Z"), "old playback callbacks cannot advance the watermark")
        }
    }

    func testPlayedACKPublishFailurePreservesBufferedWAVsAndOriginalACK() async throws {
        var fixture = try values(), header = fixture["header"] as! [String: Any]
        header["voice_status"] = "pending"; header["pending_voice_chunk_count"] = 1
        fixture["header"] = header
        var value = try consumer(fixture)
        var chunks: [CentralVoicePlayback] = []
        for sequence in 1...3 {
            var envelope = fixture["voice"] as! [String: Any]
            var chunk = envelope["chunk"] as! [String: Any]
            chunk["seq"] = sequence; chunk["final"] = false
            envelope["chunk"] = chunk; fixture["voice"] = envelope
            chunks.append(try await playback(fixture))
        }
        try value.receiveVoice(chunks[0])
        let first = try XCTUnwrap(value.takeVoicePlayback())
        for next in chunks.dropFirst() { try value.receiveVoice(next) }
        let ack = try XCTUnwrap(value.voiceCompleted(first, successfully: true,
            observedAt: "2026-10-01T00:00:01.000Z"))

        // A same-generation publish failure preserves playback ownership and the original ACK.
        value.reportPlayedACKDeliveryFailure(CentralTextError.unavailable)
        XCTAssertEqual(value.pendingRenderedACKs, [ack], "retry must preserve the exact observed-at and idempotency bytes")
        XCTAssertEqual(value.pendingVoice, chunks[1], "ACK delivery cannot discard the next owned WAV")
        let second = try XCTUnwrap(value.takeVoicePlayback(), "the next WAV must remain playable without retransmission")
        XCTAssertEqual(second, chunks[1])
        XCTAssertThrowsError(try value.voiceCompleted(first, successfully: true,
            observedAt: "2026-10-01T00:00:02.000Z"), "a delayed completion cannot confirm or replay the old chunk")
        let secondACK = try XCTUnwrap(value.voiceCompleted(second, successfully: true,
            observedAt: "2026-10-01T00:00:02.000Z"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: secondACK) as? [String: Any])
        XCTAssertEqual((body["ack"] as? [String: Any])?["highest_contiguous_seq"] as? Int, 2)
        XCTAssertEqual(value.pendingRenderedACKs, [secondACK])
        XCTAssertEqual(value.pendingVoice, chunks[2])
        try value.cancelVoice()
        XCTAssertFalse(FileManager.default.fileExists(atPath: chunks[2].resource.file.path), "cancellation releases the still-owned queued WAV")
        XCTAssertNil(try value.takeVoicePlayback())
    }
}
