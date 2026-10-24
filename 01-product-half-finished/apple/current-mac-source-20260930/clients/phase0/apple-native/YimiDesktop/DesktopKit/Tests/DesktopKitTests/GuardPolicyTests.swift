import Darwin
import Foundation
import MCP
import XCTest
@testable import DesktopKit

final class GuardPolicyTests: XCTestCase {
    private func fixture(_ body: (Desktop, URL, URL, URL) async throws -> Void) async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-policy-\(UUID())")
        let root = base.appendingPathComponent("allowed"), store = base.appendingPathComponent("store")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        let resources = base.appendingPathComponent("unused-resources")
        let desktop = try TestDesktop.make(store: store, resources: resources)
        await desktop.start(transport: RegressionWire())
        do { try await body(desktop, root, store, resources) }
        catch { await desktop.stop(); throw error }
        await desktop.stop()
    }

    private func code(_ result: Value) -> String? {
        result.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["code"]?.stringValue
    }

    func testInterruptedGuardInstallBootsLockedWithoutTrustingEitherConfig() async throws {
        for phase in ["created", "written", "swapped", "finalized", "missing-config", "invalid-config"] {
            try await fixture { desktop, root, store, resources in
                let file = root.appendingPathComponent("owner.txt")
                try Data("owner content".utf8).write(to: file)
                _ = try await desktop.authorize(folder: root, write: true)
                _ = try await desktop.grant(files: [file], via: .paste)
                await desktop.stop()
                let configURL = store.appendingPathComponent("guard.json")
                let original = try Data(contentsOf: configURL)
                let marker = store.appendingPathComponent(".guard-interrupted")
                // Before swap this holds a candidate; after swap it holds a preimage.
                // Neither spelling contains durable evidence of audit finalization.
                try (phase == "created" ? Data() : original).write(to: marker)
                if phase == "missing-config" { try FileManager.default.removeItem(at: configURL) }
                if phase == "invalid-config" { try Data("partial config".utf8).write(to: configURL) }
                let audit = try AuditStore(store: store)
                try audit.append(AuditRecord(deviceID: "test", requestID: "retirement", tool: "retire_file_grant", toolClass: "grant"))
                let diskConfig = try? Data(contentsOf: configURL), diskMarker = try Data(contentsOf: marker)
                for _ in 0..<2 {
                    let reopened = try TestDesktop.make(store: store, resources: resources)
                    await reopened.start(transport: RegressionWire())
                    let folders = await reopened.folders(), grants = await reopened.grants()
                    let reason = await reopened.toolLockReason()
                    XCTAssertNotNil(reason)
                    XCTAssertTrue(folders.isEmpty, phase); XCTAssertTrue(grants.isEmpty, phase)
                    for (name, args) in [("read_text_file", ["path": Value.string(file.path)]),
                                         ("list_allowed_directories", [:])] {
                        let result = try await reopened.call(id: .int(1), name: name, arguments: args)
                        XCTAssertEqual(code(result), "DESKTOP_AUDIT_STORE", phase)
                    }
                    do {
                        _ = try await reopened.authorize(folder: root, write: true)
                        XCTFail("Uncertain permissions must remain locked: \(phase)")
                    } catch let error as ToolFailure { XCTAssertEqual(error.code, "DESKTOP_AUDIT_STORE") }
                    let audit = try await reopened.audit(before: nil, limit: 100)
                    XCTAssertFalse(audit.isEmpty, "Local audit remains available")
                    await reopened.stop()
                    XCTAssertEqual(try? Data(contentsOf: configURL), diskConfig, phase)
                    XCTAssertEqual(try Data(contentsOf: marker), diskMarker, phase)
                }
                XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "owner content")
            }
        }
    }

    func testGuardInstallCrashWorker() throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["YIMI_GUARD_ROOT"], let phase = env["YIMI_GUARD_PHASE"], let operation = env["YIMI_GUARD_OPERATION"] else { return }
        let store = URL(fileURLWithPath: path), audit = try AuditStore(store: store)
        var policy = try GuardPolicy(store: store, audit: audit)
        policy.checkpoint = { point in
            if point == phase { kill(getpid(), SIGKILL); while true { Darwin.pause() } }
        }
        if operation == "quota" { try policy.charge(kind: "read") }
        else {
            var candidate = policy.config
            if operation == "grant" { candidate.folders[0].write = true }
            else { candidate.folders = [] }
            var row = AuditRecord(id: "crash-guard", deviceID: "test", requestID: "guard", tool: operation, toolClass: "grant")
            try audit.append(row)
            try policy.install(candidate) { row.result = "ok"; try audit.append(row) }
        }
        XCTFail("Guard crash checkpoint not reached")
    }

    func testRealGuardInstallRecoversCreationWriteSwapAuditAndUnlinkCrashes() async throws {
        for operation in ["grant", "revoke", "quota"] {
            for phase in ["created", "written", "swapped", "audited", "unlinked"] {
                try await fixture { desktop, root, store, resources in
                    let folder = try await desktop.authorize(folder: root, write: false)
                    await desktop.stop()
                    let child = Process()
                    child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
                    child.arguments = ["xctest", "-XCTest", "DesktopKitTests.GuardPolicyTests/testGuardInstallCrashWorker", Bundle(for: Self.self).bundlePath]
                    var environment = ProcessInfo.processInfo.environment
                    environment["YIMI_GUARD_ROOT"] = store.path; environment["YIMI_GUARD_PHASE"] = phase
                    environment["YIMI_GUARD_OPERATION"] = operation; child.environment = environment
                    try child.run(); child.waitUntilExit()
                    XCTAssertEqual(child.terminationReason, .uncaughtSignal); XCTAssertEqual(child.terminationStatus, SIGKILL)
                    let committed = phase == "audited" || phase == "unlinked"
                    let reopened = try TestDesktop.make(store: store, resources: resources)
                    let folders = await reopened.folders(), reason = await reopened.toolLockReason()
                    XCTAssertNil(reason, "\(operation) / \(phase)")
                    if operation == "revoke" && committed { XCTAssertTrue(folders.isEmpty) }
                    else { XCTAssertEqual(folders.first?.id, folder.id); XCTAssertEqual(folders.first?.write, operation == "grant" && committed) }
                    let audit = try AuditStore(store: store), policy = try GuardPolicy(store: store, audit: audit)
                    XCTAssertFalse(policy.poisoned)
                    XCTAssertEqual(policy.config.usage.count, operation == "quota" && committed ? 1 : 0)
                    if operation != "quota" { XCTAssertEqual(try audit.record("crash-guard")?.result == "ok", committed) }
                    XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: store.path).contains { $0.hasPrefix(".guard-") })
                    await reopened.stop()
                    _ = try TestDesktop.make(store: store, resources: resources)
                }
            }
        }
    }

    func testUnsafeOrUnmatchedV2MarkerNeverPublishesAuthorization() async throws {
        for kind in ["mismatched", "multiple", "symlink", "hardlink"] {
            try await fixture { desktop, root, store, resources in
                await desktop.stop()
                let audit = try AuditStore(store: store), id = UUID().uuidString
                var expanded = GuardConfig(); expanded.folders = [.init(id: root.path, label: "allowed", write: true)]
                try audit.setGuardJournal(JSONEncoder().encode(GuardPolicy.Journal(id: id, config: expanded, committed: true)))
                let marker = store.appendingPathComponent(".guard-v2-" + (kind == "mismatched" ? "other" : id))
                let original = root.appendingPathComponent("original.txt")
                try Data("owner content".utf8).write(to: original)
                if kind == "symlink" { try FileManager.default.createSymbolicLink(at: marker, withDestinationURL: original) }
                else if kind == "hardlink" { try FileManager.default.linkItem(at: original, to: marker) }
                else { try Data().write(to: marker) }
                if kind == "multiple" { try Data().write(to: store.appendingPathComponent(".guard-legacy")) }
                let reopened = try TestDesktop.make(store: store, resources: resources)
                let folders = await reopened.folders(), reason = await reopened.toolLockReason()
                XCTAssertTrue(folders.isEmpty); XCTAssertNotNil(reason)
                XCTAssertEqual(try String(contentsOf: original, encoding: .utf8), "owner content")
                await reopened.stop()
            }
        }
    }

    func testInstallAuditFailureRestoresCommittedPreimage() async throws {
        try await fixture { desktop, root, store, _ in
            _ = try await desktop.authorize(folder: root, write: false)
            await desktop.stop()
            let audit = try AuditStore(store: store)
            var policy = try GuardPolicy(store: store, audit: audit)
            let before = try Data(contentsOf: policy.file)
            var candidate = policy.config; candidate.folders[0].write = true
            XCTAssertThrowsError(try policy.install(candidate) { throw ToolFailure("DESKTOP_AUDIT_STORE", "fixture") })
            XCTAssertEqual(try Data(contentsOf: policy.file), before)
            XCTAssertFalse(policy.config.folders[0].write)
            XCTAssertFalse(try GuardPolicy(store: store, audit: audit).config.folders[0].write)
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: store.path).contains { $0.hasPrefix(".guard-") })
        }
    }

    func testI5RefusesEscapesSensitiveVariantsAndUnauthorizedPaths() async throws {
        try await fixture { desktop, root, _, _ in
            _ = try await desktop.authorize(folder: root, write: true)
            let outside = root.deletingLastPathComponent().appendingPathComponent("outside.txt")
            try Data("outside".utf8).write(to: outside)
            let link = root.appendingPathComponent("escape.txt")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
            let cases: [(String, String)] = [
                (link.path, "GUARD_PATH_NOT_AUTHORIZED"),
                (root.path + "/../outside.txt", "GUARD_PATH_INVALID"),
                (outside.path, "GUARD_PATH_NOT_AUTHORIZED"),
                (root.path + "-sibling/file.txt", "GUARD_PATH_NOT_AUTHORIZED"),
                (root.path + "/.SsH/id_rsa", "GUARD_SENSITIVE_PATH"),
                (root.path + "/.ENV", "GUARD_SENSITIVE_PATH"),
                (root.path + "/certificate.PeM", "GUARD_SENSITIVE_PATH")
            ]
            for (path, expected) in cases {
                let result = try await desktop.call(id: .int(1), name: "extract_text", arguments: ["path": .string(path)])
                XCTAssertEqual(code(result), expected, path)
            }
            XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "outside")
        }
    }

    func testI5ForbiddenRootsCannotBeAuthorized() async throws {
        try await fixture { desktop, root, _, _ in
            let home = root.deletingLastPathComponent().appendingPathComponent("home").path
            // Policy predicates never open the owner's home or system roots.
            for path in ["/", home, "/Users", "/Volumes", "/System", "/Library", "/Applications", home + "/Library"] {
                XCTAssertTrue(GuardPath.forbiddenRoot(path, home: home), path)
            }
            for name in ["Keychains", ".SSH", "certificate.PeM"] {
                XCTAssertTrue(GuardPath.sensitive(root.path + "/" + name + "/data"))
            }
            let folders = await desktop.folders()
            XCTAssertTrue(folders.isEmpty)
        }
    }

    func testConfiguredProtectedAppsApplyToToolsAndGrants() async throws {
        var config = GuardConfig()
        XCTAssertTrue(config.protectedApps.isEmpty)
        let legacy = try JSONEncoder().encode(config)
        XCTAssertTrue(try JSONDecoder().decode(GuardConfig.self, from: legacy).protectedApps.isEmpty)
        config.protected_apps = [" ExampleTunnel ", "", "ORG.EXAMPLE.SECUREPROXY"]
        try await TestDesktop.fixture(config: config) { desktop, _, root in
            let allowed = root.appendingPathComponent("allowed")
            try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
            let authorized = try await desktop.authorize(folder: allowed, write: true)
            for name in ["ExampleTunnel", "EXAMPLETUNNEL Lane.app", "prefixExampleTunnelSuffix", "org.example.secureproxy"] {
                let folder = allowed.appendingPathComponent(name)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let file = folder.appendingPathComponent("settings.txt")
                try Data("synthetic settings".utf8).write(to: file)
                let result = try await desktop.call(id: .int(1), name: "read_text_file", arguments: ["path": .string(file.path)])
                XCTAssertEqual(code(result), "GUARD_SENSITIVE_PATH")
                let write = try await desktop.call(id: .int(2), name: "write_file", arguments: ["path": .string(file.path), "content": "replacement"])
                XCTAssertEqual(code(write), "GUARD_SENSITIVE_PATH")
                XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "synthetic settings")
                do { _ = try await desktop.grant(files: [file], via: .paste); XCTFail("Protected app grant accepted") }
                catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_SENSITIVE_PATH") }
                do { _ = try await desktop.authorize(folder: folder, write: true); XCTFail("Protected app folder accepted") }
                catch let error as ToolFailure { XCTAssertEqual(error.code, "GUARD_SENSITIVE_PATH") }
            }
            let cap = try FileCapability.open(root: authorized.id, path: authorized.id, protectedApps: config.protectedApps)
            XCTAssertThrowsError(try cap.child("ExampleTunnel")) { error in
                XCTAssertEqual((error as? ToolFailure)?.code, "GUARD_SENSITIVE_PATH")
            }
            let ordinary = allowed.appendingPathComponent("ordinary-app.txt")
            try Data("allowed".utf8).write(to: ordinary)
            let result = try await desktop.call(id: .int(2), name: "read_text_file", arguments: ["path": .string(ordinary.path)])
            XCTAssertEqual(result.objectValue?["content"]?.arrayValue?.first?.objectValue?["text"]?.stringValue, "allowed")
        }
    }

    func testReadOnlyFolderRefusesWritesAndI6UnknownDeleteCannotRun() async throws {
        try await fixture { desktop, root, _, _ in
            let folder = try await desktop.authorize(folder: root, write: false)
            let file = root.appendingPathComponent("keep.txt")
            try Data("original".utf8).write(to: file)
            let write = try await desktop.call(id: .int(1), name: "write_file", arguments: ["path": .string(file.path), "content": "replacement"])
            XCTAssertEqual(code(write), "GUARD_PATH_NOT_AUTHORIZED")
            for tool in ["delete_file", "delete_directory", "run_command", "unknown"] {
                do { _ = try await desktop.call(id: .int(2), name: tool, arguments: ["path": .string(file.path)]); XCTFail("Unknown tool accepted") }
                catch { }
            }
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "original")
            try await desktop.setWrite(true, folder: folder.id)
            let folders = await desktop.folders()
            XCTAssertEqual(folders.first?.write, true)
        }
    }

    func testScreenShareSignalsPreserveManualAndPhonePauseState() async throws {
        try await fixture { desktop, _, _, _ in
            for reason in [PauseReason.manual, .phone] {
                await desktop.pause(.screenShare)
                var state = await desktop.pauseState()
                XCTAssertFalse(state.paused)
                let ready = try await desktop.call(id: .int(1), name: "list_allowed_directories", arguments: [:])
                XCTAssertEqual(ready.objectValue?["isError"]?.boolValue, false)
                await desktop.pause(reason)
                await desktop.pause(.screenShare)
                await desktop.resume(.screenShare)
                state = await desktop.pauseState()
                XCTAssertEqual(state.reasons, [reason])
                let blocked = try await desktop.call(id: .int(2), name: "list_allowed_directories", arguments: [:])
                XCTAssertEqual(code(blocked), "DESKTOP_PAUSED")
                await desktop.resume(reason == .manual ? .phone : .manual)
                state = await desktop.pauseState()
                XCTAssertFalse(state.paused)
            }
        }
    }

    func testManualPauseStreamsAreIndependent() async throws {
        try await fixture { desktop, _, _, _ in
            var first = desktop.subscribe().makeAsyncIterator(), second = desktop.subscribe().makeAsyncIterator()
            await desktop.pause(.manual)
            let state = await desktop.pauseState(), firstEvent = await first.next(), secondEvent = await second.next()
            XCTAssertEqual(firstEvent, .pause(state))
            XCTAssertEqual(secondEvent, .pause(state))
        }
    }

    func testConfigReloadPreservesFoldersAndExactFileGrants() async throws {
        try await fixture { desktop, root, store, resources in
            let folder = try await desktop.authorize(folder: root, write: false)
            let file = root.deletingLastPathComponent().appendingPathComponent("attachment.txt")
            try Data("附件文字".utf8).write(to: file)
            let issued = try await desktop.grant(files: [file], via: .paste)
            let grant = try XCTUnwrap(issued.first)
            let config = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: store.appendingPathComponent("guard.json"))) as? [String: Any])
            let saved = try XCTUnwrap((config["files"] as? [[String: Any]])?.first)
            XCTAssertEqual(saved["path"] as? String, grant.path)
            for key in ["dev", "ino", "size", "kind", "via", "granted_at", "expires_at"] { XCTAssertNotNil(saved[key], key) }
            await desktop.stop()
            let reloaded = try TestDesktop.make(store: store, resources: resources)
            await reloaded.start(transport: RegressionWire())
            let folders = await reloaded.folders(), grants = await reloaded.grants()
            XCTAssertEqual(folders, [folder])
            XCTAssertEqual(grants, [grant])
            let extracted = try await reloaded.call(id: .int(1), name: "extract_text", arguments: ["path": .string(grant.path)])
            XCTAssertEqual(extracted.objectValue?["isError"]?.boolValue, false)
            XCTAssertEqual(extracted.objectValue?["structuredContent"]?.objectValue?["text"]?.stringValue, "附件文字")
            try await reloaded.revoke(grant: grant.id)
            let denied = try await reloaded.call(id: .int(2), name: "extract_text", arguments: ["path": .string(grant.path)])
            XCTAssertEqual(code(denied), "GUARD_PATH_NOT_AUTHORIZED")
            try await reloaded.remove(folder: folder.id)
            await reloaded.stop()
            let reopened = try TestDesktop.make(store: store, resources: resources)
            let finalFolders = await reopened.folders(), finalGrants = await reopened.grants()
            XCTAssertTrue(finalFolders.isEmpty)
            XCTAssertTrue(finalGrants.isEmpty)
            await reopened.stop()
        }
    }
}
