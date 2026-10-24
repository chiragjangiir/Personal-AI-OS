import SwiftUI

@main
struct PersonalAIOSWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self)
    private var extensionDelegate

    @StateObject private var connectivity: WatchConnectivityAdapter
    @StateObject private var workout: WatchWorkoutCoordinator
    @StateObject private var notifications: WatchNotificationCoordinator

    @StateObject private var talk: WatchTalkClient
    private let widgetPublisher: WatchWidgetPublisher

    init() {
        let workout = WatchWorkoutCoordinator()
        _workout = StateObject(wrappedValue: workout)
        let connectivity = WatchConnectivityAdapter(workoutController: workout)
        _connectivity = StateObject(wrappedValue: connectivity)
        workout.onCyclingMetric = { [weak connectivity] metric, state in
            connectivity?.sendCyclingMetrics(metric, workoutState: state)
        }
        _notifications = StateObject(
            wrappedValue: WatchNotificationCoordinator()
        )
        let talk = WatchTalkClient(credential: { [weak connectivity] in connectivity?.yimiStore.validCredential }, refreshCredential: { [weak connectivity] in connectivity?.yimiStore.refreshCredential() })
        connectivity.yimiStore.onScopeChange = { [weak talk] in talk?.reset() }
        _talk = StateObject(wrappedValue: talk)
        widgetPublisher = WatchWidgetPublisher(store: connectivity.yimiStore, workout: workout)
        extensionDelegate.workoutCoordinator = workout
    }

    var body: some Scene {
        WindowGroup {
            YimiWatchRootView(
                connectivity: connectivity,
                workout: workout,
                notifications: notifications,
                store: connectivity.yimiStore,
                talkClient: talk
            )
        }
        WKNotificationScene(controller: YimiWatchQuestionNotificationController.self, category: "question_card")
        WKNotificationScene(controller: YimiWatchReplyNotificationController.self, category: "assistant_reply")
        WKNotificationScene(controller: YimiWatchPaymentNotificationController.self, category: "payment_confirmation")
        WKNotificationScene(controller: YimiWatchCareNotificationController.self, category: "care_checkin")
    }
}
