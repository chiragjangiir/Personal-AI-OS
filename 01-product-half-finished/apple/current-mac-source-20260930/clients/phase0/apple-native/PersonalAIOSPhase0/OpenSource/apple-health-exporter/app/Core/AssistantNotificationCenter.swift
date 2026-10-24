import Foundation
import UserNotifications

enum AssistantNotificationAuthorizationStatus: String, Equatable, Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
    case unavailable
}

enum AssistantReplyPrivacy: String, Codable, Equatable, Sendable { case payment }

enum AssistantNotificationDestination: Equatable, Sendable {
    case card(String), care(String)

    var url: URL {
        var parts = URLComponents()
        parts.scheme = "yimi"
        let id: String
        switch self {
        case .card(let value): parts.host = "card"; id = value
        case .care(let value): parts.host = "care"; id = value
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        parts.percentEncodedPath = "/" + id.addingPercentEncoding(withAllowedCharacters: allowed)!
        return parts.url!
    }
}

struct AssistantNotificationMessage: Equatable, Sendable {
    let identifier: String
    let title: String
    let body: String
    let careIdentity: String?
    let deepLink: AssistantNotificationDestination?
    let opensPayment: Bool
    let privacy: AssistantReplyPrivacy?
    let redactsPrivateContent: Bool

    init(identifier: String, title: String, body: String, careIdentity: String? = nil, deepLink: AssistantNotificationDestination? = nil, opensPayment: Bool = false,
         privacy: AssistantReplyPrivacy? = nil, redactsPrivateContent: Bool = true) {
        self.identifier = identifier
        self.title = title
        self.body = body
        self.opensPayment = opensPayment
        self.careIdentity = careIdentity
        self.deepLink = deepLink
        self.privacy = privacy
        self.redactsPrivateContent = redactsPrivateContent
    }

    /// Source provenance controls notification privacy; reply text stays available to speech and the app.
    static func assistantReply(identifier: String, title: String = "依米", text: String,
                               privacy: AssistantReplyPrivacy?, locked: Bool, active: Bool) -> Self {
        Self(identifier: identifier, title: title, body: text, privacy: privacy,
             redactsPrivateContent: locked || !active)
    }

    var isWellFormed: Bool {
        !identifier.isEmpty && !title.isEmpty && !body.isEmpty
    }
}

enum AssistantNotificationDelivery: Equatable, Sendable {
    case delivered
    case duplicate
    case revoked
    case malformed
    case failed
}

enum AssistantNotificationError: LocalizedError, Equatable, Sendable {
    case requestWasNotUserInitiated
    case remindersPermissionDenied
    case tooManyReminders

    var errorDescription: String? {
        switch self {
        case .remindersPermissionDenied: return "通知权限未打开，提醒尚未在本机安排。请在系统设置中打开通知。"
        case .tooManyReminders: return "本机最多安排 64 个待触发提醒。"
        case .requestWasNotUserInitiated:
            return "Notification permission requires an explicit user action."
        }
    }
}

actor AssistantNotificationDeduper {
    private var delivered: Set<String> = []
    private var revoked: Set<String> = []

    func reserve(_ identifier: String) -> AssistantNotificationDelivery {
        guard !identifier.isEmpty else {
            return .malformed
        }
        guard !revoked.contains(identifier) else {
            return .revoked
        }
        guard delivered.insert(identifier).inserted else {
            return .duplicate
        }
        return .delivered
    }

    func release(_ identifier: String) {
        delivered.remove(identifier)
    }

    func revoke(_ identifier: String) {
        guard !identifier.isEmpty else {
            return
        }
        revoked.insert(identifier)
        delivered.remove(identifier)
    }

    func revokeAll() {
        revoked.formUnion(delivered)
        delivered.removeAll()
    }

    func clear() {
        delivered.removeAll()
        revoked.removeAll()
    }
}

final class AssistantNotificationCenter: NSObject, UNUserNotificationCenterDelegate, AssistantNotificationScheduling,
    @unchecked Sendable {
    static let paymentCategoryIdentifier = "payment_confirmation"
    static let paymentResultBody = "依米：付款结果已更新，解锁依米查看。"
    static let paymentResultCategoryIdentifier = "payment_result"
    static let paymentPreviewBody = "解锁依米查看金额和收款方。"
    static let watchPaymentReadOnlyBody = "请在 iPhone 上确认。手表不能付款。"
    static let questionCategoryIdentifier = "question_card"

    static func questionCategory() -> UNNotificationCategory {
        UNNotificationCategory(identifier: questionCategoryIdentifier, actions: [], intentIdentifiers: [])
    }

    static func careCategory() -> UNNotificationCategory {
        UNNotificationCategory(identifier: "care_checkin", actions: [], intentIdentifiers: [])
    }

    static func paymentCategory() -> UNNotificationCategory {
        UNNotificationCategory(identifier: paymentCategoryIdentifier, actions: [], intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: paymentPreviewBody, options: [])
    }

    private let center: UNUserNotificationCenter
    private let deduper = AssistantNotificationDeduper()
    @MainActor var paymentPrivacyRequired: (@MainActor @Sendable () -> Bool)?
    var onPaymentOpen: (@Sendable () async -> Void)?
    var onCardOpen: (@Sendable (URL) async -> Void)?

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.setNotificationCategories([
            Self.careCategory(), Self.questionCategory(),
            Self.paymentCategory(),
            UNNotificationCategory(identifier: Self.paymentResultCategoryIdentifier, actions: [], intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: Self.paymentResultBody, options: [])
        ])
        center.delegate = self
    }

