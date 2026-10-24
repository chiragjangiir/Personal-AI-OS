import Foundation
import XCTest
@testable import HealthKitExporter

final class WatchCredentialTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_108_800)
    private let watch = "ee0ebf3d-1813-4c98-9f67-0c026ee72989"
    private let installation = "10d8903c-25b7-4e76-a0f0-e3be17542029"
    private func binding(expiry: Date) -> RealtimeFormalWatchBinding {
        let ref = RealtimeCanonicalReference(refType: "DeviceLease", refID: "lease", objectVersion: "1", canonicalPayloadSha256: String(repeating: "a", count: 64))
        return RealtimeFormalWatchBinding(bindingId: "binding", kind: "formal_watch", status: "active", pairVersion: "4",
            installationId: installation, userId: "owner", issuedAt: stamp(now), expiresAt: stamp(expiry),
            canonicalPayloadSha256: String(repeating: "b", count: 64), realtimeSessionRef: ref,
            iphone: .init(deviceId: "phone", clientInstanceId: "phone-installation", deviceLeaseRef: ref),
            watch: .init(deviceId: watch, clientInstanceId: installation, deviceLeaseRef: ref))
    }
    private func stamp(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    private func data(_ body: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: body) }
    private func reply(expiry: Date) -> [String: Any] {
        ["status": "credential", "watch_device_id": watch, "installation_id": installation,
         "pair_version": "4", "token": "watch-only-secret", "expires_at": stamp(expiry)]
    }

    func testAllCredentialActionsUseExactFrozenRequestWithoutPhoneIdentityOrTTL() throws {
        let requestID = UUID().uuidString.lowercased()
        for action in [WatchCredentialAction.issue, .refresh, .revoke] {
            let value = try JSONSerialization.jsonObject(with: WatchCredentialWire.request(action: action,
                binding: binding(expiry: now.addingTimeInterval(600)), requestID: requestID)) as? [String: String]
            XCTAssertEqual(value, ["action": action.rawValue, "watch_device_id": watch, "installation_id": installation,
                "expected_pair_version": "4", "request_id": requestID])
        }
    }

    func testCredentialExpiryCannotOutliveCanonicalBindingOrSevenDays() throws {
        let bound = binding(expiry: now.addingTimeInterval(600))
        let valid = try WatchCredentialWire.response(data(reply(expiry: now.addingTimeInterval(600))), action: .issue,
            binding: bound, server: "https://example.com", now: now)
        XCTAssertEqual(valid?.token, "watch-only-secret")
        XCTAssertEqual(valid?.scope, WatchBindingScope(watch_device_id: watch, pair_version: "4"))
        for expiry in [now, now.addingTimeInterval(601)] {
            XCTAssertThrowsError(try WatchCredentialWire.response(data(reply(expiry: expiry)), action: .refresh,
                binding: bound, server: "https://example.com", now: now))
        }
        XCTAssertThrowsError(try WatchCredentialWire.response(data(reply(expiry: now.addingTimeInterval(604801))), action: .issue,
            binding: binding(expiry: now.addingTimeInterval(900000)), server: "https://example.com", now: now))
    }

    func testRejectsForeignScopeUnknownKeysAndWrongActionOutcome() throws {
        for (key, value) in [("watch_device_id", UUID().uuidString), ("installation_id", UUID().uuidString),
                             ("pair_version", "5"), ("principal", "forbidden")] {
            var body = reply(expiry: now.addingTimeInterval(100)); body[key] = value
            XCTAssertThrowsError(try WatchCredentialWire.response(data(body), action: .refresh,
                binding: binding(expiry: now.addingTimeInterval(600)), server: "https://example.com", now: now))
        }
        let revoked: [String: Any] = ["status": "revoked", "watch_device_id": watch, "installation_id": installation, "pair_version": "4"]
        XCTAssertNil(try WatchCredentialWire.response(data(revoked), action: .revoke,
            binding: binding(expiry: now.addingTimeInterval(600)), server: "https://example.com", now: now))
        XCTAssertThrowsError(try WatchCredentialWire.response(data(revoked), action: .issue,
            binding: binding(expiry: now.addingTimeInterval(600)), server: "https://example.com", now: now))
        XCTAssertEqual(try WatchCredentialWire.failure(data(["status": "failed", "reason": "pair_version_conflict"])), .rejected("pair_version_conflict"))
    }

    func testOverlappingWakeupsSerializeMutationsAndPublishOnlyLatestToken() async {
        let provider = SlowWatchCredentialProvider()
        let deliveries = WatchCredentialDeliveries()
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { await deliveries.append($0, $1) })
        let first = Task { await lifecycle.synchronize() }
        await provider.waitUntilRequested()
        await lifecycle.refresh()
        await first.value
        let maximum = await provider.maximumActive
        let tokens = await deliveries.values.compactMap { $0?.token }
        XCTAssertEqual(maximum, 1)
        XCTAssertEqual(tokens, ["token-2"])
        await lifecycle.invalidate()
    }

    func testLifecycleRefreshRotatesAndRevokeClearsDelivery() async {
        let provider = RotatingWatchCredentialProvider()
        let deliveries = WatchCredentialDeliveries()
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { await deliveries.append($0, $1) })
        await lifecycle.synchronize()
        await lifecycle.refresh()
        await lifecycle.revoke()
        let actions = await provider.actions
        let values = await deliveries.values
        XCTAssertEqual(actions, [.issue, .refresh, .revoke])
        XCTAssertEqual(values.compactMap { $0?.token }, ["token-1", "token-2"])
        XCTAssertNil(values.last!)
    }

    func testScopePublishesBeforeIssueAndSameScopeRefreshKeepsToken() async {
        let trace = WatchCredentialTrace()
        let provider = ScopedWatchCredentialProvider(trace: trace, scopes: [testWatchScope, testWatchScope,
            WatchBindingScope(watch_device_id: testWatchScope.watch_device_id, pair_version: "5")])
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { scope, credential in
            await trace.append("publish:\(scope?.scope.pair_version ?? "nil"):\(credential?.token ?? "nil")")
        })
        await lifecycle.synchronize()
        await lifecycle.refresh()
        await lifecycle.refresh()
        let events = await trace.events
        XCTAssertEqual(events, ["publish:4:nil", "issue:4", "publish:4:token-1", "issue:4",
            "publish:4:token-2", "publish:5:nil", "issue:5", "publish:5:token-3"])
        await lifecycle.suspend()
        let suspended = await trace.events
        XCTAssertEqual(suspended.last, "publish:5:nil")
    }

    func testChangedLocalAuthorityClearsBeforeIssueEvenWithSameWireScope() async {
        let trace = WatchCredentialTrace()
        let replacement = WatchCredentialAuthority(scope: testWatchScope, principal: "owner", pairingIdentity: "new-pairing")
        let provider = ScopedWatchCredentialProvider(trace: trace, authorities: [testWatchAuthority, replacement])
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { authority, value in
            await trace.append("publish:\(authority?.pairingIdentity ?? "nil"):\(value?.token ?? "nil")")
        })
        await lifecycle.synchronize()
        await lifecycle.refresh()
        let events = await trace.events
        XCTAssertEqual(events, ["publish:paired-owner:nil", "issue:4", "publish:paired-owner:token-1",
            "publish:new-pairing:nil", "issue:4", "publish:new-pairing:token-2"])
        await lifecycle.suspend()
    }

    func testFailedScopePublicationIsRetriedBeforeCredentialHTTP() async {
        let trace = WatchCredentialTrace(failFirstPublication: true)
        let provider = ScopedWatchCredentialProvider(trace: trace, scopes: [testWatchScope, testWatchScope])
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { scope, value in
            try await trace.publish(scope, value)
        })
        await lifecycle.synchronize()
        await lifecycle.synchronize()
        let events = await trace.events
        XCTAssertEqual(events, ["publish:4:nil", "publish:4:nil", "issue:4", "publish:4:token-2"])
        await lifecycle.suspend()
    }

    func testFailedReplacementPublicationCannotSuspendBackToOldAuthority() async {
        let trace = WatchCredentialTrace()
        let replacement = WatchBindingScope(watch_device_id: testWatchScope.watch_device_id, pair_version: "5")
        let provider = ScopedWatchCredentialProvider(trace: trace, scopes: [testWatchScope, replacement, replacement])
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { authority, value in
            try await trace.publish(authority, value)
        })
        await lifecycle.synchronize()
        await trace.failNextPublication()
        await lifecycle.refresh()
        await lifecycle.suspend()
        await lifecycle.synchronize()
        let events = await trace.events
        XCTAssertEqual(events, ["publish:4:nil", "issue:4", "publish:4:token-1",
            "publish:5:nil", "publish:5:nil", "issue:5", "publish:5:token-3"])
        await lifecycle.suspend()
    }

    func testUnresolvedStartupAndNetworkFailureDoNotPublishUnregistered() async {
        let trace = WatchCredentialTrace()
        let provider = ScopedWatchCredentialProvider(trace: trace, scopes: [])
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { scope, credential in
            await trace.append("publish:\(scope?.scope.pair_version ?? "nil"):\(credential?.token ?? "nil")")
        })
        await lifecycle.suspend()
        await lifecycle.synchronize()
        let events = await trace.events
        XCTAssertTrue(events.isEmpty)
        await lifecycle.invalidate()
        let invalidated = await trace.events
        XCTAssertEqual(invalidated, ["publish:nil:nil"])
    }

    func testInvalidationDropsLateCredentialFromInflightAuthority() async throws {
        let provider = SuspendedWatchCredentialProvider()
        let deliveries = WatchCredentialDeliveries()
        let lifecycle = WatchCredentialLifecycle(provider: provider, deliver: { await deliveries.append($0, $1) })
        let operation = Task { await lifecycle.synchronize() }
        await provider.waitUntilRequested()
        await lifecycle.invalidate()
        await provider.complete(WatchCredential(version: 1, kind: "watch_credential", token: "stale",
            expires_at: stamp(Date().addingTimeInterval(600)), server: "https://example.com", scope: testWatchScope))
        await operation.value
        let values = await deliveries.values
        XCTAssertFalse(values.isEmpty)
        XCTAssertTrue(values.allSatisfy { $0 == nil })
    }
}

