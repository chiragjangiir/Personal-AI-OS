import AppKit
import ApplicationServices

enum Failure: Error { case message(String) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw Failure.message(message) }
}
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func run(_ usage: String, counts: [Int], _ body: ([String]) throws -> [String: Any]) {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["--help"] { emit(["ok": true, "usage": usage]); return }
    do {
        try require(counts.contains(args.count), "usage: " + usage)
        emit(try body(args).merging(["ok": true]) { _, new in new })
    } catch {
        emit(["ok": false, "error": String(describing: error)])
        exit(1)
    }
}
func wechat() throws -> NSRunningApplication {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat").first else {
        throw Failure.message("WeChat is not running")
    }
    return app
}
func frontmostPID() throws -> pid_t {
    // WeChat 4.1.15 can make the system-wide AX focus query fail with -25204.
    if let app = NSWorkspace.shared.frontmostApplication { return app.processIdentifier }
    let visible = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    if let window = visible.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 }),
       let pid = window[kCGWindowOwnerPID as String] as? Int32 { return pid }
    throw Failure.message("Cannot determine frontmost application")
}
func front() throws -> NSRunningApplication {
    let app = try wechat()
    try require(try frontmostPID() == app.processIdentifier,
                "WeChat is not frontmost; no input posted")
    return app
}
func windows(_ app: NSRunningApplication) -> [[String: Any]] {
    let all = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    return all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) }
}
func windowJSON(_ item: [String: Any]) -> [String: Any] {
    ["window_id": item[kCGWindowNumber as String]!, "title": item[kCGWindowName as String] ?? "",
     "frame": item[kCGWindowBounds as String]!]
}
func ownedWindow(_ id: UInt32) throws -> [String: Any] {
    guard let item = windows(try wechat()).first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }) else {
        throw Failure.message("Window is not an on-screen WeChat window")
    }
    return item
}
func process(_ path: String, _ args: [String]) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: path)
    task.arguments = args
    // Diagnostics stay on stderr; stdout is reserved for the primitive JSON.
    task.standardOutput = FileHandle.standardError
    try task.run()
    task.waitUntilExit()
    try require(task.terminationStatus == 0, "\(path) exited \(task.terminationStatus); inspect outcome")
}

// System consent can float above WeChat without changing the frontmost app.
struct PermissionNode: Decodable {
    let role: String
    let subrole: String
    let text: String
    let children: [PermissionNode]
}
struct PermissionWindow: Decodable {
    let app: String
    let bundle: String
    let system: Bool
    let nodes: [PermissionNode]
}
func permissionHost(_ bundle: String, _ system: Bool) -> Bool {
    system && ["com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent",
               "com.apple.SecurityAgent", "com.apple.universalaccessAuthWarn",
               "com.apple.screencaptureui", "com.apple.LocalAuthentication.UIAgent"].contains(bundle)
}
func permissionRequest(_ node: PermissionNode) -> String? {
    let dialog = ["AXDialog", "AXSystemDialog"].contains(node.subrole)
        || ["AXDialog", "AXSheet"].contains(node.role)
    if dialog {
        func text(_ node: PermissionNode) -> [String] {
            // Buttons alone (Allow, Cancel, Don't Allow) are not a consent request.
            (node.role == "AXButton" ? [] : [node.text]) + node.children.flatMap(text)
        }
        let body = text(node).filter { !$0.isEmpty }.joined(separator: " ")
        let lower = body.lowercased()
        let request = ["would like to", "wants to", "is requesting", "想要", "希望", "请求"].contains { lower.contains($0) }
        let permission = ["control", "access", "record", "capture", "monitor", "camera", "microphone",
                          "控制", "访问", "录制", "录屏", "摄像头", "麦克风", "辅助功能", "监控"].contains { lower.contains($0) }
        let recording = ["screen recording", "screen & system audio recording", "屏幕录制", "屏幕与系统音频录制"].contains { lower.contains($0) }
        if (request && permission) || recording { return body }
    }
    return node.children.compactMap(permissionRequest).first
}
func requireNoPermissionDialog(_ read: () throws -> [PermissionWindow] = readPermissionWindows) throws {
    for window in try read() where permissionHost(window.bundle, window.system) {
        for node in window.nodes {
            if let request = permissionRequest(node) {
                throw Failure.message("System permission dialog hosted by \(window.app) (\(window.bundle)): \(request). Waiting for owner; no input posted. All choices, including denial and Escape, belong to the owner.")
            }
        }
    }
}
func readPermissionWindows() throws -> [PermissionWindow] {
    guard let visible = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        throw Failure.message("Cannot inspect system permission windows; no input posted")
    }
    let pids = Set(visible.compactMap { $0[kCGWindowOwnerPID as String] as? Int32 })
    var result: [PermissionWindow] = []
    for pid in pids {
        guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
        let bundle = app.bundleIdentifier ?? ""
        let system = app.bundleURL?.path.hasPrefix("/System/Library/") == true
        guard permissionHost(bundle, system) else { continue }
        let name = app.localizedName ?? bundle
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 1)
        func read(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
            var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
            if status == .attributeUnsupported || status == .noValue { return nil }
            try require(status == .success, "Cannot inspect permission dialog for \(name): AX \(status.rawValue); waiting for owner; no input posted")
            return value
        }
        var visited: [AXUIElement] = []
        func node(_ element: AXUIElement) throws -> PermissionNode {
            if visited.contains(where: { CFEqual($0, element) }) {
                return PermissionNode(role: "", subrole: "", text: "", children: [])
            }
            visited.append(element)
            let role = try read(element, kAXRoleAttribute) as? String ?? ""
            let subrole = try read(element, kAXSubroleAttribute) as? String ?? ""
            if [kAXTextFieldRole, kAXTextAreaRole].contains(role) {
                return PermissionNode(role: role, subrole: subrole, text: "", children: [])
            }
            let labels = try [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap {
                try read(element, $0) as? String
            }
            let children = try read(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            return PermissionNode(role: role, subrole: subrole, text: labels.joined(separator: " "),
                                  children: try children.map(node))
        }
        guard let windows = try read(root, kAXWindowsAttribute) as? [AXUIElement] else {
            throw Failure.message("Cannot inspect permission windows for \(name); waiting for owner; no input posted")
        }
        let nodes = try windows.filter { try read($0, kAXMinimizedAttribute) as? Bool != true }.map(node)
        result.append(PermissionWindow(app: name, bundle: bundle, system: system, nodes: nodes))
    }
    return result
}
