import SwiftUI
import WidgetKit

/// One card in the four complication forms. A dimmed or privacy-redacted face shows only that something is there.
struct YimiWatchWidgetView: View {
    let entry: YimiWatchEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.isLuminanceReduced) private var dimmed

    private var item: WatchWidgetSnapshot.Item { entry.item }
    private var shown: (header: String, title: String?, detail: String?) {
        item.display(isPrivate: redaction.contains(.privacy) || dimmed)
    }

    var body: some View {
        content
            .widgetURL(family == .accessoryCircular ? WatchDeepLink.talk.url : item.link)
            .containerBackground(for: .widget) { item.kind == .question ? Yimi.klein : Color.clear }
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular:
            mark.padding(6).accessibilityLabel("和依米说话")
        case .accessoryCorner:
            mark.padding(5).widgetLabel { Text(item.shortLabel) }
        case .accessoryInline:
            Text("依米 · \(item.shortLabel)")
        default:
            rectangular
        }
    }

    private var mark: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image("YimMarkHeader").resizable().scaledToFit().widgetAccentable()
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image("YimMarkHeader").resizable().scaledToFit().frame(width: 15, height: 15).widgetAccentable()
                Text(shown.header).font(.headline).widgetAccentable().lineLimit(1)
            }
            if let title = shown.title {
                Text(title).font(.body).lineLimit(2).privacySensitive()
            }
            if let since = item.since, shown.title != nil {
                (Text((shown.detail.map { $0 + " · " } ?? "") + "已用 ") + Text(since, style: .timer)).font(.footnote).monospacedDigit()
            } else if let detail = shown.detail {
                Text(detail).font(.footnote)
            }
        }
        .foregroundStyle(item.kind == .question ? Color.white : Yimi.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension YimiWatchEntry {
    static func sample(_ kind: WatchWidgetSnapshot.Kind, header: String, title: String, detail: String? = nil, since: Date? = nil) -> YimiWatchEntry {
        YimiWatchEntry(date: Date(), item: .init(kind: kind, from: Date(), header: header, title: title, detail: detail, since: since, link: nil), validFor: 600)
    }
    static let question = sample(.question, header: "依米在问你", title: "要我约明早 9 点把快递送上门吗？")
    static let errand = sample(.errand, header: "依米在办", title: "正在帮你点奶茶", detail: "第 3 步", since: Date().addingTimeInterval(-84))
    static let reply = sample(.reply, header: "依米刚说", title: "奶茶大约 25 分钟到")
    static let ride = sample(.ride, header: "骑行中", title: "27.4 km/h · ♥ 142", since: Date().addingTimeInterval(-2_535))
    static let idle = sample(.idle, header: "依米", title: "在呢")
}

#Preview("长方形", as: .accessoryRectangular) {
    YimiWatchWidget()
} timeline: {
    YimiWatchEntry.question
    YimiWatchEntry.errand
    YimiWatchEntry.reply
    YimiWatchEntry.ride
    YimiWatchEntry.idle
}

#Preview("圆形 · 说话", as: .accessoryCircular) {
    YimiWatchWidget()
} timeline: {
    YimiWatchEntry.idle
}

#Preview("角落", as: .accessoryCorner) {
    YimiWatchWidget()
} timeline: {
    YimiWatchEntry.question
    YimiWatchEntry.idle
}

#Preview("单行", as: .accessoryInline) {
    YimiWatchWidget()
} timeline: {
    YimiWatchEntry.reply
    YimiWatchEntry.errand
}

#Preview("长方形 · 大字 · 隐私", traits: .sizeThatFitsLayout) {
    VStack(spacing: 8) {
        YimiWatchWidgetView(entry: .reply).environment(\.redactionReasons, [])
        YimiWatchWidgetView(entry: .reply).environment(\.redactionReasons, .privacy)
    }
    .environment(\.dynamicTypeSize, .accessibility1)
    .frame(width: 172, height: 190).background(Color.black)
}
