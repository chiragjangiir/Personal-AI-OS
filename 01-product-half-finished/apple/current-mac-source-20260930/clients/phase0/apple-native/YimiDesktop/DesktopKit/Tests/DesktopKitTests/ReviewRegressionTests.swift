import Foundation
import CryptoKit
import CSQLite
import MCP
import XCTest
@testable import DesktopKit

// Every filesystem path and Trash destination is owned by a disposable fixture.
enum TestDesktop {
    static func make(store: URL, resources: URL) throws -> Desktop {
        let base = store.deletingLastPathComponent(), home = base.appendingPathComponent("home")
        let trash = base.appendingPathComponent("synthetic-trash")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
        return try Desktop(store: store, resources: resources, home: home, trash: { source in
            let destination = trash.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
            try FileManager.default.moveItem(at: source, to: destination)
            return destination
        })
    }
    static func fixture(config: GuardConfig? = nil, _ body: (Desktop, RegressionWire, URL) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-review-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = root.appendingPathComponent("state")
        if let config {
            try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
            try JSONEncoder().encode(config).write(to: store.appendingPathComponent("guard.json"))
        }
        let desktop = try make(store: store, resources: root.appendingPathComponent("unused-resources")), wire = RegressionWire()
        await desktop.start(transport: wire)
        do { try await body(desktop, wire, root); await desktop.stop() }
        catch { await desktop.stop(); throw error }
    }
    static func code(_ value: Value) -> String? { value.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["code"]?.stringValue }
}

