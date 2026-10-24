import CryptoKit
import Foundation
import MCP
import XCTest
@testable import DesktopKit

final class DesktopIntegrationTests: XCTestCase {
    private func fixture(config: GuardConfig? = nil, beforeUpload: (@Sendable () async throws -> Void)? = nil,
                         failStatePublish: Bool = false, _ body: (Desktop, IntegrationWire, URL) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-integration-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let resources = root.appendingPathComponent("unused-resources")
        let store = root.appendingPathComponent("state")
        if let config {
            try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
            try JSONEncoder().encode(config).write(to: store.appendingPathComponent("guard.json"))
        }
        let desktop = try TestDesktop.make(store: store, resources: resources), wire = IntegrationWire(beforeUpload: beforeUpload, failStatePublish: failStatePublish)
        await desktop.start(transport: wire)
        do { try await body(desktop, wire, root); await desktop.stop() }
        catch { await desktop.stop(); throw error }
    }
    private func call(_ desktop: Desktop, _ name: String, _ args: [String: Value]) async throws -> Value {
        try await desktop.call(id: .string(UUID().uuidString), name: name, arguments: args)
    }
    private func code(_ value: Value) -> String? {
        value.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["code"]?.stringValue
    }
    private func ok(_ value: Value, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotEqual(value.objectValue?["isError"], true, value.description, file: file, line: line)
    }
    private func latest(_ desktop: Desktop, tool: String) async throws -> AuditEntry {
        let entries = try await desktop.audit(before: nil, limit: 100)
        return try XCTUnwrap(entries.first { $0.tool == tool && $0.result == "ok" && $0.undo != nil && $0.undoneAt == nil })
    }
    func testI9PinnedManifestMatchesNativeContract() throws {
        var repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: repository.appendingPathComponent("integrations/contracts/desktop-tools.v1.json").path), repository.path != "/" { repository.deleteLastPathComponent() }
        let source = try Data(contentsOf: repository.appendingPathComponent("integrations/contracts/desktop-tools.v1.json"))
        let bundled = try Data(contentsOf: XCTUnwrap(Bundle.module.url(forResource: "desktop-tools.v1", withExtension: "json")))
        expectEqual(source, bundled)
        let pin = "1e11cfdba142bee678fddb82a4ad8484f8274be408ef8221ed44ef35e9434d68"
        expectEqual(SHA256.hash(data: bundled).map { String(format: "%02x", $0) }.joined(), pin)
        expectEqual(try JSONDecoder().decode(Value.self, from: source).objectValue?["tools"], .array(try ToolContract().tools))
    }
    func testI5ChangedAuthorizedRootsReplaceNativeScope() async throws {
        try await fixture { desktop, _, root in
            let a = root.appendingPathComponent("A"), b = root.appendingPathComponent("B")
            for folder in [a, b] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
            let old = a.appendingPathComponent("old.txt"), current = b.appendingPathComponent("new.txt")
            try Data("old root".utf8).write(to: old); try Data("new root".utf8).write(to: current)
            let folder = try await desktop.authorize(folder: a, write: true)
            ok(try await call(desktop, "read_text_file", ["path": .string(old.path)]))
            try await desktop.remove(folder: folder.id)
            _ = try await desktop.authorize(folder: b, write: true)
            ok(try await call(desktop, "read_text_file", ["path": .string(current.path)]))
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(old.path)])), "GUARD_PATH_NOT_AUTHORIZED")
        }
    }
    func testI7NativeOwnerFileLoopAndUndo() async throws {
        try await fixture() { desktop, _, root in
            let folder = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let created = folder.appendingPathComponent("created-" + UUID().uuidString)
            ok(try await call(desktop, "create_directory", ["path": .string(created.path)]))
            expectTrue(FileManager.default.fileExists(atPath: created.path))
            let creation = try await latest(desktop, tool: "create_directory"); try await desktop.undo(creation.id)
            expectFalse(FileManager.default.fileExists(atPath: created.path))
            let path = folder.appendingPathComponent("note-" + UUID().uuidString + ".txt"), moved = folder.appendingPathComponent("moved.txt")
            ok(try await call(desktop, "write_file", ["path": .string(path.path), "content": "before\n"]))
            ok(try await call(desktop, "write_file", ["path": .string(path.path), "content": "after\n"]))
            let overwrite = try await latest(desktop, tool: "write_file")
            expectEqual(try String(contentsOf: path, encoding: .utf8), "after\n")
            try await desktop.undo(overwrite.id)
            expectEqual(try String(contentsOf: path, encoding: .utf8), "before\n")
            ok(try await call(desktop, "edit_file", ["path": .string(path.path), "edits": [["oldText": "before", "newText": "edited"]]]))
            expectEqual(try String(contentsOf: path, encoding: .utf8), "edited\n")
            let edit = try await latest(desktop, tool: "edit_file"); try await desktop.undo(edit.id)
            expectEqual(try String(contentsOf: path, encoding: .utf8), "before\n")
            ok(try await call(desktop, "move_file", ["source": .string(path.path), "destination": .string(moved.path)]))
            expectFalse(FileManager.default.fileExists(atPath: path.path))
            let move = try await latest(desktop, tool: "move_file"); try await desktop.undo(move.id)
            expectEqual(try String(contentsOf: path, encoding: .utf8), "before\n")
            let entries = try await desktop.audit(before: nil, limit: 100)
            expectTrue(entries.contains { $0.tool == "undo" && $0.result == "ok" })
            let allowed = await desktop.folders().first!; try await desktop.setWrite(false, folder: allowed.id)
            expectEqual(code(try await call(desktop, "write_file", ["path": .string(path.path), "content": "denied"])), "GUARD_PATH_NOT_AUTHORIZED")
            try await desktop.remove(folder: allowed.id)
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(path.path)])), "GUARD_PATH_NOT_AUTHORIZED")
        }
    }
    func testC63ConcurrentOverwritesKeepSerializedUndoHistory() async throws {
        try await fixture() { desktop, _, root in
            let folder = root.appendingPathComponent("concurrent-work")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let file = folder.appendingPathComponent("shared.txt")
            try Data("zero".utf8).write(to: file)
            async let first = call(desktop, "write_file", ["path": .string(file.path), "content": "first"])
            async let second = call(desktop, "write_file", ["path": .string(file.path), "content": "second"])
            let results = try await (first, second); ok(results.0); ok(results.1)
            let final = try String(contentsOf: file, encoding: .utf8)
            expectTrue(["first", "second"].contains(final))
            let writes = try await desktop.audit(before: nil, limit: 100).filter { $0.tool == "write_file" && $0.result == "ok" }
            expectEqual(writes.count, 2)
            let newest = try XCTUnwrap(writes.first), older = try XCTUnwrap(writes.last)
            expectEqual(newest.undo, .overwrite); expectEqual(older.undo, .overwrite)
            try await desktop.undo(newest.id)
            expectEqual(try String(contentsOf: file, encoding: .utf8), final == "first" ? "second" : "first")
            try await desktop.undo(older.id)
            expectEqual(try String(contentsOf: file, encoding: .utf8), "zero")
        }
    }
    func testI5I9ListingsHideSensitiveEntriesAndCappedResultsAreExplicit() async throws {
        try await fixture() { desktop, _, root in
            let folder = root.appendingPathComponent("listing")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for index in 0..<505 { try Data("x".utf8).write(to: folder.appendingPathComponent(String(format: "file-%03d.txt", index))) }
            try Data("sensitive".utf8).write(to: folder.appendingPathComponent(".env"))
            try Data("padding".utf8).write(to: folder.appendingPathComponent(".env "))
            try Data("emoji".utf8).write(to: folder.appendingPathComponent("😀report.txt"))
            let privateFolder = folder.appendingPathComponent(".ssh")
            try FileManager.default.createDirectory(at: privateFolder, withIntermediateDirectories: true)
            try Data("sensitive".utf8).write(to: privateFolder.appendingPathComponent("hidden.txt"))
            _ = try await desktop.authorize(folder: folder, write: true)
            for name in ["list_directory", "list_directory_with_sizes", "search_files"] {
                var args: [String: Value] = ["path": .string(folder.path)]
                if name == "search_files" { args["pattern"] = "**/*" }
                let result = try await call(desktop, name, args); ok(result)
                let body = try XCTUnwrap(result.objectValue?["structuredContent"]?.objectValue)
                expectEqual(body["truncated"], true)
                let text = try XCTUnwrap(body["content"]?.stringValue)
                let lines = text.components(separatedBy: "\n")
                let entries = name == "search_files" ? lines.filter { !$0.isEmpty } : lines.filter { $0.hasPrefix("[FILE]") || $0.hasPrefix("[DIR]") }
                expectEqual(entries.count, 500)
                expectFalse(text.components(separatedBy: "\n").contains("[FILE] .env")); expectFalse(text.contains(".ssh")); expectFalse(text.contains("hidden.txt"))
            }
            let fractional = try await call(desktop, "find_files", ["folder": .string(folder.path), "limit": 1, "modified_after": "2000-01-01T00:00:00.001Z"])
            ok(fractional)
        }
    }
    func testC63NativePermissionErrorsHaveStructuredChineseHint() async throws {
        try await fixture() { desktop, _, root in
            let folder = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("unreadable.txt")
            try Data("protected".utf8).write(to: file)
            _ = try await desktop.authorize(folder: folder, write: true)
            try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
            let result = try await call(desktop, "read_text_file", ["path": .string(file.path)])
            expectEqual(code(result), "GUARD_PERMISSION_REQUIRED")
            let text = result.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"]?.stringValue ?? ""
            expectTrue(text.contains("这件事要先在电脑上允许依米访问"))
        }
    }
    func testC63PersistedRateLimitRefusesBeforeTheSecondRead() async throws {
        var config = GuardConfig(); config.rates.reads_per_minute = 1
        try await fixture(config: config) { desktop, _, _ in
            ok(try await call(desktop, "list_allowed_directories", [:]))
            let limited = try await call(desktop, "list_allowed_directories", [:])
            expectEqual(code(limited), "GUARD_RATE_LIMITED")
            expectEqual(limited.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["retry_after_s"], 60)
        }
    }
    func testA64GrantExpiryPublishesTheVisibleAuthorizationChange() async throws {
        var config = GuardConfig(); config.desktop.attachments.grant_ttl_h = 0.2 / 3600
        try await fixture(config: config) { desktop, _, root in
            let stream = desktop.subscribe()
            let changes = Task {
                var count = 0
                for await event in stream { if event == .grantsChanged { count += 1; if count == 2 { return } } }
            }
            let file = root.appendingPathComponent("temporary.txt"); try Data("given".utf8).write(to: file)
            _ = try await desktop.grant(files: [file], via: .paste)
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { await changes.value }
                group.addTask { try await Task.sleep(for: .seconds(2)); throw DesktopError.unavailable }
                defer { group.cancelAll(); changes.cancel() }
                _ = try await group.next()
            }
            expectTrue(await desktop.grants().isEmpty)
        }
    }
    func testA64PerFileGrantMatrixAndIdentityReplacement() async throws {
        try await fixture { desktop, _, root in
            let folder = root.appendingPathComponent("Library/Mobile Documents/cloud")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("given.txt"), sibling = folder.appendingPathComponent("sibling.txt")
            try Data("given".utf8).write(to: file); try Data("private".utf8).write(to: sibling)
            let grant = try await desktop.grant(files: [file], via: .paste).first!
            ok(try await call(desktop, "read_text_file", ["path": .string(file.path)]))
            expectEqual(code(try await call(desktop, "write_file", ["path": .string(file.path), "content": "changed"])), "GUARD_TYPE_UNSUPPORTED")
            expectEqual(try String(contentsOf: file, encoding: .utf8), "given")
            for (name, args) in [("read_text_file", ["path": Value.string(sibling.path)]),
                                 ("write_file", ["path": .string(folder.appendingPathComponent("new.txt").path), "content": "no"]),
                                 ("move_file", ["source": .string(file.path), "destination": .string(sibling.path)])] {
                expectEqual(code(try await call(desktop, name, args)), "GUARD_PATH_NOT_AUTHORIZED")
            }
            let replacement = root.appendingPathComponent("replacement.txt")
            try Data("replacement".utf8).write(to: replacement)
            try FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: replacement, to: file)
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(file.path)])), "GUARD_PATH_NOT_AUTHORIZED")
            do { try await desktop.revoke(grant: grant.id); XCTFail("Observed invalid grant must already be retired") }
            catch let error as ToolFailure { expectEqual(error.code, "GUARD_NOT_FOUND") }
            expectTrue(await desktop.grants().isEmpty)
            for name in [".env"] {
                let sensitive = folder.appendingPathComponent(name)
                try Data("secret".utf8).write(to: sensitive)
                do { _ = try await desktop.grant(files: [sensitive], via: .drag); XCTFail("Sensitive grant accepted") }
                catch let error as ToolFailure { expectEqual(error.code, "GUARD_SENSITIVE_PATH") }
            }
            expectFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("new.txt").path))
            do { _ = try await desktop.grant(files: [folder], via: .drag); XCTFail("Folder attachment accepted") }
            catch let error as DesktopError { if case .notAFile = error {} else { XCTFail("Unexpected folder error") } }

        }
        var expired = GuardConfig(); expired.desktop.attachments.grant_ttl_h = 0
        try await fixture(config: expired) { desktop, _, root in
            let file = root.appendingPathComponent("expired.txt"); try Data("expired".utf8).write(to: file)
            _ = try await desktop.grant(files: [file], via: .drag)
            expectTrue(await desktop.grants().isEmpty)
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(file.path)])), "GUARD_PATH_NOT_AUTHORIZED")
        }
    }
    func testRelayAcknowledgementPublishesCurrentPauseAndClearsOnLifecycleEnd() async throws {
        try await fixture { desktop, wire, _ in
            await desktop.pause(.manual)
            // Consume the local change: the relay may not yet have its handler attached.
            _ = try await wire.next(method: "notifications/paios/state", paused: true)
            var events = desktop.subscribe().makeAsyncIterator()
            try wire.feed(["id": "init", "method": "initialize", "params": [
                "protocolVersion": "2025-11-25", "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]])
            let initializing = await events.next()
            XCTAssertEqual(initializing, .ready(false))
            _ = try await wire.next(id: "init")
            try wire.feed(["method": "notifications/paios/ready", "params": ["ready": true]])
            let ready = await events.next()
            XCTAssertEqual(ready, .ready(true))
            _ = try await wire.next(method: "notifications/paios/state", paused: true)
            // A new handshake immediately retires the previous relay confirmation.
            try wire.feed(["id": "reinit", "method": "initialize", "params": [
                "protocolVersion": "2025-11-25", "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]])
            let reinitializing = await events.next()
            XCTAssertEqual(reinitializing, .ready(false))
            _ = try await wire.next(id: "reinit")
            try wire.feed(["method": "notifications/paios/ready", "params": ["ready": true]])
            let reconnected = await events.next()
            XCTAssertEqual(reconnected, .ready(true))
            wire.finishFrames()
            let ended = await events.next()
            XCTAssertEqual(ended, .ready(false))
        }
    }
    func testRetiredQueuedIncomingFileIsDiscardedBeforeStaging() async throws {
        try await fixture { desktop, _, root in
            let file = root.appendingPathComponent("old-download")
            try Data("old".utf8).write(to: file)
            let incoming = DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": "dt-00000000-0000-7000-8000-000000000001",
                "name": "old.txt", "size": "3", "sha256": String(repeating: "0", count: 64), "request": "old-call"],
                file: file, completion: {}, abort: {}, current: { false })
            await desktop.received(incoming)
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        }
    }
    func testFreshInitializeRetiresPendingIncomingBeforeResponding() async throws {
        try await fixture { desktop, wire, root in
            let file = root.appendingPathComponent("pending-download")
            try Data("old".utf8).write(to: file)
            await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": "dt-00000000-0000-7000-8000-000000000001",
                "name": "old.txt", "size": "3", "sha256": String(repeating: "0", count: 64), "request": "old-call"],
                file: file, completion: {}, abort: {}))
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
            try wire.feed(["id": "fresh-initialize", "method": "initialize", "params": ["protocolVersion": "2025-11-25",
                "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]])
            _ = try await wire.next(id: "fresh-initialize")
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "old download must be retired before the fresh handshake completes")
        }
    }
    func testFailedPauseAndReadinessPublicationKeepLocalPauseAndReceiver() async throws {
        try await fixture(failStatePublish: true) { desktop, wire, _ in
            var events = desktop.subscribe().makeAsyncIterator()
            await desktop.pause(.manual)
            let pause = await events.next(), readiness = await events.next()
            XCTAssertEqual(pause, .pause(PauseState(reasons: [.manual])))
            XCTAssertEqual(readiness, .ready(false))
            let retainedPause = await desktop.pauseState()
            XCTAssertTrue(retainedPause.paused)
            try wire.feed(["method": "notifications/paios/ready", "params": ["ready": true]])
            try wire.feed(["id": "fresh-initialize", "method": "initialize", "params": ["protocolVersion": "2025-11-25",
                "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]])
            _ = try await wire.next(id: "fresh-initialize")
            let recoveredPause = await desktop.pauseState()
            XCTAssertTrue(recoveredPause.paused)
        }
    }
    func testI13ManualAndPhonePauseUseOneState() async throws {
        try await fixture { desktop, wire, _ in
            await desktop.pause(.manual)
            expectEqual(await desktop.pauseState().reasons, [.manual])
            await desktop.resume(.phone)
            var state = await desktop.pauseState(); expectFalse(state.paused)
            try wire.feed(["method": "notifications/paios/pause", "params": ["paused": true]])
            try wire.feed(["id": "phone-paused", "method": "ping"])
            _ = try await wire.next(id: "phone-paused")
            state = await desktop.pauseState(); expectTrue(state.reasons.contains(.phone))
            expectEqual(code(try await call(desktop, "list_allowed_directories", [:])), "DESKTOP_PAUSED")
            try wire.feed(["method": "notifications/paios/pause", "params": ["paused": false]])
            try wire.feed(["id": "phone-resumed", "method": "ping"])
            _ = try await wire.next(id: "phone-resumed")
            expectFalse(await desktop.pauseState().paused)
        }
    }
    func testScreenSharingDoesNotCancelAnActiveUpload() async throws {
        let started = expectation(description: "upload started")
        let release = AsyncStream<Void>.makeStream()
        defer { release.continuation.finish() }
        try await fixture(beforeUpload: {
            started.fulfill()
            for await _ in release.stream { break }
            try Task.checkCancellation()
        }) { desktop, wire, root in
            let folder = root.appendingPathComponent("sharing-work")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let file = folder.appendingPathComponent("note.txt")
            try Data("keep uploading".utf8).write(to: file)
            try wire.feed(["id": "sharing-upload", "method": "tools/call", "params": ["name": "upload_to_workshop", "arguments": ["path": .string(file.path)]]])
            await fulfillment(of: [started], timeout: 5)
            await desktop.pause(.screenShare)
            await desktop.resume(.screenShare)
            expectFalse(await desktop.pauseState().paused)
            release.continuation.yield(())
            let response = try await wire.next(id: "sharing-upload")
            ok(try XCTUnwrap(response.objectValue?["result"]))
        }
    }
    func testI13PauseCancelsTransfersWithinOneSecondAndKeepsProtocolLive() async throws {
        let uploadStarted = expectation(description: "upload started"), uploadCancelled = expectation(description: "upload cancelled")
        let beforeUpload: @Sendable () async throws -> Void = {
            try await withTaskCancellationHandler(operation: {
                uploadStarted.fulfill(); try await Task.sleep(nanoseconds: 30_000_000_000)
            }, onCancel: { uploadCancelled.fulfill() })
        }
        try await fixture(beforeUpload: beforeUpload) { desktop, wire, root in
            let folder = root.appendingPathComponent("pause-work"); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let source = folder.appendingPathComponent("original.txt"); try Data("still here".utf8).write(to: source)
            try wire.feed(["id": "upload-paused", "method": "tools/call", "params": ["name": "upload_to_workshop", "arguments": ["path": .string(source.path)]]])
            await fulfillment(of: [uploadStarted], timeout: 5)
            await desktop.pause(.manual)
            await fulfillment(of: [uploadCancelled], timeout: 1)
            try wire.feed(["id": "chat-ping", "method": "ping"])
            _ = try await wire.next(id: "chat-ping")
            try wire.feed(["id": "paused-read", "method": "tools/call", "params": ["name": "list_allowed_directories", "arguments": [:]]])
            let paused = try await wire.next(id: "paused-read")
            expectEqual(code(paused.objectValue!["result"]!), "DESKTOP_PAUSED")
            await desktop.resume(.phone)
            let started = expectation(description: "download completion started"), cancelled = expectation(description: "download completion cancelled")
            let payload = Data("new data".utf8), transfer = "dt-" + auditID()
            let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            let incoming = root.appendingPathComponent("incoming-pause"); try payload.write(to: incoming)
            wire.deliver(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": transfer, "name": "new.txt", "size": String(payload.count), "sha256": sha, "request": "save-paused"], file: incoming, completion: {
                try await withTaskCancellationHandler(operation: {
                    started.fulfill(); try await Task.sleep(nanoseconds: 30_000_000_000)
                }, onCancel: { cancelled.fulfill() })
            }, abort: {}))
            let args: Value = ["workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/new.txt"), "folder": .string(folder.path), "name": "new.txt",
                               "_transfer": ["transfer_id": .string(transfer), "size": .int(payload.count), "sha256": .string(sha)]]
            try wire.feed(["id": "save-paused", "method": "tools/call", "params": ["name": "save_from_workshop", "arguments": args]])
            await fulfillment(of: [started], timeout: 5)
            await desktop.pause(.phone)
            await fulfillment(of: [cancelled], timeout: 1)
            try wire.feed(["id": "chat-still-live", "method": "ping"])
            _ = try await wire.next(id: "chat-still-live")
            expectFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("new.txt").path))
            expectEqual(try String(contentsOf: source, encoding: .utf8), "still here")
            await desktop.resume(.manual)
            ok(try await call(desktop, "list_allowed_directories", [:]))
            let granted = try await desktop.grant(files: [source], via: .drag)
            for grant in granted { try await desktop.revoke(grant: grant.id) }
            _ = try await desktop.authorize(folder: folder, write: true)
            ok(try await call(desktop, "write_file", ["path": .string(source.path), "content": "writer gate released"]))
            expectEqual(try String(contentsOf: source, encoding: .utf8), "writer gate released")
        }
    }
    func testI8TrashConsentDeclineAcceptReuseResetAndUndo() async throws {
        try await fixture { desktop, wire, root in
            let folder = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let file = folder.appendingPathComponent("trash-" + UUID().uuidString + ".txt")
            try Data("synthetic trash fixture".utf8).write(to: file)
            func submit(_ id: String) throws {
                try wire.feed(["id": .string(id), "method": "tools/call", "params": ["name": "trash", "arguments": ["paths": [.string(file.path)]]]])
            }
            try submit("decline")
            var approval = try await wire.next(method: "elicitation/create")
            expectEqual(approval.objectValue?["params"]?.objectValue?["_meta"]?.objectValue?["paios/relatedRequestId"], "decline")
            try wire.feed(["id": approval.objectValue!["id"]!, "result": ["action": "decline"]])
            let declined = try await wire.next(id: "decline")
            expectEqual(code(declined.objectValue!["result"]!), "GUARD_CONSENT_DENIED")
            expectTrue(FileManager.default.fileExists(atPath: file.path))
            try submit("accept")
            approval = try await wire.next(method: "elicitation/create")
            try wire.feed(["id": approval.objectValue!["id"]!, "result": ["action": "accept", "content": [:]]])
            let accepted = try await wire.next(id: "accept"); ok(accepted.objectValue!["result"]!)
            expectFalse(FileManager.default.fileExists(atPath: file.path))
            var trash = try await latest(desktop, tool: "trash"); try await desktop.undo(trash.id)
            expectEqual(try String(contentsOf: file, encoding: .utf8), "synthetic trash fixture")
            try submit("reuse")
            let reused = try await wire.next(id: "reuse"); ok(reused.objectValue!["result"]!)
            trash = try await latest(desktop, tool: "trash"); try await desktop.undo(trash.id)
            try await desktop.resetTrashConsent()
            try submit("reset")
            approval = try await wire.next(method: "elicitation/create")
            try wire.feed(["id": approval.objectValue!["id"]!, "result": ["action": "cancel"]])
            let reset = try await wire.next(id: "reset")
            expectEqual(code(reset.objectValue!["result"]!), "GUARD_CONSENT_DENIED")
            let config = try JSONDecoder().decode(GuardConfig.self, from: Data(contentsOf: root.appendingPathComponent("state/guard.json")))
            XCTAssertNil(config.consents["trash"])
            try wire.feed(["id": "consent-still-live", "method": "ping"])
            _ = try await wire.next(id: "consent-still-live")
            expectTrue(FileManager.default.fileExists(atPath: file.path))
        }
    }
    func testA64GrantedFileTrashUndoRestoresDataWithoutReactivatingGrant() async throws {
        try await fixture { desktop, wire, root in
            let file = root.appendingPathComponent("given.txt")
            try Data("handed-over data".utf8).write(to: file)
            let grant = try await desktop.grant(files: [file], via: .drag)[0]
            try wire.feed(["id": "granted-trash", "method": "tools/call", "params": ["name": "trash", "arguments": ["paths": [.string(file.path)]]]])
            let approval = try await wire.next(method: "elicitation/create")
            expectEqual(approval.objectValue?["params"]?.objectValue?["_meta"]?.objectValue?["paios/relatedRequestId"], "granted-trash")
            try wire.feed(["id": approval.objectValue!["id"]!, "result": ["action": "accept", "content": [:]]])
            let trashed = try await wire.next(id: "granted-trash"); ok(trashed.objectValue!["result"]!)
            expectFalse(FileManager.default.fileExists(atPath: file.path))
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(file.path)])), "GUARD_PATH_NOT_AUTHORIZED")
            expectFalse(await desktop.grants().contains { $0.id == grant.id })
            let row = try await latest(desktop, tool: "trash")
            try await desktop.undo(row.id)
            expectEqual(try String(contentsOf: file, encoding: .utf8), "handed-over data")
            expectEqual(code(try await call(desktop, "read_text_file", ["path": .string(file.path)])), "GUARD_PATH_NOT_AUTHORIZED")
            await desktop.stop()
            let reopened = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused-resources"))
            await reopened.start(transport: IntegrationWire())
            do {
                expectFalse(await reopened.grants().contains { $0.id == grant.id })
                expectEqual(code(try await call(reopened, "read_text_file", ["path": .string(file.path)])), "GUARD_PATH_NOT_AUTHORIZED")
                _ = try await reopened.grant(files: [file], via: .paste)
                ok(try await call(reopened, "read_text_file", ["path": .string(file.path)]))
                await reopened.stop()
            } catch { await reopened.stop(); throw error }
        }
    }
    func testI11TransfersStreamPayloadAndVerifyBeforeOverwrite() async throws {
        try await fixture { desktop, wire, root in
            let folder = root.appendingPathComponent("output"); try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = try await desktop.authorize(folder: folder, write: true)
            let target = folder.appendingPathComponent("report.txt"), payload = Data("fresh report".utf8)
            try Data("original report".utf8).write(to: target)
            let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            let transferIDs = Dictionary(uniqueKeysWithValues: ["bad", "bad-new", "good"].map { ($0, "dt-" + auditID()) })
            func incoming(_ id: String, bytes: Data) throws -> DesktopIncomingFile {
                let file = root.appendingPathComponent("incoming-" + id); try bytes.write(to: file)
                return DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": transferIDs[id]!, "name": "report.txt", "size": String(payload.count), "sha256": digest, "request": id], file: file, completion: { await wire.observations.complete() }, abort: {})
            }
            func arguments(_ id: String, name: String = "report.txt") -> [String: Value] {
                ["workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/report.txt"), "folder": .string(folder.path), "name": .string(name),
                 "_transfer": ["transfer_id": .string(transferIDs[id]!), "size": .int(payload.count), "sha256": .string(digest)]]
            }
            wire.deliver(try incoming("bad", bytes: Data("bad payload!".utf8)))
            let bad = try await desktop.call(id: "bad", name: "save_from_workshop", arguments: arguments("bad"))
            expectEqual(code(bad), "TRANSFER_INTEGRITY")
            expectEqual(try String(contentsOf: target, encoding: .utf8), "original report")
            wire.deliver(try incoming("bad-new", bytes: Data("bad payload!".utf8)))
            let absent = try await desktop.call(id: "bad-new", name: "save_from_workshop", arguments: arguments("bad-new", name: "absent.txt"))
            expectEqual(code(absent), "TRANSFER_INTEGRITY")
            expectFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("absent.txt").path))
            wire.deliver(try incoming("good", bytes: payload))
            ok(try await desktop.call(id: "good", name: "save_from_workshop", arguments: arguments("good")))
            expectEqual(try Data(contentsOf: target), payload)
            let save = try await latest(desktop, tool: "save_from_workshop"); try await desktop.undo(save.id)
            expectEqual(try String(contentsOf: target, encoding: .utf8), "original report")
            let source = folder.appendingPathComponent("stream.bin")
            FileManager.default.createFile(atPath: source.path, contents: nil)
            let handle = try FileHandle(forWritingTo: source), chunk = Data(repeating: 0x5a, count: 65_536)
            var expected = SHA256()
            for _ in 0..<17 { try handle.write(contentsOf: chunk); expected.update(data: chunk) }; try handle.close()
            ok(try await call(desktop, "upload_to_workshop", ["path": .string(source.path)]))
            let observation = await wire.observations.upload
            expectEqual(observation?.bytes, 17 * 65_536)
            expectEqual(observation?.sha, expected.finalize().map { String(format: "%02x", $0) }.joined())
            XCTAssertLessThanOrEqual(observation?.maxChunk ?? Int.max, 65_536)
            expectEqual(await wire.observations.completions, 3)
        }
    }
    private func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual, expected, message, file: file, line: line)
    }
    private func expectTrue(_ actual: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertTrue(actual, file: file, line: line) }
    private func expectFalse(_ actual: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertFalse(actual, file: file, line: line) }
}
private actor TransferObservations {
    struct Upload { let bytes: Int; let sha: String; let maxChunk: Int }
    var upload: Upload?
    var completions = 0
    func complete() { completions += 1 }
    func record(_ value: Upload) { upload = value }
}
private final class IntegrationWire: DesktopTransport, @unchecked Sendable {
    let auditDeviceID: String? = "mac-integration-fixture"
    private let input = AsyncStream<DesktopFrame>.makeStream()
    private let responseLock = NSLock()
    private var responses: [Value] = []
    private var consumed = Set<Int>()
    private let files = AsyncStream<DesktopIncomingFile>.makeStream()
    let observations = TransferObservations()
    private let beforeUpload: (@Sendable () async throws -> Void)?
    private let failStatePublish: Bool
    init(beforeUpload: (@Sendable () async throws -> Void)? = nil, failStatePublish: Bool = false) {
        self.beforeUpload = beforeUpload; self.failStatePublish = failStatePublish
    }
    func frames() -> AsyncStream<DesktopFrame> { input.stream }
    func finishFrames() { input.continuation.finish() }
    func downloads() -> AsyncStream<DesktopIncomingFile> { files.stream }
    func send(_ frame: Data) async throws {
        let value = try JSONDecoder().decode(Value.self, from: frame)
        if failStatePublish, value.objectValue?["method"] == "notifications/paios/state" { throw DesktopError.unavailable }
        responseLock.withLock { responses.append(value) }
    }
    func deliver(_ file: DesktopIncomingFile) { files.continuation.yield(file) }
    func feed(_ value: Value) throws {
        var object = value.objectValue!; object["jsonrpc"] = "2.0"
        input.continuation.yield(DesktopFrame(try JSONEncoder().encode(Value.object(object))))
    }
    func next(id: Value? = nil, method: String? = nil, paused: Bool? = nil) async throws -> Value {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            try Task.checkCancellation()
            let match: Value? = responseLock.withLock {
                for (index, value) in responses.enumerated() where !consumed.contains(index) {
                    guard let object = value.objectValue else { continue }
                    if let id, object["id"] != id { continue }
                    if let method, object["method"] != .string(method) { continue }
                    if let paused, object["params"]?.objectValue?["paused"] != .bool(paused) { continue }
                    consumed.insert(index)
                    return value
                }
                return nil
            }
            if let match { return match }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw DesktopError.unavailable
    }
    func upload(file: URL, attributes: [String: String]) async throws {
        try await beforeUpload?()
        let reader = try FileHandle(forReadingFrom: file); defer { try? reader.close() }
        var hash = SHA256(), count = 0, maximum = 0
        while let data = try reader.read(upToCount: 65_536), !data.isEmpty {
            try Task.checkCancellation(); hash.update(data: data); count += data.count; maximum = max(maximum, data.count)
        }
        let sha = hash.finalize().map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(attributes["size"], String(count)); XCTAssertEqual(attributes["sha256"], sha)
        await observations.record(.init(bytes: count, sha: sha, maxChunk: maximum))
    }
}
