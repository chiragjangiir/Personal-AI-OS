import Foundation
import XCTest
@testable import HealthKitExporter

@MainActor
final class WatchRelayTests: XCTestCase {
    private let scopeA = WatchBindingScope(watch_device_id: "00000000-0000-4000-8000-000000000001", pair_version: "1")
    private let scopeB = WatchBindingScope(watch_device_id: "00000000-0000-4000-8000-000000000002", pair_version: "2")
    private func authority(_ scope: WatchBindingScope, principal: String = "owner", pairing: String = "paired-owner") -> WatchCredentialAuthority {
        WatchCredentialAuthority(scope: scope, principal: principal, pairingIdentity: pairing)
    }
    private func question(_ id: String = "question") throws -> CentralQuestion {
        let fields: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "gesture_card",
            "session_id": "session", "card_id": id, "question": "哪一家？", "expires_at": "2030-01-01T00:00:00.120Z",
            "options": [["id": "b", "label": "乙", "lines": ["第二家"], "recommended": true],
                        ["id": "a", "label": "甲", "lines": []]]]
        return try CentralQuestion(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields)).fields)
    }
    private func sources(owner: String? = "owner", pairing: String? = "paired-owner", items: [YimiItem] = [], question: CentralQuestion? = nil,
                         care: CentralAmbientReply? = nil, errands: [CentralErrand] = [],
                         payments: [CentralPaymentCard] = []) -> WatchRelaySources {
        WatchRelaySources(ownerIdentity: owner, ownerPairingIdentity: pairing, items: items, question: question, errands: errands,
            care: care, payments: payments, serverReachable: true)
    }
    private func defaults() -> UserDefaults {
        let name = "WatchRelayTests-" + UUID().uuidString
        let value = UserDefaults(suiteName: name)!
        addTeardownBlock { value.removePersistentDomain(forName: name) }
        return value
    }
    private func request(_ action: WatchAssistantAction, _ args: WatchYimiActionArguments) -> WatchLocalEnvelope {
        WatchLocalEnvelope(kind: .request, action: action, requestID: UUID().uuidString, sequence: 1, version: 1, args: args)
    }
    func testCurrentSourcesPreserveOrderDeadlineDatesAndPrivacy() throws {
        let date = Date(timeIntervalSince1970: 10)
        let item = YimiItem(id: "assistant", kind: .her, text: "private amount", date: date, privacy: .payment)
        let state = sources(items: [item, YimiItem(id: "me", kind: .me, text: "ignore", date: date)],
            question: try question(), care: CentralAmbientReply(id: "care", heard: "", text: "你还好吗")).state(
                revision: 8, scope: scopeA, currentOwner: { principal, _ in principal == "owner" })
        XCTAssertEqual(state.latest?.card_id, "assistant")
        XCTAssertEqual(state.latest?.lines, [AssistantNotificationCenter.paymentResultBody])
        XCTAssertEqual(state.latest?.created_at, "1970-01-01T00:00:10.000Z")
        XCTAssertEqual(state.question?.options.map(\.id), ["b", "a"])
        XCTAssertEqual(state.question?.expires_at, "2030-01-01T00:00:00.120Z")
        XCTAssertEqual(state.care?.care_id, "care")
        XCTAssertNil(state.ride)
        XCTAssertLessThanOrEqual(try state.encodedStrict().count, 8192)
        let stale = sources(items: [item], question: try question()).state(revision: 9, scope: scopeA, currentOwner: { _, _ in false })
        XCTAssertNil(stale.latest); XCTAssertNil(stale.question); XCTAssertTrue(stale.errands.isEmpty)
    }
    func testRideProjectionPreservesSourceAndRejectsOtherOwner() throws {
        var source = sources()
        source.ride = CentralRideFeedback(ride_id: UUID().uuidString.lowercased(), at: "2026-10-17T00:00:00.000Z",
            hr_zone: 5, text: "源端提醒", max_hr_bpm: 160)
        let state = source.state(revision: 1, scope: scopeA, currentOwner: { _, _ in true })
        XCTAssertEqual(state.ride, WatchYimiRide(hr_zone: 5, text: "源端提醒", max_hr_bpm: 160, feedback_at: "2026-10-17T00:00:00.000Z"))
        _ = try state.encodedStrict()
        XCTAssertNil(source.state(revision: 2, scope: scopeA, currentOwner: { _, _ in false }).ride)
        XCTAssertNil(source.state(revision: 3, scope: nil, currentOwner: { _, _ in true }).ride)
        source.ride = CentralRideFeedback(ride_id: UUID().uuidString.lowercased(), at: "2026-10-17T00:00:01.000Z",
            hr_zone: nil, text: nil, max_hr_bpm: nil)
        XCTAssertEqual(source.state(revision: 4, scope: scopeA, currentOwner: { _, _ in true }).ride,
            WatchYimiRide(hr_zone: nil, text: nil, max_hr_bpm: nil, feedback_at: "2026-10-17T00:00:01.000Z"))
    }

    func testPhoneMetricsSurviveRelayAndMatchOnlyTheirWorkout() throws {
        let started = Date(timeIntervalSince1970: 100)
        var session = MoveSession()
        _ = session.startRide(by: "watch", at: started)
        let metrics = WatchYimiRideMetrics(ride_id: session.rideID!, workout_id: "live-workout", ended: false,
            speed_kmh: 23.4, avg_kmh: 20.1, max_kmh: 29.0, distance_m: 402.5,
            elapsed_s: 80, moving_s: 60, hr_bpm: 133, hr_avg: nil, hr_max: nil, kcal: 20,
            hr_sample_at: "1970-01-01T00:02:59.125Z", speed_sample_at: "1970-01-01T00:02:59.000Z")
        var source = sources()
        source.rideMetrics = metrics
        let encoded = try source.state(revision: 1, scope: scopeA, currentOwner: { _, _ in true }).encodedStrict()
        let decoded = try WatchYimiState.decodeStrict(encoded)
        XCTAssertEqual(decoded.ride?.metrics, metrics)
        XCTAssertTrue(metrics.matches(workoutID: "live-workout"))
        XCTAssertFalse(metrics.matches(workoutID: "previous-workout"))
        XCTAssertFalse(metrics.matches(workoutID: nil))
        XCTAssertNil(source.state(revision: 2, scope: scopeA, currentOwner: { _, _ in false }).ride)
        source.rideMetrics = WatchYimiRideMetrics(ride_id: metrics.ride_id, workout_id: metrics.workout_id,
            ended: true, speed_kmh: nil, avg_kmh: 20.1, max_kmh: 29, distance_m: 402.5,
            elapsed_s: 80, moving_s: 60, hr_bpm: nil, hr_avg: 130, hr_max: 144, kcal: 20)
        let ended = try WatchYimiState.decodeStrict(source.state(revision: 3, scope: scopeA,
            currentOwner: { _, _ in true }).encodedStrict())
        XCTAssertEqual(ended.ride?.metrics, source.rideMetrics)
        XCTAssertEqual(ended.ride?.metrics?.moving_s, 60)
        XCTAssertEqual(ended.ride?.metrics?.elapsed_s, 80)
        XCTAssertTrue(ended.ride!.metrics!.ended)
        var malformed = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(metrics)) as? [String: Any])
        malformed["distance_m"] = -1
        XCTAssertThrowsError(try JSONDecoder().decode(WatchYimiRideMetrics.self,
            from: JSONSerialization.data(withJSONObject: malformed)))
    }

    func testDiagnosticExporterHasNoProductMembershipOrComposition() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let name = "PhysicalCanaryPreworkoutObservationExporter"
        XCTAssertTrue(FileManager.default.fileExists(atPath: app.appendingPathComponent("Tests/Diagnostics/" + name + ".swift").path))
        for path in ["App/AssistantComposition.swift", "Core/WatchConnectivityPhoneAdapter.swift"] {
            XCTAssertFalse(try String(contentsOf: app.appendingPathComponent(path), encoding: .utf8).contains(name), path)
        }
        let project = try String(contentsOf: app.appendingPathComponent("HealthKitExporter.xcodeproj/project.pbxproj"), encoding: .utf8)
        let sources = project.components(separatedBy: "A90000000000000000000001 /* Sources */ = {").last!
            .components(separatedBy: "A90000000000000000000002 /* Sources */ = {").first!
        XCTAssertFalse(sources.contains(name))
    }
    func testPaymentCountUsesCanDecide() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Contracts/payment-message.v1.json")
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let examples = try XCTUnwrap(contract["examples"] as? [String: [[String: Any]]])
        let example = try XCTUnwrap(examples["payment_cards"]?.first)
        let sample = try XCTUnwrap((example["cards"] as? [[String: Any]])?.first)
        let cards = try ["awaiting_owner", "auto_pending", "verifying", "paying", "paid"].map { state in
            var raw = sample; raw["state"] = state
            return try JSONDecoder().decode(CentralPaymentCard.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        let state = sources(payments: cards).state(revision: 1, scope: scopeA, currentOwner: { _, _ in true })
        XCTAssertEqual(state.payment_pending.count, 3)
        XCTAssertFalse(state.payment_pending.summary.contains("\n"))
    }
    func testChangesOnlyAndPersistentRevisionAndBoundedEncoding() throws {
        var source = sources(question: try question())
        var published: [Data?] = []
        let defaults = defaults()
        let make = {
            WatchRelay(sources: { source }, currentOwner: { principal, _ in principal == "owner" }, publish: { state, _ in published.append(state) },
                answerQuestion: { _, _ in true }, cancelErrand: { _, _ in true }, careSafe: { _ in true },
                refreshCredential: {}, defaults: defaults)
        }
        let relay = make()
        try relay.projectBinding(authority(scopeA), credential: nil); try relay.synchronize()
        XCTAssertEqual(published.count, 1)
        let first = try WatchYimiState.decodeStrict(XCTUnwrap(published.last!))
        try make().projectBinding(authority(scopeA), credential: nil)
        let second = try WatchYimiState.decodeStrict(XCTUnwrap(published.last!))
        XCTAssertGreaterThan(second.rev, first.rev)
        source = sources(care: CentralAmbientReply(id: "care", heard: "", text: String(repeating: "字", count: 9000)))
        XCTAssertThrowsError(try relay.synchronize())
        XCTAssertNil(published.last!)
    }
    func testScopeRevisionRestartsAndKeepsOnlyCurrentBindingAcrossPhoneRestart() throws {
        let sender = ScopedPhoneSender(), adapter = WatchConnectivityPhoneAdapter(sender: sender), defaults = defaults()
        let source = sources(question: try question())
        let make = {
            WatchRelay(sources: { source }, currentOwner: { principal, _ in principal == "owner" },
                publish: { try adapter.publishYimiState($0, credential: $1) },
                answerQuestion: { _, _ in true }, cancelErrand: { _, _ in true }, careSafe: { _ in true },
                refreshCredential: {}, defaults: defaults)
        }
        let relay = make()
        try relay.synchronize()
        XCTAssertTrue(sender.contexts.isEmpty, "Unknown startup authority must not erase the last binding revision")
        try relay.projectBinding(authority(scopeA), credential: nil)
        try relay.synchronize(force: true)
        let beforeRestart = try sender.state()
        let restarted = make()
        try restarted.synchronize()
        XCTAssertEqual(try sender.state(), beforeRestart)
        try restarted.projectBinding(authority(scopeA), credential: nil)
        XCTAssertGreaterThan(try sender.state().rev, beforeRestart.rev)
        try restarted.projectBinding(authority(scopeB), credential: nil)
        XCTAssertEqual(try sender.state().rev, 1)
        try restarted.synchronize(force: true)
        XCTAssertEqual(try sender.state().rev, 2)
        try restarted.projectBinding(nil, credential: nil)
        XCTAssertEqual(try sender.state().link, .watch_unregistered)
        XCTAssertNil(try sender.state().scope)
        XCTAssertNil(sender.applicationContext["watch_credential"])
        try restarted.synchronize(force: true)
        XCTAssertEqual(try sender.state().rev, 2)
        let record = try XCTUnwrap(defaults.dictionary(forKey: "paios.watch.yimi-state-revision.v2"))
        XCTAssertEqual(Set(record.keys), ["rev"], "A revoked binding's scope must not remain in persistence")
        for context in sender.contexts {
            _ = try WatchYimiState.decodeStrict(XCTUnwrap(context["yimi_state"] as? Data))
        }
    }
    func testServerScopeChangeAtomicallyRemovesOldCredentialBeforeIssuingNewOne() async throws {
        let sender = ScopedPhoneSender()
        sender.applicationContext = ["payload": Data("identity".utf8)]
        let adapter = WatchConnectivityPhoneAdapter(sender: sender), source = sources()
        let relay = WatchRelay(sources: { source }, currentOwner: { principal, _ in principal == "owner" },
            publish: { try adapter.publishYimiState($0, credential: $1) },
            answerQuestion: { _, _ in true }, cancelErrand: { _, _ in true }, careSafe: { _ in true },
            refreshCredential: {}, defaults: defaults())
        let a = scopeA, b = scopeB
        let provider = ScopedPhoneCredentialProvider(scope: a) { scope in
            try await MainActor.run {
                XCTAssertEqual(try sender.state().scope, scope)
                if scope == b {
                    XCTAssertNil(sender.applicationContext["watch_credential"], "Old token must be removed before new issue")
                }
            }
        }
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { scope, credential in
            try await relay.projectBinding(scope, credential: credential)
        })
        await lifecycle.synchronize()
        XCTAssertNotNil(sender.applicationContext["watch_credential"])
        let beforeSuspension = try sender.state().rev
        await lifecycle.suspend() // Local authority loss or a revoke attempt that has not succeeded.
        XCTAssertEqual(try sender.state().scope, a)
        XCTAssertNil(sender.applicationContext["watch_credential"])
        await lifecycle.synchronize() // The server still reports A after a failed revoke.
        XCTAssertEqual(try sender.state().scope, a)
        XCTAssertGreaterThan(try sender.state().rev, beforeSuspension)
        let before = sender.contexts.count
        await provider.replaceScope(b)
        await lifecycle.synchronize()
        XCTAssertEqual(sender.contexts.count, before + 2)
        let transition = sender.contexts[before]
        XCTAssertEqual(try WatchYimiState.decodeStrict(XCTUnwrap(transition["yimi_state"] as? Data)).scope, b)
        XCTAssertNil(transition["watch_credential"], "State change and old-token removal are one context write")
        let credential = try JSONDecoder().decode(WatchCredential.self, from: XCTUnwrap(sender.applicationContext["watch_credential"] as? Data))
        XCTAssertEqual(credential.scope, b)
        XCTAssertEqual(try sender.state().rev, 2)
        await lifecycle.invalidate()
        for context in sender.contexts {
            let state = try WatchYimiState.decodeStrict(XCTUnwrap(context["yimi_state"] as? Data))
            XCTAssertEqual(context["payload"] as? Data, Data("identity".utf8))
            if let data = context["watch_credential"] as? Data {
                XCTAssertEqual(try JSONDecoder().decode(WatchCredential.self, from: data).scope, state.scope)
            }
        }
        XCTAssertEqual(try sender.state().link, .watch_unregistered)
    }
    func testCanonicalPrincipalAndPairingGenerationRemainLocalActionFences() async throws {
        var source = sources(owner: "canonical-principal", pairing: "generation-a", question: try question())
        let sender = ScopedPhoneSender()
        let relay = WatchRelay(sources: { source }, currentOwner: { principal, pairing in
            principal == "canonical-principal" && pairing == source.ownerPairingIdentity
        }, publish: { state, credential in
            var context: [String: Any] = [:]; context["yimi_state"] = state; context["watch_credential"] = credential
            sender.updateApplicationContext(context)
        }, answerQuestion: { _, _ in XCTFail("stale projection cannot submit"); return false },
           cancelErrand: { _, _ in false }, careSafe: { _ in false }, refreshCredential: {}, defaults: defaults())
        try relay.projectBinding(authority(scopeA, principal: "canonical-principal", pairing: "generation-a"), credential: nil)
        XCTAssertEqual(try sender.state().scope, scopeA)
        let wire = try XCTUnwrap(sender.applicationContext["yimi_state"] as? Data)
        XCTAssertFalse(String(decoding: wire, as: UTF8.self).contains("canonical-principal"))
        XCTAssertFalse(String(decoding: wire, as: UTF8.self).contains("generation-a"))
        source = sources(owner: "canonical-principal", pairing: "generation-b", question: try question())
        try relay.synchronize()
        XCTAssertEqual(try sender.state().scope, scopeA)
        XCTAssertNil(try sender.state().question, "New owner data cannot use a scope validated under the previous pairing")
        try relay.projectBinding(authority(scopeA, principal: "canonical-principal", pairing: "generation-a"), credential: nil) // Suspension does not validate the new owner.
        XCTAssertNil(try sender.state().question)
        let accepted = await relay.handle(request(.cardAnswer, .init(card_id: "question", option_id: "b")))
        XCTAssertFalse(accepted)
        XCTAssertThrowsError(try relay.projectBinding(authority(scopeA, principal: "canonical-principal", pairing: "generation-a"), credential: WatchCredential(version: 1, kind: "watch_credential", token: "revalidated",
            expires_at: "2030-01-01T00:00:00Z", server: "https://example.com", scope: scopeA)))
        XCTAssertNil(try sender.state().question)
        try relay.projectBinding(authority(scopeA, principal: "canonical-principal", pairing: "generation-b"), credential: nil)
        XCTAssertEqual(try sender.state().question?.card_id, "question")
    }
    func testWorkoutSnapshotRequiresResolvedScopeAndCurrentOwnerGeneration() throws {
        var source = sources(owner: "owner", pairing: "paired-owner")
        let relay = WatchRelay(sources: { source }, currentOwner: { principal, pairing in
            principal == source.ownerIdentity && pairing == source.ownerPairingIdentity
        }, publish: { _, _ in }, answerQuestion: { _, _ in false }, cancelErrand: { _, _ in false },
            careSafe: { _ in false }, refreshCredential: {}, defaults: defaults())
        XCTAssertFalse(relay.acceptsWorkoutSnapshot(scopeA))
        try relay.projectBinding(authority(scopeA), credential: nil)
        XCTAssertTrue(relay.acceptsWorkoutSnapshot(scopeA))
        XCTAssertFalse(relay.acceptsWorkoutSnapshot(scopeB))
        source = sources(owner: "other", pairing: "new-pair")
        XCTAssertFalse(relay.acceptsWorkoutSnapshot(scopeA))
        try relay.projectBinding(nil, credential: nil)
        XCTAssertFalse(relay.acceptsWorkoutSnapshot(scopeA))
    }
    func testActionsUseCapturedAuthorityAndRefuseStaleOwnerCardAndCare() async throws {
        var owner = "owner", source = sources(question: try question(), care: CentralAmbientReply(id: "care", heard: "", text: "好吗"))
        var answers: [String] = [], careOwners: [String] = []
        let relay = WatchRelay(sources: { source }, currentOwner: { principal, _ in principal == owner }, publish: { _, _ in },
            answerQuestion: { card, option in answers.append(card + "/" + option); return true },
            cancelErrand: { _, _ in XCTFail("no errand projected"); return false },
            careSafe: { careOwners.append($0); return true }, refreshCredential: {}, defaults: defaults())
        try relay.projectBinding(authority(scopeA), credential: nil)
        let answered = await relay.handle(request(.cardAnswer, .init(card_id: "question", option_id: "b")))
        XCTAssertTrue(answered); XCTAssertEqual(answers, ["question/b"])
        let safe = await relay.handle(request(.careSafe, .init(care_id: "care")))
        XCTAssertTrue(safe); XCTAssertEqual(careOwners, ["paired-owner"])
        source = sources(question: try question("new"), care: CentralAmbientReply(id: "new-care", heard: "", text: "好吗"))
        let staleCard = await relay.handle(request(.cardAnswer, .init(card_id: "question", option_id: "b")))
        let staleCare = await relay.handle(request(.careSafe, .init(care_id: "care")))
        XCTAssertFalse(staleCard); XCTAssertFalse(staleCare)
        owner = "different"
        let staleOwner = await relay.handle(request(.careSafe, .init(care_id: "care")))
        XCTAssertFalse(staleOwner); XCTAssertEqual(careOwners, ["paired-owner"])
    }
}

