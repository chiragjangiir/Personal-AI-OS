import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Local privacy cover. The server remains the owner of the payment lease.
@MainActor
final class YimiAppLock: ObservableObject {
    @Published private(set) var covered: Bool
    @Published private(set) var obscured = false
    @Published private(set) var generation: UInt64 = 0
    @Published private(set) var protectedDataAvailable: Bool
    private(set) var enabled: Bool
    private var relock: TimeInterval?
    private var leftAt: Date?
    private var timer: Task<Void, Never>?
    private let defaults: UserDefaults
    private let notificationCenter: NotificationCenter
    private var observers: [NSObjectProtocol] = []
    /// Live system reading; nil when a test injects the protected-data state.
    private let systemProtectedData: (() -> Bool)?
    var onPresence: ((String) async -> Void)?
    var onAuthorizationInvalidated: (() -> Void)?

    init(defaults: UserDefaults = .standard, notificationCenter: NotificationCenter = .default,
         protectedDataAvailable: Bool? = nil) {
        self.defaults = defaults
        self.notificationCenter = notificationCenter
#if os(iOS)
        systemProtectedData = protectedDataAvailable == nil ? { UIApplication.shared.isProtectedDataAvailable } : nil
#else
        systemProtectedData = nil
#endif
        let dataAvailable = protectedDataAvailable ?? systemProtectedData?() ?? true
        self.protectedDataAvailable = dataAvailable
        let lockEnabled = defaults.bool(forKey: "paios.payment.phoneLock")
        enabled = lockEnabled
        covered = lockEnabled || !dataAvailable
        relock = defaults.object(forKey: "paios.payment.relock") as? TimeInterval
        for (name, available) in [(Self.protectedDataWillLock, false), (Self.protectedDataDidUnlock, true)] {
            observers.append(notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.protectedDataChanged(available) }
            })
        }
    }

    deinit { observers.forEach(notificationCenter.removeObserver); timer?.cancel() }

    static var protectedDataWillLock: Notification.Name {
#if os(iOS)
        UIApplication.protectedDataWillBecomeUnavailableNotification
#else
        Notification.Name("YimiProtectedDataWillLock")
#endif
    }
    static var protectedDataDidUnlock: Notification.Name {
#if os(iOS)
        UIApplication.protectedDataDidBecomeAvailableNotification
#else
        Notification.Name("YimiProtectedDataDidUnlock")
#endif
    }

    var presence: String { covered ? "locked" : leftAt == nil ? "foreground" : "background" }

    func configure(_ phone: CentralPaymentPhone) {
        let wasEnabled = enabled
        enabled = phone.enabled
        relock = TimeInterval(phone.relock_s)
        defaults.set(enabled, forKey: "paios.payment.phoneLock")
        defaults.set(relock, forKey: "paios.payment.relock")
        if !enabled {
            timer?.cancel()
            if wasEnabled { invalidateAuthorization() }
            covered = !protectedDataAvailable
        } else if !phone.unlocked {
            // Initial lock setup shares its authenticated context with the following unlock.
            // Every later locked snapshot is a new fence, even if the cover is already visible.
            if wasEnabled { lock() } else { covered = true }
        }
        if let leftAt { schedule(from: leftAt) }
    }

    func scene(_ phase: ScenePhase, now: Date = Date()) {
        obscured = phase != .active
        if phase == .active {
            // The unlock notification may have fired while the app was suspended; read the system state again.
            if !protectedDataAvailable, systemProtectedData?() == true { protectedDataChanged(true) }
            if let leftAt, enabled, relock.map({ now.timeIntervalSince(leftAt) >= $0 }) ?? true { lock() }
            timer?.cancel()
            leftAt = nil
        } else if phase == .background, leftAt == nil {
            invalidateAuthorization()
            leftAt = now
            schedule(from: now)
        }
        emit()
    }

    @discardableResult
    func didUnlock(generation expected: UInt64) -> Bool {
        guard expected == generation, protectedDataAvailable else { return false }
        covered = false
        if let leftAt { schedule(from: leftAt) }
        emit()
        return true
    }

    func lock() {
        guard enabled || !protectedDataAvailable else { return }
        timer?.cancel()
        invalidateAuthorization()
        covered = true
        emit()
    }

    private func protectedDataChanged(_ available: Bool) {
        protectedDataAvailable = available
        if !available { lock() }
        else if !enabled { covered = false; emit() }
    }

    private func invalidateAuthorization() {
        generation &+= 1
        onAuthorizationInvalidated?()
    }

    private func schedule(from date: Date) {
        timer?.cancel()
        guard enabled, !covered else { return }
        let remaining = max(0, (relock ?? 0) - Date().timeIntervalSince(date))
        if remaining == 0 { lock(); return }
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            self?.lock()
        }
    }

    private func emit() {
        guard let onPresence else { return }
        let state = presence
        Task { await onPresence(state) }
    }
}

