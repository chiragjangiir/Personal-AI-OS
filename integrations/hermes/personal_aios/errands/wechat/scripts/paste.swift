import AppKit
// WeChat 4.x ignores CGEvent Cmd-V; use System Events (wechat-bridge-mac, MIT).
@main enum Paste {
    static func main() { run("paste", counts: [0]) { _ in
        try requireNoPermissionDialog()
        _ = try front()
        try process("/usr/bin/osascript", ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        return ["posted": true]
    } }
}
