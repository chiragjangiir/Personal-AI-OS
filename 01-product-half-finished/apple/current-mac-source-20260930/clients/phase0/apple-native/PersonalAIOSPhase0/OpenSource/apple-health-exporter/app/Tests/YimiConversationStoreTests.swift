import Foundation
import XCTest
@testable import HealthKitExporter

final class YimiConversationStoreTests: XCTestCase {
    private func pairing(user: String = "owner-a", pairedAt: String = "2026-10-17T00:00:00Z") -> RealtimeDevicePairing {
        RealtimeDevicePairing(schema: RealtimeDevicePairing.schema,
            origin: RealtimeAPIOriginMigration.legacyOrigin, deviceID: "phone", userID: user, token: "token",
            governance: RealtimeWireGovernance(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [],
                purposeTokenRefs: [], capabilityGrantRefs: []), media: ["data"], pairedAt: pairedAt)
    }

    private func temporaryFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: folder) }
        return folder
    }

    func testRepairingKeepsEachOwnersHistorySeparateAndLeavesLegacyUntouched() throws {
        let folder = try temporaryFolder()
        let legacy = folder.appendingPathComponent("yimi-conversation.json")
        let oldItems = [YimiItem(id: "old", kind: .me, text: "private old request", date: Date())]
        let legacyData = try JSONEncoder().encode(oldItems)
        try legacyData.write(to: legacy)
        let first = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: pairing()))
        XCTAssertTrue(try first.load().isEmpty, "An ownerless legacy file cannot be attributed to this pairing")
        try first.write(oldItems)

        let second = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: pairing(user: "owner-b")))
        XCTAssertTrue(try second.load().isEmpty, "A DEBUG replacement pairing starts without the previous owner's retained rows")
        let newItems = [YimiItem(id: "new", kind: .her, text: "new reply", date: Date())]
        try second.write(newItems)
        XCTAssertEqual(try first.load(), oldItems)
        XCTAssertEqual(try second.load(), newItems)
        XCTAssertEqual(try Data(contentsOf: legacy), legacyData)
        XCTAssertNil(YimiConversationStore(folder: folder, pairing: nil), "Unavailable pairing must not select a shared writable cache")
    }

    func testNewPairingGenerationIsolatedButEndpointMigrationKeepsHistory() throws {
        let folder = try temporaryFolder(), original = pairing()
        let store = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: original))
        let items = [YimiItem(id: "retained", kind: .her, text: "saved reply", date: Date())]
        try store.write(items)
        let repaired = try XCTUnwrap(YimiConversationStore(folder: folder,
            pairing: pairing(pairedAt: "2026-10-18T00:00:00Z")))
        XCTAssertTrue(try repaired.load().isEmpty)
        let migrated = try RealtimeAPIOriginMigration.migrated(original)
        let migratedStore = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: migrated))
        XCTAssertEqual(try migratedStore.load(), items, "Endpoint migration retains the authoritative pairing identity")
    }
    func testQueuedBubbleUsesReceiptAndRemainsReadableByRel26() throws {
        struct Rel26Row: Decodable {
            enum Delivery: String, Decodable { case sending, unconfirmed, failed }
            let id: String; let delivery: Delivery?
        }
        let folder = try temporaryFolder()
        let store = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: pairing()))
        for via in ["text", "ptt"] {
            var item = YimiItem(id: "me-" + via, kind: .me, text: "下一句", date: Date(), delivery: .sending, via: via)
            item.setSubmissionDelivery(.queued)
            XCTAssertEqual(item.deliveryStatus, "排队中 · 她处理完上一句就发")
            XCTAssertFalse(item.offersTextResend)
            try store.write([item])
            XCTAssertTrue(try XCTUnwrap(store.load().first).isQueued)
            let legacy = try JSONDecoder().decode([Rel26Row].self, from: Data(contentsOf: store.url))
            XCTAssertEqual(legacy.first?.delivery, .sending)
            var shared = item; shared.seq = 12; shared.delivery = nil; shared.queued = nil
            var timeline = YimiConversationTimeline(items: [item, shared])
            item = try XCTUnwrap(timeline.items.first)
            XCTAssertTrue(item.isQueued, "shared timeline input proves storage, not foreground dispatch")
            item.setSubmissionDelivery(.accepted); timeline.upsert(item)
            XCTAssertNil(timeline.items.first?.deliveryStatus)
            item.setSubmissionDelivery(.rejected)
            XCTAssertEqual(item.deliveryStatus, "没发出去")
            XCTAssertTrue(item.offersTextResend, "expired admission can be retried after shared input was stored")
        }
    }

    func testRestoredAdmissionWaitsForItsOwnReplyWithoutOfferingResend() throws {
        var queued = YimiItem(id: "me-queued", kind: .me, text: "下一句", date: Date(), delivery: .sending)
        queued.setSubmissionDelivery(.queued, processedID: "d-queued")
        var timeline = YimiConversationTimeline(items: [queued])
        timeline.settleTypedSends(AssistantCentralTextConsumer())
        let waiting = try XCTUnwrap(timeline.items.first)
        XCTAssertEqual(waiting.deliveryStatus, "已接收 · 等待同步处理状态")
        XCTAssertFalse(waiting.offersTextResend)
        timeline.upsert(YimiItem(id: "her-other", kind: .her, text: "另一句", date: Date()))
        XCTAssertNotNil(timeline.items.first?.deliveryStatus)
        timeline.upsert(YimiItem(id: "her-d-queued", kind: .her, text: "这句的回复", date: Date()))
        XCTAssertNil(timeline.items.first?.deliveryStatus)
    }

}
