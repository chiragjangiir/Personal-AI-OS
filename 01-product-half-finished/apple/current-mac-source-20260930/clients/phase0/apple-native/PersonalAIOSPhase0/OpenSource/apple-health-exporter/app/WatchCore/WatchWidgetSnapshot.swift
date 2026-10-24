import Foundation

/// What the watch complications and the Smart Stack card show. The watch app writes it from the state it already holds
/// (WatchWidgetProjection) and the widget extension only renders it, so the two never disagree about priority.
/// Timeline entries follow `items`: each one is valid from its `from` date until the next item's.
struct WatchWidgetSnapshot: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case ride, question, errand, reply, idle, unregistered }

    struct Item: Codable, Equatable, Sendable {
        let kind: Kind
        let from: Date
        /// First line, e.g. 依米在问你.
        let header: String
        /// The card's content. Shown only when nobody else can read the watch (see `display`).
        let title: String
        let detail: String?
        /// Start of an errand or a ride: the widget counts up from it without being reloaded.
        let since: Date?
        /// A yimi:// address, or nil to just open the app.
        let link: URL?

        /// A few words for the corner and inline forms. Carries no content, so it is shown even on a private face.
        var shortLabel: String {
            switch kind {
            case .question: return "在问你"
            case .errand: return "在办事"
            case .reply: return "有新消息"
            case .ride: return header
            case .idle: return "在呢"
            case .unregistered: return "未登记"
            }
        }

        /// The lines to draw. A locked, dimmed or otherwise private face gets one neutral line and no content.
        func display(isPrivate: Bool) -> (header: String, title: String?, detail: String?) {
            guard isPrivate else { return (header, title, detail) }
            switch kind {
            case .question, .reply: return ("依米 · 有新消息", nil, nil)
            case .errand: return ("依米 · 正在办事", nil, nil)
            case .ride: return ("依米 · 骑行中", nil, nil)
            case .idle, .unregistered: return (header, title, nil)
            }
        }
    }

    let items: [Item]

    func item(at date: Date) -> Item? { items.last { $0.from <= date } ?? items.first }

    static let groupID = "group.ai.paios.personal.phase0.watch"
    static let widgetKind = "YimiWatchWidget"
    private static let storageKey = "yimi.watch.widget-snapshot.v1"

    static var shared: UserDefaults? { UserDefaults(suiteName: groupID) }

    static func read(from defaults: UserDefaults?) -> WatchWidgetSnapshot? {
        defaults?.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
    }

    func write(to defaults: UserDefaults?) {
        defaults?.set(try? JSONEncoder().encode(self), forKey: Self.storageKey)
    }
}
