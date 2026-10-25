import AppKit
@main enum Activate {
    static func main() { run("activate", counts: [0]) { _ in
        let app = try wechat()
        let previous = try frontmostPID()
        do {
            if windows(app).isEmpty {
                try process("/usr/bin/open", ["-a", "WeChat"])
            }
            try require(app.activate(), "WeChat activation refused")
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.4))
            _ = try front()
            try require(!windows(app).isEmpty, "WeChat has no visible window after reopening")
        } catch {
            emit(["ok": false, "previous_pid": Int(previous), "error": String(describing: error)])
            exit(1)
        }
        return ["previous_pid": Int(previous),
                "windows": windows(app).map(windowJSON)]
    } }
}
