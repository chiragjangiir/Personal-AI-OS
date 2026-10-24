import Darwin
import Foundation

/// Watches an app-owned PID without wrapping it or hiding its exit status.
@main enum AndroidProcessGuard {
    static func main() {
        if CommandLine.arguments[1] == "--vm" { watchVirtualMachine(); return }
        let parent = Int32(CommandLine.arguments[1])!, child = Int32(CommandLine.arguments[2])!
        let queue = DispatchQueue(label: "yimi.android.child")
        let stop: @Sendable () -> Void = {
            kill(child, SIGTERM)
            queue.asyncAfter(deadline: .now() + 45) {
                kill(child, SIGKILL)
            }
        }
        let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: queue)
        parentExit.setEventHandler(handler: stop)
        let signals = [SIGTERM, SIGINT, SIGHUP].map { number -> any DispatchSourceProtocol in
            // Keep the watcher alive until its owned process exits.
            _ = signal(number) { _ in }
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler(handler: stop); source.resume(); return source
        }
        let childExit = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: queue)
        childExit.setEventHandler { exit(0) }; childExit.resume()
        parentExit.resume()
        if getppid() != parent { stop() }
        if kill(child, 0) != 0 { return }
        withExtendedLifetime(signals + [parentExit, childExit]) { dispatchMain() }
    }

    /// Lima's start command exits before its VM; the parent lease covers that daemon lifetime.
    private static func watchVirtualMachine() {
        let parent = Int32(CommandLine.arguments[2])!, executable = CommandLine.arguments[3]
        let instance = CommandLine.arguments[5]
        let queue = DispatchQueue(label: "yimi.android.vm")
        let stop: @Sendable () -> Void = {
            var failed = false
            do {
                let state = try run(executable, ["list", "--format", "{{.Status}}", instance], capture: true)
                if state.trimmingCharacters(in: .whitespacesAndNewlines) == "Stopped" { exit(0) }
            } catch { failed = true; fputs("VM state: \(error.localizedDescription)\n", stderr) }
            do { _ = try run(executable, ["shell", instance, "--", "sudo", "systemctl", "stop", "redroid.service"]) }
            catch { failed = true; fputs("Android shutdown: \(error.localizedDescription)\n", stderr) }
            do { _ = try run(executable, ["stop", instance]) }
            catch { failed = true; fputs("VM shutdown: \(error.localizedDescription)\n", stderr) }
            exit(failed ? 1 : 0)
        }
        let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: queue)
        parentExit.setEventHandler(handler: stop); parentExit.resume()
        let signals = [SIGTERM, SIGINT, SIGHUP].map { number -> any DispatchSourceProtocol in
            _ = signal(number) { _ in }
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler(handler: stop); source.resume(); return source
        }
        fputs("VM guardian ready\n", stdout); fflush(stdout)
        if getppid() != parent { queue.async(execute: stop) }
        withExtendedLifetime(signals + [parentExit]) { dispatchMain() }
    }

    private static func run(_ executable: String, _ arguments: [String], capture: Bool = false) throws -> String {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = capture ? pipe.fileHandleForWriting : FileHandle.standardError
        process.standardError = FileHandle.standardError
        try process.run()
        if capture { try pipe.fileHandleForWriting.close() }
        let timeout = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timeout.schedule(deadline: .now() + 65)
        timeout.setEventHandler { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
        timeout.resume(); defer { timeout.cancel() }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "AndroidProcessGuard", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "limactl \(arguments[0]) 退出（\(process.terminationStatus)）"])
        }
        return capture ? String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self) : ""
    }
}
