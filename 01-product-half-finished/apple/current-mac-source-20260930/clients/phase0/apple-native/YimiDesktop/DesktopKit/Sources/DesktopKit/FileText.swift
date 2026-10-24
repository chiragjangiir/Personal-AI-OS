import Darwin
import Foundation
import JavaScriptCore
import MCP

/// Reads the authorized descriptor, including files that grow after authorization.
enum DescriptorRead {
    static func data(fd: Int32, maximum: Int, message: String) throws -> Data {
        try Task.checkCancellation()
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try file.seek(toOffset: 0)
        var data = Data()
        while true {
            try Task.checkCancellation()
            // Probe at most one byte beyond the budget; never accumulate an oversized chunk.
            let chunk = try file.read(upToCount: min(65_536, maximum - data.count + 1)) ?? Data()
            try Task.checkCancellation()
            guard chunk.count <= maximum - data.count else { throw ToolFailure("GUARD_TOO_LARGE", message) }
            if chunk.isEmpty { return data }
            data.append(chunk)
        }
    }
}

/// Official text semantics; the executor owns descriptors, authorization and all mutations.
enum FileText {
    static func value(_ text: String) -> MCP.Value {
        .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])]), "structuredContent": .object(["content": .string(text)])])
    }
    static func info(_ info: stat) -> String {
        let js = JSContext()!
        func date(_ time: timespec) -> String {
            let milliseconds = Double(time.tv_sec) * 1000 + Double(time.tv_nsec) / 1_000_000
            return js.objectForKeyedSubscript("Date").construct(withArguments: [milliseconds])!.invokeMethod("toString", withArguments: [])!.toString()
        }
        return "size: \(info.st_size)\ncreated: \(date(info.st_birthtimespec))\nmodified: \(date(info.st_mtimespec))\naccessed: \(date(info.st_atimespec))\nisDirectory: \(info.st_mode & S_IFMT == S_IFDIR)\nisFile: \(info.st_mode & S_IFMT == S_IFREG)\npermissions: " + String(format: "%03o", info.st_mode & 0o777)
    }
    static func content(fd: Int32) throws -> String {
        // Match writeContent/edit's 1 MiB content budget before text decoding or JS transforms.
        let data = try DescriptorRead.data(fd: fd, maximum: 1_048_576, message: "工具内容超过1 MiB")
        return String(decoding: data, as: UTF8.self)
    }
    static func writeContent(_ args: [String: MCP.Value]) throws -> String {
        guard let text = args["content"]?.stringValue else { throw ToolFailure("DESKTOP_TOOL_FAILED", "content must be a string") }
        guard text.utf8.count <= 1_048_576 else { throw ToolFailure("GUARD_TOO_LARGE", "工具内容超过1 MiB") }
        return text
    }
    static func edit(content: String, args: [String: MCP.Value], path: String) throws -> (text: String, diff: String) {
        try Task.checkCancellation()
        let js = JSContext()!
        for name in ["diff", "file-edit"] {
            guard let url = Bundle.module.url(forResource: name, withExtension: "js") else { throw ToolFailure("DESKTOP_TOOL_FAILED", "Missing bundled text transform") }
            js.evaluateScript(try String(contentsOf: url, encoding: .utf8))
            if let error = js.exception { throw ToolFailure("DESKTOP_TOOL_FAILED", error.toString()) }
        }
        guard let values = args["edits"]?.arrayValue else { throw ToolFailure("DESKTOP_TOOL_FAILED", "edits must be an array") }
        let edits = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MCP.Value.array(values)))
        let result = js.objectForKeyedSubscript("edit").call(withArguments: [content, edits, path])
        if let error = js.exception { throw ToolFailure("DESKTOP_TOOL_FAILED", error.objectForKeyedSubscript("message").toString()) }
        guard let text = result?.objectForKeyedSubscript("text")?.toString(), let diff = result?.objectForKeyedSubscript("diff")?.toString() else { throw ToolFailure("DESKTOP_TOOL_FAILED", "Pinned text transform returned no result") }
        if args["dryRun"]?.boolValue != true && text.utf8.count > 1_048_576 { throw ToolFailure("GUARD_TOO_LARGE", "工具内容超过1 MiB") }
        try Task.checkCancellation()
        return (text, diff)
    }
    private static func number(_ value: MCP.Value?) -> Double {
        return value?.doubleValue ?? value?.intValue.map(Double.init) ?? 0
    }
    static func read(fd: Int32, size: off_t, args: [String: MCP.Value]) throws -> String {
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try file.seek(toOffset: 0)
        let head = number(args["head"]), tail = number(args["tail"])
        if head != 0 && tail != 0 { throw ToolFailure("DESKTOP_TOOL_FAILED", "Cannot specify both head and tail parameters simultaneously") }
        let limit = 256 * 1024
        var data = Data(), newlines = 0
        if tail != 0 {
            var position = UInt64(size)
            while position > 0 && Double(newlines) < tail {
                try Task.checkCancellation()
                let count = min(1024, Int(position)); position -= UInt64(count)
                try file.seek(toOffset: position)
                let chunk = try file.read(upToCount: count) ?? Data()
                newlines += chunk.filter { $0 == 10 }.count; data.insert(contentsOf: chunk, at: 0)
                if data.count > 2 * limit + 1024 { throw ToolFailure("GUARD_TOO_LARGE", "工具结果超过256 KiB") }
            }
            let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
            let lines = text.components(separatedBy: "\n")
            let count = tail > 0 ? (tail < 1 ? lines.count : min(lines.count, Int(min(tail.rounded(.towardZero), Double(Int.max / 2))))) : 0
            let result = lines.suffix(count).joined(separator: "\n")
            guard result.utf8.count <= limit else { throw ToolFailure("GUARD_TOO_LARGE", "工具结果超过256 KiB") }
            return result
        }
        while head == 0 || Double(newlines) < head {
            try Task.checkCancellation()
            let chunk = try file.read(upToCount: 1024) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk); newlines += chunk.filter { $0 == 10 }.count
            if data.count > limit + 1024 { throw ToolFailure("GUARD_TOO_LARGE", "工具结果超过256 KiB") }
        }
        var text = String(decoding: data, as: UTF8.self)
        if head != 0 {
            var lines = text.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() }
            let count = Int(max(0, min(Double(lines.count), head.rounded(.up))))
            text = lines.prefix(count).joined(separator: "\n")
        }
        guard text.utf8.count <= limit else { throw ToolFailure("GUARD_TOO_LARGE", "工具结果超过256 KiB") }
        return text
    }
}
