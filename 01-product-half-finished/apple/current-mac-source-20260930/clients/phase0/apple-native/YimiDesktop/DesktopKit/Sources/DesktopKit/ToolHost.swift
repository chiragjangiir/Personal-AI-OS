import Foundation
import MCP

// A raw router preserves manifest extensions and the originating request ID. SDK 0.12.1's
// Server.HandlerContext.id is package-only; its public handler cannot correlate elicitation.
actor ToolHost {
    private let transport: DesktopTransport
    private let tools: [Value]
    private let call: @Sendable (Value, String, [String: Value]) async throws -> Value
    private let reset: @Sendable (ToolHost) async -> Void
    private let readiness: @Sendable (Bool) async -> Void
    private let phonePause: @Sendable (Bool) async -> Void
    private var receiver: Task<Void, Never>?
    private var calls: [Value: (UUID, Task<Void, Never>)] = [:]
    private var names: [Value: String] = [:]
    private var approvals: [Value: (Value, CheckedContinuation<Bool, Error>)] = [:]
    private(set) var droppedResponses = 0
    init(transport: DesktopTransport, tools: [Value],
         call: @escaping @Sendable (Value, String, [String: Value]) async throws -> Value,
         phonePause: @escaping @Sendable (Bool) async -> Void,
         readiness: @escaping @Sendable (Bool) async -> Void = { _ in },
         reset: @escaping @Sendable (ToolHost) async -> Void = { _ in }) {
        self.transport = transport; self.tools = tools; self.call = call; self.phonePause = phonePause; self.readiness = readiness; self.reset = reset
    }
    func start() {
        guard receiver == nil else { return }
        DesktopDiagnostics.logger.notice("transport started")
        receiver = Task { [weak self, transport] in
            for await frame in transport.frames() {
                guard !Task.isCancelled else { break }
                switch frame {
                case .reset: await self?.resetChannel()
                case .message(let data, let current):
                    guard current() else { continue }
                    do { try await self?.receive(data, current: current) }
                    catch where !current() { await self?.readiness(false); continue }
                    catch { await self?.stop(reason: "receive_failed"); return }
                }
            }
            await self?.stop(reason: "frames_ended")
        }
    }
    private func resetChannel() async { cancelCalls(); await reset(self) }
    func stop(reason: String = "host_stopped") async {
        guard receiver != nil else { return }
        DesktopDiagnostics.logger.notice("stopped reason=\(reason, privacy: .public)")
        receiver?.cancel(); receiver = nil; cancelCalls(); await readiness(false)
    }
    func cancelCalls() {
        for (_, task) in calls.values { task.cancel() }
        calls.removeAll(); names.removeAll()
        for (_, continuation) in approvals.values { continuation.resume(throwing: CancellationError()) }
        approvals.removeAll()
    }
    func state(_ paused: Bool) async throws {
        if paused { cancelCalls() }
        try await send(["method": .string("notifications/paios/state"), "params": .object(["paused": .bool(paused)])])
    }
    func consent(related: Value, message: String) async throws -> Bool {
        guard names[related] == "trash" else { throw ToolFailure("GUARD_CONSENT_DENIED", "只有移到废纸篓需要首次确认") }
        let id = Value.string("consent-" + UUID().uuidString)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                approvals[id] = (related, continuation)
                Task {
                    do {
                        guard approvals[id] != nil, calls[related]?.1.isCancelled == false else { return }
                        try await send(["id": id, "method": .string("elicitation/create"), "params": .object([
                            "message": .string(String(message.prefix(200))),
                            "requestedSchema": .object(["type": .string("object"), "properties": .object([:])]),
                            "_meta": .object(["paios/relatedRequestId": related])])])
                    } catch { finishApproval(id, error: error) }
                }
            }
        } onCancel: { Task { await self.finishApproval(id, error: CancellationError()) } }
    }
    private func finishApproval(_ id: Value, error: Error) {
        approvals.removeValue(forKey: id)?.1.resume(throwing: error)
    }
    private func receive(_ frame: Data, current: @escaping @Sendable () -> Bool) async throws {
        guard frame.count <= 1_048_576 else { throw ToolFailure("GUARD_TOO_LARGE", "工具消息超过大小限制") }
        guard let value = try? JSONDecoder().decode(Value.self, from: frame), let object = value.objectValue,
              object["jsonrpc"] == .string("2.0") else { try await rpcError(.null, -32600, "Invalid Request"); return }
        let id = object["id"]
        if object["method"] == nil, object["result"] != nil || object["error"] != nil {
            if let id, let pending = approvals.removeValue(forKey: id) {
                pending.1.resume(returning: object["error"] == nil && object["result"]?.objectValue?["action"] == .string("accept"))
            } else { droppedResponses += 1 }
            return
        }
        guard let method = object["method"]?.stringValue else { try await rpcError(id ?? .null, -32600, "Invalid Request"); return }
        DesktopDiagnostics.logger.notice("request received method=\(method, privacy: .public)")
        let params = object["params"]?.objectValue ?? [:]
        if id == nil {
            if method == "notifications/cancelled", let related = params["requestId"] {
                calls[related]?.1.cancel()
                for (key, pending) in approvals where pending.0 == related { finishApproval(key, error: CancellationError()) }
            } else if method == "notifications/paios/ready", let ready = params["ready"]?.boolValue {
                DesktopDiagnostics.logger.notice("ready ack received ready=\(ready)")
                await readiness(ready)
            } else if method == "notifications/paios/pause", let paused = params["paused"]?.boolValue { await phonePause(paused) }
            return
        }
        guard let id, id.stringValue != nil || id.intValue != nil else { try await rpcError(.null, -32600, "Invalid id"); return }
        if object["params"] != nil && object["params"]?.objectValue == nil { try await rpcError(id, -32602, "Invalid params"); return }
        switch method {
        case "initialize":
            await readiness(false)
            await resetChannel()
            guard let version = params["protocolVersion"]?.stringValue, params["capabilities"]?.objectValue != nil,
                  params["clientInfo"]?.objectValue != nil else { try await rpcError(id, -32602, "Invalid initialize"); return }
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
            try await result(id, .object(["protocolVersion": .string(supported.contains(version) ? version : supported[0]),
                "capabilities": .object(["tools": .object(["listChanged": .bool(false)])]),
                "serverInfo": .object(["name": .string("paios-desktop"), "version": .string("1")])]))
        case "ping": try await result(id, .object([:]))
        case "tools/list": try await result(id, .object(["tools": .array(tools)]))
        case "tools/call":
            guard let name = params["name"]?.stringValue, let args = params["arguments"]?.objectValue,
                  tools.contains(where: { $0.objectValue?["name"] == .string(name) }) else { try await rpcError(id, -32602, "Unknown tool or invalid arguments"); return }
            guard calls[id] == nil else { try await rpcError(id, -32600, "Duplicate request id"); return }
            guard calls.count < 4 else { try await result(id, ToolFailure("DESKTOP_BUSY", "电脑正在处理其他操作，稍后再试").result); return }
            let timeout = tools.first { $0.objectValue?["name"] == .string(name) }?.objectValue?["x-paios"]?.objectValue?["timeout_ms"]?.intValue ?? 30_000
            names[id] = name
            let token = UUID()
            calls[id] = (token, Task {
                let deadline = Task {
                    do { try await Task.sleep(nanoseconds: UInt64(timeout + (name == "trash" ? 300_000 : 0)) * 1_000_000) }
                    catch { return }
                    await expire(id, token: token, current: current)
                }
                defer { deadline.cancel() }
                defer { if calls[id]?.0 == token { calls[id] = nil; names[id] = nil } }
                let output: Value
                do {
                    guard current() else { return }
                    output = try await call(id, name, args)
                } catch is InvalidParams {
                    guard !Task.isCancelled, current() else { return }
                    do { try await rpcError(id, -32602, "Invalid params") }
                    catch { guard !Task.isCancelled, current() else { return }; await stop() }
                    return
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled, current() else { return }
                    output = (error as? ToolFailure ?? ToolFailure("DESKTOP_TOOL_FAILED", String(describing: error))).result
                }
                guard !Task.isCancelled, current() else { return }
                do { try await result(id, output) }
                catch { guard !Task.isCancelled, current() else { return }; await stop() }
            })
        default: try await rpcError(id, -32601, "Method not found")
        }
    }
    private func expire(_ id: Value, token: UUID, current: @escaping @Sendable () -> Bool) async {
        guard calls[id]?.0 == token else { return }
        calls[id]?.1.cancel()
        for (key, pending) in approvals where pending.0 == id { finishApproval(key, error: CancellationError()) }
        guard current() else { return }
        do { try await result(id, ToolFailure("DESKTOP_TIMEOUT", "电脑操作超时").result) }
        catch { guard !Task.isCancelled, current() else { return }; await stop() }
    }
    private func result(_ id: Value, _ value: Value) async throws { try await send(["id": id, "result": value]) }
    private func rpcError(_ id: Value, _ code: Int, _ text: String) async throws {
        try await send(["id": id, "error": .object(["code": .int(code), "message": .string(text), "data": .object(["error_code": .string(text)])])])
    }
    private func send(_ fields: [String: Value]) async throws {
        try Task.checkCancellation()
        var fields = fields; fields["jsonrpc"] = .string("2.0")
        let data = try JSONEncoder().encode(Value.object(fields))
        guard data.count <= 1_048_576 else { throw ToolFailure("GUARD_TOO_LARGE", "工具结果超过大小限制") }
        do {
            try await transport.send(data)
            if fields["result"] != nil || fields["error"] != nil { DesktopDiagnostics.logger.notice("reply written") }
        } catch {
            if fields["result"] != nil || fields["error"] != nil { DesktopDiagnostics.logger.error("reply failed") }
            throw error
        }
        try Task.checkCancellation()
    }
}