private actor WatchCredentialDeliveries {
    var values: [WatchCredential?] = []
    var scopes: [WatchCredentialAuthority?] = []
    func append(_ scope: WatchCredentialAuthority?, _ value: WatchCredential?) { scopes.append(scope); values.append(value) }
}
private actor SuspendedWatchCredentialProvider: WatchCredentialProviding {
    private var pending: CheckedContinuation<WatchCredential?, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    func watchCredential(action: WatchCredentialAction, requestID: String,
        prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        try await prepare(testWatchAuthority)
        return await withCheckedContinuation { continuation in
            pending = continuation
            waiting?.resume(); waiting = nil
        }
    }
    func waitUntilRequested() async {
        if pending != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func complete(_ value: WatchCredential) { pending?.resume(returning: value); pending = nil }
}

private actor RotatingWatchCredentialProvider: WatchCredentialProviding {
    var actions: [WatchCredentialAction] = []
    func watchCredential(action: WatchCredentialAction, requestID: String,
        prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        try await prepare(testWatchAuthority)
        actions.append(action)
        guard action != .revoke else { return nil }
        return WatchCredential(version: 1, kind: "watch_credential", token: "token-\(actions.count)",
            expires_at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)), server: "https://example.com", scope: testWatchScope)
    }
}

