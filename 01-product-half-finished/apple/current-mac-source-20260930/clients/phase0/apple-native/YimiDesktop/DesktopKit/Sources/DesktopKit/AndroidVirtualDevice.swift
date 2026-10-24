import Foundation

/// Persistent Redroid storage and the private host transport.
public struct AndroidVirtualDevice: Sendable {
    public static let adbPort = 5555, adbServerPort = 5039
    public let root: URL
    public let physicalInterface: String
    public let instance: String
    public let adbExecutable: URL
    public init(root: URL? = nil, physicalInterface: String = "en0", instance: String? = nil,
                adbExecutable: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        let storage = root ?? environment["YIMI_ANDROID_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Yimi/Android")
        self.root = storage; self.physicalInterface = physicalInterface
        self.instance = instance ?? environment["YIMI_ANDROID_INSTANCE"] ?? "r"
        self.adbExecutable = adbExecutable ?? environment["YIMI_ANDROID_ADB"].map { URL(fileURLWithPath: $0) }
            ?? storage.appendingPathComponent("sdk/platform-tools/adb")
    }
    public func file(_ path: String) -> URL { root.appendingPathComponent(path) }
    public var environment: [String: String] { [
        "ANDROID_SDK_ROOT": file("sdk").path, "ANDROID_HOME": file("sdk").path,
        "LIMA_HOME": file("lima").path, "XDG_CACHE_HOME": file("cache").path,
        "ANDROID_ADB_SERVER_PORT": "\(Self.adbServerPort)", "ADB_SERVER_SOCKET": "tcp:127.0.0.1:\(Self.adbServerPort)",
        "ADB_USB": "0", "ADB_EMU": "0", "ADB_MDNS": "0"
    ] }
    public var installed: Bool {
        (AndroidArtifact.runtime.map(\.required) + ["lima/\(instance)/lima.yaml", "lima/\(instance)/disk",
            "lima/\(instance)/kernel", "lima/\(instance)/initrd", "gost.yml", "redroid-installed"])
            .allSatisfy { FileManager.default.fileExists(atPath: file($0).path) }
    }
    public func create() throws {
        for path in ["lima", "cache", "logs"] {
            try FileManager.default.createDirectory(at: file(path), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        try AndroidGuestNetwork.createConfiguration(device: self)
    }
    public func command(_ path: String, _ arguments: [String]) -> AndroidCommand {
        AndroidCommand(file(path), arguments, environment: environment)
    }
    public func lima(_ arguments: [String]) -> AndroidCommand { command("tools/lima/bin/limactl", arguments) }
    public func adb(_ arguments: [String]) -> AndroidCommand {
        AndroidCommand(adbExecutable, ["-P", "\(Self.adbServerPort)", "-s", "127.0.0.1:\(Self.adbPort)"] + arguments, environment: environment)
    }
}
