import XCTest
@testable import HealthKitExporter
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class WatchTalkTests: XCTestCase {
    private let scope = WatchBindingScope(watch_device_id: "47ea18be-77ce-489d-aa00-d2343f7cbf94", pair_version: "1")
    private func audio() -> WatchUtterance {
        WatchUtterance(id: UUID(), bytes: Data([1, 2, 3]), durationMilliseconds: 1000, scope: scope)
    }
    private func credential(token: String = "token", scope: WatchBindingScope? = nil) -> WatchCredential {
        WatchCredential(version: 1, kind: "watch_credential", token: token, expires_at: "2099-01-01T00:00:00Z",
                        server: "https://example.invalid", scope: scope ?? self.scope)
    }
    func testSilenceMaximumAndExplicitEnd() {
        var segmenter = WatchRecorderSegmenter()
        XCTAssertNil(segmenter.sample(elapsed: 0.1, level: -20))
        XCTAssertNil(segmenter.sample(elapsed: 1.29, level: -70))
        XCTAssertEqual(segmenter.sample(elapsed: 1.31, level: -70), .silence)
        XCTAssertEqual(segmenter.finish(wristDown: true), .silence)
        var maximum = WatchRecorderSegmenter()
        XCTAssertEqual(maximum.sample(elapsed: 30, level: -10), .maximumDuration)
        var wrist = WatchRecorderSegmenter()
        XCTAssertEqual(wrist.finish(wristDown: true), .wristDown)
        var manual = WatchRecorderSegmenter()
        XCTAssertEqual(manual.finish(), .manual)
        var empty = WatchRecorderSegmenter()
        XCTAssertEqual(empty.sample(elapsed: 1.21, level: -80), .silence)
    }
    func testAmbiguousUploadMustPollBeforeManualIdenticalResend() {
        var state = WatchTalkState()
        let value = audio()
        XCTAssertTrue(state.startByUser())
        XCTAssertEqual(state.recorded(value), .upload(value))
        XCTAssertNil(state.recorded(value))
        state.transportFailed()
        XCTAssertEqual(state.retryByUser(), .poll(value.id))
        XCTAssertNil(state.retryByUser())
        state.receivedFailure(.turn_not_found, polling: true)
        XCTAssertEqual(state.phase, .failure)
        XCTAssertNil(state.resumePoll()) // A GET never automatically becomes POST.
        XCTAssertEqual(state.retryByUser(), .upload(value))
        XCTAssertEqual(state.utterance?.id, value.id)
        XCTAssertEqual(state.utterance?.bytes, value.bytes)
        XCTAssertNil(state.retryByUser())
    }
    func testAcceptedTurnRetriesOnlyPollAndReplyNeverListens() {
        var state = WatchTalkState()
        let value = audio()
        XCTAssertTrue(state.startByUser())
        _ = state.recorded(value)
        state.receivedHeard("你好")
        XCTAssertEqual(state.resumePoll(), .poll(value.id))
        state.pausePoll()
        XCTAssertEqual(state.resumePoll(), .poll(value.id))
        state.transportFailed()
        XCTAssertEqual(state.retryByUser(), .poll(value.id))
        state.receivedReply("在呢")
        XCTAssertEqual(state.phase, .reply)
        XCTAssertEqual(state.heard, "你好")
        XCTAssertEqual(state.reply, "在呢")
        XCTAssertFalse(state.canRetry)
        XCTAssertNil(state.resumePoll())
        XCTAssertNil(state.retryByUser())
        XCTAssertTrue(state.startByUser()) // Only an explicit next tap can listen.
    }
    func testFailureScreensAndNoAutomaticListeningAfterUnclearSpeech() {
        var state = WatchTalkState()
        XCTAssertTrue(state.startByUser())
        _ = state.recorded(audio())
        state.receivedFailure(.not_heard, polling: false)
        XCTAssertEqual(state.phase, .failure)
        XCTAssertEqual(state.failureScreen, .server)
        XCTAssertFalse(state.canRetry)
        XCTAssertNil(state.resumePoll())
        XCTAssertNil(state.retryByUser())
        XCTAssertEqual(WatchTalkFailure.service_unavailable.screen, .server)
        XCTAssertEqual(WatchTalkFailure.watch_unregistered.screen, .registration)
        state.recordingFailed("无权限")
        XCTAssertEqual(state.failureScreen, .microphone)
        state.recordingFailed("无网络", screen: .network)
        XCTAssertEqual(state.failureScreen, .network)
        state.reset()
        XCTAssertTrue(state.startByUser())
        _ = state.recorded(audio())
        state.receivedWorking()
        state.prolongedThinking()
        XCTAssertEqual(state.failureScreen, .delayed)
        XCTAssertEqual(state.phase, .thinking)
    }
    func testScopeResetErasesOldTurnAndRefreshPreservesRequest() throws {
        var state = WatchTalkState()
        let value = audio()
        XCTAssertTrue(state.startByUser())
        let action = try XCTUnwrap(state.recorded(value))
        let original = try WatchTalkHTTP.request(action, credential: credential())
        let refresh = try WatchTalkHTTP.request(action, credential: credential(token: "rotated"))
        XCTAssertEqual(original.httpBody, refresh.httpBody)
        XCTAssertEqual(original.value(forHTTPHeaderField: "X-Watch-Turn-ID"), refresh.value(forHTTPHeaderField: "X-Watch-Turn-ID"))
        XCTAssertEqual(refresh.value(forHTTPHeaderField: "Authorization"), "Bearer rotated")
        let replacement = WatchBindingScope(watch_device_id: scope.watch_device_id, pair_version: "2")
        XCTAssertThrowsError(try WatchTalkHTTP.request(action, credential: credential(scope: replacement)))
        state.reset()
        XCTAssertNil(state.utterance)
        XCTAssertNil(state.heard)
        XCTAssertNil(state.retryByUser())
        XCTAssertNil(state.resumePoll())
    }
    func testFrozenUploadAndPollWire() throws {
        let value = audio()
        let request = try WatchTalkHTTP.request(.upload(value), credential: credential())
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/v1/watch/utterances")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.httpBody, value.bytes)
        let expected = ["X-Watch-Turn-ID": value.id.uuidString.lowercased(), "X-Watch-Codec": "aac_lc",
                        "X-Watch-Sample-Rate-Hz": "16000", "X-Watch-Channels": "1",
                        "X-Watch-Duration-Ms": "1000", "Content-Type": "audio/mp4", "Authorization": "Bearer token"]
        for (key, text) in expected { XCTAssertEqual(request.value(forHTTPHeaderField: key), text) }
        let poll = try WatchTalkHTTP.request(.poll(value.id), credential: credential())
        XCTAssertEqual(poll.httpMethod, "GET")
        XCTAssertEqual(poll.url?.path, "/v1/watch/turns/\(value.id.uuidString.lowercased())")
        XCTAssertEqual(poll.url?.query, "wait=25")
        XCTAssertNil(poll.httpBody)
    }
    func testStrictResponsesRejectCrossTurnExtraFieldsAndWrongEndpoint() throws {
        let value = audio()
        let id = value.id.uuidString
        func data(_ text: String) -> Data { Data(text.utf8) }
        XCTAssertEqual(try WatchTalkHTTP.decode(data("{\"status\":\"heard\",\"turn_id\":\"\(id)\",\"heard\":\"你好\"}"), statusCode: 200, action: .upload(value)), .heard("你好"))
        XCTAssertEqual(try WatchTalkHTTP.decode(data("{\"status\":\"working\",\"turn_id\":\"\(id)\"}"), statusCode: 200, action: .poll(value.id)), .working)
        XCTAssertEqual(try WatchTalkHTTP.decode(data("{\"status\":\"replied\",\"turn_id\":\"\(id)\",\"text\":\"在呢\"}"), statusCode: 200, action: .poll(value.id)), .replied("在呢"))
        for text in ["{\"status\":\"working\",\"turn_id\":\"\(UUID())\"}",
                     "{\"status\":\"working\",\"turn_id\":\"\(id)\",\"extra\":1}",
                     "{\"status\":\"failed\",\"reason\":\"unknown\"}"] {
            XCTAssertThrowsError(try WatchTalkHTTP.decode(data(text), statusCode: 200, action: .poll(value.id)))
        }
        XCTAssertThrowsError(try WatchTalkHTTP.decode(data("{\"status\":\"working\",\"turn_id\":\"\(id)\"}"), statusCode: 200, action: .upload(value)))
        XCTAssertEqual(try WatchTalkHTTP.decode(data("{\"status\":\"failed\",\"reason\":\"not_heard\"}"), statusCode: 422, action: .upload(value)), .failed(.not_heard))
        XCTAssertThrowsError(try WatchTalkHTTP.decode(data("{\"status\":\"failed\",\"reason\":\"not_heard\"}"), statusCode: 200, action: .upload(value)))
    }
    func testAudioIngressLimits() {
        for (bytes, duration) in [(Data(), 1000), (Data([1]), 0), (Data([1]), 30001), (Data(repeating: 1, count: 1_000_001), 1000)] {
            let value = WatchUtterance(id: UUID(), bytes: bytes, durationMilliseconds: duration, scope: scope)
            XCTAssertThrowsError(try WatchTalkHTTP.request(.upload(value), credential: credential()))
        }
    }
}
