import Foundation
import XCTest
@testable import HealthKitExporter

final class WatchYimiMessagesTests: XCTestCase {
    private var state: [String: Any] {
        ["version": 1, "kind": "yimi_state", "rev": 3, "link": "ok", "scope": scope,
         "latest": ["card_id": "reply-1", "title": "依米", "lines": ["在呢"], "created_at": "2026-10-16T00:00:00Z", "kind": "message"],
         "question": ["card_id": "question-1", "question": "选哪项？", "options": [["id": "one", "label": "第一项", "lines": [], "recommended": true], ["id": "two", "label": "第二项", "lines": [], "recommended": false]], "expires_at": "2026-10-16T00:00:30Z"],
         "errands": [["job_id": "job-1", "title": "查资料", "step": 1, "max_steps": 3, "state": "running"]],
         "care": ["care_id": "care-1", "text": "你还好吗？"],
         "payment_pending": ["count": 1, "summary": "请在 iPhone 上确认"],
         "ride": ["hr_zone": 4, "text": "慢一点", "max_hr_bpm": 175]]
    }
    private let scope: [String: Any] = ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": "7"]
    private func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func decode(_ value: Any) throws -> WatchYimiState { try JSONDecoder().decode(WatchYimiState.self, from: data(value)) }

    func testStateRoundTripsAllProjectionsAndLinks() throws {
        for link in ["ok", "server_unreachable", "watch_unregistered"] {
            var value = state; value["link"] = link
            if link == "watch_unregistered" { value.removeValue(forKey: "scope") }
            let decoded = try decode(value)
            XCTAssertEqual(try WatchYimiState.decodeStrict(decoded.encodedStrict()), decoded)
            XCTAssertLessThanOrEqual(try decoded.encodedStrict().count, 8192)
        }
    }
    func testRejectsUnknownKeysAtEveryNestedBoundaryWithOrdinaryDecoder() throws {
        var value = state; value["avatar"] = [:]
        XCTAssertThrowsError(try decode(value))
        for key in ["latest", "question", "care", "payment_pending", "ride"] {
            var value = state, nested = try XCTUnwrap(state[key] as? [String: Any]); nested["unknown"] = true; value[key] = nested
            XCTAssertThrowsError(try decode(value), key)
        }
        var value2 = state, errands = try XCTUnwrap(state["errands"] as? [[String: Any]])
        errands[0]["unknown"] = 1; value2["errands"] = errands; XCTAssertThrowsError(try decode(value2))
        var value3 = state, question = try XCTUnwrap(state["question"] as? [String: Any])
        var options = try XCTUnwrap(question["options"] as? [[String: Any]]); options[0]["unknown"] = 1
        question["options"] = options; value3["question"] = question; XCTAssertThrowsError(try decode(value3))
    }
    func testRejectsVersionsKindsLinksAndNegativeRevision() throws {
        for (key, bad) in [("version", 2 as Any), ("kind", "state"), ("link", "offline"), ("rev", -1)] {
            var value = state; value[key] = bad; XCTAssertThrowsError(try decode(value))
        }
    }
    func testAbsentProjectionsAreNotInvented() throws {
        let decoded = try decode(["version": 1, "kind": "yimi_state", "rev": 0, "link": "watch_unregistered", "errands": [], "payment_pending": ["count": 0, "summary": ""]])
        XCTAssertNil(decoded.latest); XCTAssertNil(decoded.question); XCTAssertNil(decoded.care); XCTAssertNil(decoded.ride)
    }

