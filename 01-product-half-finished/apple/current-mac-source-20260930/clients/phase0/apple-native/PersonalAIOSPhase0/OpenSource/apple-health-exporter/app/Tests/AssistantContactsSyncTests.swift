import Contacts
import XCTest
@testable import HealthKitExporter

final class AssistantContactsSyncTests: XCTestCase {
    func testPendingIsDurableBeforeSendAndRestartUsesSameBody() async throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = ContactsFixture([card("a")])
        let sync = AssistantContactsSync(source: source, directory: directory)
        try await sync.setEnabled(true, identity: "pair-a")
        let recorder = ContactsPackets()
        do {
            _ = try await sync.sync(identity: "pair-a", maximumBytes: 15_000) { batch in
                let state = try self.state(directory, "pair-a")
                XCTAssertEqual(state.pending?.controlID, batch.controlID); XCTAssertTrue(state.baseline.isEmpty)
                await recorder.append(batch)
                throw AssistantContactsFailure.permission
            }
            XCTFail("Expected failed receipt")
        } catch {}
        let before = try state(directory, "pair-a")
        XCTAssertNotNil(before.pending); XCTAssertTrue(before.baseline.isEmpty)
        let restarted = AssistantContactsSync(source: source, directory: directory)
        _ = try await restarted.sync(identity: "pair-a", maximumBytes: 15_000) { await recorder.append($0) }
        let packets = await recorder.values
        XCTAssertEqual(packets[0].bytes, packets[1].bytes); XCTAssertEqual(packets[0].controlID, packets[1].controlID)
        let after = try state(directory, "pair-a")
        XCTAssertNil(after.pending); XCTAssertNotNil(after.baseline["a"])
        let otherEnabled = try await restarted.isEnabled(identity: "pair-b")
        XCTAssertFalse(otherEnabled)
    }

    func testPendingVisibilityRemovalAndReAddUseNewControls() async throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = ContactsFixture([card("a")])
        let sync = AssistantContactsSync(source: source, directory: directory)
        try await sync.setEnabled(true, identity: "pair")
        do { _ = try await sync.sync(identity: "pair", maximumBytes: 15_000) { _ in throw AssistantContactsFailure.permission } } catch {}
        let oldID = try XCTUnwrap(state(directory, "pair").pending?.controlID)
        await source.replace([], limited: true)
        let recorder = ContactsPackets()
        _ = try await AssistantContactsSync(source: source, directory: directory).sync(identity: "pair", maximumBytes: 15_000) { await recorder.append($0) }
        let removed = await recorder.values
        let removal = try XCTUnwrap(removed.first)
        XCTAssertNotEqual(removal.controlID, oldID)
        XCTAssertEqual(try payload(removal)["deleted"] as? [String], ["a"])
        XCTAssertEqual((try payload(removal)["contacts"] as? [[String: Any]])?.count, 0)
        await source.replace([card("a", name: "新名字")], limited: true)
        _ = try await sync.sync(identity: "pair", maximumBytes: 15_000) { await recorder.append($0) }
        let restored = await recorder.values
        XCTAssertEqual((try payload(XCTUnwrap(restored.last))["contacts"] as? [[String: Any]])?.first?["name"] as? String, "新名字")
    }

    func testDeniedSnapshotDoesNotSendDeletionOrAdvanceBaseline() async throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = ContactsFixture([card("a")])
        let sync = AssistantContactsSync(source: source, directory: directory)
        try await sync.setEnabled(true, identity: "pair")
        _ = try await sync.sync(identity: "pair", maximumBytes: 15_000) { _ in }
        let baseline = try state(directory, "pair").baseline
        await source.deny()
        do { _ = try await sync.sync(identity: "pair", maximumBytes: 15_000) { _ in XCTFail("Denied snapshot must not publish") }; XCTFail("Expected permission failure") } catch {}
        XCTAssertEqual(try state(directory, "pair").baseline, baseline)
    }

    func testActualByteBudgetPartitionsWithoutDroppingCardsOrDeletes() async throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let sync = AssistantContactsSync(source: ContactsFixture([]), directory: directory)
        let cards = (0..<40).map { card("card-\($0)", name: String(repeating: "长", count: 70)) }
        let deleted = (0..<140).map { "deleted-\($0)" }
        let packets = try await sync.packets(cards: cards, deleted: deleted, maximumBytes: 1200)
        XCTAssertEqual(packets.flatMap(\.contacts).map(\.id), cards.map(\.id))
        XCTAssertEqual(packets.flatMap(\.deleted), deleted)
        for packet in packets { XCTAssertLessThanOrEqual(packet.bytes.count, 1200); XCTAssertLessThanOrEqual(packet.contacts.count, 16); XCTAssertLessThanOrEqual(packet.deleted.count, 128) }
    }

    func testRelationDirectionLabelAndNumberOnlyNameArePreserved() async throws {
        XCTAssertEqual(SystemAssistantContactsSource.label(CNLabelContactRelationMother, relation: true), "妈妈")
        XCTAssertEqual(SystemAssistantContactsSource.label(CNLabelContactRelationFather, relation: true), "爸爸")
        XCTAssertEqual(SystemAssistantContactsSource.label("自定义关系", relation: true), "自定义关系")
        let card = AssistantContact(id: "zhang", name: "", phones: [.init(number: "+86 123", label: "手机")], relations: [.init(label: "妈妈", name: "王芳")])
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let packets = try await AssistantContactsSync(source: ContactsFixture([]), directory: directory).packets(cards: [card], deleted: [], maximumBytes: 15_000)
        XCTAssertEqual(packets.first?.contacts.first?.name, "")
        XCTAssertEqual(packets.first?.contacts.first?.relations, [.init(label: "妈妈", name: "王芳")])
        XCTAssertEqual(packets.first?.contacts.first?.id, "zhang")
    }

    func testInvalidCardFailsVisiblyInsteadOfTruncation() async throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let source = ContactsFixture([card("a", name: String(repeating: "字", count: 161))])
        let sync = AssistantContactsSync(source: source, directory: directory)
        try await sync.setEnabled(true, identity: "pair")
        do { _ = try await sync.sync(identity: "pair", maximumBytes: 15_000) { _ in XCTFail("Invalid card must not publish") }; XCTFail("Expected invalid card") }
        catch AssistantContactsFailure.invalidCard {} catch { XCTFail("Unexpected failure") }
        XCTAssertTrue(try state(directory, "pair").baseline.isEmpty)
    }

    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("contacts-tests-" + UUID().uuidString) }
    private func state(_ directory: URL, _ identity: String) throws -> AssistantContactsSync.State {
        try JSONDecoder().decode(AssistantContactsSync.State.self, from: Data(contentsOf: directory.appendingPathComponent(identity + ".json")))
    }
    private func payload(_ batch: CentralOwnerDataBatch) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: batch.bytes) as? [String: Any])
    }
    private func card(_ id: String, name: String = "张三") -> AssistantContact {
        AssistantContact(id: id, name: name, phones: [.init(number: "123", label: "手机")], relations: [])
    }
}
private actor ContactsFixture: AssistantContactsReading {
    var cards: [AssistantContact]
    var limited = false
    var denied = false
    init(_ cards: [AssistantContact]) { self.cards = cards }
    func requestAccess() async throws { if denied { throw AssistantContactsFailure.permission } }
    func snapshot() async throws -> AssistantContactsSnapshot {
        if denied { throw AssistantContactsFailure.permission }
        return .init(contacts: cards, limited: limited)
    }
    func replace(_ cards: [AssistantContact], limited: Bool) { self.cards = cards; self.limited = limited }
    func deny() { denied = true }
}
private actor ContactsPackets {
    var values: [CentralOwnerDataBatch] = []
    func append(_ value: CentralOwnerDataBatch) { values.append(value) }
}
