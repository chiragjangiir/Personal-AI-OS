import AppKit
import DesktopKit
import Combine

@MainActor final class DesktopAndroidHost: ObservableObject {
    let host: AndroidRedroidHost
    @Published private(set) var state = AndroidHostStatus(state: .notInstalled)
    @Published private(set) var enabled = UserDefaults.standard.bool(forKey: "desktop.androidExecutorEnabled")
    private let device = AndroidVirtualDevice()
    private let processes: AndroidProcesses
    private var control: AndroidControlSocket?
    init() {
        processes = AndroidProcesses(temporary: device.file("logs/commands"), guardian: Bundle.main.resourceURL!.appendingPathComponent("android-process-guard"))
        host = AndroidRedroidHost(device: device, enabled: UserDefaults.standard.bool(forKey: "desktop.androidExecutorEnabled"),
            processes: processes, catalog: Bundle.main.resourceURL!.appendingPathComponent("phone-apks.json"))
    }
    func activate() throws {
        if control != nil { return }
        let helper = Bundle.main.resourceURL!.appendingPathComponent("android-control")
        let destination = device.file("control")
        try FileManager.default.createDirectory(at: device.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let bytes = try Data(contentsOf: helper)
        try bytes.write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        let host = host
        control = try AndroidControlSocket(directory: device.root) { action in
            let status: AndroidHostStatus
            if action == "start" { status = try await host.requestStart() } else { status = await host.status() }
            return try JSONEncoder().encode(status)
        }
    }
    func setEnabled(_ enabled: Bool) async throws {
        if !enabled { self.enabled = false; UserDefaults.standard.set(false, forKey: "desktop.androidExecutorEnabled") }
        if enabled { try await host.enable() } else { try await host.disable() }
        if enabled { self.enabled = true; UserDefaults.standard.set(true, forKey: "desktop.androidExecutorEnabled") }
        await refresh()
    }
    func refresh() async { state = await host.status() }
    var hasShownLoginPhone: Bool { UserDefaults.standard.bool(forKey: "desktop.androidExecutorLoginShown") }
    func showPhone() async throws { try await host.showPhone() }
    func showLoginPhone() async throws {
        try await host.showLoginPhone {}
        UserDefaults.standard.set(true, forKey: "desktop.androidExecutorLoginShown")
    }
    func shutdown() async throws { try await host.stop() }
    func requiresShutdown() async -> Bool { await host.needsShutdown() }
}

extension DesktopAppModel {
    func syncAndroidErrandActivity() {
        Task { await androidHost?.host.setErrandActive(!errands.isEmpty) }
    }
}
