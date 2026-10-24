import Foundation
import XCTest
@testable import HealthKitExporter

extension YimiPaymentFlowTests {
    private func historyFixture(_ name: String) throws -> [String: Any] {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: YimiPaymentFlowTests.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/PaymentRound3"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func testAuthorityTimestampTiePagesReturnEveryRecordWithOpaqueCursor() async throws {
        let (model, transport, _) = try await fixture()
        transport.onOutput = nil // Awaited replies must project even when observer delivery is delayed.
        let manifest = try historyFixture("history-pages")
        let names = try XCTUnwrap(manifest["records"] as? [String])
        let pages = try names.map { try historyFixture($0) }
        let allRows = try pages.flatMap { try XCTUnwrap($0["items"] as? [[String: Any]]) }
        XCTAssertEqual(Set(allRows.compactMap { $0["at"] as? String }).count, 1)
        for var page in pages {
            _ = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: page))
            page["session_id"] = "session-1"; transport.recordPages.append(page)
        }
        await model.loadRecords()
        XCTAssertLessThan(model.records.count, allRows.count)
        let cursor = try XCTUnwrap(model.nextBefore)
        XCTAssertNotEqual(cursor, model.records.last?.at)
        await model.loadRecords(before: cursor)
        XCTAssertEqual(model.records.map(\.id), try XCTUnwrap(manifest["expected_record_ids"] as? [String]))
        XCTAssertNil(model.nextBefore)
        let requests = transport.requests.filter { $0["operation"] as? String == "payment_records_get" }
        XCTAssertEqual(requests.count, 2)
        XCTAssertNil(requests.first?["before"])
        XCTAssertEqual(requests.last?["before"] as? String, cursor)
        var delayed = pages[0]
        delayed["session_id"] = "session-1"; delayed["request_id"] = requests.first?["request_id"]
        model.receive(.output(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: delayed))))
        XCTAssertNil(model.nextBefore, "An older observer delivery cannot restore a consumed cursor")
    }

    func testAuthorityDetailContinuationPrependsEveryEventWithoutInventingSequence() async throws {
        let (model, transport, _) = try await fixture()
        let manifest = try historyFixture("history-pages")
        let names = try XCTUnwrap(manifest["detail"] as? [String])
        let pages = try names.map { try historyFixture($0) }
        let first = try XCTUnwrap(pages.first)
        let payment = try XCTUnwrap(first["payment"] as? [String: Any])
        let paymentID = try XCTUnwrap(payment["payment_id"] as? String)
        for var page in pages {
            _ = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: page))
            page["session_id"] = "session-1"; transport.recordDetailPages.append(page)
        }
        await model.loadRecord(paymentID)
        XCTAssertEqual(model.record?.timeline.count, 64)
        let sequence = try XCTUnwrap(model.record?.next_seq)
        XCTAssertEqual(sequence, first["next_seq"] as? Int)
        await model.loadRecord(paymentID, beforeSeq: sequence)
        XCTAssertEqual(model.record?.timeline.map(\.kind), try XCTUnwrap(manifest["expected_detail_kinds"] as? [String]))
        XCTAssertNil(model.record?.next_seq)
        XCTAssertFalse(model.loadingRecord)
        let requests = transport.requests.filter { $0["operation"] as? String == "payment_record_get" }
        XCTAssertEqual(requests.count, 2)
        XCTAssertNil(requests.first?["before_seq"])
        XCTAssertEqual(requests.last?["before_seq"] as? Int, sequence)
        // The event stream and awaited response both carry this packet; it must project only once.
        var repeated = pages.last!
        repeated["session_id"] = "session-1"; repeated["request_id"] = requests.last?["request_id"]
        model.receive(.output(try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: repeated))))
        XCTAssertEqual(model.record?.timeline.count, 68)
    }

    func testIncompleteSnapshotsNeverRemoveLiveCardsApprovalsOrNotifications() async throws {
        let removed = expectation(description: "only complete snapshots withdraw notices")
        removed.expectedFulfillmentCount = 2
        let scheduler = RecordingAssistantNotificationScheduling(onRevoke: { _ in removed.fulfill() })
        let (model, _, _) = try await fixture(notifications: scheduler)
        let card = try XCTUnwrap(model.cards.first), approval = try XCTUnwrap(model.approvals.first)
        _ = await scheduler.deliver(.payment(card))
        _ = await scheduler.deliver(.paymentApproval(approval))
        for (operation, key) in [("payment_cards", "cards"), ("payment_approvals", "approvals")] {
            let original = try Self.example(operation)
            let validated = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: original))
            var incomplete = original
            incomplete["complete"] = false; incomplete[key] = []
            let bytes = try JSONSerialization.data(withJSONObject: incomplete)
            XCTAssertThrowsError(try AssistantCentralTextWire.decode(bytes))
            // Exercise the projection guard as well as the production wire rejection above.
            model.receive(.output(CentralTextPacket(bytes: bytes, fields: validated.fields)))
        }
        XCTAssertEqual(model.cards.map(\.id), [card.id])
        XCTAssertEqual(model.approvals.map(\.id), [approval.id])
        let ids = await scheduler.paymentNotificationIDs()
        XCTAssertEqual(ids, ["payment-" + card.id, "payment-approval-" + approval.id])
        let prematurelyRevoked = await scheduler.revoked
        XCTAssertTrue(prematurelyRevoked.isEmpty)
        try project("payment_cards", into: model) { $0["cards"] = [] }
        try project("payment_approvals", into: model) { $0["approvals"] = [] }
        await fulfillment(of: [removed], timeout: 1)
        let remaining = await scheduler.paymentNotificationIDs()
        XCTAssertTrue(remaining.isEmpty)
    }
}