private final class ScopedPhoneSender: WatchPhoneConnectivitySending {
    var isActivated = true
    var isReachable = true
    var receivedApplicationContext: [String: Any] = [:]
    var applicationContext: [String: Any] = [:]
    var contexts: [[String: Any]] = []
    func activate() {}
    func updateApplicationContext(_ context: [String: Any]) { applicationContext = context; contexts.append(context) }
    func sendMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?, errorHandler: ((Error) -> Void)?) {}
    func enqueueUserInfo(_ userInfo: [String: Any]) {}
    func state() throws -> WatchYimiState { try WatchYimiState.decodeStrict(XCTUnwrap(applicationContext["yimi_state"] as? Data)) }
}
private actor ScopedPhoneCredentialProvider: WatchCredentialProviding {
    private var scope: WatchBindingScope
    private let onIssue: @Sendable (WatchBindingScope) async throws -> Void
    init(scope: WatchBindingScope, onIssue: @escaping @Sendable (WatchBindingScope) async throws -> Void) {
        self.scope = scope; self.onIssue = onIssue
    }
    func replaceScope(_ value: WatchBindingScope) { scope = value }
    func watchCredential(action: WatchCredentialAction, requestID: String,
                         prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        try await prepare(WatchCredentialAuthority(scope: scope, principal: "owner", pairingIdentity: "paired-owner"))
        try await onIssue(scope)
        return WatchCredential(version: 1, kind: "watch_credential", token: requestID,
            expires_at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)),
            server: "https://example.com", scope: scope)
    }
}
