import ApplicationServices
@main enum WriteAX {
    static func main() { run("ax-write <search|input> <exact-AXTextArea-title> <text>", counts: [3]) { args in
        try require(["search", "input"].contains(args[0]), "Expected search or input")
        try require(!args[1].isEmpty && (args[0] == "search" ? args[1] == "搜索" : args[1] != "搜索"), "Invalid AXTextArea title")
        let inputs = try axWindows().flatMap(descendants).filter {
            string($0, kAXRoleAttribute) == kAXTextAreaRole && string($0, kAXTitleAttribute) == args[1]
        }
        try require(inputs.count == 1, "Expected one exact AXTextArea; found \(inputs.count)")
        let input = inputs[0]
        let status = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, args[2] as CFString)
        let actual = string(input, kAXValueAttribute)
        try require(status == .success && actual == args[2], "AX write/read-back mismatch (\(status.rawValue)); inspect draft")
        return ["target": args[0], "title": args[1], "text": actual, "read_back_matches": true]
    } }
}
