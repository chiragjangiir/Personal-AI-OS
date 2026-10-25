import SwiftUI
import WidgetKit

struct YimiWatchEntry: TimelineEntry {
    let date: Date
    let item: WatchWidgetSnapshot.Item
    /// How long this card stays relevant for the Smart Stack: until the next entry, or a short while for the last.
    let validFor: TimeInterval

    /// The system lifts the Smart Stack card when she is asking something or a ride is running.
    var relevance: TimelineEntryRelevance? {
        switch item.kind {
        case .question, .ride: return TimelineEntryRelevance(score: 100, duration: validFor)
        case .errand: return TimelineEntryRelevance(score: 50, duration: validFor)
        case .reply: return TimelineEntryRelevance(score: 20, duration: validFor)
        case .idle, .unregistered: return nil
        }
    }
}

/// Reads the snapshot the watch app wrote. It never fetches anything itself.
struct YimiWatchProvider: TimelineProvider {
    private static let neverOpened = WatchWidgetSnapshot.Item(kind: .idle, from: .distantPast, header: "依米", title: "打开依米", detail: nil, since: nil, link: nil)

    func placeholder(in context: Context) -> YimiWatchEntry {
        YimiWatchEntry(date: Date(), item: Self.neverOpened, validFor: 600)
    }

    func getSnapshot(in context: Context, completion: @escaping (YimiWatchEntry) -> Void) {
        completion(entries().last { $0.date <= Date() } ?? placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<YimiWatchEntry>) -> Void) {
        completion(Timeline(entries: entries(), policy: .never))
    }

    private func entries() -> [YimiWatchEntry] {
        let items = WatchWidgetSnapshot.read(from: WatchWidgetSnapshot.shared)?.items ?? [Self.neverOpened]
        return items.enumerated().map { index, item in
            let next = index + 1 < items.count ? items[index + 1].from : nil
            return YimiWatchEntry(date: item.from, item: item, validFor: next.map { max(60, $0.timeIntervalSince(item.from)) } ?? 600)
        }
    }
}

struct YimiWatchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WatchWidgetSnapshot.widgetKind, provider: YimiWatchProvider()) { entry in
            YimiWatchWidgetView(entry: entry)
        }
        .configurationDisplayName("依米")
        .description("她在问你什么、在办什么、刚说了什么。圆形的依米点一下，直接找她说话。")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryCorner, .accessoryInline])
    }
}

@main
struct YimiWatchWidgetBundle: WidgetBundle {
    var body: some Widget { YimiWatchWidget() }
}
