import Foundation
import WatchConnectivity
import WatchKit
@testable import PersonalAIOSWatch
import XCTest

private final class TestLocalNotificationScheduler:
    WatchLocalNotificationScheduling {
    private(set) var revokedIdentifiers: [String] = []

    func requestAuthorization() async throws -> Bool { true }

    func schedule(_ notification: WatchLocalNotification) async throws {}

    func revoke(identifier: String) async {
        revokedIdentifiers.append(identifier)
    }
}

private final class TestWatchSender: WatchConnectivitySending {
    var activationState: WCSessionActivationState = .activated
    var isReachable = true
    var applicationContext: [String: Any] = [:]
    var receivedApplicationContext: [String: Any] = [:]
    private(set) var lastMessage: [String: Any]?
    private(set) var sentMessages: [[String: Any]] = []
    private(set) var queuedUserInfo: [[String: Any]] = []
    private(set) var applicationContexts: [[String: Any]] = []
    private(set) var errorHandler: ((Error) -> Void)?
    private(set) var errorHandlers: [((Error) -> Void)?] = []
    var applicationContextError: Error?
    private(set) var applicationContextAttemptCount = 0

    func activate() {}

    func enqueueUserInfo(_ userInfo: [String: Any]) {
        queuedUserInfo.append(userInfo)
    }

    func sendMessage(
        _ message: [String: Any],
        replyHandler: (([String: Any]) -> Void)?,
        errorHandler: ((Error) -> Void)?
    ) {
        lastMessage = message
        sentMessages.append(message)
        self.errorHandler = errorHandler
        errorHandlers.append(errorHandler)
    }

    func updateApplicationContext(_ applicationContext: [String: Any]) throws {
        applicationContextAttemptCount += 1
        if let applicationContextError {
            throw applicationContextError
        }
        self.applicationContext = applicationContext
        applicationContexts.append(applicationContext)
    }
}

private final class TestHapticPlayer: WatchHapticPlaying {
    private(set) var played: [String] = []

    var successCount: Int {
        played.filter { $0 == "success" }.count
    }

    var failureCount: Int {
        played.filter { $0 == "failure" }.count
    }

    func play(_ type: WKHapticType) {
        switch type {
        case .success:
            played.append("success")
        case .failure:
            played.append("failure")
        default:
            played.append("other")
        }
    }
}

private struct TestNetworkError: Error {}
private struct TestInstallationIdentityError: Error {}

private final class TestPublishDiagnosticRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [WatchInstallationIdentityPublishDiagnostic] = []

    func append(_ value: WatchInstallationIdentityPublishDiagnostic) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }

    var values: [WatchInstallationIdentityPublishDiagnostic] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}


private struct TestCyclingWorkoutError: Error {}

private final class TestInstallationIdentityStore:
    WatchInstallationIdentityStoring,
    @unchecked Sendable {
    private(set) var loadCount = 0
    var error: Error?
    var identity = WatchInstallationIdentity(
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source: "existing_watch_install_identity"
    )

    func loadOrCreate() throws -> WatchInstallationIdentity {
        loadCount += 1
        if let error { throw error }
        return identity
    }
}

@MainActor
private final class TestCyclingWorkoutController:
    WatchCyclingWorkoutControlling {
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var rejectStart = false
    var activeWorkoutID = "active-workout"

    func startCyclingWorkout() async throws {
        startCount += 1
        if rejectStart {
            throw TestCyclingWorkoutError()
        }
    }

    func stopCyclingWorkout(workoutID: String?) -> Bool {
        guard workoutID == nil || workoutID == activeWorkoutID else { return false }
        stopCount += 1
        return true
    }
}
final class WatchConnectivityAdapterTests: XCTestCase {
    @MainActor
    func testInstallationIdentityReplyIsNonceScopedAndOneShot() async throws {
        let store = TestInstallationIdentityStore()
        let adapter = WatchConnectivityAdapter(
            sender: TestWatchSender(),
            installationIdentityStore: store
        )
        let nonce = "11111111-1111-4111-8111-111111111111"
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let request = try encoder.encode(
            WatchInstallationIdentityRequest(
                kind: WatchInstallationIdentityRequest.currentKind,
                nonce: nonce
            )
        )
        let reply = await withCheckedContinuation { continuation in
            adapter.session(
                WCSession.default,
                didReceiveMessage: ["payload": request],
                replyHandler: { continuation.resume(returning: $0) }
            )
        }
        let data = try XCTUnwrap(reply["payload"] as? Data)
        let decoded = try JSONDecoder().decode(
            WatchInstallationIdentityReply.self,
            from: data
        )
        XCTAssertEqual(decoded.nonce, nonce)
        XCTAssertEqual(decoded.localClientInstanceID, store.identity.id)
        XCTAssertEqual(store.loadCount, 1)
    }


