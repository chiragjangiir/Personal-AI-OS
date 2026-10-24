import ApplicationServices
@main enum ReadAX {
    static func main() { run("ax-read", counts: [0]) { _ in
        let output = try axWindows().enumerated().map { index, window -> [String: Any] in
            let nodes = descendants(window)
            let inputs = nodes.filter { string($0, kAXRoleAttribute) == kAXTextAreaRole }
            let chats = inputs.filter { !string($0, kAXTitleAttribute).isEmpty && string($0, kAXTitleAttribute) != "搜索" }
            let lists = nodes.filter { string($0, kAXRoleAttribute) == kAXListRole && string($0, kAXTitleAttribute) == "消息" }
            let messages = lists.flatMap { attr($0, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
            let visible = messages.sorted { frame($0)["y"]! < frame($1)["y"]! }
            let content = nodes.filter {
                !string($0, kAXTitleAttribute).isEmpty || !string($0, kAXValueAttribute).isEmpty
            }
            return ["ax_window": index, "title": string(window, kAXTitleAttribute), "frame": frame(window),
                    "content_exposed": !inputs.isEmpty || !lists.isEmpty,
                    "chat_titles": chats.map { string($0, kAXTitleAttribute) },
                    "inputs": inputs.map { ["title": string($0, kAXTitleAttribute), "text": string($0, kAXValueAttribute), "frame": frame($0)] as [String: Any] },
                    "recent_visible_messages": visible.suffix(10).map { string($0, kAXTitleAttribute) },
                    "nodes": content.prefix(120).map { ["role": string($0, kAXRoleAttribute), "title": string($0, kAXTitleAttribute), "value": string($0, kAXValueAttribute), "frame": frame($0)] as [String: Any] },
                    "nodes_truncated": content.count > 120]
        }
        return ["windows": output, "content_exposed": output.contains { $0["content_exposed"] as? Bool == true }]
    } }
}
