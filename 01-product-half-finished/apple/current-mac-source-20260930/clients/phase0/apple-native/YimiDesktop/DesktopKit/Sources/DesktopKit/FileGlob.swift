import Foundation
import JavaScriptCore

/// Pure official glob semantics. Keep a matcher local to one search; no shared JS state.
final class FileGlob {
    private let context: JSContext
    private let matcher: JSValue

    init() throws {
        guard let context = JSContext(),
              let url = Bundle.module.url(forResource: "file-glob", withExtension: "js") else {
            throw ToolFailure("DESKTOP_TOOL_FAILED", "Missing bundled glob transform")
        }
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        if let error = context.exception {
            throw ToolFailure("DESKTOP_TOOL_FAILED", error.toString())
        }
        guard let matcher = context.objectForKeyedSubscript("fileGlobMatches"), !matcher.isUndefined else {
            throw ToolFailure("DESKTOP_TOOL_FAILED", "Bundled glob transform returned no matcher")
        }
        self.context = context
        self.matcher = matcher
    }

    func matches(_ path: String, _ pattern: String) throws -> Bool {
        context.exception = nil
        let result = matcher.call(withArguments: [path, pattern])
        if let error = context.exception {
            throw ToolFailure("DESKTOP_TOOL_FAILED", error.toString())
        }
        guard let result, result.isBoolean else {
            throw ToolFailure("DESKTOP_TOOL_FAILED", "Bundled glob transform returned no result")
        }
        return result.toBool()
    }

    static func matches(_ path: String, _ pattern: String) throws -> Bool {
        try FileGlob().matches(path, pattern)
    }
}
