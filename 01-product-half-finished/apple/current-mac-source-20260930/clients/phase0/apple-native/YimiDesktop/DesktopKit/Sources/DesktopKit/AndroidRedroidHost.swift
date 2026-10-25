import Foundation

public struct AndroidHostStatus: Encodable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case running, starting, stopped, notInstalled = "not_installed" }
    public let schema = "paios.mac-android.v1"
    public let state: State
    public let adb_port = AndroidVirtualDevice.adbPort
    public let last_error: String?
    public init(state: State, error: String? = nil) { self.state = state; last_error = error }
}

/// Owns the persistent VM lifecycle; normal starts only start existing systemd units.
public actor AndroidRedroidHost {
    public let device: AndroidVirtualDevice
    private let processes: any AndroidProcessRunning
    private let installRuntime: @Sendable () async throws -> Void
    private let installApps: @Sendable () async throws -> Void
    private let installViewer: @Sendable () async throws -> Void
    private var generation = 0
    private var enabled: Bool
    private var installation: Task<Void, Error>?, startup: Task<Void, Error>?, stopping: Task<Void, Error>?
    private var guardian: (any AndroidChild)?, proxy: (any AndroidChild)?, adbServer: (any AndroidChild)?, viewer: (any AndroidChild)?
    private var ready = false, ownsVM = false, errandActive = false
    private var lastError: String?, step = "安装"
    private var errandActivity: (any NSObjectProtocol)?
    public init(device: AndroidVirtualDevice, enabled: Bool = false, processes: any AndroidProcessRunning,
                catalog: URL? = nil, installRuntime: (@Sendable () async throws -> Void)? = nil,
                installApps: (@Sendable () async throws -> Void)? = nil,
                installViewer: (@Sendable () async throws -> Void)? = nil) {
        self.device = device; self.processes = processes; self.enabled = enabled
        let installer = AndroidRedroidInstaller(device: device, processes: processes)
        self.installViewer = installViewer ?? { try await installer.install(.scrcpy) }
        self.installRuntime = installRuntime ?? { try await installer.install() }
        self.installApps = installApps ?? {
            guard let catalog else { throw AndroidHostError.unavailable("手机应用安装目录未配置") }
            let provisioner = AndroidPhoneProvisioner(device: device, processes: processes, catalog: catalog)
            try await provisioner.installMissing(packages: ["com.aliyun.tongyi", "com.mobilerun.portal", "io.appium.settings"])
            try await provisioner.prepareExecutor()
        }
    }
    public func status() async -> AndroidHostStatus {
        guard device.installed else { return AndroidHostStatus(state: installation == nil ? .notInstalled : .starting, error: lastError) }
        if installation != nil || startup != nil { return AndroidHostStatus(state: .starting, error: lastError) }
        return await readStatus()
    }
    private func readStatus() async -> AndroidHostStatus {
        do {
            let vm = try await vmState()
            if vm == "Stopped" { return AndroidHostStatus(state: .stopped, error: lastError) }
            let running: Bool
            if vm == "Running" { running = await androidReady() } else { running = false }
            return AndroidHostStatus(state: running ? .running : .starting, error: lastError)
        } catch { return AndroidHostStatus(state: .stopped, error: lastError ?? error.localizedDescription) }
    }
    public func needsShutdown() -> Bool {
        installation != nil || startup != nil || stopping != nil || ownsVM || [viewer, guardian, proxy, adbServer].contains { $0?.isRunning == true }
    }
    public func enable() async throws {
        guard stopping == nil else { throw AndroidHostError.unavailable("安卓手机正在停止") }
        let task: Task<Void, Error>
        if let installation { task = installation }
        else {
            lastError = nil
            let current = generation
            task = Task {
                defer { installation = nil }
                do {
                    try validate(current)
                    if !device.installed { try attachGuardian(); try await installRuntime() }
                    try validate(current); enabled = true
                    try await prepareStart(current)
                    if let startup {
                        try await withTaskCancellationHandler { try await startup.value } onCancel: { startup.cancel() }
                    }
                    try validate(current)
                    try await installApps()
                    try validate(current)
                } catch {
                    enabled = false
                    if stopping == nil {
                        if lastError == nil, !(error is CancellationError) { lastError = error.localizedDescription }
                        do { try await Task { try await shutdownVM() }.value }
                        catch { lastError = [lastError, error.localizedDescription].compactMap { $0 }.joined(separator: "\n") }
                        await terminateChildren()
                    }
                    throw error
                }
            }
            installation = task
        }
        try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    public func disable() async throws { enabled = false; try await stop() }
    private func validate(_ current: Int) throws {
        try Task.checkCancellation()
        guard generation == current, stopping == nil else { throw CancellationError() }
    }
    private func prepareStart(_ current: Int) async throws {
        if startup == nil {
            let state = await readStatus()
            try validate(current)
            guard enabled else { throw AndroidHostError.unavailable("安卓手机尚未开启") }
            if startup == nil && (!ready || state.state != .running || proxy?.isRunning != true) { scheduleStart() }
        }
    }
    /// The control request never installs or recreates a persistent device.
    public func requestStart() async throws -> AndroidHostStatus {
        if !device.installed || installation != nil { return await status() }
        guard enabled else { throw AndroidHostError.unavailable("安卓手机尚未开启") }
        let current = generation
        try validate(current)
        try await prepareStart(current)
        return await status()
    }
    public func start() async throws {
        let current = generation
        if let installation { try await installation.value }
        try validate(current)
        let response = try await requestStart()
        guard response.state != .notInstalled else { throw AndroidHostError.unavailable("请先安装安卓手机") }
        if let startup { try await startup.value }
        try validate(current)
    }
    private func scheduleStart() {
        lastError = nil
        startup = Task {
            let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "启动依米手机执行器")
            let timer = Task { try await Task.sleep(for: .seconds(180)); timeoutStartup() }
            defer { timer.cancel(); ProcessInfo.processInfo.endActivity(activity); startup = nil }
            do { try await boot() }
            catch {
                let failure = lastError ?? (error is CancellationError ? nil : "\(step)：\(error.localizedDescription)")
                if stopping == nil {
                    do { try await Task { try await shutdownVM() }.value } catch { lastError = [failure, error.localizedDescription].compactMap { $0 }.joined(separator: "\n") }
                    await terminateChildren(); if lastError == nil { lastError = failure }
                }
                throw error
            }
        }
    }
    private func timeoutStartup() { lastError = "安卓手机启动超时：" + step; startup?.cancel() }
    private func vmState() async throws -> String {
        try await processes.output(device.lima(["list", "--format", "{{.Status}}", device.instance]), timeout: .seconds(5)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func androidReady() async -> Bool {
        do {
            guard try processes.listenerAvailable(port: UInt16(AndroidVirtualDevice.adbServerPort)) else { return false }
            return try await processes.output(device.adb(["shell", "getprop", "sys.boot_completed"]), timeout: .seconds(3))
                .trimmingCharacters(in: .whitespacesAndNewlines) == "1"
        } catch { return false }
    }
    private func attachGuardian() throws {
        if guardian?.isRunning != true { guardian = try processes.watchVirtualMachine(device.lima(["stop", device.instance]), log: device.file("logs/guardian.log")) }
        ownsVM = true
    }
    private func boot() async throws {
        try Task.checkCancellation()
        step = "虚拟机守护进程"
        try attachGuardian()
        step = "启动虚拟机"
        if try await vmState() != "Running" {
            try processes.checkPorts([UInt16(AndroidVirtualDevice.adbPort)])
            _ = try await processes.output(device.lima(["start", "--tty=false", "--timeout=170s", device.instance]), timeout: .seconds(170))
        }
        step = "modules → binderfs → permissions → Docker → Redroid"
        _ = try await processes.output(device.lima(["shell", device.instance, "--", "sudo", "systemctl", "start", "redroid.service"]), timeout: .seconds(60))
        step = "HTTP 代理 127.0.0.1:18080"
        if proxy?.isRunning != true {
            try processes.checkPorts([18080])
            proxy = try processes.launch(device.command("tools/gost/gost", ["-C", device.file("gost.yml").path]), log: device.file("logs/gost.log"))
            try await processes.waitForListener(port: 18080, child: proxy!)
        }
        step = "ADB 服务 127.0.0.1:5039"
        if !(try processes.listenerAvailable(port: UInt16(AndroidVirtualDevice.adbServerPort))) {
            try processes.checkPorts([UInt16(AndroidVirtualDevice.adbServerPort)])
            var command = device.adb([])
            command = AndroidCommand(command.executable, ["-L", "tcp:\(AndroidVirtualDevice.adbServerPort)", "server", "nodaemon"], environment: command.environment)
            adbServer = try processes.launch(command, log: device.file("logs/adb.log"))
            try await processes.waitForListener(port: UInt16(AndroidVirtualDevice.adbServerPort), child: adbServer!)
        }
        step = "adbd / sys.boot_completed=1"
        while !(await androidReady()) {
            try Task.checkCancellation()
            _ = try await processes.output(device.adb(["connect", "127.0.0.1:\(AndroidVirtualDevice.adbPort)"]), timeout: .seconds(3))
            if await androidReady() { break }
            try await Task.sleep(for: .seconds(1))
        }
        step = "安卓网络"
        try await AndroidGuestNetwork(device: device, processes: processes).prepare()
        try Task.checkCancellation()
        ready = true; setErrandActive(errandActive)
    }
    public func setErrandActive(_ active: Bool) {
        errandActive = active
        if active && ready {
            if errandActivity == nil { errandActivity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "依米正在手机上办事") }
        } else if let activity = errandActivity { ProcessInfo.processInfo.endActivity(activity); errandActivity = nil }
    }
    public func stop() async throws {
        if let stopping { try await stopping.value; return }
        generation += 1
        installation?.cancel(); startup?.cancel()
        let task = Task { try await stopDevice() }; stopping = task
        defer { stopping = nil }; try await task.value
    }
    private func stopDevice() async throws {
        if let installation { _ = await installation.result }
        if let startup { _ = await startup.result }
        do { try await shutdownVM() } catch { await terminateChildren(); throw error }
        await terminateChildren()
    }
    private func shutdownVM() async throws {
        ready = false; setErrandActive(errandActive)
        guard ownsVM else { return }
        guard FileManager.default.fileExists(atPath: device.file("lima/\(device.instance)/lima.yaml").path) else { ownsVM = false; return }
        var failures: [String] = []
        do { if try await vmState() == "Stopped" { ownsVM = false; return } }
        catch { failures.append(error.localizedDescription) }
        do { _ = try await processes.output(device.lima(["shell", device.instance, "--", "sudo", "systemctl", "stop", "redroid.service"]), timeout: .seconds(60)) }
        catch { failures.append(error.localizedDescription) }
        do {
            _ = try await processes.output(device.lima(["stop", device.instance]), timeout: .seconds(45))
            ownsVM = false
        } catch { failures.append(error.localizedDescription) }
        if !failures.isEmpty { throw AndroidHostError.unavailable(failures.joined(separator: "\n")) }
    }
    private func terminateChildren() async {
        ready = false; setErrandActive(errandActive)
        let children = [viewer, proxy, adbServer, guardian].compactMap { $0 }
        viewer = nil; proxy = nil; adbServer = nil; guardian = nil
        for child in children { child.terminate() }
        for child in children { _ = await child.wait() }
    }
    public func showPhone() async throws {
        let current = generation
        try await start()
        guard await status().state == .running else { throw AndroidHostError.unavailable("请先启动安卓手机") }
        try validate(current)
        if viewer?.isRunning == true { return }
        try await installViewer()
        try validate(current)
        if viewer?.isRunning == true { return }
        var command = device.command("tools/scrcpy/scrcpy", ["-s", "127.0.0.1:\(AndroidVirtualDevice.adbPort)", "--window-title", "依米 · 手机", "--no-audio", "--max-fps=30"])
        command.environment["ADB"] = device.adbExecutable.path
        command.environment["SCRCPY_SERVER_PATH"] = device.file("tools/scrcpy/scrcpy-server").path
        viewer = try processes.launch(command, log: device.file("logs/scrcpy.log"))
    }
    public func showLoginPhone(provision: @escaping @Sendable () async throws -> Void) async throws {
        guard device.installed, enabled else { throw AndroidHostError.unavailable("请先开启安卓手机") }
        let current = generation
        try await start()
        try validate(current)
        let task = Task { try await provision() }; installation = task
        do { try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
        catch { installation = nil; throw error }
        installation = nil; try validate(current); try await showPhone()
    }
}
