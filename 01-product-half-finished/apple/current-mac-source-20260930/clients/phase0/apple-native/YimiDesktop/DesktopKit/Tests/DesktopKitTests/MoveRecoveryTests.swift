import Darwin
import Foundation
import XCTest
@testable import DesktopKit

final class MoveRecoveryTests: XCTestCase {
    func testMoveCrashWorker() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let rawPath = environment["YIMI_MOVE_CRASH_ROOT"], let step = environment["YIMI_MOVE_CRASH_STEP"] else { return }
        let path = try GuardPath.canonical(rawPath)
        let root = URL(fileURLWithPath: path), store = try AuditStore(store: root.appendingPathComponent("state"))
        let source = try FileCapability.open(root: path, path: path + "/source")
        let destination = try FileCapability.open(root: path, path: path + "/destination")
        var row = AuditRecord(id: "crash-move", deviceID: "test", requestID: "move", tool: "move_file", toolClass: "write")
        let kind = environment["YIMI_MOVE_KIND"] ?? "move"
        row.undo = UndoRecord(kind: kind, originalPath: source.path, trashPath: kind == "trash" ? destination.path : nil, movedTo: kind == "move" ? destination.path : nil)
        try store.append(row)
        _ = try source.move(to: destination, journal: { movement in
            row.undo?.movement = movement
            try store.append(row)
        }) { point in
            if point == step {
                kill(getpid(), SIGKILL)
                while true { Darwin.pause() }
            }
        }
        XCTFail("Crash checkpoint not reached")
    }
    func testDesktopMoveCrashWorker() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["YIMI_DESKTOP_MOVE_ROOT"], let scenario = environment["YIMI_DESKTOP_MOVE_SCENARIO"] else { return }
        let root = URL(fileURLWithPath: path), desktop = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root)
        let work = root.appendingPathComponent("work"), source = work.appendingPathComponent("source"), destination = work.appendingPathComponent("destination")
        _ = try await desktop.authorize(folder: work, write: true)
        let undoing = scenario.hasPrefix("undo-"), step = scenario.replacingOccurrences(of: "undo-", with: "")
        var entry: String?
        if undoing {
            let result = try await desktop.call(id: .string("initial"), name: "move_file", arguments: ["source": .string(source.path), "destination": .string(destination.path)])
            XCTAssertNotEqual(result.objectValue?["isError"]?.boolValue, true)
            entry = try await desktop.history.records(before: nil, limit: 100).first { $0.tool == "move_file" && $0.result == "ok" }?.id
        }
        await desktop.setFileCheckpoint { point in
            if point == step { kill(getpid(), SIGKILL); while true { Darwin.pause() } }
        }
        if let entry { try await desktop.undo(entry) }
        else { _ = try await desktop.call(id: .string("move"), name: "move_file", arguments: ["source": .string(source.path), "destination": .string(destination.path)]) }
        XCTFail("Desktop movement checkpoint not reached")
    }
    func testDesktopMoveAndUndoCrashRecovery() async throws {
        guard ProcessInfo.processInfo.environment["YIMI_DESKTOP_MOVE_ROOT"] == nil else { return }
        for scenario in ["captured", "delivered", "undo-captured", "undo-delivered"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-move-crash-" + UUID().uuidString)
            let work = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            try Data("original".utf8).write(to: work.appendingPathComponent("source"))
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            child.arguments = ["xctest", "-XCTest", "DesktopKitTests.MoveRecoveryTests/testDesktopMoveCrashWorker", Bundle(for: Self.self).bundlePath]
            var environment = ProcessInfo.processInfo.environment
            environment["YIMI_DESKTOP_MOVE_ROOT"] = root.path; environment["YIMI_DESKTOP_MOVE_SCENARIO"] = scenario
            child.environment = environment
            try child.run(); child.waitUntilExit()
            XCTAssertEqual(child.terminationReason, .uncaughtSignal, scenario); XCTAssertEqual(child.terminationStatus, SIGKILL, scenario)
            let desktop = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root)
            let rows = try await desktop.history.records(before: nil, limit: 100)
            let undoing = scenario.hasPrefix("undo-"), delivered = scenario.hasSuffix("delivered")
            let visible = undoing == delivered ? "source" : "destination"
            XCTAssertEqual(try String(contentsOf: work.appendingPathComponent(visible), encoding: .utf8), "original", scenario)
            let original = try XCTUnwrap(rows.first { $0.tool == "move_file" })
            if undoing { XCTAssertEqual(original.undoneAt != nil, delivered, scenario) }
            else if delivered { try await desktop.undo(original.id); XCTAssertTrue(FileManager.default.fileExists(atPath: work.path + "/source")) }
            _ = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root)
        }
    }
    func testCapturedMoveRecoversAfterSIGKILL() throws { try recover(step: "captured") }
    func testDeliveredMoveRecoversAfterSIGKILL() throws { try recover(step: "delivered") }
    func testPreparedMoveRecoversAfterSIGKILL() throws { try recover(step: "prepared") }
    func testCapturedTrashJournalRecoversAfterSIGKILL() throws { try recover(step: "captured", kind: "trash") }
    func testDeliveredTrashJournalRecoversAfterSIGKILL() throws { try recover(step: "delivered", kind: "trash") }
    func testCapturedDirectoryRecoversAfterSIGKILL() throws { try recover(step: "captured", directory: true) }
    func testDeliveredDirectoryRecoversAfterSIGKILL() throws { try recover(step: "delivered", directory: true) }
    func testCapturedMovePreservesOwnerCollision() throws { try recover(step: "captured", conflict: "source") }
    func testDeliveredMovePreservesOwnerReplacement() throws { try recover(step: "delivered", conflict: "destination") }
    private func recover(step: String, directory: Bool = false, conflict: String? = nil, kind: String = "move") throws {
        guard ProcessInfo.processInfo.environment["YIMI_MOVE_CRASH_ROOT"] == nil else { return }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("move-crash-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source"), destination = root.appendingPathComponent("destination")
        if directory {
            try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
            try Data("original".utf8).write(to: source.appendingPathComponent("child"))
        } else { try Data("original".utf8).write(to: source) }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        child.arguments = ["xctest", "-XCTest", "DesktopKitTests.MoveRecoveryTests/testMoveCrashWorker", Bundle(for: Self.self).bundlePath]
        var environment = ProcessInfo.processInfo.environment
        environment["YIMI_MOVE_CRASH_ROOT"] = root.path; environment["YIMI_MOVE_CRASH_STEP"] = step; environment["YIMI_MOVE_KIND"] = kind
        child.environment = environment
        try child.run(); child.waitUntilExit()
        XCTAssertEqual(child.terminationReason, .uncaughtSignal)
        XCTAssertEqual(child.terminationStatus, SIGKILL)
        if let conflict { try Data("owner replacement".utf8).write(to: root.appendingPathComponent(conflict), options: .atomic) }
        let store = try AuditStore(store: root.appendingPathComponent("state"))
        try FileStage.recoverPending(store)
        var row = try XCTUnwrap(store.record("crash-move"))
        if let conflict {
            XCTAssertEqual(row.result, "error"); XCTAssertEqual(row.errorCode, "GUARD_RECOVERY_REQUIRED")
            XCTAssertNotNil(row.undo?.movement)
            XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(conflict), encoding: .utf8), "owner replacement")
            if conflict == "source" {
                row.at = Date(timeIntervalSinceNow: -100 * 86400)
                var original = AuditRecord(id: "prior-move", at: row.at, deviceID: "test", requestID: "prior", tool: "move_file", toolClass: "write")
                original.result = "ok"; original.undo = UndoRecord(kind: "move", originalPath: source.path, movedTo: destination.path)
                try store.append(original)
                row.undoOf = original.id
                try store.append(row)
                _ = try store.prune(auditDays: 30, undoDays: 7)
                row = try XCTUnwrap(store.record("crash-move"), "Unresolved capture must outlive retention pruning")
                XCTAssertNotNil(try store.record("prior-move")?.undo, "Pending Undo must retain its original audit and identity")
                let held = try XCTUnwrap(row.undo?.movement?.directory)
                XCTAssertEqual(try String(contentsOfFile: held + "/captured", encoding: .utf8), "original")
                try FileManager.default.removeItem(at: source)
                try FileStage.recoverPending(store)
                row = try XCTUnwrap(store.record("crash-move"))
                XCTAssertEqual(row.result, "cancelled"); XCTAssertNil(row.undo?.movement)
                XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "original")
            }
        } else {
            let applied = step == "delivered", visible = applied ? destination : source
            XCTAssertTrue(FileManager.default.fileExists(atPath: visible.path), "Captured source must be restored after restart")
            XCTAssertEqual(try String(contentsOf: directory ? visible.appendingPathComponent("child") : visible, encoding: .utf8), "original")
            XCTAssertEqual(row.result, applied ? "ok" : "cancelled"); XCTAssertNil(row.undo?.movement)
            if applied { XCTAssertNotNil(row.undo?.inode) }
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".yimi-") })
        }
        try FileStage.recoverPending(store)
        XCTAssertEqual(try store.record("crash-move")?.result, row.result)
    }
}
