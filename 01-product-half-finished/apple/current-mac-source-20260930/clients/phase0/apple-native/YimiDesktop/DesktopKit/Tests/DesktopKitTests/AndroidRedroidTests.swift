import CryptoKit
import Darwin
import XCTest
@testable import DesktopKit

final class AndroidRedroidTests: XCTestCase {
    private var root: URL!
    private var device: AndroidVirtualDevice!
    override func setUpWithError() throws {
        root = URL(fileURLWithPath: "/tmp/yimi-" + UUID().uuidString.prefix(8))
        device = AndroidVirtualDevice(root: root.appendingPathComponent("手机 with spaces"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func installed() throws {
        for artifact in AndroidArtifact.runtime {
            let target = device.file(artifact.required)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: target)
        }
        try device.create()
        for name in ["lima.yaml", "disk", "kernel", "initrd"] {
            let target = device.file("lima/\(device.instance)/" + name)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("persistent".utf8).write(to: target)
        }
        try Data().write(to: device.file("redroid-installed"))
    }
    func testOfficialChecksumAlgorithmsRejectCorruptionAndTruncation() throws {
        let archive = root.appendingPathComponent("archive")
        try Data("abc".utf8).write(to: archive)
        for (algorithm, checksum) in [(AndroidArtifact.Checksum.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d"), (.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")] {
            let artifact = AndroidArtifact(url: URL(string: "https://example.test/archive")!, size: 3, checksum: checksum, algorithm: algorithm, destination: "tool", unpacked: "", required: "tool/run")
            try artifact.verify(archive)
            try Data("abd".utf8).write(to: archive)
            XCTAssertThrowsError(try artifact.verify(archive))
            try Data("ab".utf8).write(to: archive)
            XCTAssertThrowsError(try artifact.verify(archive))
            try Data("abc".utf8).write(to: archive)
        }
    }
    func testLayoutPreservesPersistentDiskAndUsesPrivateTransport() throws {
        try installed()
        let disk = device.file("lima/r/disk"), original = try Data(contentsOf: disk)
        try device.create()
        XCTAssertEqual(try Data(contentsOf: disk), original)
        XCTAssertEqual(device.lima(["list"]).environment["LIMA_HOME"], device.file("lima").path)
        XCTAssertEqual(device.adb(["shell"]).arguments, ["-P", "5039", "-s", "127.0.0.1:5555", "shell"])
        let overridden = AndroidVirtualDevice(environment: ["YIMI_ANDROID_ROOT": root.path, "YIMI_ANDROID_INSTANCE": "adopted", "YIMI_ANDROID_ADB": "/fixture/adb"])
        XCTAssertEqual(overridden.root.path, root.path); XCTAssertEqual(overridden.instance, "adopted")
        XCTAssertEqual(overridden.adbExecutable.path, "/fixture/adb")
        XCTAssertFalse(FileManager.default.fileExists(atPath: device.file("avd").path))
    }
    func testInstallChecksumFailureNeverExtractsOrPublishes() async throws {
        let processes = FakeAndroidProcesses()
        let artifact = AndroidArtifact(url: URL(string: "https://example.test/corrupt.tgz")!, size: 3,
            checksum: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", algorithm: .sha256,
            destination: "tools/test", unpacked: "", required: "tools/test/run")
        try Data("bad".utf8).write(to: root.appendingPathComponent("corrupt.tgz"))
        do {
            try await AndroidRedroidInstaller(device: device, processes: processes, archives: root).install(artifact)
            XCTFail("A changed download cannot be used")
        } catch AndroidHostError.verification(let name) { XCTAssertEqual(name, "corrupt.tgz") }
        XCTAssertTrue(processes.commands.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: device.file(artifact.required).path))
    }
    func testStatusReadsFourStatesWithoutLaunchingOrConnecting() async throws {
        let processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, processes: processes)
        var state = await host.status(); XCTAssertEqual(state.state, .notInstalled)
        try installed()
        state = await host.status(); XCTAssertEqual(state.state, .stopped)
        processes.vm = "Running"; processes.bootCompleted = "0"
        state = await host.status(); XCTAssertEqual(state.state, .starting)
        processes.bootCompleted = "1"
        state = await host.status(); XCTAssertEqual(state.state, .running)
        processes.adbResponding = false
        state = await host.status(); XCTAssertEqual(state.state, .starting)
        processes.adbResponding = true
        processes.serverListening = false
        state = await host.status(); XCTAssertEqual(state.state, .starting)
        XCTAssertTrue(processes.launched.isEmpty)
        XCTAssertFalse(processes.commands.contains { $0.arguments.contains("connect") })
    }
    func testIdempotentStartAndOrderlyPersistentStop() async throws {
        try installed()
        let processes = FakeAndroidProcesses(); processes.serverListening = false
        let host = AndroidRedroidHost(device: device, enabled: true, processes: processes)
        async let first: Void = host.start()
        async let second: Void = host.start()
        _ = try await (first, second)
        let running = await host.status(); XCTAssertEqual(running.state, .running)
        XCTAssertEqual(processes.commands.filter { $0.arguments.first == "start" }.count, 1)
        XCTAssertEqual(processes.guardians, 1)
        let adb = try XCTUnwrap(processes.launched.first { $0.0.executable.lastPathComponent == "adb" })
        XCTAssertEqual(adb.0.arguments, ["-L", "tcp:5039", "server", "nodaemon"], "ADB server listen sockets reject an explicit hostname")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(running)) as? [String: Any])
        XCTAssertEqual(json["schema"] as? String, "paios.mac-android.v1")
        XCTAssertEqual(json["adb_port"] as? Int, 5555)
        XCTAssertTrue(processes.commands.contains { $0.arguments == ["shell", "r", "--", "sudo", "docker", "exec", "--user", "0", "redroid", "sh", "-c", AndroidGuestNetwork.udpRules] })
        let proxy = try XCTUnwrap(processes.launched.first { $0.0.executable.lastPathComponent == "gost" })
        proxy.1.terminate()
        try await host.start()
        XCTAssertEqual(processes.launched.filter { $0.0.executable.lastPathComponent == "gost" }.count, 2)
        XCTAssertEqual(processes.commands.filter { $0.arguments.first == "start" }.count, 1, "Recovering the proxy preserves the running VM")
        try await host.stop()
        let commands = processes.commands.map(\.arguments)
        let modules = try XCTUnwrap(commands.firstIndex { $0 == ["shell", "r", "--", "sudo", "modprobe", "-a", "ipt_REJECT", "ip6t_REJECT"] })
        let firewall = try XCTUnwrap(commands.firstIndex { $0.last == AndroidGuestNetwork.udpRules })
        XCTAssertLessThan(modules, firewall, "Redroid cannot autoload the host's REJECT kernel modules")
        let androidStop = try XCTUnwrap(commands.firstIndex { $0.suffix(3) == ["systemctl", "stop", "redroid.service"] })
        let vmStop = try XCTUnwrap(commands.firstIndex { $0 == ["stop", "r"] })
        XCTAssertLessThan(androidStop, vmStop)
        XCTAssertFalse(commands.contains { $0.contains("run") || $0.contains("delete") || $0.contains("create") })
        XCTAssertEqual(try String(contentsOf: device.file("lima/r/disk"), encoding: .utf8), "persistent")
        XCTAssertTrue(processes.launched.allSatisfy { !$0.1.isRunning })
        let pending = await host.needsShutdown(); XCTAssertFalse(pending)
    }
    func testSystemdFailureNamesStepAndStopsVM() async throws {
        try installed()
        for enabling in [false, true] {
            let processes = FakeAndroidProcesses(); processes.rejectUnits = true
            let host = AndroidRedroidHost(device: device, enabled: true, processes: processes)
            do {
                if enabling { try await host.enable() } else { try await host.start() }
                XCTFail("Invalid units cannot pass readiness")
            } catch {}
            let status = await host.status()
            XCTAssertEqual(status.state, .stopped)
            XCTAssertTrue(status.last_error?.contains("binderfs") == true)
            XCTAssertEqual(processes.vm, "Stopped")
            XCTAssertTrue(processes.launched.allSatisfy { !$0.1.isRunning })
        }
    }
    func testEnableUsesPackageAuthorityWithoutReinstallingRuntime() async throws {
        let processes = FakeAndroidProcesses()
        let fresh = AndroidRedroidHost(device: device, processes: processes,
            installRuntime: { try self.installed() }, installApps: { processes.appsProvisioned += 1 })
        let uninstalled = try await fresh.requestStart(); XCTAssertEqual(uninstalled.state, .notInstalled)
        try await fresh.enable()
        let status = await fresh.status(); XCTAssertEqual(status.state, .running)
        XCTAssertEqual(processes.appsProvisioned, 1)
        try await fresh.stop()
        let adopted = AndroidRedroidHost(device: device, processes: processes,
            installRuntime: { XCTFail("Adoption cannot reinstall") }, installApps: { processes.appsProvisioned += 1 })
        try await adopted.enable(); XCTAssertEqual(processes.appsProvisioned, 2); try await adopted.stop()
    }
    func testPhoneViewUsesPrivateADBWithoutReboot() async throws {
        try installed()
        let executable = device.file(AndroidArtifact.scrcpy.required)
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: executable)
        let processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, enabled: true, processes: processes)
        try await host.showLoginPhone(provision: {})
        let viewer = try XCTUnwrap(processes.launched.first { $0.0.executable.lastPathComponent == "scrcpy" }?.0)
        XCTAssertEqual(viewer.environment["ADB"], device.adbExecutable.path)
        XCTAssertEqual(viewer.environment["ADB_SERVER_SOCKET"], "tcp:127.0.0.1:5039")
        XCTAssertEqual(processes.commands.filter { $0.arguments.first == "start" }.count, 1)
        try await host.stop()
    }
    func testShutdownCancelsFirstEnableAndCleansItsWork() async throws {
        let began = expectation(description: "installation started"), processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, processes: processes, installRuntime: {
            began.fulfill(); try await Task.sleep(for: .seconds(60))
        })
        let enabling = Task { try await host.enable() }
        await fulfillment(of: [began], timeout: 3)
        let pending = await host.needsShutdown(); XCTAssertTrue(pending)
        try await host.stop()
        do { try await enabling.value; XCTFail("Quit must cancel a pending first enable") } catch is CancellationError {}
        let stopped = await host.status(), work = await host.needsShutdown()
        XCTAssertEqual(stopped.state, .notInstalled); XCTAssertFalse(work)
    }
    func testStopInvalidatesAnAwaitingStartDecision() async throws {
        try installed()
        let entered = expectation(description: "status query suspended"), gate = AndroidTestGate()
        let processes = FakeAndroidProcesses()
        processes.beforeOutput = { command in
            if command.arguments.first == "list" { await gate.wait(entered) }
        }
        let host = AndroidRedroidHost(device: device, enabled: true, processes: processes)
        let starting = Task { try await host.requestStart() }
        await fulfillment(of: [entered], timeout: 3)
        try await host.disable()
        await gate.release()
        do { _ = try await starting.value; XCTFail("A pre-stop request cannot launch the VM") } catch is CancellationError {}
        XCTAssertTrue(processes.launched.isEmpty)
        XCTAssertFalse(processes.commands.contains { $0.arguments.first == "start" })
    }
    func testConcurrentEnableSharesProvisioningFailure() async throws {
        let runtimeEntered = expectation(description: "runtime install"), appsEntered = expectation(description: "APK install")
        let secondEntered = expectation(description: "second enable"), secondFinished = expectation(description: "second enable completed early")
        secondFinished.isInverted = true
        let runtimeGate = AndroidTestGate(), appsGate = AndroidTestGate(), processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, processes: processes, installRuntime: {
            await runtimeGate.wait(runtimeEntered); try self.installed()
        }, installApps: {
            processes.appsProvisioned += 1
            await appsGate.wait(appsEntered)
            throw AndroidHostError.unavailable("APK fixture failure")
        })
        let first = Task { try await host.enable() }
        await fulfillment(of: [runtimeEntered], timeout: 3)
        let second = Task {
            secondEntered.fulfill()
            do { try await host.enable(); secondFinished.fulfill() }
            catch { throw error }
        }
        await fulfillment(of: [secondEntered], timeout: 3)
        await Task.yield()
        await runtimeGate.release()
        await fulfillment(of: [appsEntered], timeout: 3)
        await fulfillment(of: [secondFinished], timeout: 0.1)
        await appsGate.release()
        for task in [first, second] {
            do { try await task.value; XCTFail("Every enable waiter must receive the APK failure") }
            catch { XCTAssertTrue(error.localizedDescription.contains("APK fixture failure")) }
        }
        XCTAssertEqual(processes.appsProvisioned, 1)
        XCTAssertEqual(processes.guardians, 1)
    }
    func testStopCancelsTheWholeEnableDuringAPKSetup() async throws {
        try installed()
        let entered = expectation(description: "APK setup"), processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, processes: processes, installApps: {
            entered.fulfill(); try await Task.sleep(for: .seconds(60))
        })
        let enabling = Task { try await host.enable() }
        await fulfillment(of: [entered], timeout: 3)
        try await host.stop()
        do { try await enabling.value; XCTFail("Stop must cancel the complete enable operation") } catch is CancellationError {}
        let state = await host.status(), pending = await host.needsShutdown()
        XCTAssertEqual(state.state, .stopped); XCTAssertFalse(pending)
        XCTAssertEqual(processes.vm, "Stopped")
        XCTAssertEqual(processes.commands.filter { $0.arguments == ["stop", "r"] }.count, 1)
    }
    func testStopInvalidatesViewerInstallationBeforeLaunch() async throws {
        try installed()
        let entered = expectation(description: "scrcpy install"), gate = AndroidTestGate(), processes = FakeAndroidProcesses()
        let host = AndroidRedroidHost(device: device, enabled: true, processes: processes, installViewer: {
            await gate.wait(entered)
        })
        let showing = Task { try await host.showPhone() }
        await fulfillment(of: [entered], timeout: 3)
        try await host.stop()
        await gate.release()
        do { try await showing.value; XCTFail("Stopped phone cannot open a late viewer") } catch is CancellationError {}
        XCTAssertFalse(processes.launched.contains { $0.0.executable.lastPathComponent == "scrcpy" })
        let pending = await host.needsShutdown(); XCTAssertFalse(pending)
    }
    func testShutdownAttemptsVMStopAfterStateQueryFailure() async throws {
        try installed()
        let processes = FakeAndroidProcesses()
        let managed = AndroidRedroidHost(device: device, enabled: true, processes: processes)
        try await managed.start()
        processes.rejectState = true
        do { try await managed.stop(); XCTFail("State-query failure must remain visible") }
        catch { XCTAssertTrue(error.localizedDescription.contains("state fixture failure")) }
        XCTAssertEqual(processes.vm, "Stopped")
        XCTAssertTrue(processes.commands.contains { $0.arguments == ["stop", "r"] })
        XCTAssertTrue(processes.launched.allSatisfy { !$0.1.isRunning })
    }
    private let apkDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    private func appCatalog(_ entries: [[String: Any]]) throws -> URL {
        let file = root.appendingPathComponent("phone-apks.json")
        try JSONSerialization.data(withJSONObject: entries).write(to: file); return file
    }
    func testPhoneAppPinsAndInstalledVersionPreserveExistingData() async throws {
        let catalog = try appCatalog([
            ["package": "com.test.existing", "url": "https://example.test/old.apk", "sha256": apkDigest, "version_code": 2],
            ["package": "com.test.new", "url": "https://example.test/new.apk", "sha256": apkDigest, "version_code": 1]
        ])
        try Data("abc".utf8).write(to: root.appendingPathComponent("new.apk"))
        let processes = FakeAndroidProcesses(); processes.installedApps = "package:com.test.existing versionCode:3\n"
        let provision = AndroidPhoneProvisioner(device: device, processes: processes, catalog: catalog, archives: root)
        try await provision.installMissing()
        XCTAssertEqual(processes.commands.filter { $0.arguments.contains("install") }.count, 1)
        try Data("abd".utf8).write(to: root.appendingPathComponent("new.apk"))
        let rejected = FakeAndroidProcesses(); rejected.installedApps = processes.installedApps
        do {
            try await AndroidPhoneProvisioner(device: device, processes: rejected, catalog: catalog, archives: root).installMissing()
            XCTFail("A changed APK cannot be installed")
        } catch AndroidHostError.verification(let name) { XCTAssertEqual(name, "com.test.new") }
        XCTAssertFalse(rejected.commands.contains { $0.arguments.contains("install") })
    }
    func testAppiumCatalogPinCoversTheExtractedAPK() async throws {
        let seed = root.appendingPathComponent("seed"), member = "package/apks/settings_apk-debug.apk"
        let apk = seed.appendingPathComponent(member)
        try FileManager.default.createDirectory(at: apk.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("abc".utf8).write(to: apk)
        let archive = root.appendingPathComponent("settings.tgz"), runner = AndroidProcesses(temporary: root.appendingPathComponent("logs"))
        _ = try await runner.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/tar"), ["-czf", archive.path, "-C", seed.path, "package"]), timeout: .seconds(5))
        let archiveDigest = SHA256.hash(data: try Data(contentsOf: archive)).map { String(format: "%02x", $0) }.joined()
        let catalog = try appCatalog([["package": "io.appium.settings", "url": "https://example.test/settings.tgz", "sha256": apkDigest, "version_code": 1, "archive_path": member, "archive_sha256": archiveDigest]])
        let processes = FakeAndroidProcesses(); processes.archiveRunner = runner
        try await AndroidPhoneProvisioner(device: device, processes: processes, catalog: catalog, archives: root).installMissing()
        XCTAssertEqual(processes.commands.filter { $0.arguments.contains("install") }.count, 1)
    }
    func testRealProcessOutputFailureAndCancellation() async throws {
        let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs"))
        let output = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/printf"), ["ready"]), timeout: .seconds(2))
        XCTAssertEqual(output, "ready")
        let priority = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/bin/sh"),
            ["-c", "/bin/ps -o nice= -p $$"]), timeout: .seconds(2))
        XCTAssertEqual(Int(priority.trimmingCharacters(in: .whitespacesAndNewlines)), Int(getpriority(PRIO_PROCESS, 0)))
        do {
            _ = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/bin/sh"), ["-c", "printf broken >&2; exit 7"]), timeout: .seconds(2))
            XCTFail("Nonzero child exit must surface")
        } catch AndroidHostError.command(_, let code, let text) { XCTAssertEqual(code, 7); XCTAssertEqual(text, "broken") }
        let task = Task { try await processes.output(AndroidCommand(URL(fileURLWithPath: "/bin/sleep"), ["30"]), timeout: .seconds(60)) }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled child must stop") } catch is CancellationError {}
    }
    func testPortProbeRejectsAnOccupiedListener() throws {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(descriptor) }
        var reuse: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        try withUnsafeMutablePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { raw in
                XCTAssertEqual(Darwin.bind(descriptor, raw, length), 0); XCTAssertEqual(listen(descriptor, 1), 0)
                XCTAssertEqual(getsockname(descriptor, raw, &length), 0)
                let port = UInt16(bigEndian: pointer.pointee.sin_port)
                let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs"))
                XCTAssertThrowsError(try processes.checkPorts([port])) { XCTAssertEqual(($0 as? POSIXError)?.code, .EADDRINUSE) }
            }
        }
    }
    func testControlSocketUsesLiveStateAndExclusiveOwnership() async throws {
        let host = AndroidRedroidHost(device: device, processes: FakeAndroidProcesses())
        let server = try AndroidControlSocket(directory: root) { action in
            let value: AndroidHostStatus
            if action == "start" { value = try await host.requestStart() } else { value = await host.status() }
            return try JSONEncoder().encode(value)
        }
        defer { withExtendedLifetime(server) {} }
        XCTAssertThrowsError(try AndroidControlSocket(directory: root) { _ in Data() })
        let root = root!
        let response = try await Task.detached { try AndroidControlSocket.request("status", directory: root) }.value
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: response) as? [String: Any])
        XCTAssertEqual(json["state"] as? String, "not_installed")
    }
    func testParentExitReapsGuardedProcess() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        guard FileManager.default.isExecutableFile(atPath: guardian) else { return XCTFail("Built app guardian is missing or not executable") }
        let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs")), log = root.appendingPathComponent("owned-pid")
        let owner = try processes.launch(AndroidCommand(URL(fileURLWithPath: "/bin/sh"), ["-c", "/bin/sleep 120 & child=$!; \"$1\" \"$$\" \"$child\" & echo $child; wait", "owner", guardian]), log: log)
        defer { owner.terminate() }
        var text = ""
        for _ in 0..<40 {
            text = try String(contentsOf: log, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let pid = try XCTUnwrap(Int32(text)); defer { if kill(pid, 0) == 0 { kill(pid, SIGTERM) } }
        owner.terminate(); _ = await owner.wait()
        for _ in 0..<60 {
            if kill(pid, 0) != 0 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(kill(pid, 0), -1, "A crashed app cannot leave its phone process resident")
    }
    func testGuardObservesDirectChildAndPreservesItsExitStatus() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs"), guardian: URL(fileURLWithPath: guardian))
        do {
            _ = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/bin/sh"), ["-c", "echo $PPID; exit 7"]), timeout: .seconds(5))
            XCTFail("The guardian cannot hide a failing child's exit")
        } catch AndroidHostError.command(_, let code, let output) {
            XCTAssertEqual(code, 7)
            XCTAssertEqual(output.trimmingCharacters(in: .whitespacesAndNewlines), String(getpid()))
        }
    }
    func testParentDeathShutsDownAndroidBeforeDaemonVM() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        let fake = root.appendingPathComponent("limactl"), events = root.appendingPathComponent("events")
        try Data("#!/bin/sh\ncase \"$1\" in\nlist) echo Running;;\nshell) echo shutdown >> \"$YIMI_VM_TEST_LOG\";;\nstop) echo vm-stop >> \"$YIMI_VM_TEST_LOG\";;\nesac\n".utf8).write(to: fake)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        let runner = AndroidProcesses(temporary: root.appendingPathComponent("logs")), log = root.appendingPathComponent("owner")
        let owner = try runner.launch(AndroidCommand(URL(fileURLWithPath: "/bin/sh"),
            ["-c", "\"$1\" --vm $$ \"$2\" stop r > /dev/null & echo $$; wait", "owner", guardian, fake.path],
            environment: ["YIMI_VM_TEST_LOG": events.path]), log: log)
        defer { owner.terminate() }
        var pid: Int32?
        for _ in 0..<100 {
            pid = Int32(try String(contentsOf: log, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))
            if pid != nil { break }; try await Task.sleep(for: .milliseconds(100))
        }
        kill(try XCTUnwrap(pid), SIGKILL); _ = await owner.wait()
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: events.path),
               try String(contentsOf: events, encoding: .utf8).contains("vm-stop") { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(try String(contentsOf: events, encoding: .utf8), "shutdown\nvm-stop\n")
    }
    private func awaitVMGuardianReady(_ child: any AndroidChild, log: URL) async throws {
        for _ in 0..<100 {
            guard child.isRunning else {
                let code = await child.wait()
                throw AndroidHostError.unavailable("VM guardian exited before ready (\(code))")
            }
            let output = try String(contentsOf: log, encoding: .utf8)
            if output.split(whereSeparator: \.isNewline).contains("VM guardian ready") { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw AndroidHostError.unavailable("VM guardian ready timed out")
    }
    func testVMGuardianStopsAfterFailedStateReadAndReportsFailure() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        let fake = root.appendingPathComponent("limactl"), events = root.appendingPathComponent("events")
        try Data("#!/bin/sh\ncase \"$1\" in\nlist) echo state-failed >&2; exit 7;;\nshell) echo shutdown >> \"$YIMI_VM_TEST_LOG\";;\nstop) echo vm-stop >> \"$YIMI_VM_TEST_LOG\";;\nesac\n".utf8).write(to: fake)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        let runner = AndroidProcesses(temporary: root.appendingPathComponent("logs"), guardian: URL(fileURLWithPath: guardian))
        let watcher = try runner.watchVirtualMachine(AndroidCommand(fake, ["stop", "r"], environment: ["YIMI_VM_TEST_LOG": events.path]), log: root.appendingPathComponent("watcher"))
        defer { watcher.terminate() }
        try await awaitVMGuardianReady(watcher, log: root.appendingPathComponent("watcher"))
        watcher.terminate()
        let code = await watcher.wait()
        XCTAssertEqual(code, 1)
        XCTAssertEqual(try String(contentsOf: events, encoding: .utf8), "shutdown\nvm-stop\n")
        XCTAssertTrue(try String(contentsOf: root.appendingPathComponent("watcher"), encoding: .utf8).contains("VM state:"))
    }
    func testVMGuardianHasTimeForGuestShutdownBeyondChildGrace() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        let fake = root.appendingPathComponent("limactl"), events = root.appendingPathComponent("events")
        try Data("#!/bin/sh\ncase \"$1\" in\nlist) echo Running;;\nshell) sleep 46; echo shutdown >> \"$YIMI_VM_TEST_LOG\";;\nstop) echo vm-stop >> \"$YIMI_VM_TEST_LOG\";;\nesac\n".utf8).write(to: fake)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        let runner = AndroidProcesses(temporary: root.appendingPathComponent("logs"), guardian: URL(fileURLWithPath: guardian))
        let watcher = try runner.watchVirtualMachine(AndroidCommand(fake, ["stop", "r"], environment: ["YIMI_VM_TEST_LOG": events.path]), log: root.appendingPathComponent("watcher"))
        defer { watcher.terminate() }
        try await awaitVMGuardianReady(watcher, log: root.appendingPathComponent("watcher"))
        watcher.terminate()
        let code = await watcher.wait()
        XCTAssertEqual(code, 0, "VM guardian must survive the ordinary child's 45-second escalation")
        XCTAssertEqual(try String(contentsOf: events, encoding: .utf8), "shutdown\nvm-stop\n")
    }
    func testOwnerEscalatesTerminationOfAnUnresponsiveOwnedChild() async throws {
        guard let guardian = ProcessInfo.processInfo.environment["YIMI_ANDROID_GUARD"] else { throw XCTSkip("Built app guardian not configured") }
        let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs"), guardian: URL(fileURLWithPath: guardian))
        let log = root.appendingPathComponent("ignores-term")
        let child = try processes.launch(AndroidCommand(URL(fileURLWithPath: "/bin/sh"),
            ["-c", "trap '' TERM; echo $$; exec /bin/sleep 120"]), log: log)
        var text = ""
        for _ in 0..<100 {
            text = try String(contentsOf: log, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let pid = try XCTUnwrap(Int32(text))
        defer { if kill(pid, 0) == 0 { kill(pid, SIGKILL) } }
        let deadline = Task {
            do {
                try await Task.sleep(for: .seconds(55))
                if child.isRunning { kill(pid, SIGKILL); return true }
            } catch {}
            return false
        }
        defer { deadline.cancel() }
        child.terminate()
        let code = await child.wait()
        deadline.cancel()
        let exceeded = await deadline.value
        XCTAssertEqual(code, -SIGKILL)
        XCTAssertFalse(exceeded, "The owner must bound cancellation without waiting for the child")
    }
    func testCaptivePortalProvisioningSetsMissingValuesAndRejectsConflicts() async throws {
        let settings = root.appendingPathComponent("settings")
        try FileManager.default.createDirectory(at: settings, withIntermediateDirectories: true)
        let boundary = """
        fixture="$1"
        settings() {
          if [ "$1" = get ]; then
            if [ -f "$fixture/$3" ]; then cat "$fixture/$3"; else echo null; fi
          else
            printf '%s' "$4" > "$fixture/$3"
            echo "$3" >> "$fixture/writes"
          fi
        }
        """
        let runner = AndroidProcesses(temporary: root.appendingPathComponent("logs"))
        let command = AndroidCommand(URL(fileURLWithPath: "/bin/sh"),
            ["-c", boundary + "\n" + AndroidGuestNetwork.captivePortals, "portals", settings.path])
        _ = try await runner.output(command, timeout: .seconds(5))
        _ = try await runner.output(command, timeout: .seconds(5))
        let writes = try String(contentsOf: settings.appendingPathComponent("writes"), encoding: .utf8)
        XCTAssertEqual(writes.split(separator: "\n").count, 3, "Existing portal URLs are verified without rewriting")
        let https = settings.appendingPathComponent("captive_portal_https_url")
        try Data("https://conflicting.test/".utf8).write(to: https)
        do { _ = try await runner.output(command, timeout: .seconds(5)); XCTFail("Portal drift must surface") }
        catch AndroidHostError.command(_, let code, _) { XCTAssertNotEqual(code, 0) }
        XCTAssertEqual(try String(contentsOf: https, encoding: .utf8), "https://conflicting.test/")
    }
    func testCachedOfficialToolsVerifyAndExtractWithoutBooting() async throws {
        guard let path = ProcessInfo.processInfo.environment["YIMI_ANDROID_ARCHIVES"] else { throw XCTSkip("Cached release archives not configured") }
        let processes = AndroidProcesses(temporary: root.appendingPathComponent("logs"))
        let installer = AndroidRedroidInstaller(device: device, processes: processes, archives: URL(fileURLWithPath: path))
        try await installer.install(AndroidArtifact.runtime.last!)
        try await installer.install(.scrcpy)
        XCTAssertTrue(FileManager.default.fileExists(atPath: device.file("tools/gost/LICENSE").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: device.file("tools/scrcpy/LICENSE").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: device.file("avd").path))
    }
}

private final class FakeAndroidChild: AndroidChild, @unchecked Sendable {
    private let lock = NSLock()
    private var running = true
    private var waiters: [CheckedContinuation<Int32, Never>] = []
    var isRunning: Bool { lock.withLock { running } }
    func terminate() {
        let pending = lock.withLock { running = false; let result = waiters; waiters = []; return result }
        pending.forEach { $0.resume(returning: 0) }
    }
    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.withLock { if running { waiters.append(continuation) } else { continuation.resume(returning: 0) } }
        }
    }
}
private final class FakeAndroidProcesses: AndroidProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var children: [(AndroidCommand, FakeAndroidChild)] = []
    private var outputs: [AndroidCommand] = []
    var vm = "Stopped", bootCompleted = "1", serverListening = true
    var rejectUnits = false, adbResponding = true, installedApps = ""
    var guardians = 0, appsProvisioned = 0
    var archiveRunner: AndroidProcesses?
    var rejectState = false
    var beforeOutput: (@Sendable (AndroidCommand) async -> Void)?
    var launched: [(AndroidCommand, FakeAndroidChild)] { lock.withLock { children } }
    var commands: [AndroidCommand] { lock.withLock { outputs } }
    func launch(_ command: AndroidCommand, log: URL) throws -> any AndroidChild {
        let child = FakeAndroidChild(); lock.withLock { children.append((command, child)) }; return child
    }
    func watchVirtualMachine(_ command: AndroidCommand, log: URL) throws -> any AndroidChild {
        guardians += 1; return try launch(command, log: log)
    }
    func listenerAvailable(port: UInt16) throws -> Bool { serverListening }
    func output(_ command: AndroidCommand, timeout: Duration) async throws -> String {
        lock.withLock { outputs.append(command) }
        await beforeOutput?(command)
        if command.executable.path == "/usr/bin/tar", let archiveRunner { return try await archiveRunner.output(command, timeout: timeout) }
        if command.executable.lastPathComponent == "limactl" {
            if command.arguments.first == "list" {
                if rejectState { throw AndroidHostError.command("limactl", 1, "state fixture failure") }
                return vm + "\n"
            }
            if command.arguments.first == "start" { vm = "Running" }
            if command.arguments.first == "stop" { vm = "Stopped" }
            if command.arguments.suffix(3) == ["systemctl", "start", "redroid.service"], rejectUnits {
                throw AndroidHostError.command("limactl", 1, "binderfs failed")
            }
            return ""
        }
        if command.arguments.suffix(2) == ["getprop", "sys.boot_completed"] {
            if !adbResponding { throw AndroidHostError.command("adb", 1, "device offline") }
            return bootCompleted
        }
        if command.executable.lastPathComponent == "adb", command.arguments.contains(where: { $0.contains("iptables") }) {
            throw AndroidHostError.command("adb", 3, "iptables requires the container root context")
        }
        if command.arguments.suffix(3) == ["list", "packages", "--show-versioncode"] { return installedApps }
        if command.arguments.contains("install") { return "Performing Streamed Install\nSuccess\n" }
        if command.arguments.contains("connect") { return "connected to 127.0.0.1:5555\n" }
        return "redroid-ethernet-ready\nHTTP/1.1 204 No Content\n"
    }
    func waitForListener(port: UInt16, child: any AndroidChild) async throws {
        if port == AndroidVirtualDevice.adbServerPort { serverListening = true }
    }
    func checkPorts(_ ports: [UInt16]) throws {}
}

private actor AndroidTestGate {
    private var open = false, entered = false
    private var waiter: CheckedContinuation<Void, Never>?
    func wait(_ arrival: XCTestExpectation) async {
        if !entered { entered = true; arrival.fulfill() }
        if open { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func release() { open = true; waiter?.resume(); waiter = nil }
}
