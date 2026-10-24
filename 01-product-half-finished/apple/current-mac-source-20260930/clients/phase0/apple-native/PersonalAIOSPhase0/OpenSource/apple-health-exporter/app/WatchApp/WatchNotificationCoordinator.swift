import Combine
import Foundation
import UserNotifications

struct WatchLocalNotification: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String
}

protocol WatchLocalNotificationScheduling: AnyObject {
    func requestAuthorization() async throws -> Bool
    func schedule(_ notification: WatchLocalNotification) async throws
    func revoke(identifier: String) async
}

final class UserNotificationCenterScheduler: WatchLocalNotificationScheduling,
    @unchecked Sendable {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert])
    }

    func schedule(_ notification: WatchLocalNotification) async throws {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = nil

        let request = UNNotificationRequest(
            identifier: notification.identifier,
            content: content,
            trigger: nil
        )
        try await center.add(request)
    }

    func revoke(identifier: String) async {
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
    }
}

@MainActor
final class WatchNotificationCoordinator: NSObject, ObservableObject {
    @Published private(set) var lastNotification: WatchLocalNotification?
    @Published private(set) var openURL: URL?
    @Published private(set) var openEventID = UUID()

    private let scheduler: any WatchLocalNotificationScheduling

    init(
        scheduler: (any WatchLocalNotificationScheduling)? = nil
    ) {
        self.scheduler = scheduler ?? UserNotificationCenterScheduler()
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Set(YimiWatchNotificationKind.allCases.map {
            UNNotificationCategory(identifier: $0.rawValue, actions: [], intentIdentifiers: [], options: [])
        }))
    }

    func authorize() async -> Bool {
        (try? await scheduler.requestAuthorization()) ?? false
    }

    func publish(_ notification: WatchLocalNotification) async {
        do {
            try await scheduler.schedule(notification)
            lastNotification = notification
        } catch {
            // Local notification failure is surfaced as absent local state;
            // it is never converted into a server or delivery receipt.
        }
    }

    func revoke(identifier: String) async {
        await scheduler.revoke(identifier: identifier)
        if lastNotification?.identifier == identifier {
            lastNotification = nil
        }
    }
}


extension WatchNotificationCoordinator: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let link = response.notification.request.content.userInfo["deep_link"] as? String,
              let url = URL(string: link), url.scheme == "yimi", ["card", "care"].contains(url.host ?? "") else { return }
        await MainActor.run { self.openURL = url; self.openEventID = UUID() }
    }
}
