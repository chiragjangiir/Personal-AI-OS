import AppKit
@main enum Restore {
    static func main() { run("restore <previous-pid>", counts: [1]) { args in
        guard let pid = Int32(args[0]), pid > 0 else { throw Failure.message("Expected positive PID") }
        guard let app = NSRunningApplication(processIdentifier: pid) else { throw Failure.message("Previous app has exited") }
        try require(app.activate(), "Previous app activation refused")
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.4))
        try require(try frontmostPID() == pid, "Previous app did not become frontmost")
        return ["restored_pid": pid]
    } }
}
