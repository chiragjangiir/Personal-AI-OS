import Foundation
import XCTest
@testable import HealthKitExporter

final class WatchStateReducerTests: XCTestCase {
    private let a = WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "7")
    private let b = WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "8")
    private func state(_ scope: WatchBindingScope?, _ rev: UInt64, question: WatchYimiQuestion? = nil, errands: [WatchYimiErrand] = []) -> WatchYimiState {
        WatchYimiState(version: 1, kind: "yimi_state", rev: rev, link: scope == nil ? .watch_unregistered : .ok, scope: scope,
            latest: .init(card_id: "card-\(rev)", title: "依米", lines: ["消息"], created_at: "2026-10-16T00:00:00Z", kind: .message),
            question: question, errands: errands, care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
    }
    private func request(_ option: String = "one") -> WatchLocalEnvelope {
        .init(kind: .request, action: .cardAnswer, requestID: "request-1", sequence: 1, version: 1,
              args: .init(card_id: "card-1", option_id: option))
    }
    private func receipt(_ sequence: UInt64 = 1) -> WatchLocalEnvelope {
        .init(kind: .acknowledgement, action: .cardAnswer, requestID: "request-1", sequence: sequence, status: .accepted, version: 1)
    }
    func testRefreshAndDelayedRevOneStayStale() {
        var reducer = WatchStateReducer(state: state(a, 20))
        XCTAssertFalse(reducer.apply(state(a, 20), fromContext: true))
        XCTAssertFalse(reducer.apply(state(a, 1), fromContext: true))
        XCTAssertFalse(reducer.apply(state(a, 1), fromContext: false))
        XCTAssertEqual(reducer.state?.rev, 20)
    }
    func testReplacementRevOneClearsOldRequestsAndReceipts() throws {
        var reducer = WatchStateReducer(state: state(a, 20))
        try reducer.begin(request(), scope: a)
        XCTAssertTrue(reducer.receive(receipt(), scope: a))
        try reducer.begin(.init(kind: .request, action: .stateRequest, requestID: "pending", sequence: 2, version: 1, args: .init()), scope: a)
        XCTAssertTrue(reducer.apply(state(b, 1), fromContext: true))
        XCTAssertEqual(reducer.scope, b); XCTAssertEqual(reducer.state?.rev, 1)
        XCTAssertTrue(reducer.pending.isEmpty); XCTAssertTrue(reducer.receipts.isEmpty)
        XCTAssertFalse(reducer.receive(receipt(), scope: a))
    }
    func testNilRevocationAndMessageCannotEstablishBinding() {
        var reducer = WatchStateReducer(state: state(a, 20))
        XCTAssertFalse(reducer.apply(state(b, 99), fromContext: false))
        XCTAssertEqual(reducer.scope, a)
        XCTAssertTrue(reducer.apply(state(nil, 1), fromContext: true))
        XCTAssertNil(reducer.scope)
        XCTAssertFalse(reducer.apply(state(a, 21), fromContext: false))
    }
    func testMissedIntermediateContextsAndColdLaunchFence() throws {
        var beforeRestart = WatchStateReducer(state: state(a, 89))
        XCTAssertTrue(beforeRestart.apply(state(a, 90), fromContext: false))
        let saved = try XCTUnwrap(beforeRestart.state).encodedStrict()
        var reducer = WatchStateReducer(state: try WatchYimiState.decodeStrict(saved))
        XCTAssertFalse(reducer.apply(state(a, 3), fromContext: true))
        let c = WatchBindingScope(watch_device_id: b.watch_device_id, pair_version: "2")
        XCTAssertTrue(reducer.apply(state(c, 1), fromContext: true))
        XCTAssertEqual(reducer.scope, c) // Scope is equality-only, never numerically ordered.
    }
    func testReceiptCorrelationAndChangedArgumentFingerprint() throws {
        var reducer = WatchStateReducer(state: state(a, 1))
        try reducer.begin(request(), scope: a)
        XCTAssertThrowsError(try reducer.begin(request("two"), scope: a))
        XCTAssertFalse(reducer.receive(receipt(2), scope: a))
        XCTAssertFalse(reducer.receive(receipt(), scope: b))
        XCTAssertTrue(reducer.receive(receipt(), scope: a))
        XCTAssertFalse(reducer.receive(receipt(), scope: a))
    }
    func testCredentialRefreshMismatchNoStateAndExpiry() throws {
        var reducer = WatchStateReducer(state: state(a, 20))
        let now = WatchStateReducer.date("2026-10-16T00:00:00Z")!
        func credential(_ scope: WatchBindingScope, _ token: String) -> WatchCredential {
            .init(version: 1, kind: "watch_credential", token: token, expires_at: "2026-10-17T00:00:00Z", server: "https://example.test", scope: scope)
        }
        try reducer.receiveCredential(credential(a, "first"), contextState: state(a, 20), now: now)
        try reducer.receiveCredential(credential(a, "refresh"), contextState: state(a, 20), now: now)
        XCTAssertEqual(reducer.credential?.token, "refresh")
        XCTAssertFalse(reducer.apply(state(a, 1), fromContext: true))
        XCTAssertThrowsError(try reducer.receiveCredential(credential(b, "wrong"), contextState: state(a, 21), now: now))
        XCTAssertThrowsError(try reducer.receiveCredential(credential(a, "alone"), contextState: nil, now: now))
        XCTAssertEqual(reducer.credential?.token, "refresh")
        XCTAssertNil(reducer.validCredential(at: now.addingTimeInterval(86_400)))
        XCTAssertTrue(reducer.apply(state(b, 1), fromContext: true))
        XCTAssertNil(reducer.credential)
        try reducer.receiveCredential(credential(b, "owner-b"), contextState: state(b, 1), now: now)
        XCTAssertTrue(reducer.apply(state(nil, 1), fromContext: true))
        XCTAssertNil(reducer.credential)
    }
    func testColdLaunchRetainsCredentialOnlyForPersistedScope() {
        let credential = WatchCredential(version: 1, kind: "watch_credential", token: "token", expires_at: "2099-10-17T00:00:00Z", server: "https://example.test", scope: a)
        XCTAssertEqual(WatchStateReducer(state: state(a, 20), credential: credential).credential, credential)
        XCTAssertNil(WatchStateReducer(state: state(b, 1), credential: credential).credential)
    }
    func testHomePriorityExpiryAndThreeLinkMessages() {
        let question = WatchYimiQuestion(card_id: "q", question: "选哪个？", options: [.init(id: "one", label: "第一项", lines: [], recommended: true), .init(id: "two", label: "第二项", lines: [], recommended: false)], expires_at: "2026-10-16T00:00:30Z")
        let errands = [WatchYimiErrand(job_id: "job", title: "查资料", step: 1, max_steps: 2, state: .running, started_at: nil)]
        let value = state(a, 1, question: question, errands: errands)
        XCTAssertEqual(WatchStateReducer.home(state: value, now: WatchStateReducer.date("2026-10-16T00:00:00Z")!), .question(question))
        XCTAssertEqual(WatchStateReducer.home(state: value, now: WatchStateReducer.date(question.expires_at)!), .errands(errands))
        XCTAssertEqual(WatchStateReducer.home(state: state(a, 1)), .latest(state(a, 1).latest!))
        let messages = [WatchYimiLink.ok, .server_unreachable, .watch_unregistered].map(WatchStateReducer.linkText)
        XCTAssertEqual(messages, ["在呢", "暂时连不上依米，稍后再试", "先在 iPhone 上登记这块手表"])
        XCTAssertTrue(messages.allSatisfy { !$0.contains("WatchConnectivity") && !$0.contains("请求") })
    }
}