final class ReviewRegressionTests: XCTestCase {
    private func directory(_ root: URL, _ name: String) throws -> URL {
        let path = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        return path
    }
    private func put(_ path: URL, _ value: String) throws { try Data(value.utf8).write(to: path) }
    private func call(_ desktop: Desktop, _ tool: String, _ args: [String: Value]) async throws -> Value {
        try await desktop.call(id: .string(UUID().uuidString), name: tool, arguments: args)
    }
    private func rows(_ desktop: Desktop, _ tool: String) async throws -> [AuditRecord] {
        try await desktop.history.records(before: nil, limit: 100).filter { $0.tool == tool && $0.result == "ok" && $0.undoneAt == nil }
    }
    private func sql(_ root: URL, _ statement: String) throws {
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(root.appendingPathComponent("state/audit.sqlite").path, &database), SQLITE_OK)
        defer { sqlite3_close(database) }
        XCTAssertEqual(sqlite3_exec(database, statement, nil, nil, nil), SQLITE_OK)
    }
    func testA83HardLinkAliasesRefusedAcrossRootsGrantsAndTransfers() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed"), sensitive = try directory(root, "outside/.ssh")
            let original = sensitive.appendingPathComponent("id_rsa_fixture"), alias = allowed.appendingPathComponent("report.txt")
            try put(original, "synthetic-secret"); try FileManager.default.linkItem(at: original, to: alias)
            _ = try await desktop.authorize(folder: allowed, write: true)
            for tool in ["read_text_file", "extract_text", "upload_to_workshop", "get_file_info"] {
                let result = try await call(desktop, tool, ["path": .string(alias.path)])
                XCTAssertEqual(TestDesktop.code(result), "GUARD_TYPE_UNSUPPORTED", tool)
                XCTAssertFalse(result.description.contains("synthetic-secret"))
            }
            let write = try await call(desktop, "write_file", ["path": .string(alias.path), "content": "wrong"])
            XCTAssertEqual(TestDesktop.code(write), "GUARD_TYPE_UNSUPPORTED")
            do { _ = try await desktop.grant(files: [alias], via: .drag); XCTFail("Hardlinked grant accepted") }
            catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_TYPE_UNSUPPORTED") }
            XCTAssertEqual(try String(contentsOf: original, encoding: .utf8), "synthetic-secret")
        }
    }
    func testA83ExtendedSensitiveStoresApplyToRootsAndExactGrants() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed")
            _ = try await desktop.authorize(folder: allowed, write: true)
            let names = ["Library/Application Support/Google/Chrome/Default/Login Data", "Library/Application Support/Microsoft Edge/Default/Cookies", "Library/Application Support/BraveSoftware/Brave-Browser/Default/Web Data", "Library/Application Support/Arc/User Data/Default/Login Data", "Library/Application Support/Firefox/Profiles/sample/logins.json", "Library/Safari/History.db", "Library/Application Support/1Password/data.sqlite", "Library/Application Support/Bitwarden/data.json", "Library/Mail/V10/message.emlx", "Library/Messages/chat.db", ".gnupg/pubring.kbx", ".aws/credentials", ".config/gh/hosts.yml"]
            for name in names {
                let file = allowed.appendingPathComponent(name)
                _ = try directory(file.deletingLastPathComponent(), ""); try put(file, "synthetic-private")
                let result = try await call(desktop, "read_text_file", ["path": .string(file.path)])
                XCTAssertEqual(TestDesktop.code(result), "GUARD_SENSITIVE_PATH", name)
                do { _ = try await desktop.grant(files: [file], via: .paste); XCTFail("Sensitive grant accepted: \(name)") }
                catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_SENSITIVE_PATH", name) }
            }
            for name in ["Keychains", ".SSH", "certificate.PeM"] { XCTAssertTrue(GuardPath.sensitive(allowed.path + "/" + name + "/data")) }
        }
    }
    func testA82AuthorizedDirectorySwapCannotReadOrWriteOutside() async throws {
        for tool in ["read_text_file", "extract_text", "upload_to_workshop", "write_file", "edit_file"] {
            try await TestDesktop.fixture { desktop, wire, root in
                let allowed = try directory(root, "allowed"), inner = try directory(allowed, "switch"), outside = try directory(root, "outside")
                let target = inner.appendingPathComponent("target.txt"), external = outside.appendingPathComponent("target.txt"), parked = root.appendingPathComponent("parked")
                try put(target, "authorized"); try put(external, "outside-secret")
                _ = try await desktop.authorize(folder: allowed, write: true)
                await desktop.setInterleave { stage in
                    guard stage == "authorized" else { return }
                    try FileManager.default.moveItem(at: inner, to: parked)
                    try FileManager.default.createSymbolicLink(at: inner, withDestinationURL: outside)
                }
                var args: [String: Value] = ["path": .string(target.path)]
                if tool == "write_file" { args["content"] = "outside-write" }
                if tool == "edit_file" { args["edits"] = [["oldText": "authorized", "newText": "outside-write"]] }
                let result = try await call(desktop, tool, args)
                XCTAssertFalse(result.description.contains("outside-secret"), tool)
                XCTAssertEqual(try String(contentsOf: external, encoding: .utf8), "outside-secret", tool)
                // A retained descriptor may read the original; no path-based re-open may read the replacement.
                if tool == "upload_to_workshop" { XCTAssertFalse(wire.uploadedBytes.contains(Data("outside-secret".utf8))) }
            }
        }
    }
    func testA82GrantSwapUsesCapturedIdentityAndRetiresObservedReplacement() async throws {
        for tool in ["read_text_file", "extract_text", "upload_to_workshop"] {
            try await TestDesktop.fixture { desktop, wire, root in
                let file = root.appendingPathComponent("given.txt"), parked = root.appendingPathComponent("parked.txt")
                try put(file, "original-given"); _ = try await desktop.grant(files: [file], via: .drag)
                await desktop.setInterleave { stage in
                    guard stage == "authorized" else { return }
                    try FileManager.default.moveItem(at: file, to: parked)
                    try Data("replacement-secret".utf8).write(to: file)
                }
                let result = try await call(desktop, tool, ["path": .string(file.path)])
                XCTAssertFalse(result.description.contains("replacement-secret"))
                XCTAssertFalse(wire.uploadedBytes.contains(Data("replacement-secret".utf8)))
                await desktop.setInterleave { _ in }
                let denied = try await call(desktop, "read_text_file", ["path": .string(file.path)])
                XCTAssertEqual(TestDesktop.code(denied), "GUARD_PATH_NOT_AUTHORIZED")
            }
        }
    }
    func testA84PauseAtStagePreventsCommitAndKeepsIntentBeforeEffect() async throws {
        try await TestDesktop.fixture { desktop, wire, root in
            let allowed = try directory(root, "allowed"), file = allowed.appendingPathComponent("target.txt")
            try put(file, "before"); _ = try await desktop.authorize(folder: allowed, write: true)
            let probe = StageInterleaveProbe()
            await desktop.setInterleave { stage in
                guard stage == "staged" else { return }
                probe.enter()
                do { try await Task.sleep(for: .seconds(30)) }
                catch is CancellationError { probe.cancel() }
                // Return normally after cancellation. The executor must still refuse commit.
            }
            try wire.feed(["id": "stage-pause", "method": "tools/call", "params": ["name": "write_file", "arguments": ["path": .string(file.path), "content": "after"]]])
            let enteredDeadline = Date().addingTimeInterval(3)
            while !probe.entered && Date() < enteredDeadline { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(probe.entered)
            guard probe.entered else { throw DesktopError.unavailable }
            let intent = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == "stage-pause" }
            XCTAssertNil(intent?.result); XCTAssertNotNil(intent?.undo?.backupPath)
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "before")
            await desktop.pause(.manual)
            let cancelledDeadline = Date().addingTimeInterval(1)
            while !probe.cancelled && Date() < cancelledDeadline { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(probe.cancelled)
            let deadline = Date().addingTimeInterval(1)
            while Date() < deadline {
                let finished = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == "stage-pause" }?.result
                if finished == "cancelled" { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let final = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == "stage-pause" }
            XCTAssertEqual(final?.result, "cancelled")
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "before")
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: allowed.path).contains { $0.hasPrefix(".yimi-") })
            let paused = try await call(desktop, "list_allowed_directories", [:])
            XCTAssertEqual(TestDesktop.code(paused), "DESKTOP_PAUSED")
            await desktop.setInterleave { _ in }; await desktop.resume(.phone)
            let resumed = try await call(desktop, "write_file", ["path": .string(file.path), "content": "resumed"])
            XCTAssertNotEqual(resumed.objectValue?["isError"], true)
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "resumed")
        }
    }
    func testA84PauseGenerationBlocksEveryCommitWithoutCancellingCaller() async throws {
        for operation in ["write_file", "edit_file", "create_directory", "move_file", "save-new", "save-overwrite"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), original = allowed.appendingPathComponent("original.txt"), destination = allowed.appendingPathComponent("destination")
                try put(original, "before")
                _ = try await desktop.authorize(folder: allowed, write: true)
                let request = "generation-" + operation
                let tool = operation.hasPrefix("save-") ? "save_from_workshop" : operation
                let args: [String: Value]
                let completed = IncomingWriterCounter(), aborted = IncomingWriterCounter()
                switch operation {
                case "write_file": args = ["path": .string(original.path), "content": "after"]
                case "edit_file": args = ["path": .string(original.path), "edits": [["oldText": "before", "newText": "after"]]]
                case "create_directory": args = ["path": .string(destination.path)]
                case "move_file": args = ["source": .string(original.path), "destination": .string(destination.path)]
                default:
                    let payload = Data("after".utf8), incoming = root.appendingPathComponent("incoming"), token = "dt-" + auditID()
                    let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
                    try payload.write(to: incoming)
                    let name = operation == "save-overwrite" ? original.lastPathComponent : destination.lastPathComponent
                    await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": token, "name": name, "size": String(payload.count), "sha256": sha, "request": request], file: incoming, completion: {
                        await completed.wrote()
                    }, abort: { await aborted.wrote() }))
                    args = ["workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/report.txt"), "folder": .string(allowed.path), "name": .string(name), "_transfer": ["transfer_id": .string(token), "size": .int(payload.count), "sha256": .string(sha)]]
                }
                let reached = StageInterleaveProbe()
                await desktop.setInterleave { stage in
                    guard stage == (tool == "move_file" ? "move" : "staged") else { return }
                    reached.enter()
                    await desktop.pause(.manual)
                    // Direct Desktop.call has no ToolHost call task to cancel.
                }
                XCTAssertFalse(Task.isCancelled)
                let result = try await desktop.call(id: .string(request), name: tool, arguments: args)
                XCTAssertFalse(Task.isCancelled, operation)
                XCTAssertTrue(reached.entered, operation)
                XCTAssertEqual(TestDesktop.code(result), "DESKTOP_PAUSED", operation)
                XCTAssertEqual(try String(contentsOf: original, encoding: .utf8), "before", operation)
                XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path), operation)
                XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: allowed.path).contains { $0.hasPrefix(".yimi-") }, operation)
                let record = try await desktop.history.records(before: nil, limit: 100).first { $0.requestID == request }
                XCTAssertEqual(record?.result, "cancelled", operation)
                if tool == "save_from_workshop" {
                    let completions = await completed.count, aborts = await aborted.count
                    XCTAssertEqual(completions, 1, operation)
                    XCTAssertEqual(aborts, 1, operation)
                }
            }
        }
    }
    func testA82MoveCollisionPreservesBothFiles() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed"), source = allowed.appendingPathComponent("source.txt"), target = allowed.appendingPathComponent("dest.txt")
            try put(source, "source"); _ = try await desktop.authorize(folder: allowed, write: true)
            await desktop.setInterleave { stage in if stage == "move" { try Data("concurrent-owner-file".utf8).write(to: target) } }
            let result = try await call(desktop, "move_file", ["source": .string(source.path), "destination": .string(target.path)])
            XCTAssertEqual(result.objectValue?["isError"], true)
            XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "source")
            XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "concurrent-owner-file")
            let records = try await rows(desktop, "move_file"); XCTAssertTrue(records.isEmpty)
        }
    }
    func testA82StaleCreateAndMoveUndoCannotTouchReplacement() async throws {
        for tool in ["write_file", "create_directory", "move_file"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), original = allowed.appendingPathComponent("original.txt"), target = allowed.appendingPathComponent("target")
                _ = try await desktop.authorize(folder: allowed, write: true)
                let args: [String: Value]
                if tool == "move_file" { try put(original, "original"); args = ["source": .string(original.path), "destination": .string(target.path)] }
                else if tool == "write_file" { args = ["path": .string(target.path), "content": "created"] }
                else { args = ["path": .string(target.path)] }
                let result = try await call(desktop, tool, args); XCTAssertNotEqual(result.objectValue?["isError"], true)
                let records = try await rows(desktop, tool)
                let row = try XCTUnwrap(records.first)
                let parked = root.appendingPathComponent("parked")
                try FileManager.default.moveItem(at: target, to: parked)
                try put(target, "replacement-owner-file")
                do { try await desktop.undo(row.id); XCTFail("Stale undo accepted") } catch { }
                XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "replacement-owner-file")
                XCTAssertFalse(FileManager.default.fileExists(atPath: original.path))
            }
        }
    }
    func testA85FailedPersistenceAndAuditKeepPriorAuthorityAcrossRestart() async throws {
        for failure in ["audit", "persistence"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), file = root.appendingPathComponent("given.txt")
                try put(file, "secret")
                if failure == "audit" { try sql(root, "CREATE TRIGGER reject_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(FAIL,'fixture'); END") }
                else {
                    let config = root.appendingPathComponent("state/guard.json")
                    if FileManager.default.fileExists(atPath: config.path) { try FileManager.default.removeItem(at: config) }
                    try FileManager.default.createDirectory(at: config, withIntermediateDirectories: false)
                }
                do { _ = try await desktop.grant(files: [file], via: .drag); XCTFail("Grant failure expected") } catch { }
                do { _ = try await desktop.authorize(folder: allowed, write: true); XCTFail("Root failure expected") } catch { }
                let grants = await desktop.grants(), folders = await desktop.folders()
                XCTAssertTrue(grants.isEmpty); XCTAssertTrue(folders.isEmpty)
                if failure == "audit" { try sql(root, "DROP TRIGGER reject_audit") }
                else { try FileManager.default.removeItem(at: root.appendingPathComponent("state/guard.json")) }
                await desktop.stop()
                let reopened = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused"))
                let afterGrants = await reopened.grants(), afterFolders = await reopened.folders()
                XCTAssertTrue(afterGrants.isEmpty); XCTAssertTrue(afterFolders.isEmpty)
                await reopened.stop()
            }
        }
    }
    func testA85ObservedMissingGrantNeverReactivatesAfterRestoreOrRestart() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let file = root.appendingPathComponent("given.txt"), parked = root.appendingPathComponent("parked.txt")
            try put(file, "given"); _ = try await desktop.grant(files: [file], via: .paste)
            try FileManager.default.moveItem(at: file, to: parked)
            let missing = try await call(desktop, "read_text_file", ["path": .string(file.path)])
            XCTAssertEqual(TestDesktop.code(missing), "GUARD_PATH_NOT_AUTHORIZED")
            try FileManager.default.moveItem(at: parked, to: file)
            let restored = try await call(desktop, "read_text_file", ["path": .string(file.path)])
            XCTAssertEqual(TestDesktop.code(restored), "GUARD_PATH_NOT_AUTHORIZED")
            await desktop.stop()
            let reopened = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused"))
            let grants = await reopened.grants(); XCTAssertTrue(grants.isEmpty)
            await reopened.start(transport: RegressionWire())
            let after = try await call(reopened, "read_text_file", ["path": .string(file.path)])
            XCTAssertEqual(TestDesktop.code(after), "GUARD_PATH_NOT_AUTHORIZED")
            _ = try await reopened.grant(files: [file], via: .drag)
            let fresh = try await call(reopened, "read_text_file", ["path": .string(file.path)])
            XCTAssertNotEqual(fresh.objectValue?["isError"], true)
            await reopened.stop()
        }
    }
    func testC14SchemaErrorsRemainRPCInvalidParams() async throws {
        try await TestDesktop.fixture { _, wire, _ in
            for (id, args): (String, Value) in [("type", ["path": 42, "content": true]), ("missing", ["path": "/synthetic"])] {
                try wire.feed(["id": .string(id), "method": "tools/call", "params": ["name": "write_file", "arguments": args]])
                let reply = try await wire.next(id: .string(id))
                XCTAssertEqual(reply.objectValue?["error"]?.objectValue?["code"], -32602)
                XCTAssertNil(reply.objectValue?["result"])
            }
        }
    }
    func testA84UnclaimedIncomingAbortOnPauseStopCancelAndRejection() async throws {
        for action in ["pause", "stop", "cancel", "invalid"] {
            try await TestDesktop.fixture { desktop, _, root in
                let aborted = expectation(description: action + " abort")
                let file = root.appendingPathComponent("incoming"); try put(file, "partial")
                let counter = IncomingWriterCounter()
                let writer = Task.detached {
                    let handle = try FileHandle(forWritingTo: file)
                    defer { try? handle.close() }
                    while true {
                        try Task.checkCancellation()
                        try handle.write(contentsOf: Data(repeating: 65, count: 64))
                        await counter.wrote()
                        try await Task.sleep(for: .milliseconds(10))
                    }
                }
                let token = "dt-" + auditID()
                let attributes = action == "invalid" ? ["v": "bad"] : ["v": "1", "dir": "down", "transfer": token, "name": "file.txt", "size": "7", "sha256": String(repeating: "a", count: 64), "request": "unclaimed"]
                await desktop.received(DesktopIncomingFile(attributes: attributes, file: file, completion: { XCTFail("Unclaimed completion invoked") }, abort: { writer.cancel(); _ = try? await writer.value; aborted.fulfill() }))
                if action == "pause" { await desktop.pause(.manual) }
                if action == "stop" { await desktop.stop() }
                if action == "cancel" { await desktop.cancelDownload(token) }
                await fulfillment(of: [aborted], timeout: 1)
                let stopped = await counter.count
                try await Task.sleep(for: .milliseconds(50))
                let after = await counter.count
                XCTAssertEqual(after, stopped, "Writer continued after " + action)
            }
        }
    }
    func testA84RejectedSaveAbortsQueuedIncomingWithoutClaimingCompletion() async throws {
        for reason in ["sensitive", "unauthorized", "invalid-name"] {
            try await TestDesktop.fixture { desktop, _, root in
                let allowed = try directory(root, "allowed"), outside = try directory(root, "outside")
                _ = try await desktop.authorize(folder: allowed, write: true)
                let file = root.appendingPathComponent("incoming"), token = "dt-" + auditID(), request = "rejected-" + reason
                try put(file, "partial")
                let aborted = expectation(description: reason + " incoming aborted")
                await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": token, "name": "report.txt", "size": "7", "sha256": String(repeating: "a", count: 64), "request": request], file: file, completion: {
                    XCTFail("Rejected save must not claim incoming completion")
                }, abort: { aborted.fulfill() }))
                let folder = reason == "unauthorized" ? outside : allowed
                let name = reason == "sensitive" ? ".env" : (reason == "invalid-name" ? "." : "report.txt")
                let result = try await desktop.call(id: .string(request), name: "save_from_workshop", arguments: ["workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/report.txt"), "folder": .string(folder.path), "name": .string(name), "_transfer": ["transfer_id": .string(token), "size": 7, "sha256": .string(String(repeating: "a", count: 64))]])
                let expected = reason == "sensitive" ? "GUARD_SENSITIVE_PATH" : (reason == "unauthorized" ? "GUARD_PATH_NOT_AUTHORIZED" : "GUARD_PATH_INVALID")
                XCTAssertEqual(TestDesktop.code(result), expected)
                await fulfillment(of: [aborted], timeout: 1)
                XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
                XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: allowed.path).isEmpty)
                XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
            }
        }
    }
    func testA64GrantLimitsAndRevocationAreDurable() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            var files: [URL] = []
            for index in 0..<11 {
                let file = root.appendingPathComponent("given-\(index).txt")
                try put(file, "given"); files.append(file)
            }
            do { _ = try await desktop.grant(files: files, via: .drag); XCTFail("Eleven files accepted") }
            catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_TOO_LARGE") }
            let granted = try await desktop.grant(files: Array(files.prefix(10)), via: .paste)
            XCTAssertEqual(granted.count, 10)
            do { _ = try await desktop.grant(files: [root], via: .drag); XCTFail("Folder attached") }
            catch DesktopError.notAFile(_) { }
            try await desktop.undo(granted[0].id)
            let read = try await call(desktop, "read_text_file", ["path": .string(files[0].path)])
            XCTAssertEqual(TestDesktop.code(read), "GUARD_PATH_NOT_AUTHORIZED")
            await desktop.stop()
            let reopened = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused"))
            let remaining = await reopened.grants()
            XCTAssertEqual(remaining.count, 9); XCTAssertFalse(remaining.contains { $0.id == granted[0].id })
            await reopened.stop()
        }
    }
    func testI5TextResultCapsAndUnicodeAlias() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed"), unicode = try directory(allowed, "café")
            _ = try await desktop.authorize(folder: allowed, write: true)
            let file = unicode.appendingPathComponent("report.txt"); try put(file, "unicode")
            let alias = file.path.decomposedStringWithCanonicalMapping
            let read = try await call(desktop, "read_text_file", ["path": .string(alias)])
            XCTAssertNotEqual(read.objectValue?["isError"], true)
            for path in [unicode.path + "/.env", unicode.path.decomposedStringWithCanonicalMapping + "/.ENV", unicode.path.uppercased() + "/.SSH/key"] {
                let refused = try await call(desktop, "read_text_file", ["path": .string(path)])
                XCTAssertEqual(TestDesktop.code(refused), "GUARD_SENSITIVE_PATH")
            }
            let large = allowed.appendingPathComponent("large.txt"); try put(large, String(repeating: "x", count: 300_000))
            for args: [String: Value] in [["path": .string(large.path)], ["path": .string(large.path), "head": 1]] {
                let result = try await call(desktop, "read_text_file", args)
                XCTAssertEqual(TestDesktop.code(result), "GUARD_TOO_LARGE")
            }
        }
    }
    func testI11HostileTransferPlacementAndUploadCaps() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let allowed = try directory(root, "allowed")
            _ = try await desktop.authorize(folder: allowed, write: true)
            // Validate names before consuming any incoming bytes.
            for name in ["..", ".", "../escape", "/", "a/b", "nul\0name", String(repeating: "x", count: 256), ".env"] {
                let args: [String: Value] = ["workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/file.txt"), "folder": .string(allowed.path), "name": .string(name), "_transfer": ["transfer_id": .string("dt-" + auditID()), "size": 7, "sha256": .string(String(repeating: "a", count: 64))]]
                if name.contains("/") || name.utf8.contains(0) || name.count > 255 {
                    do { _ = try await call(desktop, "save_from_workshop", args); XCTFail("Schema-invalid name accepted") }
                    catch is InvalidParams { }
                } else {
                    let result = try await call(desktop, "save_from_workshop", args)
                    XCTAssertEqual(result.objectValue?["isError"], true, name)
                }
            }
            for source in ["/owner/out/short/a", "/owner/in/token/a", "/owner/out/" + String(repeating: "a", count: 32) + "/../outside"] {
                let args: [String: Value] = ["workshop_path": .string(source), "folder": .string(allowed.path), "name": "report.txt", "_transfer": ["transfer_id": .string("dt-" + auditID()), "size": 7, "sha256": .string(String(repeating: "a", count: 64))]]
                if source.hasPrefix("/owner/out/" + String(repeating: "a", count: 32) + "/") {
                    let result = try await call(desktop, "save_from_workshop", args)
                    XCTAssertEqual(result.objectValue?["isError"], true, source)
                } else {
                    do { _ = try await call(desktop, "save_from_workshop", args); XCTFail("Schema-invalid source accepted") }
                    catch is InvalidParams { }
                }
            }
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: allowed.path).isEmpty)
            let big = allowed.appendingPathComponent("large.bin")
            XCTAssertTrue(FileManager.default.createFile(atPath: big.path, contents: nil))
            let handle = try FileHandle(forWritingTo: big); try handle.truncate(atOffset: 26_214_401); try handle.close()
            let result = try await call(desktop, "upload_to_workshop", ["path": .string(big.path)])
            XCTAssertEqual(TestDesktop.code(result), "TRANSFER_TOO_LARGE")
        }
        var config = GuardConfig(); config.rates.upload_bytes_per_day = 2
        try await TestDesktop.fixture(config: config) { desktop, wire, root in
            let allowed = try directory(root, "allowed"), file = allowed.appendingPathComponent("quota.txt")
            try put(file, "abc"); _ = try await desktop.authorize(folder: allowed, write: true)
            let result = try await call(desktop, "upload_to_workshop", ["path": .string(file.path)])
            XCTAssertEqual(TestDesktop.code(result), "GUARD_RATE_LIMITED")
            XCTAssertTrue(wire.uploadedBytes.isEmpty)
        }
    }
    func testI9NativeToolExposureAndPairedAuditIdentity() async throws {
        try await TestDesktop.fixture { desktop, wire, root in
            let allowed = try directory(root, "allowed"); _ = try await desktop.authorize(folder: allowed, write: true)
            for name in ["read_file", "read_multiple_files", "read_media_file", "directory_tree", "delete_file", "run_command"] {
                try wire.feed(["id": .string(name), "method": "tools/call", "params": ["name": .string(name), "arguments": [:]]])
                let reply = try await wire.next(id: .string(name))
                XCTAssertEqual(reply.objectValue?["error"]?.objectValue?["code"], -32602)
            }
            let result = try await call(desktop, "create_directory", ["path": .string(allowed.path + "/created")])
            XCTAssertNotEqual(result.objectValue?["isError"], true)
            let records = try await rows(desktop, "create_directory")
            XCTAssertEqual(records.first?.deviceID, "regression-synthetic-mac")
            let roots = try await call(desktop, "list_allowed_directories", [:])
            XCTAssertEqual(roots.objectValue?["structuredContent"]?.objectValue?["directories"]?.arrayValue?.first?.objectValue?["path"], .string(try GuardPath.canonical(allowed.path)))
        }
        try await TestDesktop.fixture { desktop, _, _ in
            await desktop.stop(); await desktop.start(transport: NoIdentityRegressionWire())
            let result = try await call(desktop, "list_allowed_directories", [:])
            XCTAssertEqual(TestDesktop.code(result), "DESKTOP_OFFLINE")
        }
    }

}

