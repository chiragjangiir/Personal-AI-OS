import HealthKit
import WatchKit

final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    weak var workoutCoordinator: WatchWorkoutCoordinator?

    func handle(_ workoutConfiguration: HKWorkoutConfiguration) {
        guard workoutConfiguration.activityType == .cycling else { return }
        Task { @MainActor [weak self] in
            try? await self?.workoutCoordinator?.startWorkout(activityType: .cycling, fromPhone: true)
        }
    }

    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        // Workout processing stays owned by HKWorkoutSession. Other refresh
        // work is completed without starting a hidden assistant/media loop.
        for task in backgroundTasks {
            task.setTaskCompletedWithSnapshot(false)
        }
    }
}
