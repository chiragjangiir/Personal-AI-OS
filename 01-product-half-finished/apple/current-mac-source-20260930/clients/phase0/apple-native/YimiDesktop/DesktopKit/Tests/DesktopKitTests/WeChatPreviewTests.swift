import XCTest
import CSQLite
@testable import DesktopKit

final class WeChatPreviewTests: XCTestCase {
    private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
    private func fixture() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = root.appendingPathComponent("notifications.db")
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(database.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE app(app_id INTEGER, identifier TEXT); CREATE TABLE record(rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, delivered_date REAL); INSERT INTO app VALUES(1,'com.tencent.xinWeChat'),(2,'com.example.other'); PRAGMA journal_mode=WAL;", nil, nil, nil), SQLITE_OK)
        return (root, database)
    }
    private func insert(_ database: URL, record: Int, app: Int = 1, title: String, body: Any? = "明天下午几点见？") throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(database.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        var request: [String: Any] = ["titl": title]
        request["body"] = body
        let plist = try PropertyListSerialization.data(fromPropertyList: ["req": request], format: .binary, options: 0)
        let hex = plist.map { String(format: "%02x", $0) }.joined()
        let sql = "INSERT INTO record VALUES(\(record),\(app),X'\(String(format: "%032x", record))',X'\(hex)',\(start.timeIntervalSinceReferenceDate + Double(record)))"
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
    }
    func testExactScopeAndHiddenBodyWithoutReadingOtherApps() throws {
        let (root, database) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try insert(database, record: 1, title: "林可")
        try insert(database, record: 2, title: "林可同事")
        try insert(database, record: 3, app: 2, title: "林可")
        try insert(database, record: 4, title: "工作讨论群", body: nil)
        let reader = WeChatNotificationReader(database: database)
        let page = try reader.read(after: WeChatPreviewCursor(since: start), chats: ["林可", "工作讨论群"])
        XCTAssertEqual(page.previews.map(\.chat), ["林可", "工作讨论群"])
        XCTAssertEqual(page.previews.last?.body, "")
        XCTAssertEqual(page.previews.first?.delivered_at, "2026-05-09T06:13:21.000Z")
        XCTAssertTrue(try reader.read(after: page.cursor, chats: ["林可"]).previews.isEmpty)
        XCTAssertEqual(page.cursor.record, 4)
    }
    func testOffDoesNotOpenDatabaseAndPendingSurvivesRestartUntilReceipt() async throws {
        let (root, database) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("inbox.json")
        let inbox = try WeChatPreviewInbox(file: file)
        let missing = WeChatNotificationReader(database: root.appendingPathComponent("missing"))
        let off = try await inbox.prepare(reader: missing, owner: "owner")
        XCTAssertNil(off)
        var policy = WeChatPreviewPolicy(); policy.enabled = true; policy.chats = ["林可"]
        try await inbox.configure(policy, owner: "owner", now: start)
        try insert(database, record: 1, title: "林可")
        let reader = WeChatNotificationReader(database: database)
        let first = try await inbox.prepare(reader: reader, owner: "owner")
        let reloaded = try WeChatPreviewInbox(file: file)
        let pending = try await reloaded.prepare(reader: missing, owner: "owner")
        XCTAssertEqual(first, pending)
        let wrongOwner = try await reloaded.prepare(reader: reader, owner: "another-owner")
        XCTAssertNil(wrongOwner)
        try await reloaded.acknowledge("unrelated")
        let unchanged = try await reloaded.prepare(reader: reader, owner: "owner")
        XCTAssertEqual(first, unchanged)
        try await reloaded.acknowledge(try XCTUnwrap(first).batch_id)
        let empty = try await reloaded.prepare(reader: reader, owner: "owner")
        XCTAssertNil(empty)
        XCTAssertFalse(String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("明天"))
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testScopeChangeDropsUnsentPayloadAndStartsAtNewConsentTime() async throws {
        let (root, database) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let inbox = try WeChatPreviewInbox(file: root.appendingPathComponent("inbox.json"))
        var policy = WeChatPreviewPolicy(); policy.enabled = true; policy.chats = ["林可"]
        try await inbox.configure(policy, owner: "owner", now: start)
        try insert(database, record: 1, title: "林可")
        let pending = try await inbox.prepare(reader: WeChatNotificationReader(database: database), owner: "owner")
        XCTAssertNotNil(pending)
        policy.enabled = false
        try await inbox.configure(policy, owner: "owner", now: start.addingTimeInterval(10))
        let disabled = try await inbox.prepare(reader: WeChatNotificationReader(database: database), owner: "owner")
        XCTAssertNil(disabled)
        policy.enabled = true
        try await inbox.configure(policy, owner: "owner", now: start.addingTimeInterval(10))
        let historical = try await inbox.prepare(reader: WeChatNotificationReader(database: database), owner: "owner")
        XCTAssertNil(historical)
    }
    func testUnsupportedSchemaAndPayloadSurfaceErrors() throws {
        let (root, database) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        try insert(database, record: 1, title: "林可", body: 42)
        XCTAssertThrowsError(try WeChatNotificationReader(database: database).read(after: WeChatPreviewCursor(since: start), chats: ["林可"]))
        let absent = root.appendingPathComponent("absent.db")
        XCTAssertThrowsError(try WeChatNotificationReader(database: absent).read(after: WeChatPreviewCursor(since: start), chats: ["林可"]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: absent.path))
    }
    func testByteBoundedPagesDoNotLoseTheFirstNotificationOfTheNextPage() throws {
        let (root, database) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        for record in 1...6 { try insert(database, record: record, title: "林可", body: String(repeating: "文", count: 8192)) }
        let reader = WeChatNotificationReader(database: database)
        let first = try reader.read(after: WeChatPreviewCursor(since: start), chats: ["林可"])
        XCTAssertEqual(first.previews.count, 4)
        XCTAssertEqual(first.cursor.record, 4)
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(first.previews).count, 120_000)
        let second = try reader.read(after: first.cursor, chats: ["林可"])
        XCTAssertEqual(second.previews.count, 2)
        XCTAssertEqual(second.cursor.record, 6)
        XCTAssertEqual(Set((first.previews + second.previews).map(\.id)).count, 6)
        XCTAssertTrue((first.previews + second.previews).allSatisfy { $0.body.count == 8192 })
    }
}
