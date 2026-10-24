import AppKit
@main enum Activate {
    static func main() { run("activate", counts: [0]) { _ in
        let app = try wechat()
        let previous = try focusedPID()
        do {
            try require(app.activate(), "WeChat activation refused")
            Thread.sleep(forTimeInterval: 0.4)
            _ = try front()
        } catch {
            emit(["ok": false, "previous_pid": Int(previous), "error": String(describing: error)])
            exit(1)
        }
        return ["previous_pid": Int(previous),
                "windows": windows(app).map(windowJSON)]
    } }
}
