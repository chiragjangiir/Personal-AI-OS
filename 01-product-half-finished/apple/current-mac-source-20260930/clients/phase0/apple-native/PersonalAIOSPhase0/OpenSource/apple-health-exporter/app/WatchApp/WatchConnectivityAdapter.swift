import Combine
import Foundation
import WatchConnectivity
import WatchKit

protocol WatchConnectivitySending: AnyObject {
    var activationState: WCSessionActivationState { get }
    var isReachable: Bool { get }
    var applicationContext: [String: Any] { get }
    var receivedApplicationContext: [String: Any] { get }

    func activate()
    func sendMessage(
        _ message: [String: Any],
        replyHandler: (([String: Any]) -> Void)?,
        errorHandler: ((Error) -> Void)?
    )
    func updateApplicationContext(_ applicationContext: [String: Any]) throws
    func enqueueUserInfo(_ userInfo: [String: Any])
}

extension WCSession: WatchConnectivitySending {
    func enqueueUserInfo(_ userInfo: [String: Any]) {
        transferUserInfo(userInfo)
    }
}

protocol WatchHapticPlaying: AnyObject { func play(_ type: WKHapticType) }
private final class SystemWatchHapticPlayer: WatchHapticPlaying {
    func play(_ type: WKHapticType) { WKInterfaceDevice.current().play(type) }
}

/// Transport owns the WCSession and all merged application-context writes.
@MainActor
final class WatchConnectivityAdapter: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var isPhoneReachable = false
    let yimiStore: WatchYimiStore
    private let sender: any WatchConnectivitySending
    private let session: WCSession
    private let ride: WatchRideHandler
    private let identity: WatchIdentityHandler
    private let yimi: WatchYimiHandler
    init(session: WCSession = .default, sender: (any WatchConnectivitySending)? = nil,
         hapticPlayer: (any WatchHapticPlaying)? = nil,
         workoutController: (any WatchCyclingWorkoutControlling)? = nil,
         installationIdentityStore: any WatchInstallationIdentityStoring = UserDefaultsWatchInstallationIdentityStore(),
         sequenceDefaults: UserDefaults? = .standard, sequenceClock: (() -> Date)? = { Date() },
         yimiStore: WatchYimiStore? = nil) {
        self.session = session; self.sender = sender ?? session
        let haptics = hapticPlayer ?? SystemWatchHapticPlayer()
        let store = yimiStore ?? WatchYimiStore(defaults: sequenceDefaults)
        self.yimiStore = store
        ride = WatchRideHandler(controller: workoutController, defaults: sequenceDefaults, clock: sequenceClock)
        identity = WatchIdentityHandler(store: installationIdentityStore)
        yimi = WatchYimiHandler(store: store, defaults: sequenceDefaults, clock: sequenceClock, haptics: haptics)
        super.init()
        ride.workoutScope = { [weak store] in store?.currentScope }
        ride.publishWorkoutSnapshot = { [weak self] data in
            do { try self?.merge([WatchCyclingWorkoutSnapshot.contextKey: data]) }
            catch { self?.yimiStore.report("骑行状态未同步：\(error)") }
        }
        ride.send = { [weak self] data, lifecycle, value in self?.sendMetric(data, lifecycle: lifecycle, sequence: value) }
        yimi.isReachable = { [weak self] in self?.isReachable ?? false }
        yimi.send = { [weak self] data, reply, failure in
            self?.sender.sendMessage(["payload": data], replyHandler: { message in
                Task { @MainActor in reply(message["payload"] as? Data) }
            }, errorHandler: { error in Task { @MainActor in failure(error) } })
        }
        // Read persisted scope before this latest-context comparison. No live message can establish a scope.
        store.receiveContext(self.sender.receivedApplicationContext)
        receiveAppearance(self.sender.receivedApplicationContext)
        isPhoneReachable = isReachable
        session.delegate = self
        if WCSession.isSupported() { self.sender.activate() }
    }
    var isReachable: Bool { sender.activationState == .activated && sender.isReachable }
    func receiveCyclingControl(_ data: Data) async -> Data? { await ride.receive(data) }
    @discardableResult
    func sendCyclingMetrics(_ snapshot: WatchCyclingMetricSnapshot, workoutState: WatchCyclingWorkoutState? = nil) -> UInt64? {
        ride.metrics(snapshot, state: workoutState)
    }
