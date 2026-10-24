import Combine
import Foundation
import WidgetKit

/// Keeps the complications' snapshot in step with what the watch app already holds (the phone's state, the running
/// workout) and asks WidgetKit to redraw when it changes. It opens no connection and keeps no schedule of its own;
/// when the system actually redraws is the system's decision.
@MainActor
final class WatchWidgetPublisher {
    /// A ride's figures change every second, so a ride rewrites at most this often, and at least every `keepAlive`
    /// so the card does not fall back to the state while the ride goes on.
    static let rideInterval: TimeInterval = 30
    static let keepAlive: TimeInterval = 60

    private let store: WatchYimiStore
    private let workout: WatchWorkoutCoordinator
    private let defaults: UserDefaults?
    private let reload: () -> Void
    private var subscription: AnyCancellable?
    private var written: WatchWidgetSnapshot?
    private var writtenAt = Date.distantPast

    init(store: WatchYimiStore, workout: WatchWorkoutCoordinator, defaults: UserDefaults? = WatchWidgetSnapshot.shared,
         reload: @escaping () -> Void = { WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetSnapshot.widgetKind) }) {
        self.store = store; self.workout = workout; self.defaults = defaults; self.reload = reload
        subscription = Publishers.CombineLatest3(store.$state, workout.$snapshot, workout.$metricSnapshot)
            .sink { [weak self] state, workoutSnapshot, metric in
                self?.publish(state: state, workoutState: workoutSnapshot.state, metric: metric, now: Date())
            }
    }

    func publish(state: WatchYimiState?, workoutState: WatchWorkoutState, metric: WatchCyclingMetricSnapshot?, now: Date) {
        let snapshot = WatchWidgetSnapshot.make(state: state, ride: ride(state, workoutState, metric, now), now: now)
        let changed = written.map { Self.content($0) != Self.content(snapshot) } ?? true
        let steadyRide = snapshot.items.first?.kind == .ride && written?.items.first?.kind == .ride
        let age = now.timeIntervalSince(writtenAt)
        guard steadyRide ? age >= (changed ? Self.rideInterval : Self.keepAlive) : changed else { return }
        snapshot.write(to: defaults)
        written = snapshot; writtenAt = now
        reload()
    }

    private func ride(_ state: WatchYimiState?, _ workoutState: WatchWorkoutState, _ metric: WatchCyclingMetricSnapshot?, _ now: Date) -> WatchWidgetRide? {
        guard workoutState == .running || workoutState == .paused, metric != nil else { return nil }
        let figures = WatchRideFigures.live(phone: state?.ride?.metrics, phoneAt: store.rideMetricsAt, local: metric,
                                            elapsed: workout.elapsedTime, now: now)
        let speed = WatchCyclingDisplayFormatter.speedText(figures.speedMPS)
        let heart = WatchCyclingDisplayFormatter.valueText(figures.heartRate, unit: "").trimmingCharacters(in: .whitespaces)
        return WatchWidgetRide(paused: workoutState == .paused, figures: "\(speed) km/h · ♥ \(heart)",
                               startedAt: figures.elapsedS.map { now.addingTimeInterval(-$0) })
    }

    /// What the card says, without the moments it is valid from (those move with every write).
    private static func content(_ snapshot: WatchWidgetSnapshot) -> [[String]] {
        snapshot.items.map { [$0.kind.rawValue, $0.header, $0.title, $0.detail ?? "", $0.link?.absoluteString ?? ""] }
    }
}
