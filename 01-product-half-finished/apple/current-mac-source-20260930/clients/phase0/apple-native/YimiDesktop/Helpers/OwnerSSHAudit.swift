import Foundation
import Darwin

// The app alone holds the pipe writer. Its death revokes the whole process tree.
func supervise() throws {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[2])
    child.arguments = Array(CommandLine.arguments.dropFirst(3))
    child.standardInput = FileHandle.nullDevice
    try child.run()
    defer {
        var owned: Set<Int32> = child.isRunning ? [child.processIdentifier] : []
        for pid in owned { kill(pid, SIGSTOP) }
        while !owned.isEmpty {
            let pipe = Pipe(), ps = Process()
            ps.executableURL = URL(fileURLWithPath: "/bin/ps")
            ps.arguments = ["-axo", "pid=,ppid="]; ps.standardOutput = pipe
            do { try ps.run() } catch {
                kill(child.processIdentifier, SIGKILL); child.waitUntilExit()
                fputs("Cannot enumerate owned SSH children: \(error.localizedDescription)\n", stderr); exit(1)
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile(); ps.waitUntilExit()
            guard ps.terminationStatus == 0 else {
                kill(child.processIdentifier, SIGKILL); child.waitUntilExit()
                fputs("Cannot enumerate owned SSH children\n", stderr); exit(1)
            }
            let rows = String(decoding: data, as: UTF8.self).split(separator: "\n")
                .map { $0.split(whereSeparator: { $0.isWhitespace }).compactMap { Int32($0) } }
            let added = rows.filter { $0.count == 2 && owned.contains($0[1]) && !owned.contains($0[0]) }.map { $0[0] }
            if added.isEmpty { break }
            for pid in added { kill(pid, SIGSTOP); owned.insert(pid) }
        }
        for pid in owned { kill(pid, SIGKILL) }
        child.waitUntilExit()
    }
    var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
    while child.isRunning {
        let result = poll(&input, 1, 100)
        if result < 0 {
            if errno == EINTR { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno)!)
        }
        if result > 0 {
            var byte: UInt8 = 0
            if read(STDIN_FILENO, &byte, 1) <= 0 { return }
        }
    }
    throw CocoaError(.executableRuntimeMismatch)
}

if CommandLine.arguments.dropFirst().first == "--supervise" {
    do { try supervise(); exit(0) }
    catch { fputs("SSH supervisor failed: \(error.localizedDescription)\n", stderr); exit(1) }
}

// Record command requests, never stdout/stderr. A failed audit prevents execution.
do {
    let command = ProcessInfo.processInfo.environment["SSH_ORIGINAL_COMMAND"] ?? ""
    let path = CommandLine.arguments[1]
    let descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno)!) }
    let data = try JSONSerialization.data(withJSONObject: ["at": ISO8601DateFormatter().string(from: Date()), "command": command]) + Data([10])
    guard data.withUnsafeBytes({ write(descriptor, $0.baseAddress, $0.count) }) == data.count else { throw POSIXError(.EIO) }
    close(descriptor)
    let shell = String(cString: getpwuid(getuid())!.pointee.pw_shell)
    let arguments: [UnsafeMutablePointer<CChar>?] = [shell, "-lc", command].map { $0.withCString { strdup($0) } } + [nil]
    arguments.withUnsafeBufferPointer { execv(shell, $0.baseAddress!) }
    throw POSIXError(POSIXErrorCode(rawValue: errno)!)
} catch {
    fputs("SSH command audit or execution failed: \(error.localizedDescription)\n", stderr); exit(1)
}
