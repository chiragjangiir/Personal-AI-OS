import Darwin
import Foundation

public struct AndroidCommand: Sendable {
    public let executable: URL
    public let arguments: [String]
    public var environment: [String: String] = [:]
    public init(_ executable: URL, _ arguments: [String], environment: [String: String] = [:]) {
        self.executable = executable; self.arguments = arguments; self.environment = environment
    }
}

public enum AndroidHostError: LocalizedError {
    case verification(String), command(String, Int32, String), unavailable(String)
    public var errorDescription: String? {
        switch self {
        case .verification(let name): return "手机执行器下载校验失败：\(name)"
        case .command(let name, let code, let output): return "\(name) 退出（\(code)）：\(output)"
        case .unavailable(let reason): return reason
        }
    }
}

public protocol AndroidChild: AnyObject, Sendable {
    var isRunning: Bool { get }
    func terminate()
    func wait() async -> Int32
}

public protocol AndroidProcessRunning: Sendable {
    func launch(_ command: AndroidCommand, log: URL) throws -> any AndroidChild
    func watchVirtualMachine(_ stopCommand: AndroidCommand, log: URL) throws -> any AndroidChild
    func output(_ command: AndroidCommand, timeout: Duration) async throws -> String
    func waitForListener(port: UInt16, child: any AndroidChild) async throws
    func listenerAvailable(port: UInt16) throws -> Bool
    func checkPorts(_ ports: [UInt16]) throws
}

/// Foundation's process boundary. It never discovers or signals another application's children.
public final class AndroidProcesses: AndroidProcessRunning, @unchecked Sendable {
    private let temporary: URL
    private let guardian: URL?
    public init(temporary: URL, guardian: URL? = nil) { self.temporary = temporary; self.guardian = guardian }
    public func launch(_ command: AndroidCommand, log: URL) throws -> any AndroidChild {
        try spawn(command, log: log, guardChild: true)
    }
    public func watchVirtualMachine(_ stopCommand: AndroidCommand, log: URL) throws -> any AndroidChild {
        guard let guardian else { throw AndroidHostError.unavailable("手机执行器缺少进程守护程序") }
        let command = AndroidCommand(guardian, ["--vm", String(getpid()), stopCommand.executable.path] + stopCommand.arguments,
                                     environment: stopCommand.environment)
        // Three helper commands each allow 65 seconds; give their complete shutdown five seconds to exit.
        return try spawn(command, log: log, guardChild: false, terminationGrace: 200)
    }
    private func spawn(_ command: AndroidCommand, log: URL, guardChild: Bool, terminationGrace: Double = 45) throws -> any AndroidChild {
        try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try FileHandle(forWritingTo: log); defer { try? handle.close() }
        try handle.seekToEnd()
        let process = Process()
        process.executableURL = command.executable
        process.arguments = command.arguments
        process.qualityOfService = .userInitiated
        process.environment = ProcessInfo.processInfo.environment.merging(command.environment) { _, value in value }
        process.standardInput = FileHandle.nullDevice; process.standardOutput = handle; process.standardError = handle
        let child = Child(process, terminationGrace: terminationGrace)
        process.terminationHandler = { [weak child] process in
            child?.finish(process.terminationReason == .uncaughtSignal ? -process.terminationStatus : process.terminationStatus)
        }
        try process.run()
        if guardChild, let guardian {
            let watcher = Process()
            watcher.executableURL = guardian
            watcher.arguments = [String(getpid()), String(process.processIdentifier)]
            watcher.standardInput = FileHandle.nullDevice; watcher.standardOutput = handle; watcher.standardError = handle
            do { try watcher.run(); child.guardian = watcher }
            catch {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                throw error
            }
        }
        return child
    }
    public func output(_ command: AndroidCommand, timeout: Duration = .seconds(30)) async throws -> String {
        try Task.checkCancellation()
        let log = temporary.appendingPathComponent(UUID().uuidString + ".log")
        let child = try launch(command, log: log)
        let deadline = Task {
            do { try await Task.sleep(for: timeout) } catch { return }
            child.terminate()
        }
        defer { deadline.cancel(); try? FileManager.default.removeItem(at: log) }
        let code = await withTaskCancellationHandler { await child.wait() } onCancel: { child.terminate() }
        try Task.checkCancellation()
        let output = try String(contentsOf: log, encoding: .utf8)
        guard code == 0 else { throw AndroidHostError.command(command.executable.lastPathComponent, code, output) }
        return output
    }
    public func waitForListener(port: UInt16, child: any AndroidChild) async throws {
        for _ in 0..<100 {
            try Task.checkCancellation()
            guard child.isRunning else { throw AndroidHostError.unavailable("手机执行器进程在监听端口 \(port) 前退出") }
            if try listenerAvailable(port: port) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw AndroidHostError.unavailable("手机执行器本地端口 \(port) 启动超时")
    }
    public func listenerAvailable(port: UInt16) throws -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = port.bigEndian
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if result == 0 { return true }
        if errno == ECONNREFUSED { return false }
        throw POSIXError(POSIXErrorCode(rawValue: errno)!)
    }
    public func checkPorts(_ ports: [UInt16]) throws {
        var descriptors: [Int32] = []
        defer { descriptors.forEach { close($0) } }
        for port in ports {
            let descriptor = socket(AF_INET, SOCK_STREAM, 0)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
            descriptors.append(descriptor)
            var reuse: Int32 = 1
            setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
            address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = port.bigEndian
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
        }
    }
    private final class Child: AndroidChild, @unchecked Sendable {
        let process: Process
        var guardian: Process?
        let lock = NSLock()
        var exit: Int32?
        var waiters: [CheckedContinuation<Int32, Never>] = []
        let terminationGrace: Double
        init(_ process: Process, terminationGrace: Double) { self.process = process; self.terminationGrace = terminationGrace }
        var isRunning: Bool { process.isRunning }
        func terminate() {
            if process.isRunning {
                process.terminate()
                let process = process
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + terminationGrace) {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
            }
        }
        func finish(_ status: Int32) {
            let pending = lock.withLock { exit = status; let pending = waiters; waiters = []; return pending }
            pending.forEach { $0.resume(returning: status) }
        }
        func wait() async -> Int32 {
            await withCheckedContinuation { continuation in
                lock.withLock {
                    if let exit { continuation.resume(returning: exit) } else { waiters.append(continuation) }
                }
            }
        }
    }
}
