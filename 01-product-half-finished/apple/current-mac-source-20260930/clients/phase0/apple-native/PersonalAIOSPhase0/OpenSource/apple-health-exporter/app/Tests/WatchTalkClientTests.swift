import Foundation
import Network
import XCTest
@testable import HealthKitExporter

@MainActor
final class WatchTalkClientTests: XCTestCase {
    private let credential = WatchCredential(version: 1, kind: "watch_credential", token: "fixture-watch",
        expires_at: "2099-01-01T00:00:00Z", server: "https://example.invalid",
        scope: WatchBindingScope(watch_device_id: "47ea18be-77ce-489d-aa00-d2343f7cbf94", pair_version: "1"))

    func testUnsatisfiedPathDoesNotBlockSuccessfulURLSessionTurn() async throws {
        let monitor = NWPathMonitor()
        XCTAssertEqual(monitor.currentPath.status, .unsatisfied)
        let recorder = TalkRecorder()
        let started = expectation(description: "recording started")
        recorder.onStart = { started.fulfill() }
        let session = transport()
        defer { session.invalidateAndCancel() }
        let client = WatchTalkClient(credential: { self.credential }, recorder: recorder, session: session)
        TalkURLProtocol.handler = { request in
            let polling = request.httpMethod == "GET"
            let turn = polling ? request.url!.lastPathComponent : request.value(forHTTPHeaderField: "X-Watch-Turn-ID")!
            return (200, ["status": polling ? "replied" : "heard", "turn_id": turn, polling ? "text" : "heard": "在呢"])
        }
        let replied = expectation(description: "URLSession upload and turn wait succeeded")
        let observation = client.$state.sink { if $0.phase == .reply { replied.fulfill() } }
        defer { observation.cancel(); client.reset() }
        client.startByUser()
        await fulfillment(of: [started], timeout: 2)
        client.finishByUser()
        await fulfillment(of: [replied], timeout: 2)
        XCTAssertEqual(client.state.reply, "在呢")
        XCTAssertEqual(client.state.heard, "在呢")
        XCTAssertEqual(monitor.currentPath.status, .unsatisfied)
    }

    func testRealTransportFailuresOnUploadAndTurnWaitShowNetworkMessage() async {
        for failOnPoll in [false, true] {
            let recorder = TalkRecorder()
            let started = expectation(description: "recording started")
            recorder.onStart = { started.fulfill() }
            let session = transport()
            defer { session.invalidateAndCancel() }
            let client = WatchTalkClient(credential: { self.credential }, recorder: recorder, session: session)
            TalkURLProtocol.handler = { request in
                if !failOnPoll || request.httpMethod == "GET" { throw URLError(.notConnectedToInternet) }
                return (200, ["status": "heard", "turn_id": request.value(forHTTPHeaderField: "X-Watch-Turn-ID")!, "heard": "你好"])
            }
            let failed = expectation(description: "real transport failure surfaced")
            let observation = client.$state.sink { if $0.phase == .failure { failed.fulfill() } }
            defer { observation.cancel(); client.reset() }
            client.startByUser()
            await fulfillment(of: [started], timeout: 2)
            client.finishByUser()
            await fulfillment(of: [failed], timeout: 2)
            XCTAssertEqual(client.state.failureScreen, .network)
            XCTAssertEqual(client.state.failure, "连接中断。请重试，确认这句话的回复。")
            XCTAssertTrue(client.state.canRetry)
        }
    }

    func testMissingCredentialKeepsRegistrationFlowWithoutRecordingOrRequest() {
        let recorder = TalkRecorder()
        recorder.onStart = { XCTFail("Missing credential must not start recording") }
        let session = transport()
        defer { session.invalidateAndCancel() }
        TalkURLProtocol.handler = { _ in XCTFail("Missing credential must not send a request"); throw URLError(.cancelled) }
        var refreshed = false
        let client = WatchTalkClient(credential: { nil }, refreshCredential: { refreshed = true },
            recorder: recorder, session: session)
        client.startByUser()
        XCTAssertEqual(client.state.failureScreen, .registration)
        XCTAssertEqual(client.state.failure, WatchTalkFailure.credential_missing.message)
        XCTAssertTrue(refreshed)
        XCTAssertFalse(client.state.canRetry)
    }

    private func transport() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TalkURLProtocol.self]
        return URLSession(configuration: config)
    }
}

@MainActor
private final class TalkRecorder: WatchUtteranceRecording {
    var onFinish: ((Result<(Data, Int), Error>) -> Void)?
    var onStart: (() -> Void)?
    func requestPermission() async -> Bool { true }
    func start() throws { onStart?() }
    func finish(wristDown: Bool) { onFinish?(.success((Data([1, 2, 3]), 1000))) }
    func cancel() {}
}

private final class TalkURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, [String: String]))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler(request)
            let reply = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
