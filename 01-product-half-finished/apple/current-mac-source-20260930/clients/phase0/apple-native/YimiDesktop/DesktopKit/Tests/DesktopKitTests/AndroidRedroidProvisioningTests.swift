import XCTest
@testable import DesktopKit

final class AndroidRedroidProvisioningTests: XCTestCase {
    func testEthernetReadinessRequiresProxyResponse() {
        XCTAssertTrue(AndroidGuestNetwork.healthy("redroid-ethernet-ready\nHTTP/1.1 204 No Content\r\n"))
        XCTAssertFalse(AndroidGuestNetwork.healthy("redroid-ethernet-ready\nHTTP/1.1 502 Bad Gateway\r\n"))
        XCTAssertFalse(AndroidGuestNetwork.healthy("HTTP/1.1 204 No Content\r\n"))
    }

    func testExistingOwnerQwenIsNeverReinstalledWhenOlderThanCatalog() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let catalog = root.appendingPathComponent("phone-apks.json")
        let entries: [[String: Any]] = [
            ["package": "com.aliyun.tongyi", "url": "https://example.test/qwen.apk", "sha256": "unused", "version_code": 70408],
            ["package": "com.example.unselected", "url": "https://example.test/other.apk", "sha256": "unused", "version_code": 1]
        ]
        try JSONSerialization.data(withJSONObject: entries).write(to: catalog)
        let processes = ProvisioningProcesses()
        processes.packages = "package:com.aliyun.tongyi versionCode:70407\n"
        try await AndroidPhoneProvisioner(device: AndroidVirtualDevice(root: root), processes: processes, catalog: catalog)
            .installMissing(packages: ["com.aliyun.tongyi"])
        XCTAssertEqual(processes.commands.count, 1)
    }

    func testCorruptArchiveIsRejectedBeforeExtractionOrInstallation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let catalog = root.appendingPathComponent("phone-apks.json")
        try Data("changed".utf8).write(to: root.appendingPathComponent("settings.tgz"))
        let entries: [[String: Any]] = [["package": "io.appium.settings", "url": "https://example.test/settings.tgz",
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "archive_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "archive_path": "package/apks/settings_apk-debug.apk", "version_code": 199]]
        try JSONSerialization.data(withJSONObject: entries).write(to: catalog)
        let processes = ProvisioningProcesses()
        do {
            try await AndroidPhoneProvisioner(device: AndroidVirtualDevice(root: root), processes: processes, catalog: catalog, archives: root).installMissing()
            XCTFail("A corrupt archive must fail before tar processes it")
        } catch AndroidHostError.verification(let name) {
            XCTAssertEqual(name, "io.appium.settings archive")
        }
        XCTAssertEqual(processes.commands.count, 1)
    }

    func testHelperPermissionFailurePropagates() async throws {
        let processes = ProvisioningProcesses()
        processes.rejectSetup = true
        let device = AndroidVirtualDevice(root: URL(fileURLWithPath: "/unused"))
        do {
            try await AndroidPhoneProvisioner(device: device, processes: processes, catalog: device.file("phone-apks.json")).prepareExecutor()
            XCTFail("Failure to grant helper location cannot report setup success")
        } catch AndroidHostError.command(_, let code, _) { XCTAssertEqual(code, 1) }
    }
}

private final class ProvisioningProcesses: AndroidProcessRunning, @unchecked Sendable {
    var packages = ""
    var rejectSetup = false
    var commands: [AndroidCommand] = []
    func output(_ command: AndroidCommand, timeout: Duration) async throws -> String {
        commands.append(command)
        if command.arguments.contains(AndroidPhoneProvisioner.executorSetup), rejectSetup {
            throw AndroidHostError.command("adb", 1, "Permission grant failed")
        }
        if command.arguments.suffix(3) == ["list", "packages", "--show-versioncode"] { return packages }
        throw AndroidHostError.unavailable("Unexpected provisioning command")
    }
    func launch(_ command: AndroidCommand, log: URL) throws -> any AndroidChild { throw AndroidHostError.unavailable("Unexpected process launch") }
    func watchVirtualMachine(_ stopCommand: AndroidCommand, log: URL) throws -> any AndroidChild { throw AndroidHostError.unavailable("Unexpected VM operation") }
    func waitForListener(port: UInt16, child: any AndroidChild) async throws { throw AndroidHostError.unavailable("Unexpected listener wait") }
    func listenerAvailable(port: UInt16) throws -> Bool { false }
    func checkPorts(_ ports: [UInt16]) throws {}
}