#if os(iOS) && !SWIFT_PACKAGE
/// Keeps the running call and ambient session mounted beneath an opaque, non-interactive surface.
struct YimiAppLockCover: View {
    @ObservedObject var payment: YimiPaymentModel
    @ObservedObject var lock: YimiAppLock
    var body: some View {
        if lock.covered || lock.obscured {
            VStack(spacing: 22) {
                Spacer()
                YimiPortrait(breathes: false).frame(width: 120, height: 120).clipShape(Circle())
                Text("解锁，见到依米").font(.system(size: 24, weight: .semibold)).foregroundStyle(Yimi.ink)
                Text("用 Face ID 或 iPhone 密码继续")
                    .font(.system(size: 15)).foregroundStyle(Yimi.ink2)
                if lock.covered && lock.protectedDataAvailable {
                    Button { Task { await payment.unlock() } } label: {
                        Label(payment.busy ? "正在确认…" : "解锁依米", systemImage: "faceid")
                            .font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                            .frame(maxWidth: 280, minHeight: 50)
                            .background(Yimi.klein, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(PressScale()).disabled(payment.busy || !payment.available)
                    .accessibilityIdentifier("payment.unlock")
                    if let error = payment.error { Text(error).font(.system(size: 14)).foregroundStyle(Yimi.danger).padding(.horizontal, 28) }
                    if !payment.available { Text("连接后解锁").font(.system(size: 14)).foregroundStyle(Yimi.ink2) }
                }
                Spacer()
                Text("通话和随身模式会继续")
                    .font(.system(size: 13)).foregroundStyle(Yimi.ink2).padding(.bottom, 36)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Yimi.ground.ignoresSafeArea())
            .accessibilityAddTraits(.isModal)
        }
    }
}
/// A scene-level cover also hides sheets and alerts presented above the root navigation stack.
struct YimiLockWindow: UIViewRepresentable {
    @ObservedObject var payment: YimiPaymentModel
    @ObservedObject var lock: YimiAppLock
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.isUserInteractionEnabled = false
        view.moved = { [weak coordinator = context.coordinator, weak view] in
            coordinator?.update(scene: view?.window?.windowScene, payment: payment, lock: lock)
        }
        return view
    }
    func updateUIView(_ view: Probe, context: Context) {
        context.coordinator.update(scene: view.window?.windowScene, payment: payment, lock: lock)
    }
    static func dismantleUIView(_ view: Probe, coordinator: Coordinator) { coordinator.close() }
    final class Probe: UIView {
        var moved: (() -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); moved?() }
    }
    @MainActor final class Coordinator {
        private var cover: UIWindow?
        private weak var previous: UIWindow?
        func update(scene: UIWindowScene?, payment: YimiPaymentModel, lock: YimiAppLock) {
            guard lock.covered || lock.obscured else { close(); return }
            guard cover == nil, let scene else { return }
            previous = scene.windows.first(where: \.isKeyWindow)
            let window = UIWindow(windowScene: scene)
            window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
            window.rootViewController = UIHostingController(rootView: YimiAppLockCover(payment: payment, lock: lock))
            cover = window
            window.makeKeyAndVisible()
        }
        func close() {
            guard let cover else { return }
            cover.isHidden = true
            cover.rootViewController = nil
            self.cover = nil
            previous?.makeKey()
        }
    }
}
#endif
