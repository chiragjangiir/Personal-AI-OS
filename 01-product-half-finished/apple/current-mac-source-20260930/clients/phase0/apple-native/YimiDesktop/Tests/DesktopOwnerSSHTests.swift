import XCTest

final class DesktopOwnerSSHTests: XCTestCase {
    @MainActor func testLocalStopRemovesAuthorizationAndPreservesIdentityAndAudit() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["authorized_keys", "host_key", "commands.jsonl"] { try Data(name.utf8).write(to: root.appendingPathComponent(name)) }
        let ssh = DesktopOwnerSSH(directory: root)
        try ssh.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
        for name in ["host_key", "commands.jsonl"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), Data(name.utf8)) }
        try ssh.stop()
    }

    @MainActor func testRejectedCloudRevokeStillRemovesLocalAuthorization() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("test key".utf8).write(to: root.appendingPathComponent("authorized_keys"))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [RejectedSSHRequest.self]
        let ssh = DesktopOwnerSSH(directory: root, session: URLSession(configuration: config))
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: id, token: "test-token", governance: governance, media: [], pairedAt: "2026-10-19T00:00:00Z", deviceType: "mac")
        do { try await ssh.revoke(pairing); XCTFail("Cloud rejection must surface") }
        catch { XCTAssertEqual((error as NSError).code, 403) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
    }
}

private final class RejectedSSHRequest: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
