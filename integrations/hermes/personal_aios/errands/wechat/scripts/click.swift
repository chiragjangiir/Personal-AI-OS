import AppKit
@main enum Click {
    static func main() { run("click <screen-x> <screen-y>", counts: [2]) { args in
        guard let x = Double(args[0]), let y = Double(args[1]), x.isFinite, y.isFinite else {
            throw Failure.message("Expected finite screen coordinates")
        }
        let point = CGPoint(x: x, y: y)
        try requireNoPermissionDialog()
        let visible = windows(try front())
        try require(visible.contains {
            CGRect(dictionaryRepresentation: $0[kCGWindowBounds as String] as! CFDictionary)!.contains(point)
        }, "Point is outside WeChat windows; no click posted")
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.05)
        }
        return ["posted": true, "x": x, "y": y]
    } }
}
