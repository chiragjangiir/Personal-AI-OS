import Darwin
import Foundation
import CryptoKit
import XCTest
@testable import DesktopKit

final class FileCapabilityTests: XCTestCase {
    private func fixture(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("capability-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root.resolvingSymlinksInPath())
    }
    private func write(_ text: String, _ url: URL) throws { try Data(text.utf8).write(to: url) }
    private func text(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
    private func cap(_ root: URL, _ name: String) throws -> FileCapability { try FileCapability.open(root: GuardPath.canonical(root.path), path: GuardPath.canonical(root.appendingPathComponent(name).path)) }
    private func staged(_ target: FileCapability, text: String) throws -> FileStage {
        let stage = try FileStage(target: target), fd = try stage.fileDescriptor()
        defer { close(fd) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: Data(text.utf8))
        return stage
    }
    func testOverwriteRetainsActualOriginalAndCommitsNewIdentity() throws {
        try fixture { root in
            let target = root.appendingPathComponent("target")
            try write("original", target)
            let original = try cap(root, "target"), stage = try staged(original, text: "replacement")
            let result = try stage.commit()
            XCTAssertNotEqual(FileIdentity(result), FileIdentity(original.info!))
            XCTAssertEqual(try text(target), "replacement")
            XCTAssertEqual(try text(URL(fileURLWithPath: XCTUnwrap(stage.retainedBackupPath))), "original")
        }
    }
    func testReplacementCrashWorker() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["YIMI_REPLACE_CRASH_ROOT"], let stop = environment["YIMI_REPLACE_CRASH_STEP"] else { return }
        let root = URL(fileURLWithPath: path), store = root.appendingPathComponent("state")
        let desktop = try TestDesktop.make(store: store, resources: root)
        let work = root.appendingPathComponent("work")
        _ = try await desktop.authorize(folder: work, write: true)
        if stop.hasPrefix("save-") || stop.hasPrefix("save-foreign-") {
            let checkpoint = stop.replacingOccurrences(of: "save-foreign-", with: "").replacingOccurrences(of: "save-", with: "")
            await desktop.setFileCheckpoint { step in
                if step == checkpoint { kill(getpid(), SIGKILL); while true { Darwin.pause() } }
            }
            let file = root.appendingPathComponent("incoming"), payload = Data("replacement".utf8)
            try payload.write(to: file)
            let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(), id = "dt-" + auditID()
            await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": id, "name": "target", "size": String(payload.count), "sha256": sha, "request": "crash-save"], file: file, completion: {}, abort: {}))
            _ = try await desktop.call(id: "crash-save", name: "save_from_workshop", arguments: [
                "workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/target"),
                "folder": .string(work.path), "name": "target",
                "_transfer": ["transfer_id": .string(id), "size": .int(payload.count), "sha256": .string(sha)]])
            XCTFail("Workshop crash checkpoint was not reached"); return
        }
        let undoing = stop.hasPrefix("undo-")
        let checkpoint = undoing ? String(stop.dropFirst(5)) : (stop.hasPrefix("foreign-") ? String(stop.dropFirst(8)) : stop)
        var undoOf: String?
        if undoing {
            for content in ["middle", "latest"] {
                let result = try await desktop.call(id: .string(content), name: "write_file", arguments: ["path": .string(work.appendingPathComponent("target").path), "content": .string(content)])
                XCTAssertNotEqual(result.objectValue?["isError"]?.boolValue, true)
                XCTAssertEqual(try text(work.appendingPathComponent("target")), content)
            }
            undoOf = try await desktop.audit(before: nil, limit: 100).first { $0.tool == "write_file" && $0.result == "ok" }?.id
        }
        let target = try cap(work, "target"), stage = try staged(target, text: undoing ? "middle" : "replacement")
        var row = AuditRecord(id: "crash-replace", deviceID: "test", requestID: "test", tool: "write_file", toolClass: "write")
        row.paths = [target.path]; row.names = ["target"]; row.count = 1; row.undoOf = undoOf
        if undoing { row.tool = "undo" }
        row.undo = try await desktop.prepareWrite(target, audit: row.id)
        row.undo?.replacement = try stage.replacementRecord()
        try await desktop.recordAudit(row)
        func crash() -> Never {
            kill(getpid(), SIGKILL)
            // Signal delivery can run on another thread; never advance to the next commit step.
            while true { Darwin.pause() }
        }
        let info = try stage.commit { step in
            if step == checkpoint { crash() }
        }
        await desktop.bind(&row, info: info, path: target.path)
        try await desktop.finishBackup(stage, record: &row)
        if checkpoint == "backed-up" { crash() }
        XCTFail("Crash checkpoint was not reached")
    }
    func testSIGKILLRecoveryBeforeAndAfterAtomicReplace() async throws {
        guard ProcessInfo.processInfo.environment["YIMI_REPLACE_CRASH_ROOT"] == nil else { return }
        for step in ["prepared", "swapped", "captured", "backed-up", "undo-prepared", "undo-swapped", "undo-backed-up", "foreign-swapped", "save-prepared", "save-swapped", "save-captured", "save-backed-up", "save-foreign-swapped"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("replace-crash-" + UUID().uuidString).resolvingSymlinksInPath()
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let work = root.appendingPathComponent("work"), target = work.appendingPathComponent("target"), store = root.appendingPathComponent("state")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            try write("original", target)
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            child.arguments = ["xctest", "-XCTest", "DesktopKitTests.FileCapabilityTests/testReplacementCrashWorker", Bundle(for: Self.self).bundlePath]
            var environment = ProcessInfo.processInfo.environment
            environment["YIMI_REPLACE_CRASH_ROOT"] = root.path; environment["YIMI_REPLACE_CRASH_STEP"] = step
            child.environment = environment
            try child.run(); child.waitUntilExit()
            XCTAssertEqual(child.terminationReason, .uncaughtSignal, step)
            XCTAssertEqual(child.terminationStatus, SIGKILL, step)
            let undoing = step.hasPrefix("undo-"), applied = !step.hasSuffix("prepared"), foreign = step.contains("foreign-")
            var expected = undoing ? (applied ? "middle" : "latest") : (applied ? "replacement" : "original")
            XCTAssertEqual(try text(target), expected, "Public path must survive SIGKILL at " + step)
            if step == "captured" || step == "save-captured" {
                // An editor kept the same inode open while the app was down.
                let owner = try FileHandle(forWritingTo: target)
                try owner.truncate(atOffset: 0); try owner.write(contentsOf: Data("owner change".utf8)); try owner.close()
                expected = "owner change"
            }
            if foreign { try Data("owner replacement".utf8).write(to: target, options: .atomic); expected = "owner replacement" }
            let desktop = try TestDesktop.make(store: store, resources: root)
            let audit = try AuditStore(store: store)
            let recovered = try XCTUnwrap(step.hasPrefix("save-") ? audit.records(before: nil, limit: 100).first { $0.tool == "save_from_workshop" } : audit.record("crash-replace"))
            XCTAssertNil(recovered.undo?.replacement)
            XCTAssertEqual(recovered.result, foreign ? "error" : (applied ? "ok" : "cancelled"))
            XCTAssertEqual(try text(target), expected)
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: work.path).contains { $0.hasPrefix(".yimi-") })
            _ = try TestDesktop.make(store: store, resources: root) // Recovery is idempotent on the next launch.
            if foreign {
                XCTAssertEqual(recovered.errorCode, "GUARD_RECOVERY_REQUIRED")
                XCTAssertEqual(try text(URL(fileURLWithPath: XCTUnwrap(recovered.undo?.backupPath))), "original")
            } else if undoing {
                let original = try XCTUnwrap(audit.record(XCTUnwrap(recovered.undoOf)))
                XCTAssertEqual(original.undoneAt != nil, applied)
                if !applied { try await desktop.undo(original.id) }
                let prior = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "write_file" && $0.id != original.id && $0.result == "ok" })
                try await desktop.undo(prior.id)
                XCTAssertEqual(try text(target), "original", "Recovery must rebind the earlier undo chain")
            } else if applied {
                XCTAssertEqual(try text(URL(fileURLWithPath: XCTUnwrap(recovered.undo?.backupPath))), "original")
                if step == "captured" || step == "save-captured" {
                    do { try await desktop.undo(recovered.id); XCTFail("Undo must preserve edits made before recovery") }
                    catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_EXISTS") }
                    XCTAssertEqual(try text(target), "owner change")
                } else {
                    try await desktop.undo(recovered.id)
                    XCTAssertEqual(try text(target), "original", "Recovered commits retain normal undo")
                }
            }
        }
    }
    func testPostSwapFailureIsRecoveredBeforeTheNextWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("replace-failure-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let work = root.appendingPathComponent("work"), target = work.appendingPathComponent("target"), store = root.appendingPathComponent("state")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try write("original", target)
        let desktop = try TestDesktop.make(store: store, resources: root)
        _ = try await desktop.authorize(folder: work, write: true)
        let undo = store.appendingPathComponent("undo")
        await desktop.setInterleave { point in
            if point == "staged" { try Data("backup allocation blocked".utf8).write(to: undo) }
        }
        let failed = try await desktop.call(id: "first", name: "write_file", arguments: ["path": .string(target.path), "content": "replacement"])
        XCTAssertEqual(failed.objectValue?["isError"]?.boolValue, true)
        XCTAssertEqual(try text(target), "replacement")
        let entries = try await desktop.audit(before: nil, limit: 100)
        let failedID = try XCTUnwrap(entries.first { $0.tool == "write_file" }?.id)
        await desktop.setInterleave { _ in }
        try FileManager.default.removeItem(at: undo)
        let next = try await desktop.call(id: "next", name: "write_file", arguments: ["path": .string(target.path), "content": "latest"])
        XCTAssertNotEqual(next.objectValue?["isError"]?.boolValue, true)
        _ = try TestDesktop.make(store: store, resources: root)
        XCTAssertEqual(try text(target), "latest")
        let history = try AuditStore(store: store), recovered = try XCTUnwrap(history.record(failedID))
        XCTAssertEqual(recovered.result, "ok"); XCTAssertNil(recovered.undo?.replacement)
        XCTAssertEqual(try text(URL(fileURLWithPath: XCTUnwrap(recovered.undo?.backupPath))), "original")
    }
    func testWorkshopPostSwapFailureRecoversOnRestartAndBeforeNextWrite() async throws {
        for restart in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("save-failure-" + UUID().uuidString).resolvingSymlinksInPath()
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let work = root.appendingPathComponent("work"), store = root.appendingPathComponent("state")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let target = work.appendingPathComponent("target"), incoming = root.appendingPathComponent("incoming")
            try write("original", target); try write("replacement", incoming)
            let desktop = try TestDesktop.make(store: store, resources: root)
            _ = try await desktop.authorize(folder: work, write: true)
            let undo = store.appendingPathComponent("undo")
            await desktop.setInterleave { point in
                if point == "staged" { try Data("backup allocation blocked".utf8).write(to: undo) }
            }
            let id = "dt-" + auditID(), payload = Data("replacement".utf8)
            let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            await desktop.received(DesktopIncomingFile(attributes: ["v": "1", "dir": "down", "transfer": id, "name": "target", "size": String(payload.count), "sha256": sha, "request": "save"], file: incoming, completion: {}, abort: {}))
            let result = try await desktop.call(id: "save", name: "save_from_workshop", arguments: [
                "workshop_path": .string("/owner/out/" + String(repeating: "a", count: 32) + "/target"),
                "folder": .string(work.path), "name": "target",
                "_transfer": ["transfer_id": .string(id), "size": .int(payload.count), "sha256": .string(sha)]])
            XCTAssertEqual(result.objectValue?["isError"]?.boolValue, true)
            XCTAssertEqual(try text(target), "replacement")
            let audit = try AuditStore(store: store)
            let failed = try XCTUnwrap(audit.records(before: nil, limit: 100).first { $0.tool == "save_from_workshop" })
            XCTAssertNotNil(failed.undo?.replacement, "A post-swap failure must retain its recovery journal")
            try FileManager.default.removeItem(at: undo)
            await desktop.setInterleave { _ in }
            let recoveredDesktop: Desktop
            if restart { recoveredDesktop = try TestDesktop.make(store: store, resources: root) }
            else {
                recoveredDesktop = desktop
                _ = try await desktop.call(id: "next", name: "create_directory", arguments: ["path": .string(work.appendingPathComponent("next").path)])
            }
            let recovered = try XCTUnwrap(audit.record(failed.id))
            XCTAssertEqual(recovered.result, "ok"); XCTAssertNil(recovered.undo?.replacement)
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: work.path).contains { $0.hasPrefix(".yimi-") })
            if recovered.result == "ok" {
                try await recoveredDesktop.undo(failed.id)
                XCTAssertEqual(try text(target), "original")
            }
        }
    }
    func testStagePayloadSubstitutionDoesNotCommitOrDeleteOwnerFile() throws {
        try fixture { root in
            let target = root.appendingPathComponent("target"), owner = root.appendingPathComponent("owner")
            try write("original", target); try write("owner", owner)
            var stage: FileStage? = try staged(cap(root, "target"), text: "replacement")
            let holding = stage!.holding.fd
            XCTAssertEqual(renameat(holding, "payload", holding, "moved-payload"), 0)
            XCTAssertEqual(renameat(AT_FDCWD, owner.path, holding, "payload"), 0)
            XCTAssertThrowsError(try stage!.commit())
            let ownerInStage = root.appendingPathComponent(stage!.temporary).appendingPathComponent("payload")
            stage = nil
            XCTAssertEqual(try text(target), "original")
            XCTAssertEqual(try text(ownerInStage), "owner")
        }
    }
    func testCancellationCleanupNeverTraversesSubstitutedOuterDirectory() throws {
        try fixture { root in
            let owner = root.appendingPathComponent("owner"), moved = root.appendingPathComponent("moved-stage")
            try FileManager.default.createDirectory(at: owner, withIntermediateDirectories: false)
            try write("owner", owner.appendingPathComponent("keep"))
            var stage: FileStage? = try FileStage(target: cap(root, "new-folder"), directory: true)
            let outer = root.appendingPathComponent(stage!.temporary)
            try FileManager.default.moveItem(at: outer, to: moved)
            try FileManager.default.moveItem(at: owner, to: outer)
            stage = nil
            XCTAssertEqual(try text(outer.appendingPathComponent("keep")), "owner")
        }
    }
    func testMoveCollisionRestoresSourceWithoutReplacingDestination() throws {
        try fixture { root in
            let source = root.appendingPathComponent("source"), destination = root.appendingPathComponent("destination")
            try write("source", source)
            let from = try cap(root, "source"), to = try cap(root, "destination")
            try write("destination", destination)
            XCTAssertThrowsError(try from.move(to: to))
            XCTAssertEqual(try text(source), "source")
            XCTAssertEqual(try text(destination), "destination")
        }
    }
    func testMoveRefusesReplacedSourceAndPreservesBothFiles() throws {
        try fixture { root in
            let source = root.appendingPathComponent("source"), moved = root.appendingPathComponent("old-source")
            try write("original", source)
            let from = try cap(root, "source"), to = try cap(root, "destination")
            try FileManager.default.moveItem(at: source, to: moved); try write("substitute", source)
            XCTAssertThrowsError(try from.move(to: to))
            XCTAssertEqual(try text(source), "substitute")
            XCTAssertEqual(try text(moved), "original")
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("destination").path))
        }
    }
}
