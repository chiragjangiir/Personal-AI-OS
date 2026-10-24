import Foundation
import MCP

struct InvalidParams: Error {}

struct ToolContract {
    let tools: [Value]
    let byName: [String: Value]
    init() throws {
        let url = Bundle.module.url(forResource: "desktop-tools.v1", withExtension: "json")!
        let manifest = try JSONDecoder().decode(Value.self, from: Data(contentsOf: url))
        tools = manifest.objectValue!["tools"]!.arrayValue!
        byName = Dictionary(uniqueKeysWithValues: tools.map { ($0.objectValue!["name"]!.stringValue!, $0) })
    }
    func tool(_ name: String) throws -> [String: Value] {
        guard let tool = byName[name]?.objectValue else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "这个工具不在电脑的工具清单里") }
        return tool
    }
    func validate(_ name: String, _ arguments: [String: Value]) throws {
        let schema = try tool(name)["inputSchema"]!
        var publicArguments = arguments
        if name == "save_from_workshop" { publicArguments.removeValue(forKey: "_transfer") }
        try Self.validate(.object(publicArguments), schema)
    }
    static func validate(_ value: Value, _ schema: Value) throws {
        let s = schema.objectValue!
        func invalid() throws { throw InvalidParams() }
        if let options = s["enum"]?.arrayValue, !options.contains(value) { try invalid() }
        switch s["type"]?.stringValue {
        case "object":
            guard let object = value.objectValue else { return try invalid() }
            let properties = s["properties"]?.objectValue ?? [:]
            for name in s["required"]?.arrayValue?.compactMap(\.stringValue) ?? [] where object[name] == nil { try invalid() }
            for (key, field) in object {
                if let sub = properties[key] { try validate(field, sub) }
                else if s["additionalProperties"]?.boolValue == false { try invalid() }
            }
        case "array":
            guard let array = value.arrayValue else { return try invalid() }
            if array.count < (s["minItems"]?.intValue ?? 0) || array.count > (s["maxItems"]?.intValue ?? Int.max) { try invalid() }
            if s["uniqueItems"]?.boolValue == true && Set(array).count != array.count { try invalid() }
            if let item = s["items"] { for field in array { try validate(field, item) } }
        case "string":
            guard let string = value.stringValue else { return try invalid() }
            if string.count < (s["minLength"]?.intValue ?? 0) || string.count > (s["maxLength"]?.intValue ?? Int.max) { try invalid() }
            if let pattern = s["pattern"]?.stringValue, string.range(of: pattern, options: .regularExpression) == nil { try invalid() }
            if s["format"]?.stringValue == "date-time", date(string) == nil { try invalid() }
        case "integer", "number":
            guard let number = Double(value), number.isFinite, s["type"]?.stringValue != "integer" || number.rounded() == number else { return try invalid() }
            if let min = s["minimum"].flatMap({ Double($0) }), number < min { try invalid() }
            if let max = s["maximum"].flatMap({ Double($0) }), number > max { try invalid() }
        case "boolean": if value.boolValue == nil { try invalid() }
        default: break
        }
    }
    static func date(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let value = formatter.date(from: string) { return value }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: string)
    }
    static func result(_ body: Value) throws -> Value {
        let data = try JSONEncoder().encode(body)
        guard data.count <= 262144 else { throw ToolFailure("GUARD_TOO_LARGE", "结果太大，请缩小范围") }
        return ["isError": false, "content": [["type": "text", "text": .string(String(decoding: data, as: UTF8.self))]], "structuredContent": body]
    }
}

actor WriteGate {
    private var owner: UUID?
    private var waiting: [(UUID, CheckedContinuation<Void, Error>)] = []
    func acquire(_ id: UUID) async throws {
        try Task.checkCancellation()
        if owner == nil { owner = id; return }
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { waiting.append((id, $0)) }
            if Task.isCancelled { release(id); throw CancellationError() }
        }, onCancel: { Task { await self.cancel(id) } })
    }
    func release(_ id: UUID) {
        guard owner == id else { return }
        owner = nil
        if !waiting.isEmpty { let next = waiting.removeFirst(); owner = next.0; next.1.resume() }
    }
    private func cancel(_ id: UUID) {
        if let index = waiting.firstIndex(where: { $0.0 == id }) { waiting.remove(at: index).1.resume(throwing: CancellationError()) }
    }
}
