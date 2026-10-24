import Foundation
import ImageIO
import SwiftUI
import XCTest
import WatchConnectivity
@testable import PersonalAIOSWatch

private final class MemoryWatchCredentialVault: WatchCredentialStoring {
    var data: Data?
    var failDelete = false
    func load() throws -> Data? { data }
    func save(_ data: Data?) throws {
        if data == nil && failDelete { throw CocoaError(.fileWriteNoPermission) }
        self.data = data
    }
}
private final class MemoryWatchDefaults: UserDefaults {
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "YimiInMemoryTests")! }
    override func data(forKey key: String) -> Data? { values[key] as? Data }
    override func set(_ value: Any?, forKey key: String) { values[key] = value }
}

private final class ColdLaunchWatchSender: WatchConnectivitySending {
    var activationState: WCSessionActivationState = .activated
    var isReachable = true
    var applicationContext: [String: Any] = [:]
    var receivedApplicationContext: [String: Any] = [:]
    func activate() {}
    func sendMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?, errorHandler: ((Error) -> Void)?) {}
    func updateApplicationContext(_ context: [String: Any]) throws { applicationContext = context }
    func enqueueUserInfo(_ userInfo: [String: Any]) {}
}

@MainActor
final class WatchYimiStoreTests: XCTestCase {
    func testShippingBrandHeaderSnapshot() throws {
        let content = YimiWatchHeader()
            .frame(width: 180, height: 36, alignment: .leading)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        XCTAssertEqual(image.width, 360)
        XCTAssertEqual(image.height, 72)
        let png = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let attachment = XCTAttachment(data: png as Data, uniformTypeIdentifier: "public.png")
        attachment.name = "YimiWatchHeader-dark.png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private let a = WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "7")
    private let b = WatchBindingScope(watch_device_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", pair_version: "8")
    private func state(_ scope: WatchBindingScope?, _ rev: UInt64) -> WatchYimiState {
        .init(version: 1, kind: "yimi_state", rev: rev, link: scope == nil ? .watch_unregistered : .ok, scope: scope,
            latest: scope.map { _ in .init(card_id: "message-\(rev)", title: "依米", lines: ["消息"], created_at: "2026-10-16T00:00:00Z", kind: .message) },
            question: nil, errands: [], care: nil, payment_pending: .init(count: 0, summary: ""), ride: nil)
    }
    private func credential(_ scope: WatchBindingScope, token: String = "token", expiry: String = "2099-10-16T00:00:00Z") -> WatchCredential {
        .init(version: 1, kind: "watch_credential", token: token, expires_at: expiry, server: "https://example.test", scope: scope)
    }
    private func context(_ scope: WatchBindingScope?, _ rev: UInt64, credential: WatchCredential? = nil) throws -> [String: Any] {
        var result: [String: Any] = ["yimi_state": try state(scope, rev).encodedStrict()]
        if let credential { result["watch_credential"] = try JSONEncoder().encode(credential) }
        return result
    }
    func testAdapterColdLaunchConsumesActualReceivedContextAgainstPersistedScope() throws {
        let defaults = MemoryWatchDefaults(), vault = MemoryWatchCredentialVault()
        let prior = WatchYimiStore(defaults: defaults, credentials: vault)
        prior.receiveContext(try context(a, 20, credential: credential(a)))
        prior.receiveMessageState(try state(a, 30).encodedStrict())
        let store = WatchYimiStore(defaults: defaults, credentials: vault)
        let sender = ColdLaunchWatchSender()
        sender.receivedApplicationContext = try context(a, 20)
        let adapter = WatchConnectivityAdapter(sender: sender, sequenceDefaults: nil, sequenceClock: nil, yimiStore: store)
        XCTAssertEqual(adapter.yimiStore.state?.rev, 30)
        XCTAssertEqual(adapter.yimiStore.validCredential?.scope, a)
        let relaunched = WatchYimiStore(defaults: defaults, credentials: vault)
        sender.receivedApplicationContext = try context(b, 1)
        let replacement = WatchConnectivityAdapter(sender: sender, sequenceDefaults: nil, sequenceClock: nil, yimiStore: relaunched)
        XCTAssertEqual(replacement.yimiStore.currentScope, b)
        XCTAssertEqual(replacement.yimiStore.state?.rev, 1)
        XCTAssertNil(replacement.yimiStore.credential); XCTAssertNil(vault.data)
    }
    func testRefreshDelayedRevOneAndReplacementClearsAllOldWork() throws {
        let vault = MemoryWatchCredentialVault()
        let store = WatchYimiStore(defaults: nil, credentials: vault)
        store.receiveContext(try context(a, 20, credential: credential(a)))
        let request = WatchLocalEnvelope(kind: .request, action: .stateRequest, requestID: "request", sequence: 1, version: 1, args: .init())
        try store.begin(request, scope: a)
        store.receiveContext(try context(a, 20, credential: credential(a, token: "refresh")))
        XCTAssertEqual(store.validCredential?.token, "refresh")
        store.receiveContext(try context(a, 1))
        XCTAssertEqual(store.state?.rev, 20)
        var cancelled = 0
        store.onScopeChange = { cancelled += 1; XCTAssertEqual(store.currentScope, self.a) }
        store.receiveContext(try context(b, 1))
        XCTAssertEqual(cancelled, 1); XCTAssertEqual(store.currentScope, b)
        XCTAssertNil(store.credential); XCTAssertNil(vault.data)
        XCTAssertTrue(store.reducer.pending.isEmpty); XCTAssertTrue(store.reducer.receipts.isEmpty)
        XCTAssertEqual(store.state?.rev, 1)
    }
    func testNilRevokeAndFailingVaultStillClearContentRequestsReceiptsAndTurns() throws {
        let vault = MemoryWatchCredentialVault(), defaults = MemoryWatchDefaults()
        let store = WatchYimiStore(defaults: defaults, credentials: vault)
        store.receiveContext(try context(a, 20, credential: credential(a)))
        let request = WatchLocalEnvelope(kind: .request, action: .stateRequest, requestID: "request", sequence: 1, version: 1, args: .init())
        try store.begin(request, scope: a)
        let ack = WatchLocalEnvelope(kind: .acknowledgement, action: .stateRequest, requestID: "request", sequence: 1, status: .accepted, version: 1)
        store.receiveReceipt(try ack.encodedStrict(), scope: a)
        try store.begin(.init(kind: .request, action: .stateRequest, requestID: "pending", sequence: 2, version: 1, args: .init()), scope: a)
        vault.failDelete = true
        var cancelled = false
        store.onScopeChange = { cancelled = true }
        store.receiveContext(try context(nil, 1))
        XCTAssertTrue(cancelled); XCTAssertNil(store.state?.latest); XCTAssertNil(store.currentScope)
        XCTAssertNil(store.credential); XCTAssertNil(store.lastReceipt); XCTAssertNil(store.lastCompletedRequest)
        XCTAssertTrue(store.reducer.pending.isEmpty); XCTAssertTrue(store.reducer.receipts.isEmpty)
        XCTAssertNotNil(store.lastError)
        // Failed deletion cannot restore the old credential on the next launch.
        let relaunched = WatchYimiStore(defaults: defaults, credentials: vault)
        XCTAssertNil(relaunched.currentScope); XCTAssertNil(relaunched.credential)
    }
    func testMismatchedMessageCredentialAndCredentialWithoutStateAreIgnored() throws {
        let vault = MemoryWatchCredentialVault()
        let store = WatchYimiStore(defaults: nil, credentials: vault)
        store.receiveContext(try context(a, 20, credential: credential(a)))
        store.receiveMessageState(try state(b, 99).encodedStrict())
        XCTAssertEqual(store.currentScope, a); XCTAssertEqual(store.state?.rev, 20)
        store.receiveContext(try context(a, 21, credential: credential(b)))
        XCTAssertEqual(store.credential?.scope, a)
        store.receiveContext(["watch_credential": try JSONEncoder().encode(credential(b))])
        XCTAssertEqual(store.credential?.scope, a)
        XCTAssertNotNil(store.lastError)
    }
    func testColdLaunchFenceDirectMessagePersistenceAndMissedContexts() throws {
        let vault = MemoryWatchCredentialVault(), defaults = MemoryWatchDefaults()
        let first = WatchYimiStore(defaults: defaults, credentials: vault)
        first.receiveContext(try context(a, 20, credential: credential(a)))
        first.receiveMessageState(try state(a, 30).encodedStrict())
        let second = WatchYimiStore(defaults: defaults, credentials: vault)
        second.receiveContext(try context(a, 20))
        XCTAssertEqual(second.state?.rev, 30)
        XCTAssertEqual(second.validCredential?.scope, a)
        let later = WatchBindingScope(watch_device_id: a.watch_device_id, pair_version: "2")
        second.receiveContext(try context(later, 1))
        XCTAssertEqual(second.currentScope, later); XCTAssertNil(second.validCredential)
    }
    func testActionReturnsExactRequestIDAndOnlyMatchingReceiptPublishesOnce() throws {
        let store = WatchYimiStore(defaults: nil, credentials: MemoryWatchCredentialVault())
        store.receiveContext(try context(a, 20))
        let handler = WatchYimiHandler(store: store, defaults: nil, clock: nil)
        handler.isReachable = { true }
        var sent: WatchLocalEnvelope?
        var respond: ((Data?) -> Void)?
        handler.send = { data, reply, _ in
            sent = try? WatchLocalEnvelope.decodeStrict(data); respond = reply
        }
        var successes = 0
        store.onReceipt = { if $0 == .accepted { successes += 1 } }
        let id = try XCTUnwrap(store.answer(cardID: "card", optionID: "one"))
        let request = try XCTUnwrap(sent)
        XCTAssertEqual(request.requestID, id)
        XCTAssertEqual(request.args, .init(card_id: "card", option_id: "one"))
        let ack = WatchLocalEnvelope(kind: .acknowledgement, action: request.action, requestID: id,
                                     sequence: request.sequence, status: .accepted, version: 1)
        respond?(try ack.encodedStrict())
        XCTAssertEqual(store.lastCompletedRequest?.args, request.args)
        XCTAssertEqual(store.lastReceipt?.requestID, id); XCTAssertEqual(successes, 1)
        respond?(try ack.encodedStrict())
        XCTAssertEqual(successes, 1)
        store.receiveContext(try context(b, 1))
        respond?(try ack.encodedStrict())
        XCTAssertNil(store.lastReceipt); XCTAssertEqual(successes, 1)
    }
    func testRideMetricsTimestampMovesOnlyWhenThePhonesFiguresChange() throws {
        func ride(_ elapsed: Double, rev: UInt64) throws -> Data {
            let metrics = WatchYimiRideMetrics(ride_id: "ride", workout_id: "w", ended: false, speed_kmh: 20, avg_kmh: 18, max_kmh: 30,
                                               distance_m: 1_000, elapsed_s: elapsed, moving_s: elapsed, hr_bpm: 140, hr_avg: nil, hr_max: nil, kcal: 20)
            return try WatchYimiState(version: 1, kind: "yimi_state", rev: rev, link: .ok, scope: a, latest: nil, question: nil, errands: [],
                                      care: nil, payment_pending: .init(count: 0, summary: ""),
                                      ride: .init(hr_zone: 3, text: nil, max_hr_bpm: nil, metrics: metrics)).encodedStrict()
        }
        let store = WatchYimiStore(defaults: nil, credentials: MemoryWatchCredentialVault())
        store.receiveContext(try context(a, 1))
        XCTAssertNil(store.rideMetricsAt)
        store.receiveMessageState(try ride(10, rev: 2))
        let first = try XCTUnwrap(store.rideMetricsAt)
        store.receiveMessageState(try ride(10, rev: 3))
        XCTAssertEqual(store.rideMetricsAt, first)
        Thread.sleep(forTimeInterval: 0.02)
        store.receiveMessageState(try ride(11, rev: 4))
        XCTAssertGreaterThan(try XCTUnwrap(store.rideMetricsAt), first)
        XCTAssertEqual(store.state?.ride?.metrics?.elapsed_s, 11)
    }
    func testStrictDecodeExpiryAndLateReceiptDoNotChangeCurrentState() throws {
        let store = WatchYimiStore(defaults: nil, credentials: MemoryWatchCredentialVault())
        store.receiveContext(try context(a, 20, credential: credential(a)))
        XCTAssertNil(store.validCredential(at: WatchStateReducer.date("2100-01-01T00:00:00Z")!))
        store.receiveContext(["yimi_state": Data("{}".utf8)])
        XCTAssertEqual(store.state?.rev, 20)
        XCTAssertEqual(store.lastError, "暂时没能同步，请稍后再试。")
        store.receiveContext(try context(b, 1))
        let ack = WatchLocalEnvelope(kind: .acknowledgement, action: .stateRequest, requestID: "request", sequence: 1, status: .accepted, version: 1)
        store.receiveReceipt(try ack.encodedStrict(), scope: a)
        XCTAssertNil(store.lastReceipt)
    }
}