private actor SlowWatchCredentialProvider: WatchCredentialProviding {
    private var count = 0
    private var active = 0
    var maximumActive = 0
    private var waiting: CheckedContinuation<Void, Never>?
    func waitUntilRequested() async {
        if count > 0 { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func watchCredential(action: WatchCredentialAction, requestID: String,
        prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        try await prepare(testWatchAuthority)
        count += 1
        let token = "token-\(count)"
        active += 1
        maximumActive = max(maximumActive, active)
        waiting?.resume(); waiting = nil
        defer { active -= 1 }
        try await Task.sleep(for: .milliseconds(30))
        return WatchCredential(version: 1, kind: "watch_credential", token: token,
            expires_at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)), server: "https://example.com", scope: testWatchScope)
    }
}

private let testWatchScope = WatchBindingScope(watch_device_id: "ee0ebf3d-1813-4c98-9f67-0c026ee72989", pair_version: "4")

private actor WatchCredentialTrace {
    var events: [String] = []
    private var failFirstPublication: Bool
    init(failFirstPublication: Bool = false) { self.failFirstPublication = failFirstPublication }
    func failNextPublication() { failFirstPublication = true }
    func publish(_ scope: WatchCredentialAuthority?, _ value: WatchCredential?) throws {
        append("publish:\(scope?.scope.pair_version ?? "nil"):\(value?.token ?? "nil")")
        if failFirstPublication { failFirstPublication = false; throw URLError(.notConnectedToInternet) }
    }
    func append(_ event: String) { events.append(event) }
}

private actor ScopedWatchCredentialProvider: WatchCredentialProviding {
    let trace: WatchCredentialTrace
    let authorities: [WatchCredentialAuthority]
    private var count = 0
    init(trace: WatchCredentialTrace, scopes: [WatchBindingScope]) {
        self.trace = trace
        self.authorities = scopes.map { WatchCredentialAuthority(scope: $0, principal: "owner", pairingIdentity: "paired-owner") }
    }
    init(trace: WatchCredentialTrace, authorities: [WatchCredentialAuthority]) {
        self.trace = trace; self.authorities = authorities
    }
    func watchCredential(action: WatchCredentialAction, requestID: String,
        prepare: @escaping @Sendable (WatchCredentialAuthority?) async throws -> Void) async throws -> WatchCredential? {
        guard count < authorities.count else { throw URLError(.notConnectedToInternet) }
        let authority = authorities[count], scope = authority.scope
        count += 1
        try await prepare(authority)
        await trace.append("issue:\(scope.pair_version)")
        return WatchCredential(version: 1, kind: "watch_credential", token: "token-\(count)",
            expires_at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)),
            server: "https://example.com", scope: scope)
    }
}

private let testWatchAuthority = WatchCredentialAuthority(scope: testWatchScope, principal: "owner", pairingIdentity: "paired-owner")
