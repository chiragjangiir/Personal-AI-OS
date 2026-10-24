import Foundation
import CryptoKit
import CSQLite
import MCP
import XCTest
@testable import DesktopKit

final class AuditCommitRecoveryTests: XCTestCase {
    private func sql(_ root: URL, _ statement: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(root.appendingPathComponent("state/audit.sqlite").path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            sqlite3_close(db); throw DesktopError.unavailable
        }
        defer { sqlite3_close(db) }
        guard sqlite3_exec(db, statement, nil, nil, nil) == SQLITE_OK else { throw DesktopError.unavailable }
    }
    private func rejectFinal(_ root: URL, tool: String) throws {
        try sql(root, "CREATE TRIGGER reject_final BEFORE UPDATE ON audit WHEN json_extract(NEW.record,'$.tool')='\(tool)' AND json_extract(NEW.record,'$.result')='ok' BEGIN SELECT RAISE(ABORT,'fixture finalization failure'); END")
    }
    private func work(_ root: URL, desktop: Desktop) async throws -> URL {
        let folder = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        _ = try await desktop.authorize(folder: folder, write: true)
        return folder
    }
    private func reopen(_ root: URL) throws -> Desktop {
        try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root)
    }

    func testMoveFinalAuditFailureRetainsJournalAndRecoversUndo() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let folder = try await work(root, desktop: desktop)
            let source = folder.appendingPathComponent("source"), destination = folder.appendingPathComponent("destination")
            try Data("original".utf8).write(to: source)
            try rejectFinal(root, tool: "move_file")
            let result = try await desktop.call(id: "move", name: "move_file", arguments: ["source": .string(source.path), "destination": .string(destination.path)])
            XCTAssertEqual(TestDesktop.code(result), "DESKTOP_AUDIT_STORE")
            XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
            XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "original")
            let audit = try AuditStore(store: root.appendingPathComponent("state"))
            let pending = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "move_file" })
            XCTAssertNotNil(pending.undo?.movement, "A rejected completion must not erase the durable movement intent")
            try sql(root, "DROP TRIGGER reject_final"); await desktop.stop()
            let next = try reopen(root), recovered = try XCTUnwrap(audit.record(pending.id))
            XCTAssertEqual(recovered.result, "ok"); XCTAssertNil(recovered.undo?.movement)
            let entries = try await next.audit(before: nil, limit: 100)
            XCTAssertNotNil(entries.first { $0.id == pending.id }?.undo)
            try await next.undo(pending.id)
            XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "original")
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
            await next.stop()
        }
    }

    func testWorkshopFinalAuditFailureRetainsJournalAndRestoresOriginalOnUndo() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let folder = try await work(root, desktop: desktop)
            let target = folder.appendingPathComponent("report.txt"), incoming = root.appendingPathComponent("incoming")
            let payload = Data("replacement".utf8), transfer = "dt-" + auditID()
            try Data("original".utf8).write(to: target); try payload.write(to: incoming)
            let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": transfer, "name": "report.txt", "size": String(payload.count), "sha256": sha, "request": "save"], file: incoming, completion: {}, abort: {}))
            try rejectFinal(root, tool: "save_from_workshop")
            let result = try await desktop.call(id: "save", name: "save_from_workshop", arguments: [
                "workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/report.txt"),
                "folder": .string(folder.path), "name": "report.txt",
                "_transfer": ["transfer_id": .string(transfer), "size": .int(payload.count), "sha256": .string(sha)]])
            XCTAssertEqual(TestDesktop.code(result), "DESKTOP_AUDIT_STORE")
            XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "replacement")
            let audit = try AuditStore(store: root.appendingPathComponent("state"))
            let pending = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "save_from_workshop" })
            XCTAssertNotNil(pending.undo?.replacement, "A removed stage directory does not prove the completion audit committed")
            try sql(root, "DROP TRIGGER reject_final"); await desktop.stop()
            let next = try reopen(root), recovered = try XCTUnwrap(audit.record(pending.id))
            XCTAssertEqual(recovered.result, "ok"); XCTAssertNil(recovered.undo?.replacement)
            try await next.undo(pending.id)
            XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "original")
            await next.stop()
        }
    }

    func testUndoMoveFinalAuditFailureRetainsJournalAndRecoversCompletion() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let folder = try await work(root, desktop: desktop)
            let source = folder.appendingPathComponent("source"), destination = folder.appendingPathComponent("destination")
            try Data("original".utf8).write(to: source)
            let result = try await desktop.call(id: "move", name: "move_file", arguments: ["source": .string(source.path), "destination": .string(destination.path)])
            XCTAssertNil(TestDesktop.code(result))
            let audit = try AuditStore(store: root.appendingPathComponent("state"))
            let original = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "move_file" })
            try rejectFinal(root, tool: "undo")
            do { try await desktop.undo(original.id); XCTFail("Final completion audit must fail") }
            catch let error as ToolFailure { XCTAssertEqual(error.code, "DESKTOP_AUDIT_STORE") }
            XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "original")
            let pending = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "undo" })
            XCTAssertNotNil(pending.undo?.movement)
            try sql(root, "DROP TRIGGER reject_final"); await desktop.stop()
            let next = try reopen(root), recovered = try XCTUnwrap(audit.record(pending.id))
            XCTAssertEqual(recovered.result, "ok"); XCTAssertNil(recovered.undo?.movement)
            XCTAssertNotNil(try audit.record(original.id)?.undoneAt)
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
            await next.stop()
            _ = try reopen(root)
        }
    }
}