#if DEBUG
    func setInstallationIdentityDiagnosticHandlerForTests(_ handler: @escaping @Sendable (WatchInstallationIdentityPublishDiagnostic) -> Void) {
        identity.diagnostic = handler
    }
#endif
    private func merge(_ values: [String: Any]) throws {
        var context = sender.applicationContext
        context.merge(values) { _, new in new }
        try sender.updateApplicationContext(context)
    }
    private func receiveAppearance(_ context: [String: Any]) {
        let avatar = YimiAvatarStore.shared
        let scope = yimiStore.currentScope
        avatar.bind(scope.map { $0.watch_device_id + ":" + $0.pair_version })
        guard let data = context["yimi_appearance"] as? Data else { return }
        do {
            let projection = try JSONDecoder().decode(WatchAppearanceProjection.self, from: data)
            guard projection.scope == scope else { return }
            try avatar.applyPhoneProjection(projection)
            let receipt = WatchAppearanceReceipt(projectionID: projection.projectionID, scope: projection.scope,
                profileVersion: avatar.loadedVersion, appliedAt: Date())
            let bytes = try JSONEncoder().encode(receipt)
            try merge(["yimi_appearance_receipt": bytes])
            if isReachable { sender.sendMessage(["yimi_appearance_receipt": bytes], replyHandler: nil, errorHandler: nil) }
        } catch { yimiStore.report("形象接收失败：\(error)", userMessage: "新样子未保存，请靠近 iPhone 重试。") }
    }
    private func metricContext(_ data: Data, sequence: UInt64) {
        guard ride.isLatest(sequence) else { return }
        do { try merge(["payload": data]) }
        catch { yimiStore.report("骑行数据未同步：\(error)") }
    }
    private func sendMetric(_ data: Data, lifecycle: Bool, sequence: UInt64) {
        if lifecycle { sender.enqueueUserInfo(["payload": data]); return }
        guard isReachable else { metricContext(data, sequence: sequence); return }
        sender.sendMessage(["payload": data], replyHandler: nil, errorHandler: { [weak self] _ in
            Task { @MainActor in self?.metricContext(data, sequence: sequence) }
        })
    }
    private func activated(_ state: WCSessionActivationState, error: Error?) {
        isPhoneReachable = isReachable
        receiveAppearance(sender.receivedApplicationContext)
        identity.publish(activation: state, error: error, context: sender.applicationContext) { [self] data in
            try merge(["payload": data])
        }
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor [weak self] in self?.activated(activationState, error: error) }
    }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.activated(self.sender.activationState, error: nil)
        }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor [weak self] in
            self?.yimiStore.receiveContext(applicationContext)
            self?.receiveAppearance(applicationContext)
        }
    }
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let data = userInfo["payload"] as? Data, WatchCyclingControlCommand.declaresKind(data) else { return }
        Task { @MainActor [weak self] in _ = await self?.ride.receive(data) }
    }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor [weak self] in
            if let data = message["yimi_state"] as? Data { self?.yimiStore.receiveMessageState(data) }
            self?.receiveAppearance(message)
        }
    }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor [weak self] in
            guard let self else { replyHandler([:]); return }
            if let reply = WatchCyclingWorkoutSnapshot.queryReply(message, context: self.ride.workoutSnapshotContext, scope: self.yimiStore.currentScope) {
                replyHandler(reply); return
            }
            if let state = message["yimi_state"] as? Data { self.yimiStore.receiveMessageState(state) }
            self.receiveAppearance(message)
            guard let data = message["payload"] as? Data else { replyHandler([:]); return }
            if WatchInstallationIdentityRequest.declaresKind(data) {
                replyHandler(self.identity.reply(data).map { ["payload": $0] } ?? [:])
            } else if WatchCyclingControlCommand.declaresKind(data) {
                replyHandler(await self.ride.receive(data).map { ["payload": $0] } ?? [:])
            } else { replyHandler([:]) }
        }
    }
}
