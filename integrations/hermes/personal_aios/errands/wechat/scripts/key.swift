import AppKit
@main enum Key {
    static func main() { run("key <return|escape|find|select-all>", counts: [1]) { args in
        let codes: [String: CGKeyCode] = ["return": 36, "escape": 53, "find": 3, "select-all": 0]
        guard let code = codes[args[0]] else { throw Failure.message("Unsupported key") }
        try requireNoPermissionDialog()
        _ = try front()
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
            if ["find", "select-all"].contains(args[0]) { event.flags = .maskCommand }
            event.post(tap: .cghidEventTap)
        }
        return ["posted": true, "key": args[0]]
    } }
}
