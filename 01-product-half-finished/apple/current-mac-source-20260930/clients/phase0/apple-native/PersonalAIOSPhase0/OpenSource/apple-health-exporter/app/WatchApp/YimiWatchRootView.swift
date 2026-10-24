import SwiftUI

struct YimiWatchRootView: View {
    @ObservedObject var connectivity: WatchConnectivityAdapter
    @ObservedObject var workout: WatchWorkoutCoordinator
    @ObservedObject var notifications: WatchNotificationCoordinator
    @ObservedObject var store: WatchYimiStore
    @ObservedObject var talkClient: WatchTalkClient
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isLuminanceReduced) private var dimmed
    @AppStorage("yimi.watch.onboardingCompleted") private var onboardingCompleted = false
    @State private var showsTalk = false
    @State private var deepLink: WatchDeepLink?
    @State private var workoutError: String?
    var body: some View {
        NavigationStack {
            Group {
                if !onboardingCompleted {
                    YimiWatchOnboardingView(completed: $onboardingCompleted)
                } else if hasRide {
                    YimiWatchRideView(workout: workout, store: store, phoneReachable: connectivity.isPhoneReachable, talk: openTalk)
                } else if [.finished, .unknownSave, .failed, .discarded].contains(workout.snapshot.state) {
                    YimiWatchRideSummaryView(workout: workout, store: store)
                } else if store.state?.link == .watch_unregistered || store.state == nil {
                    YimiWatchRegistrationView()
                } else {
                    YimiWatchHomeView(store: store, phoneReachable: connectivity.isPhoneReachable, talk: openTalk) {
                        Task {
                            do { try await workout.startWorkout() }
                            catch { workoutError = error.localizedDescription }
                        }
                    }
                }
            }
            // Card and onboarding state starts fresh for a new binding. The identity sits on the stack's root content: an
            // `.id` on the NavigationStack itself leaves watchOS 26 with an empty stack and a black screen.
            .id(scopeKey)
            .navigationDestination(isPresented: Binding(get: { deepLink != nil }, set: { if !$0 { deepLink = nil } })) {
                linkedCard
            }
            .sheet(isPresented: $showsTalk) {
                NavigationStack { YimiWatchTalkView(client: talkClient) }
                    .privacySensitive()
                    .redacted(reason: dimmed ? .privacy : [])
                    .onDisappear { talkClient.cancel() }
            }
            .alert("没能开始骑行", isPresented: Binding(get: { workoutError != nil }, set: { if !$0 { workoutError = nil } })) {
                Button("好", role: .cancel) { workoutError = nil }
            } message: { Text(workoutError ?? "") }
        }.privacySensitive(!hasRide)
            .redacted(reason: dimmed && !hasRide ? .privacy : [])
            .tint(Yimi.klein).background(Yimi.ground).preferredColorScheme(.dark)
            .onOpenURL(perform: open)
            .onChange(of: notifications.openEventID, initial: true) { _, _ in if let url = notifications.openURL { open(url) } }
            .onChange(of: scenePhase) { _, phase in talkClient.setForeground(phase == .active && !dimmed) }
            .onChange(of: dimmed) { _, reduced in talkClient.setForeground(scenePhase == .active && !reduced) }
            .onChange(of: store.currentScope) { _, _ in showsTalk = false; deepLink = nil; workoutError = nil }
            .task { store.requestState() }
    }
    private var scopeKey: String { store.currentScope.map { "\($0.watch_device_id):\($0.pair_version)" } ?? "unregistered" }
    private var hasRide: Bool { [.authorizing, .starting, .running, .paused, .stopping, .saving].contains(workout.snapshot.state) }
    private func openTalk() {
        talkClient.setForeground(scenePhase == .active && !dimmed)
        showsTalk = true
        talkClient.startByUser()
    }
    private func open(_ url: URL) {
        guard let link = WatchDeepLink(url: url) else { return }
        // Deep links never begin recording. Only an explicit in-app tap can do that.
        if link == .talk { showsTalk = true } else { deepLink = link }
    }
    @ViewBuilder private var linkedCard: some View {
        if store.currentScope == nil { YimiWatchRegistrationView() }
        else if let link = deepLink {
            if case .care(let id) = link, let care = store.state?.care, care.care_id == id {
                YimiWatchCareView(store: store, care: care, talk: openTalk)
            } else if case .card(let id) = link, let question = store.state?.question, question.card_id == id {
                YimiWatchQuestionView(store: store, question: question, talk: openTalk)
            } else if case .card(let id) = link, let latest = store.state?.latest, latest.card_id == id {
                YimiWatchMessageView(message: latest, talk: openTalk)
            } else if case .errand(let id) = link, let errand = store.state?.errands.first(where: { $0.job_id == id }) {
                YimiWatchErrandView(store: store, errand: errand)
            } else {
                YimiWatchUnavailableView(title: "这条消息已不在手表上", detail: "在 iPhone 上打开依米查看。", symbol: "text.bubble")
            }
        }
    }
}
