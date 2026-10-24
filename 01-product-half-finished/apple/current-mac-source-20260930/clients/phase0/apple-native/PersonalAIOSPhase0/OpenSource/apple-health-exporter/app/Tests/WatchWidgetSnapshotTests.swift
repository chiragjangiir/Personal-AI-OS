import Foundation
import XCTest
@testable import HealthKitExporter

final class WatchWidgetSnapshotTests: XCTestCase {
    private let scope = WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "7")
    private let now = WatchStateReducer.date("2026-10-20T08:00:00Z")!
    private let expiry = "2026-10-20T08:05:00Z"

    private func state(question: Bool = false, errand: Bool = false, latest: Bool = false, scope: WatchBindingScope? = nil,
                       link: WatchYimiLink = .ok) -> WatchYimiState {
        let scope = scope ?? self.scope
        return WatchYimiState(version: 1, kind: "yimi_state", rev: 5, link: link, scope: scope,
            latest: latest ? .init(card_id: "reply/1", title: "依米", lines: ["奶茶大约 25 分钟到"], created_at: "2026-10-20T07:59:00Z", kind: .message) : nil,
            question: question ? .init(card_id: "q-1", question: "要我约明早 9 点把快递送上门吗？", options: [
                .init(id: "yes", label: "好", lines: [], recommended: true), .init(id: "no", label: "不用", lines: [], recommended: false)],
                expires_at: expiry) : nil,
            errands: errand ? [.init(job_id: "job-9", title: "点奶茶", step: 3, max_steps: 8, state: .running, started_at: "2026-10-20T07:58:00Z")] : [],
            care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
    }
    private func unregistered() -> WatchYimiState {
        WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .watch_unregistered, scope: nil, latest: nil, question: nil,
                       errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
    }

    func testPriorityIsQuestionThenWorkThenLatestReplyThenIdle() {
        let all = WatchWidgetSnapshot.make(state: state(question: true, errand: true, latest: true), ride: nil, now: now)
        XCTAssertEqual(all.items.first?.kind, .question)
        XCTAssertEqual(WatchWidgetSnapshot.make(state: state(errand: true, latest: true), ride: nil, now: now).items.first?.kind, .errand)
        XCTAssertEqual(WatchWidgetSnapshot.make(state: state(latest: true), ride: nil, now: now).items.first?.kind, .reply)
        let idle = WatchWidgetSnapshot.make(state: state(), ride: nil, now: now).items.first
        XCTAssertEqual(idle?.kind, .idle); XCTAssertEqual(idle?.title, "在呢")
        XCTAssertEqual(WatchWidgetSnapshot.make(state: state(link: .server_unreachable), ride: nil, now: now).items.first?.title, "暂时连不上")
    }

    func testQuestionHandsOverToWorkAtItsExpiryWithoutAReload() throws {
        let snapshot = WatchWidgetSnapshot.make(state: state(question: true, errand: true, latest: true), ride: nil, now: now)
        XCTAssertEqual(snapshot.items.map(\.kind), [.question, .errand])
        XCTAssertEqual(snapshot.items[1].from, WatchStateReducer.date(expiry))
        XCTAssertEqual(snapshot.item(at: now.addingTimeInterval(299))?.kind, .question)
        XCTAssertEqual(snapshot.item(at: now.addingTimeInterval(300))?.kind, .errand)
        XCTAssertEqual(snapshot.items[1].since, WatchStateReducer.date("2026-10-20T07:58:00Z"))
        XCTAssertEqual(snapshot.items[1].detail, "第 3 步")
    }

    func testRunningRideComesFirstAndFallsBackAfterItsHorizon() {
        let ride = WatchWidgetRide(paused: false, figures: "27.4 km/h · ♥ 142", startedAt: now.addingTimeInterval(-600))
        let snapshot = WatchWidgetSnapshot.make(state: state(question: true, latest: true), ride: ride, now: now)
        XCTAssertEqual(snapshot.items.map(\.kind), [.ride, .question, .reply])
        XCTAssertEqual(snapshot.items[0].header, "骑行中"); XCTAssertEqual(snapshot.items[0].since, ride.startedAt)
        XCTAssertEqual(snapshot.items[1].from, now.addingTimeInterval(WatchWidgetSnapshot.rideHorizon))
        let paused = WatchWidgetSnapshot.make(state: state(), ride: .init(paused: true, figures: "-- km/h · ♥ --", startedAt: ride.startedAt), now: now)
        XCTAssertEqual(paused.items[0].header, "已暂停"); XCTAssertNil(paused.items[0].since)
    }

    func testUnregisteredAndRevokedStateCarryNoContent() throws {
        for value in [nil, unregistered()] {
            let item = try XCTUnwrap(WatchWidgetSnapshot.make(state: value, ride: nil, now: now).items.first)
            XCTAssertEqual(item.kind, .unregistered); XCTAssertNil(item.link); XCTAssertNil(item.since)
        }
        let defaults = UserDefaults(suiteName: "WatchWidgetSnapshotTests")!
        defer { defaults.removePersistentDomain(forName: "WatchWidgetSnapshotTests") }
        WatchWidgetSnapshot.make(state: state(latest: true), ride: nil, now: now).write(to: defaults)
        XCTAssertEqual(WatchWidgetSnapshot.read(from: defaults)?.items.first?.title, "奶茶大约 25 分钟到")
        WatchWidgetSnapshot.make(state: unregistered(), ride: nil, now: now).write(to: defaults)
        let raw = String(decoding: try XCTUnwrap(defaults.data(forKey: "yimi.watch.widget-snapshot.v1")), as: UTF8.self)
        XCTAssertFalse(raw.contains("奶茶")); XCTAssertEqual(WatchWidgetSnapshot.read(from: defaults)?.items.first?.kind, .unregistered)
    }

    func testPrivateFaceShowsOnlyThatSomethingIsThere() throws {
        let question = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(question: true), ride: nil, now: now).items.first)
        let reply = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(latest: true), ride: nil, now: now).items.first)
        let errand = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(errand: true), ride: nil, now: now).items.first)
        let ride = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(), ride: .init(paused: false, figures: "27 km/h · ♥ 142", startedAt: now), now: now).items.first)
        XCTAssertEqual(question.display(isPrivate: true).header, "依米 · 有新消息")
        XCTAssertEqual(reply.display(isPrivate: true).header, "依米 · 有新消息")
        XCTAssertEqual(errand.display(isPrivate: true).header, "依米 · 正在办事")
        XCTAssertEqual(ride.display(isPrivate: true).header, "依米 · 骑行中")
        for item in [question, reply, errand, ride] {
            let hidden = item.display(isPrivate: true)
            XCTAssertNil(hidden.title); XCTAssertNil(hidden.detail)
            XCTAssertNotNil(item.display(isPrivate: false).title)
            XCTAssertFalse(item.shortLabel.contains("奶茶") || item.shortLabel.contains("快递"))
        }
    }

    func testLinksOpenTheRelevantPlaceAndNeverStartRecording() throws {
        let question = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(question: true), ride: nil, now: now).items.first)
        let errand = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(errand: true), ride: nil, now: now).items.first)
        let reply = try XCTUnwrap(WatchWidgetSnapshot.make(state: state(latest: true), ride: nil, now: now).items.first)
        XCTAssertEqual(question.link.flatMap(WatchDeepLink.init(url:)), .card("q-1"))
        XCTAssertEqual(errand.link.flatMap(WatchDeepLink.init(url:)), .errand("job-9"))
        XCTAssertEqual(reply.link.flatMap(WatchDeepLink.init(url:)), .card("reply/1"))
        XCTAssertEqual(reply.link?.absoluteString, "yimi://card/reply%2F1")
        XCTAssertEqual(WatchDeepLink.talk.url.absoluteString, "yimi://talk")
        XCTAssertEqual(WatchDeepLink(url: URL(string: "yimi://talk")!), .talk)
        XCTAssertEqual(WatchDeepLink(url: URL(string: "yimi://care/c1")!), .care("c1"))
        XCTAssertNil(WatchDeepLink(url: URL(string: "yimi://card")!))
        XCTAssertNil(WatchDeepLink(url: URL(string: "yimi://record/start")!))
        XCTAssertNil(WatchDeepLink(url: URL(string: "https://talk")!))
    }

    func testSharedContainerKeepsOnlyAShortStretchOfAMessage() throws {
        let long = String(repeating: "长", count: 300)
        let value = WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: .init(card_id: "m", title: "依米", lines: [long], created_at: "2026-10-20T07:59:00Z", kind: .message),
            question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
        XCTAssertEqual(WatchWidgetSnapshot.make(state: value, ride: nil, now: now).items.first?.title.count, 80)
    }
}
