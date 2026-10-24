import Foundation

/// The yimi:// addresses the watch opens from notifications and complications. Opening one never starts recording;
/// only an explicit tap inside the app does.
enum WatchDeepLink: Equatable {
    case talk, card(String), care(String), errand(String)

    private static let idCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    var url: URL {
        var parts = URLComponents()
        parts.scheme = "yimi"
        switch self {
        case .talk: parts.host = "talk"
        case .card(let id): parts.host = "card"; parts.percentEncodedPath = "/" + Self.encode(id)
        case .care(let id): parts.host = "care"; parts.percentEncodedPath = "/" + Self.encode(id)
        case .errand(let id): parts.host = "errand"; parts.percentEncodedPath = "/" + Self.encode(id)
        }
        return parts.url!
    }

    init?(url: URL) {
        guard url.scheme == "yimi", let host = url.host else { return nil }
        let id = url.pathComponents.dropFirst().first
        switch (host, id) {
        case ("talk", _): self = .talk
        case ("card", let id?): self = .card(id)
        case ("care", let id?): self = .care(id)
        case ("errand", let id?): self = .errand(id)
        default: return nil
        }
    }

    private static func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: idCharacters) ?? id
    }
}
