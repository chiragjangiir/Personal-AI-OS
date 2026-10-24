import Foundation
import Darwin

/// The signed host owns the daemon. SSH clients only connect to this generation's socket.
public final class EmbeddedCUA {
    private let directory: URL
    private let bundle: URL
    private var child: Process?
    private var lifetime: Pipe?
    private var socketDirectory: URL?
    public var failed: Bool { child.map { !$0.isRunning } ?? false }

    public init(directory: URL, bundle: URL = Bundle.main.bundleURL) {
        self.directory = directory
        self.bundle = bundle
    }

    public func start() throws {
        try stop()
        let files = FileManager.default
        let socketRoot = files.temporaryDirectory.appendingPathComponent("yimi-cua-\(UUID().uuidString.prefix(8))")
        try files.createDirectory(at: socketRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        socketDirectory = socketRoot
        let socket = socketRoot.appendingPathComponent("s").path
        let helper = bundle.appendingPathComponent("Contents/Helpers/CuaDriver.app")
        let runtime = bundle.appendingPathComponent("Contents/Resources/opengcua")
        let output = directory.appendingPathComponent("opengcua-output")
        try files.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let process = Process(), pipe = Pipe()
        process.executableURL = helper.appendingPathComponent("Contents/MacOS/cua-driver")
        process.arguments = ["serve", "--embedded", "--socket", socket, "--parent-liveness-stdio"]
        if let identity = Bundle(url: bundle)?.bundleIdentifier {
            process.arguments! += ["--host-bundle-id", identity]
        }
        process.environment = ProcessInfo.processInfo.environment.merging(["CUA_DRIVER_EMBEDDED": "1"]) { _, embedded in embedded }
        process.standardInput = pipe
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        child = process; lifetime = pipe
        try process.run()
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }
        let command = [runtime.appendingPathComponent("python/bin/python3.12").path, "-I", "-B",
                       runtime.appendingPathComponent("run.py").path, socket, helper.path, output.path]
        let launcher = directory.appendingPathComponent("opengcua")
        try Data(("#!/bin/sh\nexec " + command.map(quote).joined(separator: " ") + " \"$@\"\n").utf8).write(to: launcher, options: .atomic)
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: launcher.path)
    }

    public func stop() throws {
        if let child, child.isRunning {
            kill(child.processIdentifier, SIGKILL)
            child.waitUntilExit()
        }
        child = nil
        lifetime?.fileHandleForWriting.closeFile(); lifetime = nil
        let files = FileManager.default, launcher = directory.appendingPathComponent("opengcua")
        if files.fileExists(atPath: launcher.path) { try files.removeItem(at: launcher) }
        if let socketDirectory { try files.removeItem(at: socketDirectory) }
        socketDirectory = nil
    }
}
