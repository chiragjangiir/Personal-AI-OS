import ActivityKit

/// A display snapshot of a real call. The app owns call state and its lifecycle.
struct CallActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var compactTitle: String
        var detail: String
        var symbol: String
    }

    var callID: String
}
