import AppKit
@main enum Clipboard {
    static func main() { run("clipboard <save|restore|text|file> <absolute-path>", counts: [2]) { args in
        try require(["save", "restore", "text", "file"].contains(args[0]) && args[1].hasPrefix("/"), "Expected operation and absolute path")
        let url = URL(fileURLWithPath: args[1]), board = NSPasteboard.general
        switch args[0] {
        case "save":
            let saved = board.pasteboardItems?.map { item in
                Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type.rawValue, $0) } })
            } ?? []
            let data = try PropertyListSerialization.data(fromPropertyList: saved, format: .binary, options: 0)
            try data.write(to: url, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        case "restore":
            let saved = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as! [[String: Data]]
            let items = try saved.map { pairs -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (type, data) in pairs {
                    try require(item.setData(data, forType: NSPasteboard.PasteboardType(type)), "Clipboard item restore refused")
                }
                return item
            }
            board.clearContents()
            if !items.isEmpty { try require(board.writeObjects(items), "Clipboard restore refused") }
        case "text":
            let text = try String(contentsOf: url, encoding: .utf8)
            board.clearContents()
            try require(board.setString(text, forType: .string), "Clipboard text write refused")
        case "file":
            try require(FileManager.default.fileExists(atPath: url.path), "Attachment file missing")
            board.clearContents()
            try require(board.writeObjects([url as NSURL]), "Clipboard file URL write refused")
        default: preconditionFailure()
        }
        return ["operation": args[0], "path": args[1]]
    } }
}
