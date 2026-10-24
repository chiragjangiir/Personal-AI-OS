import Foundation
import XCTest
@testable import HealthKitExporter

@MainActor
final class WatchAppearanceProjectionTests: XCTestCase {
    private let image = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=")!
    private func scope() -> WatchBindingScope {
        WatchBindingScope(watch_device_id: UUID().uuidString.lowercased(), pair_version: "7")
    }
    private func profile(_ version: Int) -> CentralAvatarProfile {
        CentralAvatarProfile(version: version, look_id: "look-\(version)", style: "photo",
            image_url: URL(string: "https://example.invalid/portrait.jpg")!, focus: .init(x: 0.4, y: 0.3),
            updated_at: "2026-10-17T00:00:00Z")
    }
    private func owner(_ scope: WatchBindingScope) -> String { scope.watch_device_id + ":" + scope.pair_version }
    private func cacheURL(_ scope: WatchBindingScope) throws -> URL {
        try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
            .appendingPathComponent("yimi-avatar-" + owner(scope) + ".json")
    }
    private func projection(_ scope: WatchBindingScope, _ sequence: UInt64, version: Int) -> WatchAppearanceProjection {
        .init(projectionID: UUID(), sequence: sequence, scope: scope, profile: profile(version), image: image)
    }

    func testSavedPhoneProjectionSurvivesRestartAndRejectsDelayedDelivery() throws {
        let scope = scope(), store = YimiAvatarStore()
        defer { store.bind(nil) }
        let latest = projection(scope, 20, version: 2)
        try store.applyPhoneProjection(latest)
        let restarted = YimiAvatarStore(); restarted.bind(owner(scope))
        XCTAssertEqual(restarted.profile, latest.profile)
        XCTAssertEqual(restarted.imageData, image)
        XCTAssertThrowsError(try restarted.applyPhoneProjection(projection(scope, 19, version: 1)))
        XCTAssertEqual(restarted.profile?.version, 2)
        let saved = try Data(contentsOf: cacheURL(scope))
        XCTAssertThrowsError(try restarted.applyPhoneProjection(.init(projectionID: UUID(), sequence: 21,
            scope: scope, profile: profile(3), image: Data("invalid image".utf8))))
        XCTAssertEqual(try Data(contentsOf: cacheURL(scope)), saved)
        XCTAssertEqual(restarted.profile?.version, 2)
    }

    func testScopeSwitchAndRevocationRemovePreviousFace() throws {
        let old = scope(), next = scope(), store = YimiAvatarStore()
        defer { store.bind(nil) }
        try store.applyPhoneProjection(projection(old, 30, version: 3))
        try store.applyPhoneProjection(projection(next, 1, version: 1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: try cacheURL(old).path))
        XCTAssertEqual(store.pairingIdentity, owner(next))
        try store.applyPhoneProjection(.init(projectionID: UUID(), sequence: 2, scope: next, profile: nil, image: nil))
        XCTAssertNil(store.profile); XCTAssertNil(store.imageData)
        let restarted = YimiAvatarStore(); restarted.bind(owner(next))
        XCTAssertNil(restarted.profile); XCTAssertNil(restarted.imageData)
        XCTAssertThrowsError(try restarted.applyPhoneProjection(projection(next, 1, version: 1)))
    }