    func authorizationStatus() async
        -> AssistantNotificationAuthorizationStatus {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                continuation.resume(
                    returning: Self.map(settings.authorizationStatus)
                )
            }
        }
    }

    func requestAuthorization(userInitiated: Bool) async throws
        -> AssistantNotificationAuthorizationStatus {
        guard userInitiated else {
            throw AssistantNotificationError.requestWasNotUserInitiated
        }
        _ = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Bool, Error>) in
            center.requestAuthorization(
                options: [.alert, .sound]
            ) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
        return await authorizationStatus()
    }

    func deliver(
        _ message: AssistantNotificationMessage
    ) async -> AssistantNotificationDelivery {
        guard message.isWellFormed else {
            return .malformed
        }
        let status = await authorizationStatus()
        guard status == .authorized
            || status == .provisional
            || status == .ephemeral
        else {
            return .revoked
        }

        let reservation = await deduper.reserve(message.identifier)
        guard reservation == .delivered else {
            return reservation
        }

        do {
            try await add(message)
            return .delivered
        } catch {
            await deduper.release(message.identifier)
            return .failed
        }
    }

    @MainActor
    private func add(_ message: AssistantNotificationMessage) async throws {
        // Read the live owner immediately before the synchronous handoff to the OS.
        let redact = message.privacy == .payment ? (paymentPrivacyRequired?() ?? true) : false
        let request = UNNotificationRequest(identifier: message.identifier,
            content: Self.content(for: message, redactsPrivateContent: redact), trigger: nil)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    static func content(for message: AssistantNotificationMessage,
                        redactsPrivateContent: Bool? = nil) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        let redact = message.privacy == .payment && (redactsPrivateContent ?? message.redactsPrivateContent)
        content.title = redact ? "依米" : message.title
        content.body = redact ? paymentResultBody : message.body
        content.sound = .default
        if let identity = message.careIdentity {
            content.categoryIdentifier = "care_checkin"
            content.userInfo = ["care_identity": identity]
        }
        if let destination = message.deepLink {
            content.userInfo["yimi_deep_link"] = destination.url.absoluteString
            if case .card = destination { content.categoryIdentifier = questionCategoryIdentifier }
        }
        if message.privacy == .payment {
            content.categoryIdentifier = paymentResultCategoryIdentifier
            content.userInfo = ["paios_payment": true]
        }
        if message.opensPayment {
            content.categoryIdentifier = paymentCategoryIdentifier
            content.userInfo = ["paios_payment": true]
        }
        return content
    }

    /// Hermes owns reminder tasks; the OS persists their alert requests across app launches.
    func syncReminders(_ reminders: [AssistantReminder]) async throws {
        let pending = await center.pendingNotificationRequests()
        try await Self.syncReminders(reminders, pending: pending, status: await authorizationStatus(),
            add: { try await self.center.add($0) },
            remove: { self.center.removePendingNotificationRequests(withIdentifiers: $0) })
    }

    static func syncReminders(_ reminders: [AssistantReminder], pending: [UNNotificationRequest],
                             status: AssistantNotificationAuthorizationStatus, now: Date = Date(),
                             add: (UNNotificationRequest) async throws -> Void,
                             remove: ([String]) -> Void) async throws {
        let active = reminders.filter { $0.fireAt > now }
        guard active.count <= 64 else { throw AssistantNotificationError.tooManyReminders }
        let ids = Set(active.map(\.id))
        // A completed snapshot can arrive at the deadline before the OS presents its due alert.
        let stale = pending.filter { request in
            guard request.content.userInfo["paios_reminder"] as? Bool == true, !ids.contains(request.identifier),
                  let trigger = request.trigger as? UNCalendarNotificationTrigger,
                  let date = Calendar(identifier: .gregorian).date(from: trigger.dateComponents) else { return false }
            return date > now
        }
        guard active.isEmpty || [.authorized, .provisional, .ephemeral].contains(status) else {
            throw AssistantNotificationError.remindersPermissionDenied
        }
        let staleIDs = Set(stale.map(\.identifier))
        let preserved = pending.filter { !staleIDs.contains($0.identifier) && !ids.contains($0.identifier) }
        guard active.count + preserved.count <= 64 else { throw AssistantNotificationError.tooManyReminders }
        remove(Array(staleIDs))
        var changed: [String] = []
        do {
            for reminder in active {
                let date = Calendar(identifier: .gregorian).dateComponents(in: TimeZone(secondsFromGMT: 0)!, from: reminder.fireAt)
                var components = DateComponents()
                components.calendar = Calendar(identifier: .gregorian)
                components.timeZone = date.timeZone
                components.year = date.year; components.month = date.month; components.day = date.day
                components.hour = date.hour; components.minute = date.minute; components.second = date.second
                if pending.contains(where: { $0.identifier == reminder.id && $0.content.body == reminder.text
                    && ($0.trigger as? UNCalendarNotificationTrigger)?.dateComponents == components }) { continue }
                let content = UNMutableNotificationContent()
                content.title = "依米"; content.body = reminder.text; content.sound = .default
                content.userInfo = ["paios_reminder": true]
                changed.append(reminder.id)
                try await add(UNNotificationRequest(identifier: reminder.id, content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
            }
        } catch {
            let previous = pending.filter { changed.contains($0.identifier) || staleIDs.contains($0.identifier) }
            remove(changed.filter { id in !previous.contains { $0.identifier == id } })
            for request in previous { try await add(request) }
            throw error
        }
    }

    func hasReminder(_ id: String) async -> Bool {
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        return pending.contains { $0.identifier == id && $0.content.userInfo["paios_reminder"] as? Bool == true }
            || delivered.contains { $0.request.identifier == id && $0.request.content.userInfo["paios_reminder"] as? Bool == true }
    }

    func resetForNextSession() async {
        await deduper.clear()
    }

    func paymentNotificationIDs() async -> Set<String> {
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        return Set((pending.map(\.identifier) + delivered.map { $0.request.identifier })
            .filter { $0.hasPrefix("payment-") })
    }

    func revoke(identifier: String) async {
        await deduper.revoke(identifier)
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
    }

    func revokeAll() async {
        await deduper.revokeAll()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(notification.request.content.userInfo["paios_reminder"] as? Bool == true
            ? [.banner, .sound, .list] : [])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let raw = response.notification.request.content.userInfo["yimi_deep_link"] as? String,
           let url = URL(string: raw), url.scheme == "yimi", let host = url.host, ["card", "care"].contains(host) {
            Task { await onCardOpen?(url); completionHandler() }
            return
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           response.notification.request.content.userInfo["paios_payment"] as? Bool == true {
            Task { await onPaymentOpen?(); completionHandler() }
            return
        }
        completionHandler()
    }

    static func map(
        _ status: UNAuthorizationStatus
    ) -> AssistantNotificationAuthorizationStatus {
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        case .ephemeral: return .ephemeral
        @unknown default: return .unavailable
        }
    }
}

protocol AssistantNotificationScheduling: Sendable {
    func authorizationStatus() async
        -> AssistantNotificationAuthorizationStatus
    func requestAuthorization(userInitiated: Bool) async throws
        -> AssistantNotificationAuthorizationStatus
    func deliver(
        _ message: AssistantNotificationMessage
    ) async -> AssistantNotificationDelivery
    func paymentNotificationIDs() async -> Set<String>
    func revoke(identifier: String) async
    func revokeAll() async
}


extension AssistantNotificationMessage {
    static func question(_ card: CentralQuestion) -> Self {
        Self(identifier: "question-" + card.id, title: "依米", body: card.question ?? "请选择",
             deepLink: .card(card.id))
    }

    static func payment(_ card: CentralPaymentCard) -> Self {
        Self(identifier: "payment-" + card.id,
             title: "依米：有一笔付款等你确认",
             body: AssistantNotificationCenter.paymentPreviewBody + "\n" + AssistantNotificationCenter.watchPaymentReadOnlyBody, opensPayment: true)
    }
    static func paymentApproval(_ approval: CentralPaymentApproval) -> Self {
        Self(identifier: "payment-approval-" + approval.id,
             title: approval.kind == "glasses_unlock" ? "依米：眼镜请求解锁" : "依米：眼镜请求录入你的声音",
             body: AssistantNotificationCenter.paymentPreviewBody, opensPayment: true)
    }
}
