import Foundation
import JavaScriptCore
import MCP
import Darwin

/// Filesystem behavior over opened capabilities. GuardPolicy supplies the authority; Desktop owns commits.
enum NativeFileExecutor {
    static func omitted(_ error: Error) -> Bool {
        guard let error = error as? ToolFailure else { return false }
        return ["GUARD_SENSITIVE_PATH", "GUARD_PATH_NOT_AUTHORIZED", "GUARD_TYPE_UNSUPPORTED", "GUARD_NOT_FOUND"].contains(error.code)
    }
    static func listing(_ cap: FileCapability, sizes: Bool, args: [String: Value]) throws -> Value {
        var entries: [(String, stat)] = []
        for name in try cap.children() {
            try Task.checkCancellation()
            do { let child = try cap.child(name); entries.append((name, child.info!)) }
            catch { if !omitted(error) { throw error } }
        }
        let count = entries.count
        if sizes {
            let js = JSContext()!
            js.evaluateScript("function compare(a,b){return a.localeCompare(b,'en-US')}")
            entries.sort { args["sortBy"]?.stringValue == "size" ? $0.1.st_size > $1.1.st_size : js.objectForKeyedSubscript("compare").call(withArguments: [$0.0,$1.0]).toInt32() < 0 }
        }
        let visible = Array(entries.prefix(500))
        var lines = visible.map { name, info -> String in
            let directory = info.st_mode & S_IFMT == S_IFDIR
            let prefix = directory ? "[DIR] " : "[FILE] "
            if !sizes { return prefix + name }
            let size = directory ? "" : formatSize(info.st_size)
            return prefix + name + String(repeating: " ", count: max(0, 30 - name.utf16.count)) + " " + (directory ? "" : String(repeating: " ", count: max(0, 10 - size.count)) + size)
        }
        if sizes {
            let files = visible.filter { $0.1.st_mode & S_IFMT != S_IFDIR }
            lines += ["", "Total: \(files.count) files, \(visible.count - files.count) directories", "Combined size: \(formatSize(files.reduce(0) { $0 + $1.1.st_size }))"]
        }
        return result(lines.joined(separator: "\n"), truncated: count > 500)
    }
    static func formatSize(_ size: Int64) -> String {
        if size <= 0 { return "0 B" }; if size < 1024 { return "\(size) B" }
        let power = min(4, Int(log(Double(size)) / log(1024)))
        return String(format: "%.2f %@", Double(size) / pow(1024, Double(power)), ["B","KB","MB","GB","TB"][power])
    }
    static func result(_ text: String, truncated: Bool = false) -> Value {
        var value = FileText.value(text).objectValue!
        if truncated { var body = value["structuredContent"]!.objectValue!; body["truncated"] = true; value["structuredContent"] = .object(body) }
        return .object(value)
    }
    static func walk(_ cap: FileCapability, visit: (FileCapability, String) throws -> Bool) throws {
        func traverse(_ directory: FileCapability, _ relative: String) throws -> Bool {
            for name in try directory.children() {
                try Task.checkCancellation()
                let child: FileCapability
                do { child = try directory.child(name) } catch { if omitted(error) { continue }; throw error }
                let part = relative.isEmpty ? name : relative + "/" + name
                if try !visit(child, part) { return false }
                if child.info!.st_mode & S_IFMT == S_IFDIR, try !traverse(child, part) { return false }
            }
            return true
        }
        _ = try traverse(cap, "")
    }
    static func search(_ cap: FileCapability, args: [String: Value]) throws -> Value {
        let matcher = try FileGlob(), pattern = args["pattern"]!.stringValue!, excludes = args["excludePatterns"]?.arrayValue?.compactMap(\.stringValue) ?? []
        var paths: [String] = [], truncated = false
        func traverse(_ directory: FileCapability, _ relative: String) throws -> Bool {
            for name in try directory.children() {
                try Task.checkCancellation()
                let part = relative.isEmpty ? name : relative + "/" + name
                if try excludes.contains(where: { try matcher.matches(part, $0) }) { continue }
                let child: FileCapability
                do { child = try directory.child(name) } catch { if omitted(error) { continue }; throw error }
                if try matcher.matches(part, pattern) {
                    if paths.count == 500 { truncated = true; return false }; paths.append(child.path)
                }
                if child.info!.st_mode & S_IFMT == S_IFDIR, try !traverse(child, part) { return false }
            }
            return true
        }
        _ = try traverse(cap, "")
        return result(paths.isEmpty ? "No matches found" : paths.joined(separator: "\n"), truncated: truncated)
    }
    static func find(_ cap: FileCapability, args: [String: Value], indexed: Set<String>) throws -> Value {
        let query = args["query"]?.stringValue ?? "", kinds = args["kinds"]?.arrayValue?.compactMap(\.stringValue)
        let after = args["modified_after"]?.stringValue.flatMap(ToolContract.date), before = args["modified_before"]?.stringValue.flatMap(ToolContract.date)
        let maximum = args["limit"]?.intValue ?? 500, formatter = ISO8601DateFormatter()
        var files: [Value] = [], truncated = false
        try walk(cap) { child, _ in
            let info = child.info!, kind = NativeTools.kind(child.path), date = Date(timeIntervalSince1970: Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1e9)
            guard info.st_mode & S_IFMT == S_IFREG, query.isEmpty || indexed.contains(child.path) || (child.path as NSString).lastPathComponent.localizedStandardContains(query),
                  kinds == nil || kinds!.contains(kind), after == nil || date >= after!, before == nil || date <= before! else { return true }
            if files.count == maximum { truncated = true; return false }
            files.append(["path": .string(child.path), "name": .string((child.path as NSString).lastPathComponent), "size": .int(Int(info.st_size)), "modified": .string(formatter.string(from: date)), "kind": .string(kind)])
            return true
        }
        return ["files": .array(files), "truncated": .bool(truncated)]
    }
    static func validateTree(_ cap: FileCapability) throws {
        if cap.info.map({ $0.st_mode & S_IFMT == S_IFDIR }) != true { return }
        for name in try cap.children() {
            try Task.checkCancellation()
            let child = try cap.child(name); try validateTree(child)
        }
    }
}
