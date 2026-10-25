import AppKit
import ApplicationServices
import Foundation

// Lead-only real clicks against one already running app PID, following the existing Mac AX probe pattern.
enum ProbeError: Error { case failed(String) }
func argument(_ name: String) throws -> String {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else {
        throw ProbeError.failed("Missing " + name)
    }
    return CommandLine.arguments[index + 1]
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return code == .success ? value : nil
}
func tree(_ root: AXUIElement) -> [AXUIElement] {
    var pending = [root], result: [AXUIElement] = []
    while let node = pending.popLast(), result.count < 2000 {
        if result.contains(where: { CFEqual($0, node) }) { continue }
        result.append(node)
        pending += attribute(node, "AXChildren") as? [AXUIElement] ?? []
    }
    return result
}
func wait(_ root: AXUIElement, seconds: TimeInterval = 30, matching: (AXUIElement) -> Bool) throws -> AXUIElement {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if let node = tree(root).first(where: matching) { return node }
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    } while Date() < deadline
    throw ProbeError.failed("Expected control or receipt did not appear")
}
func control(_ root: AXUIElement, id: String) throws -> AXUIElement {
    try wait(root) { attribute($0, "AXIdentifier") as? String == id }
}
func press(_ node: AXUIElement) throws {
    guard attribute(node, "AXEnabled") as? Bool != false,
          AXUIElementPerformAction(node, kAXPressAction as CFString) == .success else {
        throw ProbeError.failed("Control is disabled or cannot be pressed")
    }
}
func text(_ root: AXUIElement, contains value: String, seconds: TimeInterval = 30) throws {
    _ = try wait(root, seconds: seconds) {
        guard attribute($0, "AXRole") as? String == "AXStaticText" else { return false }
        return (attribute($0, "AXValue") as? String ?? "").contains(value)
    }
}
func waitForReviewToClose(_ root: AXUIElement) throws {
    let deadline = Date().addingTimeInterval(90)
    while tree(root).contains(where: { attribute($0, "AXIdentifier") as? String == "modelSettings.review.confirm" }) {
        guard Date() < deadline else { throw ProbeError.failed("Signed confirmation has not completed") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    }
}
func screenshot(pid: pid_t, directory: URL, name: String) throws {
    guard let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]],
          let row = rows.first(where: { $0[kCGWindowOwnerPID as String] as? Int32 == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
          let number = row[kCGWindowNumber as String] as? Int else { throw ProbeError.failed("App window unavailable") }
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(number), directory.appendingPathComponent(name + ".png").path]
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw ProbeError.failed("Window screenshot failed") }
}

do {
    guard AXIsProcessTrusted() else { throw ProbeError.failed("Grant Accessibility to the driver before running this probe") }
    guard let pid = pid_t(try argument("--pid")), let running = NSRunningApplication(processIdentifier: pid),
          running.bundleIdentifier == "ai.paios.personal.desktop" else {
        throw ProbeError.failed("Provide the exact running YimiDesktop PID")
    }
    let output = URL(fileURLWithPath: try argument("--output"), isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: true)!
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: false)!
    down.flags = .maskCommand; up.flags = .maskCommand
    down.postToPid(pid); up.postToPid(pid)
    try press(control(app, id: "settings.modelSettings"))
    try text(app, contains: "已保存")
    let flow = try argument("--flow")
    if flow == "read-unauthorized" {
        try text(app, contains: "在 iPhone 上授权这台 Mac")
        try screenshot(pid: pid, directory: output, name: "unauthorized-read-only")
    } else if flow == "publish" {
        try press(control(app, id: "modelSettings.mac.publishKey"))
        // The owner completes the real Touch ID prompt, then authorizes this key on the iPhone.
        try text(app, contains: "已提交签名密钥", seconds: 90)
        try screenshot(pid: pid, directory: output, name: "key-published")
    } else if flow == "review" {
        try press(control(app, id: "modelSettings.role." + argument("--role")))
        try press(control(app, id: "modelSettings.role.prepare"))
        try text(app, contains: "已完整读取")
        let confirm = try control(app, id: "modelSettings.review.confirm")
        guard attribute(confirm, "AXEnabled") as? Bool == false else { throw ProbeError.failed("Unreviewed change was confirmable") }
        try press(control(app, id: "modelSettings.review.acknowledge"))
        try screenshot(pid: pid, directory: output, name: "frozen-full-review")
        if CommandLine.arguments.contains("--confirm") {
            try press(confirm)
            try waitForReviewToClose(app)
            try text(app, contains: "已保存，当前任务结束后生效", seconds: 90)
            try screenshot(pid: pid, directory: output, name: "signed-save-receipt")
        } else { try press(control(app, id: "modelSettings.review.cancel")) }
    } else if flow == "key-clear" {
        let provider = try argument("--provider")
        try press(control(app, id: "modelSettings.provider." + provider))
        let field = try control(app, id: "modelSettings.key.input")
        guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, "ui-probe-not-a-real-api-key" as CFString) == .success else {
            throw ProbeError.failed("Secure field could not accept the non-secret probe")
        }
        try press(control(app, id: "modelSettings.key.prepare"))
        try text(app, contains: "已完整读取")
        try press(control(app, id: "modelSettings.review.cancel"))
        try press(control(app, id: "modelSettings.provider." + provider))
        let cleared = try control(app, id: "modelSettings.key.input")
        guard (attribute(cleared, "AXValue") as? String ?? "").isEmpty else { throw ProbeError.failed("Key input was not cleared") }
        try screenshot(pid: pid, directory: output, name: "key-cleared")
    } else { throw ProbeError.failed("Use read-unauthorized, publish, review, or key-clear") }
    print("PASS model-settings " + flow + "; screenshots=" + output.path)
} catch {
    fputs("FAIL model-settings: \(error)\n", stderr)
    exit(1)
}
