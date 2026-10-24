import Foundation
import CSQLite
import MCP
import XCTest
@testable import DesktopKit

final class PermissionFailureTests: XCTestCase {
    private func put(_ file: URL, _ text: String = "owner content") throws { try Data(text.utf8).write(to: file) }
    private func directory(_ root: URL, _ name: String) throws -> URL {
        let file = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        return file
    }
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
    private func read(_ desktop: Desktop, _ file: URL) async throws -> Value {
        try await desktop.call(id: .string(UUID().uuidString), name: "read_text_file", arguments: ["path": .string(file.path)])
    }
    private func reopened(_ root: URL) throws -> Desktop {
        try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused"))
    }

    func testFinalGrantAndAuthorizeFailureRestorePriorLiveAndDiskPermissions() async throws {
        for tool in ["file_grant", "authorize_folder"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), extra = try directory(root, "extra")
                let file = root.appendingPathComponent("given.txt"); try put(file)
                let folder = try await desktop.authorize(folder: allowed, write: false)
                let config = root.appendingPathComponent("state/guard.json"), before = try Data(contentsOf: config)
                try rejectFinal(root, tool: tool)
                do {
                    if tool == "file_grant" { _ = try await desktop.grant(files: [file], via: .drag) }
                    else { _ = try await desktop.authorize(folder: extra, write: true) }
                    XCTFail("Final audit failure must reject permission change")
                } catch let error as ToolFailure { XCTAssertEqual(error.code, "DESKTOP_AUDIT_STORE") }
                XCTAssertEqual(try Data(contentsOf: config), before)
                let live = await desktop.folders(), grants = await desktop.grants()
                XCTAssertEqual(live.map(\.id), [folder.id]); XCTAssertFalse(live[0].write); XCTAssertTrue(grants.isEmpty)
                let intents = try await desktop.history.records(before: nil, limit: 100).filter { $0.tool == tool }
                XCTAssertTrue(intents.contains { $0.result == nil })
                try sql(root, "DROP TRIGGER reject_final"); await desktop.stop()
                let next = try reopened(root), saved = await next.folders(), savedGrants = await next.grants()
                XCTAssertEqual(saved.map(\.id), [folder.id]); XCTAssertFalse(saved[0].write); XCTAssertTrue(savedGrants.isEmpty)
                await next.stop()
            }
        }
    }

    func testFailedRevokeWriteFlagAndFolderRemovalPreservePriorAuthority() async throws {
        for tool in ["revoke_file_grant", "set_folder_write", "revoke_folder"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), file = root.appendingPathComponent("given.txt")
                try put(file); let folder = try await desktop.authorize(folder: allowed, write: true)
                let grant = try await desktop.grant(files: [file], via: .paste)[0]
                let config = root.appendingPathComponent("state/guard.json"), before = try Data(contentsOf: config)
                try rejectFinal(root, tool: tool)
                do {
                    switch tool {
                    case "revoke_file_grant": try await desktop.revoke(grant: grant.id)
                    case "set_folder_write": try await desktop.setWrite(false, folder: folder.id)
                    default: try await desktop.remove(folder: folder.id)
                    }
                    XCTFail("Final audit failure must preserve prior permission")
                } catch let error as ToolFailure { XCTAssertEqual(error.code, "DESKTOP_AUDIT_STORE") }
                XCTAssertEqual(try Data(contentsOf: config), before)
                let live = await desktop.folders(), grants = await desktop.grants()
                XCTAssertEqual(live.map(\.id), [folder.id]); XCTAssertTrue(live[0].write); XCTAssertEqual(grants.map(\.id), [grant.id])
                try sql(root, "DROP TRIGGER reject_final"); await desktop.stop()
                let next = try reopened(root), saved = await next.folders(), savedGrants = await next.grants()
                XCTAssertEqual(saved.map(\.id), [folder.id]); XCTAssertTrue(saved[0].write); XCTAssertEqual(savedGrants.map(\.id), [grant.id])
                await next.stop()
            }
        }
    }

    func testUnsupportedReplacementAndNonDirectoryParentRetireGrantAcrossRestoreAndRestart() async throws {
        for replacement in ["hardlink", "parent-file"] {
            try await TestDesktop.fixture { desktop, _, root in
                let parent = try directory(root, "given"), file = parent.appendingPathComponent("file.txt")
                let parked = root.appendingPathComponent("parked"), other = root.appendingPathComponent("other.txt")
                try put(file); _ = try await desktop.grant(files: [file], via: .drag)
                if replacement == "hardlink" {
                    try FileManager.default.moveItem(at: file, to: parked); try put(other)
                    try FileManager.default.linkItem(at: other, to: file)
                } else {
                    try FileManager.default.moveItem(at: parent, to: parked); try put(parent)
                }
                let denied = try await read(desktop, file)
                XCTAssertEqual(TestDesktop.code(denied), "GUARD_PATH_NOT_AUTHORIZED")
                let removed = replacement == "hardlink" ? file : parent
                try FileManager.default.removeItem(at: removed); try FileManager.default.moveItem(at: parked, to: removed)
                let restored = try await read(desktop, file)
                XCTAssertEqual(TestDesktop.code(restored), "GUARD_PATH_NOT_AUTHORIZED")
                await desktop.stop(); let next = try reopened(root); await next.start(transport: RegressionWire())
                let after = try await read(next, file), grants = await next.grants()
                XCTAssertEqual(TestDesktop.code(after), "GUARD_PATH_NOT_AUTHORIZED"); XCTAssertTrue(grants.isEmpty)
                await next.stop()
            }
        }
    }

    func testFailedRetirementFinalizationPoisonsRuntimeAndCompletesDurableIntentAtRestart() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let file = root.appendingPathComponent("given.txt"), parked = root.appendingPathComponent("parked.txt")
            try put(file); let grant = try await desktop.grant(files: [file], via: .drag)[0]
            try FileManager.default.moveItem(at: file, to: parked); try put(file, "replacement")
            try rejectFinal(root, tool: "retire_file_grant")
            let observed = try await read(desktop, file)
            XCTAssertEqual(TestDesktop.code(observed), "DESKTOP_AUDIT_STORE")
            let pending = try await desktop.history.unresolvedRetirements()
            XCTAssertEqual(pending.map(\.requestID), [grant.id])
            try FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: parked, to: file)
            try sql(root, "DROP TRIGGER reject_final")
            let poisoned = try await read(desktop, file)
            XCTAssertEqual(TestDesktop.code(poisoned), "DESKTOP_AUDIT_STORE")
            await desktop.stop(); let next = try reopened(root); await next.start(transport: RegressionWire())
            let restored = try await read(next, file), grants = await next.grants()
            let remaining = try await next.history.unresolvedRetirements()
            XCTAssertEqual(TestDesktop.code(restored), "GUARD_PATH_NOT_AUTHORIZED"); XCTAssertTrue(grants.isEmpty); XCTAssertTrue(remaining.isEmpty)
            let saved = try JSONDecoder().decode(GuardConfig.self, from: Data(contentsOf: root.appendingPathComponent("state/guard.json")))
            XCTAssertTrue(saved.files.isEmpty); await next.stop()
        }
    }

    func testUndoAuditFailureReleasesWriteGateForTheNextWrite() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed"), file = allowed.appendingPathComponent("file.txt")
            _ = try await desktop.authorize(folder: allowed, write: true)
            let written = try await desktop.call(id: "first", name: "write_file", arguments: ["path": .string(file.path), "content": "first"])
            XCTAssertNil(TestDesktop.code(written))
            let record = try await desktop.history.records(before: nil, limit: 100).first { $0.tool == "write_file" && $0.result == "ok" }
            let entry = try XCTUnwrap(record).id
            try sql(root, "CREATE TRIGGER reject_undo BEFORE INSERT ON audit WHEN json_extract(NEW.record,'$.tool')='undo' BEGIN SELECT RAISE(ABORT,'fixture undo audit failure'); END")
            do { try await desktop.undo(entry); XCTFail("Undo audit failure expected") } catch { }
            try sql(root, "DROP TRIGGER reject_undo")
            let completed = expectation(description: "Write gate released after failed undo")
            let task = Task {
                defer { completed.fulfill() }
                let value = try await desktop.call(id: "next", name: "write_file", arguments: ["path": .string(file.path), "content": "next"])
                XCTAssertNil(TestDesktop.code(value))
            }
            await fulfillment(of: [completed], timeout: 2); task.cancel(); _ = try? await task.value
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "next")
        }
    }

    func testRestoredIdentityDoesNotBlessOwnerChangesForEarlierCreateUndo() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed"), file = allowed.appendingPathComponent("file.txt")
            _ = try await desktop.authorize(folder: allowed, write: true)
            func write(_ request: String, _ text: String) async throws {
                let result = try await desktop.call(id: .string(request), name: "write_file", arguments: ["path": .string(file.path), "content": .string(text)])
                XCTAssertNil(TestDesktop.code(result))
            }
            try await write("create", "first")
            let created = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == "create" }
            let original = try XCTUnwrap(created)
            let ownerText = "owner changed this file in place"
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: 0); try handle.write(contentsOf: Data(ownerText.utf8))
            try handle.synchronize(); try handle.close()
            let ownerInfo = try GuardPath.info(file.path)
            XCTAssertEqual(original.undo?.inode, ownerInfo.st_ino)
            XCTAssertNotEqual(original.undo?.size, ownerInfo.st_size)
            try await write("overwrite", "agent replacement")
            let overwritten = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == "overwrite" }
            try await desktop.undo(try XCTUnwrap(overwritten).id)
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), ownerText)
            do { try await desktop.undo(original.id); XCTFail("Earlier create undo must preserve owner changes") }
            catch let error as ToolFailure { XCTAssertTrue(["GUARD_PATH_NOT_AUTHORIZED", "GUARD_EXISTS"].contains(error.code)) }
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), ownerText)
            let unchanged = try await desktop.history.record(original.id)
            XCTAssertNil(unchanged?.undoneAt)
            XCTAssertEqual(unchanged?.undo?.size, original.undo?.size)
        }
    }
}
