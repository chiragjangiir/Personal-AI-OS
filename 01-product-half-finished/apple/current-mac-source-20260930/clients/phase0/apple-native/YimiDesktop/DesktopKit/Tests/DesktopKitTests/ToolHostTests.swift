import Foundation
import MCP
import XCTest
@testable import DesktopKit

final class ToolHostTests: XCTestCase {
    func testRetiredBufferedToolCallIsDroppedBeforeNativeDispatch() async throws {
        let wire = HostWire()
        let host = ToolHost(transport: wire, tools: try ToolContract().tools,
            call: { _, _, _ in XCTFail("retired frame reached native dispatch"); return ["content": []] }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": "old-call", "method": "tools/call", "params": ["name": "list_allowed_directories", "arguments": [:]]], current: { false })
        try wire.feed(["id": "new-ping", "method": "ping"])
        let reply = try decode(await replies.next())
        XCTAssertEqual(reply.objectValue?["id"], "new-ping")
        await host.stop()
    }
    func testResetAndInitializeBarriersFinishBeforeFreshRequestDispatch() async throws {
        for initialize in [false, true] {
            let wire = HostWire(), gate = ResetBarrier()
            let resetting = expectation(description: "reset authority suspended")
            let premature = expectation(description: "fresh call must wait for reset")
            premature.isInverted = true
            let called = expectation(description: "fresh call dispatched after reset")
            let release = AsyncStream<Void>.makeStream()
            let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
                let suspended = await gate.suspended
                if suspended { premature.fulfill() }
                XCTAssertFalse(suspended)
                called.fulfill()
                return ["content": []]
            }, phonePause: { _ in }, reset: { _ in
                resetting.fulfill()
                for await _ in release.stream { break }
                await gate.complete()
            })
            await host.start()
            var replies = wire.outgoing.makeAsyncIterator()
            if initialize {
                try wire.feed(["id": "initialize", "method": "initialize", "params": ["protocolVersion": "2025-11-25",
                    "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]])
            } else { wire.reset() }
            await fulfillment(of: [resetting], timeout: 2)
            try wire.feed(["id": "fresh-call", "method": "tools/call", "params": ["name": "list_allowed_directories", "arguments": [:]]])
            await fulfillment(of: [premature], timeout: 0.1)
            release.continuation.yield(()); release.continuation.finish()
            await fulfillment(of: [called], timeout: 2)
            if initialize {
                let initialized = try decode(await replies.next())
                XCTAssertEqual(initialized.objectValue?["id"], "initialize")
            }
            let reply = try decode(await replies.next())
            XCTAssertEqual(reply.objectValue?["id"], "fresh-call")
            XCTAssertNotNil(reply.objectValue?["result"], "reset must not cancel the fresh call")
            await host.stop()
        }
    }
    func testChannelRetiredDuringInitializeSendKeepsReceiverForFreshHandshake() async throws {
        let validity = ChannelValidity()
        let attempted = expectation(description: "old response lost after channel retirement")
        let recovered = expectation(description: "fresh initialize answered by same receiver")
        let wire = HostWire(beforeSend: { data in
            let value = try JSONDecoder().decode(Value.self, from: data)
            if value.objectValue?["id"] == "old-initialize" {
                validity.retire(); attempted.fulfill(); throw DesktopError.unavailable
            }
        }, observe: { data in
            if let value = try? JSONDecoder().decode(Value.self, from: data), value.objectValue?["id"] == "fresh-initialize" {
                XCTAssertNotNil(value.objectValue?["result"]); recovered.fulfill()
            }
        })
        let host = ToolHost(transport: wire, tools: try ToolContract().tools,
            call: { _, _, _ in ["content": []] }, phonePause: { _ in })
        await host.start()
        let params: Value = ["protocolVersion": "2025-11-25", "capabilities": [:], "clientInfo": ["name": "relay", "version": "1"]]
        try wire.feed(["id": "old-initialize", "method": "initialize", "params": params], current: { validity.current() })
        await fulfillment(of: [attempted], timeout: 2)
        try wire.feed(["id": "fresh-initialize", "method": "initialize", "params": params])
        await fulfillment(of: [recovered], timeout: 2)
        await host.stop()
    }
    func testManifestExtensionsAndMalformedArguments() async throws {
        let wire = HostWire(), contract = try ToolContract()
        let host = ToolHost(transport: wire, tools: contract.tools, call: { _, _, _ in
            XCTFail("Malformed or unknown calls must not reach guard")
            return .object([:])
        }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": 1, "method": "tools/list"])
        let manifest = try decode(await replies.next())
        XCTAssertEqual(manifest.objectValue?["result"]?.objectValue?["tools"], .array(contract.tools))
        try wire.feed(["id": 2, "method": "tools/call", "params": ["name": "write_file", "arguments": []]])
        let invalid = try decode(await replies.next())
        XCTAssertEqual(invalid.objectValue?["error"]?.objectValue?["code"], -32602)
        try wire.feed(["id": 3, "method": "tools/call", "params": ["name": "run_command", "arguments": [:]]])
        let unknown = try decode(await replies.next())
        XCTAssertEqual(unknown.objectValue?["error"]?.objectValue?["code"], -32602)
        await host.stop()
    }
    func testTrashConsentCarriesOriginalIDAndAcceptsResponse() async throws {
        let wire = HostWire(), box = HostBox()
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { id, _, _ in
            let host = await box.host!
            let accepted = try await host.consent(related: id, message: "移到废纸篓，允许吗？")
            return ["isError": false, "structuredContent": ["accepted": .bool(accepted)], "content": []]
        }, phonePause: { _ in })
        await box.set(host)
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": "call-7", "method": "tools/call", "params": ["name": "trash", "arguments": ["paths": ["/tmp/file"]]]])
        let request = try decode(await replies.next())
        XCTAssertEqual(request.objectValue?["method"], "elicitation/create")
        XCTAssertEqual(request.objectValue?["params"]?.objectValue?["_meta"]?.objectValue?["paios/relatedRequestId"], "call-7")
        let requestID = try XCTUnwrap(request.objectValue?["id"])
        try wire.feed(["id": requestID, "result": ["action": "accept", "content": [:]]])
        let reply = try decode(await replies.next())
        XCTAssertEqual(reply.objectValue?["id"], "call-7")
        XCTAssertEqual(reply.objectValue?["result"]?.objectValue?["structuredContent"]?.objectValue?["accepted"], true)
        await host.stop()
    }
    func testCancellationStopsMatchingCallAndSuppressesFinalResponse() async throws {
        let wire = HostWire(), entered = expectation(description: "call entered"), cancelled = expectation(description: "call cancelled")
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
            entered.fulfill()
            defer { cancelled.fulfill() }
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return ["content": []]
        }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": "cancel-me", "method": "tools/call", "params": ["name": "read_text_file", "arguments": ["path": "/tmp/file"]]])
        await fulfillment(of: [entered], timeout: 2)
        try wire.feed(["method": "notifications/cancelled", "params": ["requestId": "cancel-me"]])
        await fulfillment(of: [cancelled], timeout: 2)
        try wire.feed(["id": "after", "method": "ping"])
        let reply = try decode(await replies.next())
        XCTAssertEqual(reply.objectValue?["id"], "after")
        await host.stop()
    }
    func testFifthCallIsModelFacingBusyError() async throws {
        let wire = HostWire(), entered = expectation(description: "four concurrent calls")
        entered.expectedFulfillmentCount = 4
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
            entered.fulfill()
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return ["content": []]
        }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        for id in 1...4 { try wire.feed(["id": .int(id), "method": "tools/call", "params": ["name": "read_text_file", "arguments": ["path": "/tmp/file"]]]) }
        await fulfillment(of: [entered], timeout: 2)
        try wire.feed(["id": 5, "method": "tools/call", "params": ["name": "read_text_file", "arguments": ["path": "/tmp/file"]]])
        let reply = try decode(await replies.next())
        XCTAssertEqual(reply.objectValue?["id"], 5)
        XCTAssertEqual(reply.objectValue?["result"]?.objectValue?["isError"], true)
        XCTAssertEqual(reply.objectValue?["result"]?.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["code"], "DESKTOP_BUSY")
        XCTAssertEqual(reply.objectValue?["result"]?.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["retryable"], true)
        await host.stop()
    }
    func testLateApprovalResponsesAreDroppedWithoutResponseLoop() async throws {
        let wire = HostWire()
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in ["content": []] }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": "expired-consent", "result": ["action": "accept"]])
        try wire.feed(["id": "failed-consent", "error": ["code": -32603, "message": "expired"]])
        try wire.feed(["id": "after", "method": "ping"])
        let reply = try decode(await replies.next())
        XCTAssertEqual(reply.objectValue?["id"], "after")
        let count = await host.droppedResponses
        XCTAssertEqual(count, 2)
        await host.stop()
    }
    func testC53IncomingOversizedFrameStopsHostBeforeDispatch() async throws {
        let unexpected = expectation(description: "oversized request or subsequent ping dispatched")
        unexpected.isInverted = true
        let wire = HostWire(observe: { _ in unexpected.fulfill() })
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
            XCTFail("Oversized input reached tools"); return ["content": []]
        }, phonePause: { _ in })
        await host.start()
        try wire.feed(["id": "too-large", "method": "ping", "params": ["padding": .string(String(repeating: "x", count: 1_048_576))]])
        try wire.feed(["id": "after", "method": "ping"])
        await fulfillment(of: [unexpected], timeout: 0.2)
        await host.stop()
    }
    func testC53MalformedEnvelopesIDsAndExactFrameLimit() async throws {
        let wire = HostWire()
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
            XCTFail("Envelope probe reached tools"); return ["content": []]
        }, phonePause: { _ in })
        await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        for raw in ["{", "[]", "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}", "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}", "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"ping\"}", "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}"] {
            wire.feedRaw(Data(raw.utf8))
            let reply = try decode(await replies.next())
            XCTAssertNotNil(reply.objectValue?["error"], raw)
        }
        for id: Value in [.int(0), .int(-7), .int(9_007_199_254_740_993), .string("unicode-请求")] {
            try wire.feed(["id": id, "method": "ping"])
            let reply = try decode(await replies.next()); XCTAssertEqual(reply.objectValue?["id"], id)
        }
        let base = try JSONEncoder().encode(Value.object(["jsonrpc": "2.0", "id": "boundary", "method": "ping"]))
        wire.feedRaw(base + Data(repeating: 32, count: 1_048_576 - base.count))
        let exact = try decode(await replies.next()); XCTAssertEqual(exact.objectValue?["id"], "boundary")
        await host.stop()
    }
    func testC53NonTrashCannotElicitAndCancelledApprovalIsDropped() async throws {
        let wire = HostWire(), box = HostBox()
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { id, _, _ in
            let host = await box.host!
            let accepted = try await host.consent(related: id, message: "synthetic")
            return ["isError": false, "content": [], "structuredContent": ["accepted": .bool(accepted)]]
        }, phonePause: { _ in })
        await box.set(host); await host.start()
        var replies = wire.outgoing.makeAsyncIterator()
        try wire.feed(["id": "nontrash", "method": "tools/call", "params": ["name": "read_text_file", "arguments": ["path": "synthetic"]]])
        let refused = try decode(await replies.next())
        XCTAssertEqual(refused.objectValue?["result"]?.objectValue?["structuredContent"]?.objectValue?["error"]?.objectValue?["code"], "GUARD_CONSENT_DENIED")
        try wire.feed(["id": "trash", "method": "tools/call", "params": ["name": "trash", "arguments": ["paths": ["synthetic"]]]])
        let approval = try decode(await replies.next())
        XCTAssertEqual(approval.objectValue?["method"], "elicitation/create")
        try wire.feed(["method": "notifications/cancelled", "params": ["requestId": "trash"]])
        try wire.feed(["id": "barrier", "method": "ping"])
        let barrier = try decode(await replies.next()); XCTAssertEqual(barrier.objectValue?["id"], "barrier")
        try wire.feed(["id": try XCTUnwrap(approval.objectValue?["id"]), "result": ["action": "accept"]])
        try wire.feed(["id": "after", "method": "ping"])
        let after = try decode(await replies.next()); XCTAssertEqual(after.objectValue?["id"], "after")
        let dropped = await host.droppedResponses; XCTAssertGreaterThanOrEqual(dropped, 1)
        await host.stop()
    }
    func testC14CancelledInvalidParamsKeepsHostLive() async throws {
        let entered = expectation(description: "Validation waiting"), ended = expectation(description: "Validation ended")
        let ping = expectation(description: "Host remains live after cancelled validation")
        let wire = HostWire(observe: { data in
            if let value = try? JSONDecoder().decode(Value.self, from: data), value.objectValue?["id"] == "after-invalid-cancel" { ping.fulfill() }
        })
        let host = ToolHost(transport: wire, tools: try ToolContract().tools, call: { _, _, _ in
            entered.fulfill()
            do { try await Task.sleep(for: .seconds(30)) } catch is CancellationError { }
            ended.fulfill(); throw InvalidParams()
        }, phonePause: { _ in })
        await host.start()
        try wire.feed(["id": "invalid", "method": "tools/call", "params": ["name": "write_file", "arguments": [:]]])
        await fulfillment(of: [entered], timeout: 2)
        try wire.feed(["method": "notifications/cancelled", "params": ["requestId": "invalid"]])
        await fulfillment(of: [ended], timeout: 2)
        try await Task.sleep(for: .milliseconds(30))
        try wire.feed(["id": "after-invalid-cancel", "method": "ping"])
        await fulfillment(of: [ping], timeout: 2)
        await host.stop()
    }
    private func decode(_ data: Data?) throws -> Value { try JSONDecoder().decode(Value.self, from: XCTUnwrap(data)) }
}
private final class ChannelValidity: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func current() -> Bool { lock.withLock { valid } }
    func retire() { lock.withLock { valid = false } }
}
private actor ResetBarrier {
    var suspended = true
    func complete() { suspended = false }
}
private actor HostBox {
    var host: ToolHost?
    func set(_ host: ToolHost) { self.host = host }
}
private final class HostWire: DesktopTransport, @unchecked Sendable {
    private let inbound = AsyncStream<DesktopFrame>.makeStream()
    private let outbound = AsyncStream<Data>.makeStream()
    var outgoing: AsyncStream<Data> { outbound.stream }
    private let beforeSend: @Sendable (Data) throws -> Void
    private let observe: @Sendable (Data) -> Void
    init(beforeSend: @escaping @Sendable (Data) throws -> Void = { _ in }, observe: @escaping @Sendable (Data) -> Void = { _ in }) {
        self.beforeSend = beforeSend; self.observe = observe
    }
    func reset() { inbound.continuation.yield(.reset) }
    func feedRaw(_ data: Data) { inbound.continuation.yield(DesktopFrame(data)) }
    func feed(_ object: Value, current: @escaping @Sendable () -> Bool = { true }) throws {
        var fields = object.objectValue!; fields["jsonrpc"] = "2.0"
        inbound.continuation.yield(DesktopFrame(try JSONEncoder().encode(Value.object(fields)), current: current))
    }
    func send(_ frame: Data) async throws {
        try beforeSend(frame)
        observe(frame); outbound.continuation.yield(frame)
    }
    func frames() -> AsyncStream<DesktopFrame> { inbound.stream }
    func upload(file: URL, attributes: [String: String]) async throws { throw DesktopError.unavailable }
    func downloads() -> AsyncStream<DesktopIncomingFile> { AsyncStream { $0.finish() } }
}