    func testRideSensorDatesRoundTripAndMalformedDatesAreRejected() throws {
        let at = "2026-10-20T08:00:00.125Z"
        let metrics = WatchYimiRideMetrics(ride_id: "r", workout_id: "w", ended: false, speed_kmh: 24, avg_kmh: 20,
            max_kmh: 30, distance_m: 1000, elapsed_s: 180, moving_s: 180, hr_bpm: 140, hr_avg: nil, hr_max: nil, kcal: 20,
            hr_sample_at: at, speed_sample_at: at)
        let bytes = try JSONEncoder().encode(metrics)
        XCTAssertEqual(try JSONDecoder().decode(WatchYimiRideMetrics.self, from: bytes), metrics)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        object["hr_sample_at"] = "today"
        XCTAssertThrowsError(try JSONDecoder().decode(WatchYimiRideMetrics.self, from: data(object)))
        object.removeValue(forKey: "hr_sample_at"); object.removeValue(forKey: "speed_sample_at")
        let legacy = try JSONDecoder().decode(WatchYimiRideMetrics.self, from: data(object))
        XCTAssertNil(legacy.hr_sample_at); XCTAssertNil(legacy.speed_sample_at)
    }
    func testLatestHasSixHundredCharacterLimitIncludingUnicode() throws {
        var value = state, latest = try XCTUnwrap(state["latest"] as? [String: Any])
        latest["lines"] = [String(repeating: "米", count: 600)]; value["latest"] = latest; _ = try decode(value)
        latest["lines"] = [String(repeating: "米", count: 601)]; value["latest"] = latest; XCTAssertThrowsError(try decode(value))
    }
    func testEightKiBBoundaryOnEncodingAndDecoding() throws {
        var value = state; value.removeValue(forKey: "latest"); value.removeValue(forKey: "question")
        value["errands"] = []; value["payment_pending"] = ["count": 0, "summary": ""]
        let base = try decode(value), bytes = try base.encodedStrict().count
        let exact = WatchYimiState(version: 1, kind: "yimi_state", rev: base.rev, link: base.link, scope: base.scope, latest: nil, question: nil, errands: [], care: base.care,
                                  payment_pending: WatchYimiPaymentPending(count: 0, summary: String(repeating: "a", count: 8192 - bytes)), ride: base.ride)
        XCTAssertEqual(try exact.encodedStrict().count, 8192)
        let tooLarge = WatchYimiState(version: 1, kind: "yimi_state", rev: base.rev, link: base.link, scope: base.scope, latest: nil, question: nil, errands: [], care: base.care,
                                     payment_pending: WatchYimiPaymentPending(count: 0, summary: String(repeating: "a", count: 8193 - bytes)), ride: base.ride)
        XCTAssertThrowsError(try tooLarge.encodedStrict())
        XCTAssertThrowsError(try WatchYimiState.decodeStrict(JSONEncoder().encode(tooLarge)))
        XCTAssertThrowsError(try JSONDecoder().decode(WatchYimiState.self, from: JSONEncoder().encode(tooLarge)))
    }
    func testPaymentCannotCarryButtonsOrMultipleLines() throws {
        for pending: [String: Any] in [["count": 1, "summary": "确认", "buttons": []], ["count": -1, "summary": ""], ["count": 1, "summary": "第一行\n第二行"]] {
            var value = state; value["payment_pending"] = pending; XCTAssertThrowsError(try decode(value))
        }
    }
    func testCredentialIsVersionedStrictAndHTTPSOnly() throws {
        let credential: [String: Any] = ["version": 1, "kind": "watch_credential", "token": "test-token", "expires_at": "2026-10-23T00:00:00Z", "server": "https://example.invalid:9443", "scope": scope]
        let decoded = try JSONDecoder().decode(WatchCredential.self, from: data(credential))
        XCTAssertEqual(decoded.token, "test-token")
        XCTAssertEqual(decoded.scope, try decode(state).scope)
        for (key, bad) in [("extra", true as Any), ("version", 2), ("kind", "other"), ("server", "http://example.invalid"), ("token", ""), ("expires_at", "tomorrow"),
                           ("scope", ["watch_device_id": "not-a-uuid", "pair_version": "7"])] {
            var value = credential; value[key] = bad
            XCTAssertThrowsError(try JSONDecoder().decode(WatchCredential.self, from: data(value)), key)
        }
        var unscoped = credential; unscoped.removeValue(forKey: "scope")
        XCTAssertThrowsError(try JSONDecoder().decode(WatchCredential.self, from: data(unscoped)))
    }
    func testScopeIsPresentExactlyWhileRegistered() throws {
        for link in ["ok", "server_unreachable"] {
            var value = state; value["link"] = link; value.removeValue(forKey: "scope")
            XCTAssertThrowsError(try decode(value), link)
        }
        var unregistered = state; unregistered["link"] = "watch_unregistered"
        XCTAssertThrowsError(try decode(unregistered))
    }
    func testScopeIsExactlyTheServerBindingShape() throws {
        XCTAssertEqual(try decode(state).scope, WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "7"))
        for bad: [String: Any] in [["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427"], ["pair_version": "7"],
                                   ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": "7", "owner": "a"],
                                   ["watch_device_id": "", "pair_version": "7"],
                                   ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": 7],
                                   ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": "0"],
                                   ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": "07"],
                                   ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": String(repeating: "9", count: 39)]] {
            var value = state; value["scope"] = bad
            XCTAssertThrowsError(try decode(value), "\(bad)")
        }
        var longest = state; longest["scope"] = ["watch_device_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "pair_version": String(repeating: "9", count: 38)]
        XCTAssertNoThrow(try decode(longest))
    }
    func testEveryYimiActionUsesExistingRequestReceiptEnvelope() throws {
        let actions: [(WatchAssistantAction, WatchYimiActionArguments)] = [(.cardAnswer, .init(card_id: "c", option_id: "o")), (.errandStop, .init(job_id: "j")),
            (.careSafe, .init(care_id: "care")), (.stateRequest, .init()), (.credentialRefresh, .init())]
        for (action, args) in actions {
            let request = WatchLocalEnvelope(kind: .request, action: action, requestID: "r", sequence: 1, version: 1, args: args)
            XCTAssertEqual(try WatchLocalEnvelope.decodeStrict(request.encodedStrict()), request)
            let receipt = WatchLocalEnvelope(kind: .acknowledgement, action: action, requestID: "r", sequence: 1, status: .accepted, version: 1)
            XCTAssertEqual(try WatchLocalEnvelope.decodeStrict(receipt.encodedStrict()), receipt)
        }
    }
    func testActionRejectsMissingExtraWrongNullAndUnversionedArgs() throws {
        let valid: [String: Any] = ["version": 1, "kind": "request", "action": "card_answer", "requestID": "r", "sequence": 1, "args": ["card_id": "c", "option_id": "o"]]
        for args: Any in [[:], ["card_id": "c"], ["card_id": "c", "option_id": "o", "job_id": "j"], ["card_id": "c", "option_id": "o", "extra": "x"], ["card_id": "c", "option_id": "o", "job_id": NSNull()]] {
            var value = valid; value["args"] = args
            XCTAssertThrowsError(try JSONDecoder().decode(WatchLocalEnvelope.self, from: data(value)))
        }
        for version: Any in [NSNull(), 0, 2] {
            var value = valid; value["version"] = version
            XCTAssertThrowsError(try WatchLocalEnvelope.decodeStrict(data(value)))
        }
        var extra = valid; extra["extra"] = 1; XCTAssertThrowsError(try WatchLocalEnvelope.decodeStrict(data(extra)))
    }
    func testLegacyEnvelopeWireContractRemainsAvailableUntilLaneThreeRemoval() throws {
        let legacy = WatchLocalEnvelope(request: WatchAssistantPacket(action: .requestVoiceSession, requestID: "old", sequence: 1))
        XCTAssertEqual(try WatchLocalEnvelope.decodeStrict(legacy.encodedStrict()), legacy)
    }
}
