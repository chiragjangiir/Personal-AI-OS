import AppKit
@main enum Screenshot {
    static func main() { run("screenshot <window-id> <absolute-new-png-path>", counts: [2]) { args in
        guard let id = UInt32(args[0]), id > 0, args[1].hasPrefix("/"), args[1].hasSuffix(".png") else {
            throw Failure.message("Expected positive window ID and absolute PNG path")
        }
        try require(!FileManager.default.fileExists(atPath: args[1]), "Output already exists")
        let item = try ownedWindow(id)
        try require(CGPreflightScreenCaptureAccess(), "Screen Recording permission required")
        try process("/usr/sbin/screencapture", ["-x", "-o", "-l", String(id), args[1]])
        return ["path": args[1], "window": windowJSON(item), "bytes": try Data(contentsOf: URL(fileURLWithPath: args[1])).count]
    } }
}