final class RegressionWire: DesktopTransport, @unchecked Sendable {
    let auditDeviceID: String? = "regression-synthetic-mac"
    private let input = AsyncStream<DesktopFrame>.makeStream(), files = AsyncStream<DesktopIncomingFile>.makeStream()
    private let lock = NSLock()
    private var sent: [Value] = [], uploads: [Data] = []
    var uploadedBytes: [Data] { lock.withLock { uploads } }
    func frames() -> AsyncStream<DesktopFrame> { input.stream }
    func downloads() -> AsyncStream<DesktopIncomingFile> { files.stream }
    func send(_ frame: Data) async throws { let value = try JSONDecoder().decode(Value.self, from: frame); lock.withLock { sent.append(value) } }
    func upload(file: URL, attributes: [String: String]) async throws { let data = try Data(contentsOf: file); lock.withLock { uploads.append(data) } }
    func feed(_ value: Value) throws {
        var fields = value.objectValue!; fields["jsonrpc"] = "2.0"
        input.continuation.yield(DesktopFrame(try JSONEncoder().encode(Value.object(fields))))
    }
    func next(id: Value) async throws -> Value {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if let value = lock.withLock({ sent.first { $0.objectValue?["id"] == id } }) { return value }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw DesktopError.unavailable
    }
}

private struct NoIdentityRegressionWire: DesktopTransport {
    func frames() -> AsyncStream<DesktopFrame> { AsyncStream { $0.finish() } }
    func downloads() -> AsyncStream<DesktopIncomingFile> { AsyncStream { $0.finish() } }
    func send(_ frame: Data) async throws { }
    func upload(file: URL, attributes: [String: String]) async throws { }
}

private actor IncomingWriterCounter {
    var count = 0
    func wrote() { count += 1 }
}

private final class StageInterleaveProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var didEnter = false, didCancel = false
    var entered: Bool { lock.withLock { didEnter } }
    var cancelled: Bool { lock.withLock { didCancel } }
    func enter() { lock.withLock { didEnter = true } }
    func cancel() { lock.withLock { didCancel = true } }
}
