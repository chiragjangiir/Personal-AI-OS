import AppKit
import UserNotifications

/// Only final local Mac text replies and phone confirmations produce notifications.
@MainActor final class DesktopNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private let deduper = AssistantNotificationDeduper()
    private let isChatFront: @MainActor () -> Bool
    private let openChat: @MainActor () -> Void
    private var expiry: [String: Task<Void, Never>] = [:]
    private var deadlines: [String: Date] = [:]
    private var snapshot = 0
    private static let confirmationPrefix = "desktop.confirmation."

    init(center: UNUserNotificationCenter = .current(),
         isChatFront: @escaping @MainActor () -> Bool,
         openChat: @escaping @MainActor () -> Void) {
        self.center = center
        self.isChatFront = isChatFront
        self.openChat = openChat
        super.init()
        center.delegate = self
    }

    func reply(id: String) async throws {
        try await deliver(identifier: "desktop.result." + id, title: "依米", body: "依米回复了你")
    }

    /// Receives the entire authoritative pending set, including while the chat is in front.
    func confirmations(_ items: [CentralPendingConfirmation]) async throws {
        snapshot += 1
        let version = snapshot
        let now = Date()
        let active = items.filter { $0.expires_in_ms > 0 && $0.answer_on == "phone"
            && ["native_approval", "voice"].contains($0.kind) }
        let next = Dictionary(uniqueKeysWithValues: active.map {
            (Self.confirmationPrefix + $0.id, now.addingTimeInterval(Double($0.expires_in_ms) / 1000))
        })
        let removed = deadlines.keys.filter { next[$0] == nil }
        for id in removed { await withdraw(id) }
        guard version == snapshot else { return }
        for (id, deadline) in next {
            expiry[id]?.cancel()
            deadlines[id] = deadline
            expiry[id] = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
                catch { return }
                guard let self, self.deadlines[id] == deadline else { return }
                await self.withdraw(id)
            }
        }
        // Delivered banners survive relaunch; reconcile them against the same server snapshot.
        let delivered = await center.deliveredNotifications().map { $0.request.identifier }
        let pending = await center.pendingNotificationRequests().map(\.identifier)
        guard version == snapshot else { return }
        for id in delivered + pending where id.hasPrefix(Self.confirmationPrefix) && deadlines[id] == nil {
            await withdraw(id)
        }
        guard version == snapshot else { return }
        for id in delivered + pending where deadlines[id] != nil { _ = await deduper.reserve(id) }
        for id in next.keys {
            try await deliver(identifier: id, title: "等你在手机上确认", body: "有一件事等你回答。请在手机上查看。",
                              eligible: { [weak self] in self.map { $0.snapshot == version && ($0.deadlines[id].map { $0 > Date() } ?? false) } ?? false })
        }
    }

    private func withdraw(_ id: String) async {
        expiry.removeValue(forKey: id)?.cancel()
        deadlines.removeValue(forKey: id)
        await deduper.revoke(id)
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    private func deliver(identifier: String, title: String, body: String,
                         eligible: @escaping @MainActor () -> Bool = { true }) async throws {
        // Reserve even in front: a later snapshot must not alert for something already seen.
        guard await deduper.reserve(identifier) == .delivered else { return }
        guard !isChatFront(), eligible() else { return }
        do {
            var status = await center.notificationSettings().authorizationStatus
            if status == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound])
                status = await center.notificationSettings().authorizationStatus
            }
            guard status == .authorized || status == .provisional,
                  !isChatFront(), eligible() else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.interruptionLevel = .active
            content.sound = .default
            guard !isChatFront(), eligible() else { return }
            try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
            if !eligible() {
                center.removePendingNotificationRequests(withIdentifiers: [identifier])
                center.removeDeliveredNotifications(withIdentifiers: [identifier])
            }
        } catch {
            await deduper.release(identifier)
            throw error
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in completionHandler(isChatFront() ? [] : [.banner, .list, .sound]) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier { openChat() }
            completionHandler()
        }
    }
}
