import Foundation

/// Installs verified host tools and provisions the single persistent Lima device.
public struct AndroidRedroidInstaller: Sendable {
    public let device: AndroidVirtualDevice
    private let processes: any AndroidProcessRunning
    private let session: URLSession
    private let archives: URL?
    public init(device: AndroidVirtualDevice, processes: any AndroidProcessRunning, session: URLSession = .shared, archives: URL? = nil) {
        self.device = device; self.processes = processes; self.session = session; self.archives = archives
    }
    public func install() async throws {
        try device.create()
        for artifact in AndroidArtifact.runtime { try await install(artifact) }
        let limactl = device.file("tools/lima/bin/limactl").path
        _ = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/codesign"), ["--verify", "--strict", limactl]), timeout: .seconds(30))
        let entitlements = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/codesign"), ["-d", "--entitlements", ":-", limactl]), timeout: .seconds(30))
        guard let start = entitlements.range(of: "<plist"), let end = entitlements.range(of: "</plist>"),
              let plist = try PropertyListSerialization.propertyList(from: Data(entitlements[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              plist["com.apple.security.virtualization"] as? Bool == true else {
            throw AndroidHostError.unavailable("Lima 缺少 Apple virtualization entitlement")
        }
        let fm = FileManager.default
        let instance = device.file("lima/\(device.instance)")
        if device.installed { return }
        let image = try await download(.ubuntu)
        let config = device.file("cache/redroid-bootstrap.json")
        if !fm.fileExists(atPath: instance.appendingPathComponent("lima.yaml").path) {
            try configuration(image: image).write(to: config, options: .atomic)
            try await lima(["create", "--name=\(device.instance)", "--tty=false", config.path])
        }
        try await lima(["start", "--tty=false", device.instance])
        let bootstrap = Bundle.module.url(forResource: "redroid-bootstrap", withExtension: "sh")!
        try await lima(["copy", bootstrap.path, "\(device.instance):/tmp/yimi-redroid-bootstrap.sh"])
        try await lima(["shell", device.instance, "sudo", "sh", "/tmp/yimi-redroid-bootstrap.sh"], timeout: .seconds(1800))
        let cmdline = try await processes.output(device.lima(["shell", device.instance, "sudo", "cat", "/tmp/yimi-redroid-cmdline"]), timeout: .seconds(30))
        let kernel = device.file("cache/redroid-kernel"), initrd = device.file("cache/redroid-initrd")
        try await lima(["copy", "\(device.instance):/tmp/yimi-redroid-kernel", kernel.path])
        try await lima(["copy", "\(device.instance):/tmp/yimi-redroid-initrd", initrd.path])
        try await lima(["stop", device.instance])
        // Lima's VZ driver reads these instance files on every direct-kernel boot.
        for (source, name) in [(kernel, "kernel"), (initrd, "initrd")] {
            let destination = instance.appendingPathComponent(name)
            if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
            try fm.copyItem(at: source, to: destination)
        }
        let commandLine = cmdline.trimmingCharacters(in: .whitespacesAndNewlines)
        try Data(commandLine.utf8).write(to: instance.appendingPathComponent("kernel.cmdline"), options: .atomic)
        let direct = try configuration(image: image, kernel: kernel, initrd: initrd, cmdline: commandLine)
        try direct.write(to: instance.appendingPathComponent("lima.yaml"), options: .atomic)
        try await lima(["start", "--tty=false", device.instance])
        try await lima(["copy", bootstrap.path, "\(device.instance):/tmp/yimi-redroid-bootstrap.sh"])
        try await lima(["shell", device.instance, "sudo", "sh", "/tmp/yimi-redroid-bootstrap.sh", "finalize",
                        AndroidGuestNetwork.downloadProxyConfiguration()], timeout: .seconds(1800))
        try Data("redroid-13.0.0-arm64\n".utf8).write(to: device.file("redroid-installed"), options: .atomic)
    }
    public func install(_ artifact: AndroidArtifact) async throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: device.file(artifact.required).path) { return }
        let archive = try await download(artifact)
        let work = device.file("cache/.extract-" + UUID().uuidString)
        try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: work) }
        _ = try await processes.output(AndroidCommand(URL(fileURLWithPath: "/usr/bin/tar"), ["-xf", archive.path, "-C", work.path]), timeout: .seconds(180))
        let destination = device.file(artifact.destination), package = work.appendingPathComponent(artifact.unpacked)
        let required = String(artifact.required.dropFirst(artifact.destination.count + 1))
        guard fm.fileExists(atPath: package.appendingPathComponent(required).path) else { throw CocoaError(.fileReadCorruptFile) }
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.moveItem(at: package, to: destination)
    }
    private func download(_ artifact: AndroidArtifact) async throws -> URL {
        let fm = FileManager.default
        let destination = device.file("cache/" + artifact.url.lastPathComponent)
        if let archives {
            let archive = archives.appendingPathComponent(artifact.url.lastPathComponent)
            try artifact.verify(archive)
            return archive
        }
        if fm.fileExists(atPath: destination.path) { try artifact.verify(destination); return destination }
        let (download, response) = try await session.download(from: artifact.url)
        defer { try? fm.removeItem(at: download) }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url?.scheme == "https" else { throw URLError(.badServerResponse) }
        try artifact.verify(download)
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.moveItem(at: download, to: destination)
        return destination
    }
    private func lima(_ arguments: [String], timeout: Duration = .seconds(300)) async throws {
        _ = try await processes.output(device.lima(arguments), timeout: timeout)
    }
    private func configuration(image: URL, kernel: URL? = nil, initrd: URL? = nil, cmdline: String = "") throws -> Data {
        var source: [String: Any] = ["location": image.path, "arch": "aarch64", "digest": "sha256:" + AndroidArtifact.ubuntu.checksum]
        if let kernel, let initrd {
            source["kernel"] = ["location": kernel.path, "cmdline": cmdline]
            source["initrd"] = ["location": initrd.path]
        }
        let config: [String: Any] = ["vmType": "vz", "arch": "aarch64", "cpus": 2, "memory": "3GiB", "disk": "8GiB",
            "images": [source], "mounts": [], "containerd": ["system": false, "user": false],
            "ssh": ["localPort": 0, "loadDotSSHPubKeys": false], "propagateProxyEnv": false,
            "vmOpts": ["vz": ["rosetta": ["enabled": false]]],
            "portForwards": [["guestPort": 5555, "hostPort": AndroidVirtualDevice.adbPort, "guestIP": "127.0.0.1", "hostIP": "127.0.0.1", "static": true],
                ["guestPortRange": [1, 65535], "guestIP": "0.0.0.0", "proto": "any", "ignore": true]]]
        return try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }
}