    func testRel26CacheReadsNewOptionalFieldAndNewCacheReadsOldBytes() throws {
        struct Rel26Cache: Codable { let profile: CentralAvatarProfile?; let image: Data? }
        let scope = scope(), store = YimiAvatarStore(), url = try cacheURL(scope)
        defer { store.bind(nil) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(Rel26Cache(profile: profile(1), image: image)).write(to: url, options: .atomic)
        store.bind(owner(scope))
        XCTAssertEqual(store.profile?.version, 1)
        XCTAssertEqual(store.imageData, image)
        try store.applyPhoneProjection(projection(scope, 5, version: 2))
        let legacy = try JSONDecoder().decode(Rel26Cache.self, from: Data(contentsOf: url))
        XCTAssertEqual(legacy.profile?.version, 2)
        XCTAssertEqual(legacy.image, image)
    }

    func testReceiptDeliveryUsesExistingPhoneTransportWithoutChangingV1State() async throws {
        let scope = scope()
        let sent = projection(scope, 9, version: 2)
        let receipt = WatchAppearanceReceipt(projectionID: sent.projectionID, scope: scope,
            profileVersion: 2, appliedAt: Date(timeIntervalSince1970: 100))
        let bytes = try JSONEncoder().encode(receipt), recorder = AppearanceReceiptRecorder()
        let sender = AppearancePhoneSender(), adapter = WatchConnectivityPhoneAdapter(sender: sender)
        adapter.setAppearanceReceiptHandler { await recorder.append($0) }
        try adapter.publishYimiState(Data("existing-v1-state".utf8), credential: nil)
        try adapter.publishAppearance(JSONEncoder().encode(sent))
        XCTAssertEqual(sender.applicationContext["yimi_state"] as? Data, Data("existing-v1-state".utf8))
        adapter.receiveApplicationContext(["yimi_appearance_receipt": bytes])
        adapter.receiveMessage(["yimi_appearance_receipt": bytes])
        await adapter.waitForPendingDeliveries()
        let values = await recorder.values
        XCTAssertEqual(values, [bytes, bytes])
    }

    func testDefaultResetRevisionSurvivesTransportRestartAndReceipt() throws {
        let scope = scope(), store = YimiAvatarStore()
        defer { store.bind(nil) }
        try store.applyPhoneProjection(projection(scope, 8, version: 4))
        let reset = WatchAppearanceProjection(projectionID: UUID(), sequence: 9, scope: scope,
            profile: nil, image: image, profileVersion: 5)
        let delivered = try JSONDecoder().decode(WatchAppearanceProjection.self, from: JSONEncoder().encode(reset))
        try store.applyPhoneProjection(delivered)
        XCTAssertNil(store.profile)
        XCTAssertEqual(store.imageData, image)
        XCTAssertEqual(store.loadedVersion, 5)
        let restarted = YimiAvatarStore(); restarted.bind(owner(scope))
        XCTAssertNil(restarted.profile)
        XCTAssertEqual(restarted.loadedVersion, 5)
        let receipt = WatchAppearanceReceipt(projectionID: delivered.projectionID, scope: delivered.scope,
            profileVersion: restarted.loadedVersion, appliedAt: Date(timeIntervalSince1970: 100))
        let returned = try JSONDecoder().decode(WatchAppearanceReceipt.self, from: JSONEncoder().encode(receipt))
        XCTAssertEqual(returned.projectionID, reset.projectionID)
        XCTAssertEqual(returned.scope, reset.scope)
        XCTAssertEqual(returned.profileVersion, reset.profileVersion)
        XCTAssertThrowsError(try restarted.applyPhoneProjection(projection(scope, 8, version: 4)))
        XCTAssertEqual(restarted.loadedVersion, 5)
    }

    func testLegacyProjectionWithoutRevisionStillLoadsProfileVersionAndDefault() throws {
        struct LegacyProjection: Codable {
            let projectionID: UUID; let sequence: UInt64; let scope: WatchBindingScope
            let profile: CentralAvatarProfile?; let image: Data?
        }
        let scope = scope(), store = YimiAvatarStore()
        defer { store.bind(nil) }
        let cases: [(UInt64, CentralAvatarProfile?, Data?, Int)] = [(1, profile(4), image, 4), (2, nil, nil, 0)]
        for (sequence, profile, image, expected) in cases {
            let legacy = LegacyProjection(projectionID: UUID(), sequence: sequence, scope: scope, profile: profile, image: image)
            let decoded = try JSONDecoder().decode(WatchAppearanceProjection.self, from: JSONEncoder().encode(legacy))
            XCTAssertNil(decoded.profileVersion)
            try store.applyPhoneProjection(decoded)
            XCTAssertEqual(store.loadedVersion, expected)
        }
    }

    func testReceiptRetainsExactSavedProjectionIdentityAcrossTransport() throws {
        let scope = scope(), store = YimiAvatarStore()
        defer { store.bind(nil) }
        let sent = projection(scope, 8, version: 4)
        let delivered = try JSONDecoder().decode(WatchAppearanceProjection.self, from: JSONEncoder().encode(sent))
        try store.applyPhoneProjection(delivered)
        let receipt = WatchAppearanceReceipt(projectionID: delivered.projectionID, scope: delivered.scope,
            profileVersion: store.loadedVersion, appliedAt: Date(timeIntervalSince1970: 100))
        let returned = try JSONDecoder().decode(WatchAppearanceReceipt.self, from: JSONEncoder().encode(receipt))
        XCTAssertEqual(returned.projectionID, sent.projectionID)
        XCTAssertEqual(returned.scope, sent.scope)
        XCTAssertEqual(returned.profileVersion, 4)
        XCTAssertEqual(returned.appliedAt, receipt.appliedAt)
    }
}

private actor AppearanceReceiptRecorder {
    private(set) var values: [Data] = []
    func append(_ value: Data) { values.append(value) }
}
private final class AppearancePhoneSender: WatchPhoneConnectivitySending {
    var isActivated = true
    var isReachable = false
    var receivedApplicationContext: [String: Any] = [:]
    var applicationContext: [String: Any] = [:]
    func activate() {}
    func updateApplicationContext(_ applicationContext: [String: Any]) throws { self.applicationContext = applicationContext }
    func sendMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?, errorHandler: ((Error) -> Void)?) {}
    func enqueueUserInfo(_ userInfo: [String: Any]) {}
}
