import XCTest
import CSQLite
@testable import DesktopKit

final class AuditStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-audit-\(UUID())")
    }

    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testIntentFinalResultAndUndoSurviveRestartWithoutDuplicateRows() throws {
        var store: AuditStore? = try AuditStore(store: directory)
        var record = AuditRecord(deviceID: "mac-1", requestID: "request-4", tool: "write_file", toolClass: "write",
                                 paths: ["/authorized/report.txt"], names: ["report.txt"], count: 1,
                                 undo: UndoRecord(kind: "overwrite", originalPath: "/authorized/report.txt",
                                                  backupPath: directory.appendingPathComponent("undo/backup/report.txt").path,
                                                  device: 16_777_234, inode: 9_007_199_254_740_993,
                                                  size: 42, mtime: 1_800_000_000.125))
        XCTAssertEqual(record.id.split(separator: "-")[2].first, "7")
        try store!.append(record)
        XCTAssertNil(try store!.record(record.id)?.result)
        record.result = "ok"
        record.durationMS = 120
        record.bytesIn = 42
        record.bytesOut = 13
        try store!.append(record)
        let undoneAt = Date()
        try store!.markUndone(record.id, at: undoneAt)
        store = nil

        let reopened = try AuditStore(store: directory)
        let saved = try XCTUnwrap(reopened.record(record.id))
        XCTAssertEqual(try reopened.records(before: nil, limit: 100).count, 1)
        XCTAssertEqual(saved.deviceID, record.deviceID)
        XCTAssertEqual(saved.requestID, record.requestID)
        XCTAssertEqual(saved.paths, record.paths)
        XCTAssertEqual(saved.result, "ok")
        XCTAssertEqual(saved.durationMS, 120)
        XCTAssertEqual(saved.bytesIn, 42)
        XCTAssertEqual(saved.bytesOut, 13)
        XCTAssertEqual(saved.undo?.backupPath, record.undo?.backupPath)
        XCTAssertEqual(saved.undo?.device, record.undo?.device)
        XCTAssertEqual(saved.undo?.inode, record.undo?.inode)
        XCTAssertEqual(saved.undo?.size, 42)
        XCTAssertEqual(saved.undo?.mtime, 1_800_000_000.125)
        XCTAssertEqual(try XCTUnwrap(saved.undoneAt).timeIntervalSince1970, undoneAt.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertTrue(try reopened.records(before: record.at.addingTimeInterval(-1), limit: 10).isEmpty)
        record.result = "error"
        record.guardCode = "GUARD_PERMISSION_REQUIRED"
        record.errorCode = "DISK_FULL"
        try reopened.append(record)
        XCTAssertEqual(try reopened.record(record.id)?.entry.errorCode, "DISK_FULL")
        XCTAssertEqual(try reopened.record(record.id)?.guardCode, "GUARD_PERMISSION_REQUIRED")
        record.result = "cancelled"
        try reopened.append(record)
        XCTAssertEqual(try reopened.record(record.id)?.result, "cancelled")
        XCTAssertEqual(try reopened.records(before: nil, limit: 100).count, 1)
    }

    func testLegacyUndoDecodesAndOnlySuccessfulOperationsExposeUndo() throws {
        let data = Data(#"{"kind":"move","originalPath":"/a","movedTo":"/b"}"#.utf8)
        let undo = try JSONDecoder().decode(UndoRecord.self, from: data)
        XCTAssertNil(undo.device)
        XCTAssertNil(undo.inode)
        var record = AuditRecord(deviceID: "mac", requestID: "r", tool: "move_file", toolClass: "write", undo: undo)
        XCTAssertNil(record.entry.undo)
        for result in ["error", "cancelled"] {
            record.result = result
            XCTAssertNil(record.entry.undo)
        }
        record.result = "ok"
        XCTAssertEqual(record.entry.undo?.rawValue, "move")
    }

    func testFinalAuditFailureRollsBackToDurableIntentAndAllowsLaterCommit() throws {
        var store: AuditStore? = try AuditStore(store: directory)
        var record = AuditRecord(deviceID: "mac", requestID: "r", tool: "grant", toolClass: "permission")
        try store!.append(record)
        func execute(_ sql: String) throws {
            var db: OpaquePointer?
            XCTAssertEqual(sqlite3_open_v2(directory.appendingPathComponent("audit.sqlite").path, &db, SQLITE_OPEN_READWRITE, nil), SQLITE_OK)
            defer { sqlite3_close(db) }
            XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        }
        try execute("CREATE TRIGGER fail_finalize BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'final audit unavailable'); END")
        record.result = "ok"
        let other = AuditRecord(deviceID: "mac", requestID: "other", tool: "grant", toolClass: "permission")
        XCTAssertThrowsError(try store!.transaction {
            try store!.append(other)
            try store!.append(record)
        })
        store = nil
        let reopened = try AuditStore(store: directory)
        XCTAssertNil(try XCTUnwrap(reopened.record(record.id)).result)
        XCTAssertEqual(try reopened.records(before: nil, limit: 10).count, 1)
        XCTAssertNil(try reopened.record(other.id))
        try execute("DROP TRIGGER fail_finalize")
        try reopened.transaction { try reopened.append(record) }
        XCTAssertEqual(try reopened.record(record.id)?.result, "ok")
    }

    func testSymlinkStoreIsRejectedWithoutChangingTargetPermissions() throws {
        let target = directory.appendingPathComponent("target")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        let link = directory.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try AuditStore(store: link))
        let mode = try FileManager.default.attributesOfItem(atPath: target.path)[.posixPermissions] as! NSNumber
        XCTAssertEqual(mode.intValue & 0o777, 0o755)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.appendingPathComponent("audit.sqlite").path))
    }

    func testRetentionClearsUndoAndDeletesOldAuditReturningOnlyOwnedBackupDirectories() throws {
        let store = try AuditStore(store: directory)
        func old(_ days: Int, id: String, backup: String) -> AuditRecord {
            AuditRecord(id: id, at: Date().addingTimeInterval(-Double(days) * 86400), deviceID: "mac", requestID: id,
                        tool: "edit_file", toolClass: "write", result: "ok",
                        undo: UndoRecord(kind: "overwrite", originalPath: "/authorized/file", backupPath: backup))
        }
        let expiredUndo = directory.appendingPathComponent("undo/undo-expired")
        let expiredAudit = directory.appendingPathComponent("undo/audit-expired")
        try store.append(old(31, id: "undo-expired", backup: expiredUndo.appendingPathComponent("file").path))
        try store.append(old(366, id: "audit-expired", backup: expiredAudit.appendingPathComponent("file").path))
        try store.append(old(31, id: "unowned", backup: "/unowned/file"))
        let fresh = AuditRecord(deviceID: "mac", requestID: "fresh", tool: "read_text_file", toolClass: "read")
        try store.append(fresh)
        let cleanup = try store.prune(auditDays: 365, undoDays: 30)
        XCTAssertEqual(Set(cleanup.map(\.path)), Set([expiredUndo.path, expiredAudit.path]))
        XCTAssertNil(try store.record("audit-expired"))
        XCTAssertNil(try XCTUnwrap(store.record("undo-expired")).undo)
        XCTAssertNotNil(try store.record(fresh.id))
        XCTAssertTrue(try store.prune(auditDays: 365, undoDays: 30).isEmpty)
    }

    func testSchemaWALPrivatePermissionsAndContentFreeArgumentSummary() throws {
        let store = try AuditStore(store: directory)
        let record = AuditRecord(deviceID: "mac", requestID: "r", tool: "write_file", toolClass: "write",
                                 paths: ["/authorized/name"], names: ["name"], count: 1)
        try store.append(record)
        let file = directory.appendingPathComponent("audit.sqlite")
        for (url, expected) in [(directory!, 0o700), (file, 0o600),
                                (URL(fileURLWithPath: file.path + "-wal"), 0o600),
                                (URL(fileURLWithPath: file.path + "-shm"), 0o600)] {
            let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! NSNumber
            XCTAssertEqual(mode.intValue & 0o777, expected)
        }
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(db) }
        func value(_ sql: String) throws -> String {
            var statement: OpaquePointer?
            XCTAssertEqual(sqlite3_prepare_v2(db, sql, -1, &statement, nil), SQLITE_OK)
            defer { sqlite3_finalize(statement) }
            XCTAssertEqual(sqlite3_step(statement), SQLITE_ROW)
            return String(cString: try XCTUnwrap(sqlite3_column_text(statement, 0)))
        }
        XCTAssertEqual(try value("SELECT value FROM meta WHERE key='schema'"), "paios.desktop-audit.v1")
        XCTAssertEqual(try value("PRAGMA journal_mode"), "wal")
        let summary = try JSONSerialization.jsonObject(with: Data(value("SELECT args_summary FROM audit").utf8)) as! [String: Any]
        XCTAssertEqual(Set(summary.keys), Set(["paths", "names", "counts"]))
        XCTAssertEqual(summary["counts"] as? Int, 1)
    }
}
