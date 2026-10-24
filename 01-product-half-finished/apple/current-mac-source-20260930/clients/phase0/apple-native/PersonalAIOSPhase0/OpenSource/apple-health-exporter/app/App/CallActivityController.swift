import ActivityKit
import OSLog

/// Serializes ActivityKit writes; only the call owner decides when a call exists.
@MainActor
final class CallActivityController {
    private let logger = Logger(subsystem: "ai.paios.personal.phase0", category: "CallActivity")
    private var pending: Task<Void, Never>?
    private var lastCallID: String?
    private var lastState: CallActivityAttributes.ContentState?
    private var revision = 0

    func update(callID: String?, title: String, compactTitle: String, detail: String, symbol: String, refreshExistingOnly: Bool = false) {
        guard let callID else { end(); return }
        let state = CallActivityAttributes.ContentState(
            title: title, compactTitle: compactTitle, detail: detail, symbol: symbol
        )
        if refreshExistingOnly {
            guard callID == lastCallID, state == lastState else { return }
            let expectedRevision = revision, previous = pending
            pending = Task {
                await previous?.value
                guard revision == expectedRevision,
                      let activity = Activity<CallActivityAttributes>.activities.first(where: { $0.attributes.callID == callID }) else { return }
                await activity.update(ActivityContent(state: state, staleDate: Date().addingTimeInterval(90)))
            }
            return
        }
        guard callID != lastCallID || state != lastState else { return }
        revision += 1
        let requestedRevision = revision
        lastCallID = callID
        lastState = state
        let previous = pending
        pending = Task {
            await previous?.value
            guard revision == requestedRevision else { return }
            let activities = Activity<CallActivityAttributes>.activities
            for activity in activities where activity.attributes.callID != callID {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            guard revision == requestedRevision else { return }
            let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(90))
            if let activity = activities.first(where: { $0.attributes.callID == callID }) {
                await activity.update(content)
            } else if ActivityAuthorizationInfo().areActivitiesEnabled {
                do {
                    _ = try Activity.request(
                        attributes: CallActivityAttributes(callID: callID), content: content, pushType: nil
                    )
                } catch {
                    logger.error("Unable to start call Live Activity: \(error.localizedDescription, privacy: .public)")
                    if lastCallID == callID { lastState = nil }
                }
            }
        }
    }

    func end() {
        revision += 1
        lastCallID = nil
        lastState = nil
        let previous = pending
        pending = Task {
            await previous?.value
            for activity in Activity<CallActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}
