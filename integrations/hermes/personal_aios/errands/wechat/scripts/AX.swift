// AXTextArea titles, message-list titles and write/read-back adapted from
// jsf9789/wechat-bridge-mac (MIT); see ../references/wechat-bridge-mac-LICENSE.
import ApplicationServices
func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String {
    attr(element, name) as? String ?? ""
}
func descendants(_ root: AXUIElement) -> [AXUIElement] {
    var nodes = [root], index = 0
    while index < nodes.count {
        nodes += attr(nodes[index], kAXChildrenAttribute) as? [AXUIElement] ?? []
        index += 1
    }
    return nodes
}
func axWindows() throws -> [AXUIElement] {
    let app = try front()
    try require(AXIsProcessTrusted(), "Accessibility permission required")
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 3)
    return attr(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
}
func frame(_ element: AXUIElement) -> [String: Double] {
    var point = CGPoint.zero, size = CGSize.zero
    if let value = attr(element, kAXPositionAttribute) { AXValueGetValue(value as! AXValue, .cgPoint, &point) }
    if let value = attr(element, kAXSizeAttribute) { AXValueGetValue(value as! AXValue, .cgSize, &size) }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
