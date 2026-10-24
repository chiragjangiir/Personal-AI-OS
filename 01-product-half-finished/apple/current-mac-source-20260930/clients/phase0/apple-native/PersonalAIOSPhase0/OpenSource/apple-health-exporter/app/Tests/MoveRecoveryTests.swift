import XCTest
@testable import HealthKitExporter

final class MoveRecoveryTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)
    private let scope = WatchBindingScope(watch_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pair_version: "1")
    private func metric(_ sequence: UInt64, seconds: Double, state: WatchCyclingWorkoutState? = nil,
                        id: String = "workout", origin: WatchCyclingWorkoutOrigin = .watch) -> WatchCyclingMetricEnvelope {
        WatchCyclingMetricEnvelope(sequence: sequence, observedAt: start.addingTimeInterval(seconds), workoutID: id,
            heartRateBPM: 120, activeEnergyKcal: seconds, distanceM: seconds * 3, elapsedS: seconds,
            cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: state, workoutOrigin: origin)
    }
    private func snapshot(_ sequence: UInt64, seconds: Double, state: WatchCyclingWorkoutState = .started,
                          id: String = "workout", origin: WatchCyclingWorkoutOrigin = .watch) -> WatchCyclingWorkoutSnapshot {
        WatchCyclingWorkoutSnapshot(startedAt: start,
            metric: metric(sequence, seconds: seconds, state: state, id: id, origin: origin), scope: scope)
    }
    private func running() -> MoveSession {
        var session = MoveSession()
        _ = session.watchMetric(metric(1, seconds: 0, state: .started), at: start)
        for second in 1...3 {
            _ = session.observe(MoveFix(position: MovePosition(lat: 1 + Double(second) * 0.00001, lng: 2, accuracy_m: 3),
                at: start.addingTimeInterval(Double(second)), speedKmh: 20))
        }
        session.recordAltitude(10); session.recordAltitude(15)
        _ = session.watchMetric(metric(2, seconds: 3), at: start.addingTimeInterval(3))
        return session
    }
    func testPreviousNavigationCheckpointReprojectsAfterUpgrade() throws {
        var previous = running()
        let route = NavRoute(nav_id: "nav", revision: 2, mode: "bicycling",
            destination: .init(name: "end", lat: 1, lng: 2.01), total_m: 1000, total_s: 200,
            steps: [.init(index: 0, maneuver: "straight", instruction: "continue", distance_m: 1000, duration_s: 200,
                polyline: [.init(lat: 1, lng: 2), .init(lat: 1, lng: 2.01)])])
        _ = previous.follow(route, at: start)
        let fix = MoveFix(position: .init(lat: 1, lng: 2.002, accuracy_m: 3), at: start.addingTimeInterval(4), speedKmh: 20)
        _ = previous.observe(fix)
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: previous.checkpoint()) as? [String: Any])
        var navigation = try XCTUnwrap(payload["navigation"] as? [String: Any])
        var progress = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(previous.navigation?.progress)) as? [String: Any])
        progress.removeValue(forKey: "route_segment_index"); progress.removeValue(forKey: "segment_fraction")
        navigation["progress"] = progress; payload["navigation"] = navigation
        var restored = try MoveSession(checkpoint: JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(restored.rideID, previous.rideID)
        XCTAssertEqual(restored.navigation?.route.nav_id, "nav")
        XCTAssertNil(restored.navigation?.progress)
        _ = restored.reconcileWatchWorkout(snapshot(4, seconds: 5), at: start.addingTimeInterval(5))
        _ = restored.observe(fix)
        let projected = try XCTUnwrap(restored.navigation?.progress)
        XCTAssertEqual(projected.route_segment_index, 0)
        XCTAssertEqual(projected.segment_fraction, 0.2, accuracy: 0.001)
    }
    func testConsumedStartRestoresSameLogicalRideAndStatisticsFromCurrentSnapshot() throws {
        let previous = running(), old = previous.ride!.summary(at: start.addingTimeInterval(3))
        var restored = try MoveSession(checkpoint: previous.checkpoint())
        XCTAssertFalse(restored.isActive, "A checkpoint must not restart sensors before Watch reconciliation")
        XCTAssertTrue(restored.watchMetric(metric(3, seconds: 4), at: start.addingTimeInterval(4)).isEmpty)
        XCTAssertFalse(restored.isActive)
        XCTAssertTrue(restored.reconcileWatchWorkout(snapshot(4, seconds: 5), at: start.addingTimeInterval(5)).isEmpty)
        XCTAssertTrue(restored.isActive)
        XCTAssertEqual(restored.rideID, previous.rideID)
        XCTAssertEqual(restored.watchWorkoutID, "workout")
        let recovered = restored.ride!.summary(at: start.addingTimeInterval(5))
        XCTAssertEqual(recovered.started_at, start)
        XCTAssertEqual(recovered.distance_m, old.distance_m)
        XCTAssertEqual(recovered.moving_s, old.moving_s)
        XCTAssertEqual(recovered.max_kmh, old.max_kmh)
        XCTAssertEqual(recovered.elev_gain_m, 5)
        XCTAssertEqual(recovered.hr_max, 120)
        XCTAssertEqual(recovered.kcal, 5)
        XCTAssertTrue(restored.reconcileWatchWorkout(snapshot(4, seconds: 5), at: start.addingTimeInterval(5)).isEmpty)
        XCTAssertEqual(restored.rideID, previous.rideID)
    }
    func testOfflineEndWinsBeforeSensorsResumeAndPersistsTombstone() throws {
        let previous = running()
        var restored = try MoveSession(checkpoint: previous.checkpoint())
        let events = restored.reconcileWatchWorkout(snapshot(5, seconds: 8, state: .ended), at: start.addingTimeInterval(20))
        XCTAssertFalse(restored.isActive)
        XCTAssertEqual(events.count, 1)
        guard case .rideState(let ended) = events[0] else { return XCTFail("Expected end") }
        XCTAssertEqual(ended.ride_id, previous.rideID)
        XCTAssertEqual(ended.state, "ended")
        XCTAssertEqual(ended.summary?.ended_at, start.addingTimeInterval(8))
        XCTAssertEqual(ended.summary?.kcal, 8)
        restored = try MoveSession(checkpoint: restored.checkpoint())
        XCTAssertTrue(restored.reconcileWatchWorkout(snapshot(6, seconds: 7), at: start.addingTimeInterval(21)).isEmpty)
        XCTAssertTrue(restored.watchMetric(metric(7, seconds: 0, state: .started), at: start.addingTimeInterval(21)).isEmpty)
        XCTAssertFalse(restored.isActive)
    }
    func testCheckpointKeepsRetainedPhoneSamplesAndEndedWatchSummary() throws {
        let previous = running(), original = previous.ride!.summary(at: start.addingTimeInterval(3))
        var restored = try MoveSession(checkpoint: previous.checkpoint())
        XCTAssertFalse(restored.isActive)
        let current = WatchCyclingMetricEnvelope(sequence: 3, observedAt: start.addingTimeInterval(30), workoutID: "workout",
            heartRateBPM: nil, activeEnergyKcal: nil, distanceM: nil, elapsedS: 30,
            cadenceSPM: nil, cyclingSpeedMPS: nil, workoutState: .started, workoutOrigin: .watch)
        _ = restored.reconcileWatchWorkout(.init(startedAt: start, metric: current, scope: scope), at: start.addingTimeInterval(30))
        XCTAssertEqual(restored.rideID, previous.rideID)
        guard case .frame(let frame) = try XCTUnwrap(restored.frame(at: start.addingTimeInterval(30), cadence: nil)) else { return XCTFail("Expected recovered ride") }
        let metrics = try XCTUnwrap(frame.ride)
        XCTAssertEqual(metrics.speed_kmh, 20); XCTAssertEqual(metrics.hr_bpm, 120)
        XCTAssertEqual(metrics.speed_sample_at, start.addingTimeInterval(3))
        XCTAssertEqual(metrics.hr_sample_at, start.addingTimeInterval(3))
        XCTAssertEqual(metrics.distance_m, original.distance_m)
        XCTAssertEqual(metrics.avg_kmh, original.avg_kmh)
        XCTAssertEqual(metrics.max_kmh, original.max_kmh)
        _ = restored.endRide(at: start.addingTimeInterval(31))
        restored = try MoveSession(checkpoint: restored.checkpoint())
        XCTAssertEqual(restored.lastRideState?.state, "ended")
        XCTAssertEqual(restored.lastRideState?.ride_id, previous.rideID)
        XCTAssertEqual(restored.lastRideWorkoutID, "workout")
        XCTAssertEqual(restored.lastRideState?.summary?.distance_m, metrics.distance_m)
        XCTAssertEqual(restored.lastRideState?.summary?.avg_kmh, metrics.avg_kmh)
        XCTAssertEqual(restored.lastRideState?.summary?.max_kmh, metrics.max_kmh)
        XCTAssertEqual(restored.lastRideState?.summary?.hr_max, 120)
        XCTAssertTrue(restored.reconcileWatchWorkout(snapshot(4, seconds: 30), at: start.addingTimeInterval(32)).isEmpty)
        XCTAssertFalse(restored.isActive)
    }
    func testUnchangedContextReconcilesAgainAfterAnotherPhoneRestart() throws {
        var session = running()
        _ = session.reconcileWatchWorkout(snapshot(4, seconds: 5), at: start.addingTimeInterval(5))
        let id = session.rideID
        session = try MoveSession(checkpoint: session.checkpoint())
        XCTAssertFalse(session.isActive)
        _ = session.reconcileWatchWorkout(snapshot(4, seconds: 5), at: start.addingTimeInterval(6))
        XCTAssertTrue(session.isActive)
        XCTAssertEqual(session.rideID, id)
    }
    func testQueuedEndBeforeCurrentContextCannotRestartSensors() throws {
        var restored = try MoveSession(checkpoint: running().checkpoint())
        XCTAssertEqual(restored.watchMetric(metric(8, seconds: 10, state: .ended), at: start.addingTimeInterval(20)).count, 1)
        XCTAssertFalse(restored.isActive)
        XCTAssertTrue(restored.reconcileWatchWorkout(snapshot(7, seconds: 9), at: start.addingTimeInterval(20)).isEmpty)
        XCTAssertFalse(restored.isActive)
    }
    func testNoCheckpointRecoversOnlyAuthoritativeSnapshotNotTelemetry() {
        var session = MoveSession()
        XCTAssertTrue(session.watchMetric(metric(2, seconds: 3), at: start.addingTimeInterval(3)).isEmpty)
        XCTAssertFalse(session.isActive)
        XCTAssertEqual(session.reconcileWatchWorkout(snapshot(3, seconds: 10), at: start.addingTimeInterval(10)).count, 1)
        XCTAssertEqual(session.ride?.startedAt, start)
    }
    func testOtherWorkoutCannotTakeOverDormantCheckpoint() throws {
        let previous = running()
        var restored = try MoveSession(checkpoint: previous.checkpoint())
        _ = restored.reconcileWatchWorkout(snapshot(9, seconds: 10, state: .ended, id: "other"), at: start.addingTimeInterval(10))
        XCTAssertFalse(restored.isActive)
        XCTAssertEqual(restored.rideID, previous.rideID)
        _ = restored.reconcileWatchWorkout(snapshot(10, seconds: 11, id: "other"), at: start.addingTimeInterval(11))
        XCTAssertFalse(restored.isActive)
        XCTAssertEqual(restored.watchWorkoutID, "workout")
    }
    func testUnboundPhoneRideCannotBeEndedByAnotherWorkout() {
        var session = MoveSession()
        _ = session.startRide(by: "phone", at: start)
        let id = session.rideID
        XCTAssertTrue(session.reconcileWatchWorkout(snapshot(9, seconds: 5, state: .ended), at: start.addingTimeInterval(5)).isEmpty)
        XCTAssertEqual(session.rideID, id)
        XCTAssertTrue(session.isActive)
    }
    func testPhoneStartedRideReconcilesWithoutChangingItsLogicalIdentity() throws {
        var session = MoveSession()
        _ = session.startRide(by: "phone", at: start)
        let id = session.rideID
        _ = session.watchMetric(metric(1, seconds: 0, state: .started, origin: .phone), at: start)
        session = try MoveSession(checkpoint: session.checkpoint())
        XCTAssertFalse(session.isActive)
        XCTAssertTrue(session.reconcileWatchWorkout(snapshot(2, seconds: 5, origin: .phone), at: start.addingTimeInterval(5)).isEmpty)
        XCTAssertTrue(session.isActive)
        XCTAssertEqual(session.rideID, id)
        var unknown = MoveSession()
        XCTAssertTrue(unknown.reconcileWatchWorkout(snapshot(2, seconds: 5, origin: .phone), at: start.addingTimeInterval(5)).isEmpty)
        XCTAssertFalse(unknown.isActive)
    }
    func testSnapshotStrictWireRoundTripAndRejection() throws {
        let value = snapshot(3, seconds: 5)
        XCTAssertEqual(try WatchCyclingWorkoutSnapshot.decodeStrict(value.encodedStrict()), value)
        XCTAssertThrowsError(try WatchCyclingWorkoutSnapshot(startedAt: start.addingTimeInterval(6), metric: value.metric, scope: scope).encodedStrict())
        XCTAssertThrowsError(try WatchCyclingWorkoutSnapshot.decodeStrict(Data("{\"started_at\":0,\"metric\":{},\"owner\":\"other\"}".utf8)))
    }
    func testBindingPublicationReplaysSnapshotAndRejectsOtherPairVersions() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.live = try snapshot(9, seconds: 10).encodedStrict()
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(9, seconds: 10).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let initial = await recorder.values
        XCTAssertTrue(initial.isEmpty)
        func state(_ scope: WatchBindingScope) throws -> Data {
            try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
                latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()
        }
        try adapter.publishYimiState(state(.init(watch_device_id: scope.watch_device_id, pair_version: "2")), credential: nil)
        await adapter.waitForPendingDeliveries()
        let wrongPair = await recorder.values
        XCTAssertTrue(wrongPair.isEmpty)
        try adapter.publishYimiState(state(scope), credential: nil)
        await adapter.waitForPendingDeliveries()
        let current = await recorder.values
        XCTAssertEqual(current, [snapshot(9, seconds: 10)])
    }
    func testCachedStartRemainsDormantOfflineAndRetriesWhenReachable() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.isReachable = false
        sender.live = try snapshot(8, seconds: 10, state: .ended).encodedStrict()
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(7, seconds: 8).encodedStrict()]
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let offline = await recorder.values
        XCTAssertTrue(offline.isEmpty)
        sender.isReachable = true; sender.wrongNonce = true
        adapter.reachabilityChanged()
        await adapter.waitForPendingDeliveries()
        let invalidReply = await recorder.values
        XCTAssertTrue(invalidReply.isEmpty)
        sender.wrongNonce = false
        sender.live = try WatchCyclingWorkoutSnapshot(startedAt: start, metric: snapshot(8, seconds: 10, state: .ended).metric,
            scope: .init(watch_device_id: scope.watch_device_id, pair_version: "2")).encodedStrict()
        adapter.reachabilityChanged()
        await adapter.waitForPendingDeliveries()
        let wrongScope = await recorder.values
        XCTAssertTrue(wrongScope.isEmpty)
        sender.live = try snapshot(8, seconds: 10, state: .ended).encodedStrict()
        adapter.reachabilityChanged()
        await adapter.waitForPendingDeliveries()
        let online = await recorder.values
        XCTAssertEqual(online.map { $0.metric.workoutState }, [.ended])
    }
    func testMissingCachedSnapshotStillQueriesCurrentBoundWatch() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.live = try snapshot(8, seconds: 10).encodedStrict()
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let current = await recorder.values
        XCTAssertEqual(current.map { $0.metric.workoutState }, [.started])
    }
    func testDelayedContextStartedAlsoRequiresLiveRead() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.live = try snapshot(8, seconds: 10, state: .ended).encodedStrict()
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.receiveApplicationContext([WatchCyclingWorkoutSnapshot.contextKey: try snapshot(7, seconds: 8).encodedStrict()])
        await adapter.waitForPendingDeliveries()
        let current = await recorder.values
        XCTAssertEqual(current.map { $0.metric.workoutState }, [.ended])
    }
    func testCachedEndedStopsOldRideThenQueriesNewCurrentWorkout() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(8, seconds: 10, state: .ended).encodedStrict()]
        sender.live = try WatchCyclingWorkoutSnapshot(startedAt: start.addingTimeInterval(20),
            metric: metric(9, seconds: 25, state: .started, id: "new-workout"), scope: scope).encodedStrict()
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let current = await recorder.values
        XCTAssertEqual(current.map { $0.metric.workoutState }, [.ended, .started])
        XCTAssertEqual(current.map { $0.metric.workoutID }, ["workout", "new-workout"])
    }
    func testCachedEndedIsAcceptedEvenWhenWatchCannotReply() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.isReachable = false
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(8, seconds: 10, state: .ended).encodedStrict()]
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let ended = await recorder.values
        XCTAssertEqual(ended.map { $0.metric.workoutState }, [.ended])
    }
    func testWatchQueryReplyRequiresExactScopeAndLiveProducerProjection() throws {
        let nonce = UUID().uuidString.lowercased()
        let query: [String: Any] = [WatchCyclingWorkoutSnapshot.queryKey: nonce, "scope": try JSONEncoder().encode(scope)]
        let ended = try snapshot(8, seconds: 10, state: .ended).encodedStrict()
        let reply = try XCTUnwrap(WatchCyclingWorkoutSnapshot.queryReply(query,
            context: [WatchCyclingWorkoutSnapshot.contextKey: ended], scope: scope))
        XCTAssertEqual(reply[WatchCyclingWorkoutSnapshot.queryKey] as? String, nonce)
        XCTAssertEqual(reply[WatchCyclingWorkoutSnapshot.contextKey] as? Data, ended)
        XCTAssertTrue(try XCTUnwrap(WatchCyclingWorkoutSnapshot.queryReply(query, context: [:], scope: scope)).isEmpty)
        XCTAssertTrue(try XCTUnwrap(WatchCyclingWorkoutSnapshot.queryReply(query,
            context: [WatchCyclingWorkoutSnapshot.contextKey: ended], scope: .init(watch_device_id: scope.watch_device_id, pair_version: "2"))).isEmpty)
    }
    func testCachedStartMustReadLiveEndedBeforeRecovery() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(7, seconds: 8).encodedStrict()]
        sender.live = try snapshot(8, seconds: 10, state: .ended).encodedStrict()
        sender.applicationContext = ["yimi_state": try WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil).encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let values = await recorder.values
        XCTAssertEqual(values.map { $0.metric.workoutState }, [.ended], "A cached running context cannot restart sensors before a live read")
    }
    func testColdActivationReadsLatestWorkoutContextBeforeQueuedMetrics() async throws {
        let sender = RecoveryQuerySender(), recorder = RecoverySnapshotRecorder()
        sender.live = try snapshot(9, seconds: 10).encodedStrict()
        sender.receivedApplicationContext = [WatchCyclingWorkoutSnapshot.contextKey: try snapshot(9, seconds: 10).encodedStrict()]
        let state = WatchYimiState(version: 1, kind: "yimi_state", rev: 1, link: .ok, scope: scope,
            latest: nil, question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
        sender.applicationContext = ["yimi_state": try state.encodedStrict()]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setWorkoutSnapshotHandler { await recorder.record($0) }
        adapter.activationChanged(isActivated: true, error: nil)
        await adapter.waitForPendingDeliveries()
        let values = await recorder.values
        XCTAssertEqual(values, [snapshot(9, seconds: 10)])
    }
}

private actor RecoverySnapshotRecorder {
    private(set) var values: [WatchCyclingWorkoutSnapshot] = []
    func record(_ value: WatchCyclingWorkoutSnapshot) { values.append(value) }
}

private final class RecoveryQuerySender: WatchPhoneConnectivitySending {
    var isActivated = true
    var isReachable = true
    var receivedApplicationContext: [String: Any] = [:]
    var applicationContext: [String: Any] = [:]
    var live: Data?
    var wrongNonce = false
    func activate() {}
    func enqueueUserInfo(_ userInfo: [String: Any]) {}
    func updateApplicationContext(_ context: [String: Any]) throws { applicationContext = context }
    func sendMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?, errorHandler: ((Error) -> Void)?) {
        guard let nonce = message["cycling_workout_query"] as? String else { return }
        var reply: [String: Any] = ["cycling_workout_query": wrongNonce ? "wrong" : nonce]
        reply[WatchCyclingWorkoutSnapshot.contextKey] = live
        replyHandler?(reply)
    }
}