    @MainActor
    func testActivationPublishesClosedIdentityContextExactlyOnce()
        async throws {
        let sender = TestWatchSender()
        let store = TestInstallationIdentityStore()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            installationIdentityStore: store
        )
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(store.loadCount, 1)
        XCTAssertEqual(sender.applicationContexts.count, 1)
        let context = try XCTUnwrap(sender.applicationContexts.first)
        XCTAssertEqual(Set(context.keys), Set(["payload"]))
        let payload = try XCTUnwrap(context["payload"] as? Data)
        let value = try WatchInstallationIdentityObservation.decodeStrict(
            payload
        )
        XCTAssertEqual(value.version, 1)
        XCTAssertEqual(value.localClientInstanceID, store.identity.id)
        XCTAssertEqual(value.localClientSource, store.identity.source)
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(store.loadCount, 1)
        XCTAssertEqual(sender.applicationContexts.count, 1)
    }

    @MainActor
    func testFirstActivationRepublishesMatchingCurrentIdentityForNewCompanion()
        async throws {
        let sender = TestWatchSender()
        let store = TestInstallationIdentityStore()
        let payload = try WatchInstallationIdentityObservation(
            identity: store.identity
        ).encodedStrict()
        sender.applicationContext = ["payload": payload]
        let recorder = TestPublishDiagnosticRecorder()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            installationIdentityStore: store
        )
        adapter.setInstallationIdentityDiagnosticHandlerForTests {
            recorder.append($0)
        }

        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }

        XCTAssertEqual(sender.applicationContextAttemptCount, 1)
        XCTAssertEqual(sender.applicationContexts.count, 1)
        XCTAssertEqual(
            recorder.values.map(\.event),
            [.attempted, .succeeded]
        )

        adapter.sessionReachabilityDidChange(WCSession.default)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(sender.applicationContextAttemptCount, 1)
        XCTAssertEqual(recorder.values.last?.event, .skippedCurrent)
    }

    @MainActor
    func testIdentityContextFailureIsNotRetriedOrPublished() async {
        let sender = TestWatchSender()
        sender.applicationContextError = TestNetworkError()
        let store = TestInstallationIdentityStore()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            installationIdentityStore: store
        )
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(store.loadCount, 1)
        XCTAssertTrue(sender.applicationContexts.isEmpty)
        XCTAssertEqual(sender.applicationContextAttemptCount, 2)

        let invalidSender = TestWatchSender()
        let invalidStore = TestInstallationIdentityStore()
        invalidStore.error = TestInstallationIdentityError()
        let invalidAdapter = WatchConnectivityAdapter(
            sender: invalidSender,
            installationIdentityStore: invalidStore
        )
        invalidAdapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(invalidStore.loadCount, 1)
        XCTAssertTrue(invalidSender.applicationContexts.isEmpty)
    }

    @MainActor
    func testIdentityContextDiagnosticsAndStateTransitionRepublish()
        async throws {
        let sender = TestWatchSender()
        sender.applicationContextError = TestNetworkError()
        let recorder = TestPublishDiagnosticRecorder()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            installationIdentityStore: TestInstallationIdentityStore()
        )
        adapter.setInstallationIdentityDiagnosticHandlerForTests {
            recorder.append($0)
        }

        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(
            recorder.values.map(\.event),
            [.attempted, .failed]
        )
        XCTAssertEqual(recorder.values.last?.errorClass, "TestNetworkError")

        sender.applicationContextError = nil
        adapter.sessionReachabilityDidChange(WCSession.default)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(sender.applicationContextAttemptCount, 2)
        XCTAssertEqual(sender.applicationContexts.count, 1)
        XCTAssertEqual(recorder.values.suffix(2).map(\.event), [
            .attempted, .succeeded
        ])

        adapter.sessionReachabilityDidChange(WCSession.default)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(sender.applicationContextAttemptCount, 2)
        XCTAssertEqual(recorder.values.last?.event, .skippedCurrent)
    }

    @MainActor
    func testIdentityContextStopsAfterTwoFailedPublishAttempts() async {
        let sender = TestWatchSender()
        sender.applicationContextError = TestNetworkError()
        let recorder = TestPublishDiagnosticRecorder()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            installationIdentityStore: TestInstallationIdentityStore()
        )
        adapter.setInstallationIdentityDiagnosticHandlerForTests {
            recorder.append($0)
        }

        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }
        adapter.sessionReachabilityDidChange(WCSession.default)
        for _ in 0..<4 { await Task.yield() }
        adapter.session(
            WCSession.default,
            activationDidCompleteWith: .activated,
            error: nil
        )
        for _ in 0..<4 { await Task.yield() }

        XCTAssertEqual(sender.applicationContextAttemptCount, 2)
        XCTAssertTrue(sender.applicationContexts.isEmpty)
        XCTAssertEqual(recorder.values.map(\.event), [
            .attempted, .failed, .attempted, .failed
        ])
    }

    func testUserDefaultsInstallationIdentityIsStableForInstall() throws {
        let suite = "WatchInstallationIdentityTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsWatchInstallationIdentityStore(
            defaults: defaults
        )
        let first = try store.loadOrCreate()
        let second = try store.loadOrCreate()
        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(first.source, "app_installation_uuid_v1")
        XCTAssertEqual(second.source, "existing_watch_install_identity")
    }

    private func scopedWorkoutContext() throws -> [String: Any] {
        let state = WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok,
            scope: .init(watch_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pair_version: "1"),
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
        return ["yimi_state": try state.encodedStrict()]
    }

    private func makeMetric(
        observedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
        elapsedS: Double = 10
    ) -> PersonalAIOSWatch.WatchCyclingMetricSnapshot {
        PersonalAIOSWatch.WatchCyclingMetricSnapshot(
            workoutID: "cycling-workout",
            observedAt: observedAt,
            heartRateBPM: 142,
            activeEnergyKcal: 3.5,
            distanceM: 125,
            elapsedS: elapsedS,
            cadenceSPM: 82,
            cyclingSpeedMPS: 6.25
        )
    }

    func testCyclingMetricEnvelopeIsClosedAndRoundTrips() throws {
        let envelope = PersonalAIOSWatch.WatchCyclingMetricEnvelope(
            snapshot: makeMetric(),
            sequence: 1
        )
        let encoded = try envelope.encodedStrict()
        let decoded = try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(encoded)

        XCTAssertEqual(decoded, envelope)
        XCTAssertEqual(decoded.version, 1)
        XCTAssertEqual(decoded.kind, "watch_cycling_metric")
        XCTAssertEqual(decoded.sequence, 1)
    }

    func testCyclingMetricEnvelopeRejectsUnknownKeyAndNonFiniteValue() throws {
        let unknownKey = Data(
            #"{"version":1,"kind":"watch_cycling_metric","sequence":1,"observedAt":"2023-11-14T22:13:20Z","workoutID":"w","elapsed_s":1,"unexpected":true}"#.utf8
        )
        XCTAssertThrowsError(
            try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(unknownKey)
        )

        let nonFinite = PersonalAIOSWatch.WatchCyclingMetricEnvelope(
            snapshot: PersonalAIOSWatch.WatchCyclingMetricSnapshot(
                workoutID: "w",
                observedAt: Date(timeIntervalSince1970: 1_700_000_000),
                heartRateBPM: .infinity,
                activeEnergyKcal: nil,
                distanceM: nil,
                elapsedS: 1,
                cadenceSPM: nil,
                cyclingSpeedMPS: nil
            ),
            sequence: 1
        )
        XCTAssertThrowsError(try nonFinite.encodedStrict())
    }

    func testCyclingDisplaySpeedConvertsMetersPerSecondToKilometersPerHour() {
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.speedText(5),
            "18.0"
        )
    }

    func testCyclingDisplayInvalidOrMissingSpeedUsesPlaceholder() {
        XCTAssertEqual(WatchCyclingDisplayFormatter.speedText(nil), "--")
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.speedText(.infinity),
            "--"
        )
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.speedText(-1),
            "--"
        )
    }

    func testCyclingDisplayDistanceChoosesMetersOrKilometers() {
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.distanceText(850),
            "850 m"
        )
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.distanceText(1_500),
            "1.50 km"
        )
    }

    func testCyclingDisplayElapsedFormatsHourAndMinuteBoundaries() {
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.elapsedText(59.9),
            "00:00:59"
        )
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.elapsedText(60),
            "00:01:00"
        )
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.elapsedText(3_600),
            "01:00:00"
        )
        XCTAssertEqual(
            WatchCyclingDisplayFormatter.elapsedText(.infinity),
            "--"
        )
    }

    @MainActor
    func testCyclingMetricsPreferRealtimeWhenReachable() throws {
        let sender = TestWatchSender()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil,
            sequenceClock: nil
        )

        XCTAssertEqual(adapter.sendCyclingMetrics(makeMetric()), 1)
        XCTAssertEqual(sender.sentMessages.count, 1)
        XCTAssertTrue(sender.applicationContexts.isEmpty)
        let data = try XCTUnwrap(sender.lastMessage?["payload"] as? Data)
        let envelope = try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(data)
        XCTAssertEqual(envelope.sequence, 1)
    }

    @MainActor
    func testCyclingMetricsUseLatestApplicationContextWhenUnreachable()
        throws {
        let sender = TestWatchSender()
        sender.isReachable = false
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil,
            sequenceClock: nil
        )

        XCTAssertEqual(adapter.sendCyclingMetrics(makeMetric()), 1)
        XCTAssertTrue(sender.sentMessages.isEmpty)
        XCTAssertEqual(sender.applicationContexts.count, 1)
        let data = try XCTUnwrap(
            sender.applicationContexts[0]["payload"] as? Data
        )
        let envelope = try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(data)
        XCTAssertEqual(envelope.sequence, 1)
    }

    @MainActor
    func testUnreachableLifecycleEdgesSurviveLatestMetricReplacement() throws {
        let sender = TestWatchSender()
        sender.receivedApplicationContext = try scopedWorkoutContext()
        sender.isReachable = false
        let adapter = WatchConnectivityAdapter(
            sender: sender, hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil, sequenceClock: nil
        )
        _ = adapter.sendCyclingMetrics(makeMetric(), workoutState: .started)
        _ = adapter.sendCyclingMetrics(makeMetric(elapsedS: 2))
        _ = adapter.sendCyclingMetrics(makeMetric(elapsedS: 3), workoutState: .ended)
        let edges = try sender.queuedUserInfo.map { item in
            try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(
                XCTUnwrap(item["payload"] as? Data)
            )
        }
        XCTAssertEqual(edges.map(\.workoutState), [.started, .ended])
        XCTAssertEqual(edges.map(\.sequence), [1, 3])
        let bytes = try XCTUnwrap(sender.applicationContext[WatchCyclingWorkoutSnapshot.contextKey] as? Data)
        let current = try WatchCyclingWorkoutSnapshot.decodeStrict(bytes)
        XCTAssertEqual(current.metric.workoutState, .ended)
        XCTAssertEqual(current.metric.sequence, 3)
        XCTAssertEqual(current.startedAt, makeMetric().observedAt)
        XCTAssertTrue(sender.sentMessages.isEmpty)
    }

    @MainActor
    func testLiveQueryUsesEndedProducerWhenContextPublicationFailed() async throws {
        let sender = TestWatchSender()
        sender.receivedApplicationContext = try scopedWorkoutContext()
        let adapter = WatchConnectivityAdapter(sender: sender, hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil, sequenceClock: nil)
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start), workoutState: .started)
        sender.applicationContextError = TestNetworkError()
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start.addingTimeInterval(10)), workoutState: .ended)
        let stale = try WatchCyclingWorkoutSnapshot.decodeStrict(XCTUnwrap(
            sender.applicationContext[WatchCyclingWorkoutSnapshot.contextKey] as? Data))
        XCTAssertEqual(stale.metric.workoutState, .started)
        let scope = try WatchYimiState.decodeStrict(XCTUnwrap(sender.receivedApplicationContext["yimi_state"] as? Data)).scope
        let query: [String: Any] = [WatchCyclingWorkoutSnapshot.queryKey: UUID().uuidString.lowercased(),
            "scope": try JSONEncoder().encode(XCTUnwrap(scope))]
        let reply: [String: Any] = await withCheckedContinuation { continuation in
            adapter.session(.default, didReceiveMessage: query) { continuation.resume(returning: $0) }
        }
        let current = try WatchCyclingWorkoutSnapshot.decodeStrict(XCTUnwrap(reply[WatchCyclingWorkoutSnapshot.contextKey] as? Data))
        XCTAssertEqual(current.metric.workoutState, .ended)
        sender.applicationContextError = nil
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start.addingTimeInterval(20)), workoutState: .started)
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start.addingTimeInterval(21)), workoutState: .failed)
        let failed: [String: Any] = await withCheckedContinuation { continuation in
            adapter.session(.default, didReceiveMessage: query) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(failed.isEmpty, "A failed workout cannot be revived through its prior running projection")
        let restarted = WatchConnectivityAdapter(sender: sender, hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil, sequenceClock: nil)
        let unavailable: [String: Any] = await withCheckedContinuation { continuation in
            restarted.session(.default, didReceiveMessage: query) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(unavailable.isEmpty, "A restarted Watch cannot claim cached running state is live")
    }

    @MainActor
    func testReachableWorkoutPublishesRecoverableCurrentContextAfterStartWasConsumed() throws {
        let sender = TestWatchSender()
        sender.receivedApplicationContext = try scopedWorkoutContext()
        let adapter = WatchConnectivityAdapter(sender: sender, hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil, sequenceClock: nil)
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start), workoutState: .started)
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start.addingTimeInterval(12), elapsedS: 12))
        let current = try WatchCyclingWorkoutSnapshot.decodeStrict(XCTUnwrap(
            sender.applicationContext[WatchCyclingWorkoutSnapshot.contextKey] as? Data))
        XCTAssertEqual(current.startedAt, start)
        XCTAssertEqual(current.metric.workoutState, .started)
        XCTAssertEqual(current.metric.elapsedS, 12)
        XCTAssertEqual(current.metric.sequence, 2)
        XCTAssertEqual(sender.queuedUserInfo.count, 1)
        _ = adapter.sendCyclingMetrics(makeMetric(observedAt: start.addingTimeInterval(15), elapsedS: 15), workoutState: .ended)
        let ended = try WatchCyclingWorkoutSnapshot.decodeStrict(XCTUnwrap(
            sender.applicationContext[WatchCyclingWorkoutSnapshot.contextKey] as? Data))
        XCTAssertEqual(ended.metric.workoutState, .ended)
    }

    @MainActor
    func testCyclingMetricRealtimeFailureFallsBackToApplicationContext()
        async throws {
        let sender = TestWatchSender()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil,
            sequenceClock: nil
        )

        _ = adapter.sendCyclingMetrics(makeMetric())
        sender.errorHandler?(TestNetworkError())
        for _ in 0..<3 {
            await Task.yield()
        }

        XCTAssertEqual(sender.applicationContexts.count, 1)
        let data = try XCTUnwrap(
            sender.applicationContexts[0]["payload"] as? Data
        )
        XCTAssertEqual(
            try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(data).sequence,
            1
        )
    }

    @MainActor
    func testOlderRealtimeFailureCannotOverwriteLatestMetricContext()
        async throws {
        let sender = TestWatchSender()
        let adapter = WatchConnectivityAdapter(
            sender: sender,
            hapticPlayer: TestHapticPlayer(),
            sequenceDefaults: nil,
            sequenceClock: nil
        )

        _ = adapter.sendCyclingMetrics(makeMetric(elapsedS: 1))
        _ = adapter.sendCyclingMetrics(makeMetric(elapsedS: 2))
        sender.errorHandlers[0]?(TestNetworkError())
        for _ in 0..<3 {
            await Task.yield()
        }
        XCTAssertTrue(sender.applicationContexts.isEmpty)

        sender.errorHandlers[1]?(TestNetworkError())
        for _ in 0..<3 {
            await Task.yield()
        }
        XCTAssertEqual(sender.applicationContexts.count, 1)
        let data = try XCTUnwrap(
            sender.applicationContexts[0]["payload"] as? Data
        )
        let envelope = try PersonalAIOSWatch.WatchCyclingMetricEnvelope.decodeStrict(data)
        XCTAssertEqual(envelope.sequence, 2)
        XCTAssertEqual(envelope.elapsedS, 2)
    }

    func testAcknowledgementEnvelopeRoundTripsWithoutCanonicalFields()
        throws {
        let packet = WatchAssistantPacket(
            action: .requestVoiceSession,
            requestID: "voice-1",
            sequence: 1
        )
        let acknowledgement = WatchLocalEnvelope.acknowledgement(
            for: packet,
            status: .accepted
        )
        let decoded = try WatchLocalEnvelope.decodeStrict(
            try acknowledgement.encodedStrict()
        )

        XCTAssertEqual(decoded, acknowledgement)
        XCTAssertNil(decoded.detail)
        XCTAssertEqual(decoded.status, .accepted)
    }

    func testUnknownAcknowledgementIsStrictlyRejectedByEnvelopeShape()
        throws {
        let data = Data(
            #"{"kind":"acknowledgement","requestID":"r","sequence":0,"status":"accepted","token":"nope"}"#
                .utf8
        )
        XCTAssertThrowsError(try WatchLocalEnvelope.decodeStrict(data)) { error in
            XCTAssertEqual(
                error as? WatchLocalEnvelopeError,
                .unsupportedKey("token")
            )
        }
    }

    @MainActor
    func testLocalNotificationCanBeRevoked() async {
        let scheduler = TestLocalNotificationScheduler()
        let coordinator = WatchNotificationCoordinator(scheduler: scheduler)
        let notification = WatchLocalNotification(
            identifier: "workout-finished",
            title: "训练完成",
            body: "已保存到本机"
        )

        await coordinator.publish(notification)
        await coordinator.revoke(identifier: notification.identifier)
        XCTAssertEqual(
            scheduler.revokedIdentifiers,
            [notification.identifier]
        )
        XCTAssertNil(coordinator.lastNotification)
    }

    // Legacy live-call interaction tests were replaced by scoped card-action tests in WatchYimiStoreTests.
    @MainActor
    func testCyclingControlStartsStopsAndDeduplicatesExactlyOnce()
        async throws {
        let workout = TestCyclingWorkoutController()
        let adapter = WatchConnectivityAdapter(
            sender: TestWatchSender(),
            hapticPlayer: TestHapticPlayer(),
            workoutController: workout
        )
        let start = WatchCyclingControlCommand(
            action: .start,
            requestID: "cycling-start-1",
            sequence: 1
        )
        let startData = try start.encodedStrict()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: startData)
                as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            Set(["version", "kind", "action", "request_id", "sequence"])
        )

        let firstData = await adapter.receiveCyclingControl(startData)
        let first = try WatchCyclingControlAcknowledgement.decodeStrict(
            try XCTUnwrap(firstData)
        )
        XCTAssertEqual(first.status, .accepted)
        XCTAssertEqual(workout.startCount, 1)
        XCTAssertEqual(workout.stopCount, 0)

        let duplicateData = await adapter.receiveCyclingControl(startData)
        let duplicate =
            try WatchCyclingControlAcknowledgement.decodeStrict(
                try XCTUnwrap(duplicateData)
            )
        XCTAssertEqual(duplicate.status, .duplicate)
        XCTAssertEqual(workout.startCount, 1)

        let conflict = WatchCyclingControlCommand(
            action: .stop,
            requestID: start.requestID,
            sequence: 2
        )
        let conflictData = await adapter.receiveCyclingControl(
            try conflict.encodedStrict()
        )
        let conflictAck =
            try WatchCyclingControlAcknowledgement.decodeStrict(
                try XCTUnwrap(conflictData)
            )
        XCTAssertEqual(conflictAck.status, .rejected)
        XCTAssertEqual(workout.stopCount, 0)

        let stale = WatchCyclingControlCommand(
            action: .stop,
            requestID: "cycling-stale-1",
            sequence: 1
        )
        let staleData = await adapter.receiveCyclingControl(
            try stale.encodedStrict()
        )
        let staleAck = try WatchCyclingControlAcknowledgement.decodeStrict(
            try XCTUnwrap(staleData)
        )
        XCTAssertEqual(staleAck.status, .rejected)
        XCTAssertEqual(workout.stopCount, 0)

        let stop = WatchCyclingControlCommand(
            action: .stop,
            requestID: "cycling-stop-2",
            sequence: 2
        )
        let stopData = await adapter.receiveCyclingControl(
            try stop.encodedStrict()
        )
        let stopAck = try WatchCyclingControlAcknowledgement.decodeStrict(
            try XCTUnwrap(stopData)
        )
        XCTAssertEqual(stopAck.status, .accepted)
        XCTAssertEqual(workout.startCount, 1)
        XCTAssertEqual(workout.stopCount, 1)

        let malformed = Data(
            #"{"version":1,"kind":"cycling_control","action":"start","request_id":"bad","sequence":3,"authority":"forbidden"}"#.utf8
        )
        let malformedAcknowledgement =
            await adapter.receiveCyclingControl(malformed)
        XCTAssertNil(malformedAcknowledgement)
        XCTAssertEqual(workout.startCount, 1)
        XCTAssertEqual(workout.stopCount, 1)
    }

    @MainActor
    func testTargetedCyclingStopRejectsAnotherWorkoutAndDetectsChangedTarget() async throws {
        let workout = TestCyclingWorkoutController()
        let adapter = WatchConnectivityAdapter(
            sender: TestWatchSender(), hapticPlayer: TestHapticPlayer(), workoutController: workout
        )
        let stale = WatchCyclingControlCommand(
            action: .stop, requestID: "targeted-stop", sequence: 1, workoutID: "old-workout"
        )
        let staleData = try stale.encodedStrict()
        XCTAssertEqual(try WatchCyclingControlCommand.decodeStrict(staleData), stale)
        let rejected = await adapter.receiveCyclingControl(staleData)
        XCTAssertEqual(try WatchCyclingControlAcknowledgement.decodeStrict(XCTUnwrap(rejected)).status, .rejected)
        XCTAssertEqual(workout.stopCount, 0)
        let conflict = WatchCyclingControlCommand(
            action: .stop, requestID: stale.requestID, sequence: 1, workoutID: workout.activeWorkoutID
        )
        let conflictReply = await adapter.receiveCyclingControl(try conflict.encodedStrict())
        XCTAssertEqual(try WatchCyclingControlAcknowledgement.decodeStrict(XCTUnwrap(conflictReply)).status, .rejected)
        let matching = WatchCyclingControlCommand(
            action: .stop, requestID: "matching-stop", sequence: 2, workoutID: workout.activeWorkoutID
        )
        let accepted = await adapter.receiveCyclingControl(try matching.encodedStrict())
        XCTAssertEqual(try WatchCyclingControlAcknowledgement.decodeStrict(XCTUnwrap(accepted)).status, .accepted)
        XCTAssertEqual(workout.stopCount, 1)
    }

    @MainActor
    func testCyclingControlRejectedStartStillInvokesOnlyOnce() async throws {
        let workout = TestCyclingWorkoutController()
        workout.rejectStart = true
        let adapter = WatchConnectivityAdapter(
            sender: TestWatchSender(),
            hapticPlayer: TestHapticPlayer(),
            workoutController: workout
        )
        let command = WatchCyclingControlCommand(
            action: .start,
            requestID: "cycling-rejected-1",
            sequence: 1
        )
        let acknowledgementData = await adapter.receiveCyclingControl(
            try command.encodedStrict()
        )
        let acknowledgement =
            try WatchCyclingControlAcknowledgement.decodeStrict(
                try XCTUnwrap(acknowledgementData)
            )
        XCTAssertEqual(acknowledgement.status, .rejected)
        XCTAssertEqual(workout.startCount, 1)

        _ = await adapter.receiveCyclingControl(
            try command.encodedStrict()
        )
        XCTAssertEqual(workout.startCount, 1)
    }
}
