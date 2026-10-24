import Foundation

/// The running ride as the complication shows it: the formatted figures and when it started.
struct WatchWidgetRide: Equatable {
    let paused: Bool
    let figures: String
    let startedAt: Date?
}

extension WatchWidgetSnapshot {
    /// A ride's figures are trusted this long without a newer write; after it the card falls back to the state.
    static let rideHorizon: TimeInterval = 120

    /// Priority is the watch home's (WatchStateReducer.home: question, then work in progress, then her latest reply);
    /// a running ride goes first. The question's expiry and the ride horizon are the moments the card changes by itself.
    static func make(state: WatchYimiState?, ride: WatchWidgetRide?, now: Date) -> WatchWidgetSnapshot {
        let rideEnds = ride.map { _ in now.addingTimeInterval(rideHorizon) }
        let questionEnds = state?.question.flatMap { WatchStateReducer.date($0.expires_at) }
        let changes = Set([rideEnds, questionEnds].compactMap { $0 }.filter { $0 > now })
        let items = ([now] + changes.sorted()).map { at -> Item in
            if let ride, let rideEnds, at < rideEnds { return rideItem(ride, from: at) }
            return stateItem(state, at: at)
        }
        return WatchWidgetSnapshot(items: items)
    }

    private static func rideItem(_ ride: WatchWidgetRide, from: Date) -> Item {
        Item(kind: .ride, from: from, header: ride.paused ? "已暂停" : "骑行中", title: ride.figures, detail: nil,
             since: ride.paused ? nil : ride.startedAt, link: nil)
    }

    private static func stateItem(_ state: WatchYimiState?, at: Date) -> Item {
        guard let state, state.scope != nil else {
            return Item(kind: .unregistered, from: at, header: "依米", title: "先在 iPhone 上登记", detail: nil, since: nil, link: nil)
        }
        switch WatchStateReducer.home(state: state, now: at) {
        case .question(let question):
            return Item(kind: .question, from: at, header: "依米在问你", title: shortened(question.question ?? "选一个告诉依米"),
                        detail: nil, since: nil, link: WatchDeepLink.card(question.card_id).url)
        case .errands(let errands):
            let errand = errands[0]
            return Item(kind: .errand, from: at, header: "依米在办", title: shortened(errand.title), detail: "第 \(errand.step) 步",
                        since: errand.started_at.flatMap(WatchStateReducer.date), link: WatchDeepLink.errand(errand.job_id).url)
        case .latest(let latest):
            return Item(kind: .reply, from: at, header: "依米刚说", title: shortened(latest.lines.joined(separator: " ")),
                        detail: nil, since: nil, link: WatchDeepLink.card(latest.card_id).url)
        case .empty:
            return Item(kind: .idle, from: at, header: "依米", title: state.link == .ok ? "在呢" : "暂时连不上", detail: nil, since: nil, link: nil)
        }
    }

    /// The card shows a few lines; the shared container keeps no more of a message than that.
    private static func shortened(_ text: String) -> String { String(text.prefix(80)) }
}
