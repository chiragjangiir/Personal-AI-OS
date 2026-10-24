import Foundation
import XCTest
@testable import HealthKitExporter

final class RealtimeMacPairingTests: XCTestCase {
    private let origin = "https://example.test"
    private let expiry = "2099-01-01T00:00:00.000Z"
    private func qr() throws -> RealtimeMacPairingQR {
        try RealtimeMacPairingQR.decode(JSONSerialization.data(withJSONObject: [
            "schema": RealtimeMacPairingQR.schema, "origin": origin, "nonce": String(repeating: "a", count: 43),
            "public_key_sha256": String(repeating: "b", count: 64), "expires_at": expiry]), origin: origin)
    }
    private func preview(_ changes: [String: String] = [:]) throws -> Data {
        var value = ["label": "Example Mac", "status": "pending", "expires_at": expiry,
                     "public_key_sha256": String(repeating: "b", count: 64)]
        value.merge(changes) { _, new in new }
        return try JSONSerialization.data(withJSONObject: value)
    }
    private func pairing() -> RealtimeDevicePairing {
        RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: origin, deviceID: "iphone", userID: "owner", token: "owner-token",
            governance: RealtimeWireGovernance(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [], purposeTokenRefs: [], capabilityGrantRefs: []),
            media: ["text"], pairedAt: "2026-10-17T00:00:00Z")
    }
    func testPreviewBindsNameToScannedKeyAndExpiry() throws {
        let request = try qr()
        let response = try RealtimeMacPairingPreview.decode(preview(), qr: request)
        XCTAssertEqual(response.label, "Example Mac")
        XCTAssertEqual(response.status, .pending)
        XCTAssertThrowsError(try RealtimeMacPairingPreview.decode(preview(["public_key_sha256": String(repeating: "c", count: 64)]), qr: request))
        XCTAssertThrowsError(try RealtimeMacPairingPreview.decode(preview(["expires_at": "2099-01-02T00:00:00Z"]), qr: request))
        XCTAssertThrowsError(try RealtimeMacPairingPreview.decode(preview(["label": "  "]), qr: request))
        XCTAssertThrowsError(try RealtimeMacPairingPreview.decode(preview(["status": "anything"]), qr: request))
    }
    func testConnectedReceiptHasIndependentServerReceiptExpiry() throws {
        let request = try qr()
        XCTAssertEqual(try RealtimeMacPairingPreview.decode(preview(["status": "connected", "expires_at": "2099-01-02T00:00:00Z"]), qr: request).status, .connected)
        XCTAssertThrowsError(try RealtimeMacPairingPreview.decode(preview(["status": "connected", "expires_at": "2000-01-01T00:00:00Z"]), qr: request))
        XCTAssertThrowsError(try RealtimeMacPairingQR.decode(request.data, origin: origin, now: request.expiresAt)) { error in
            XCTAssertTrue(error is RealtimeMacPairingError)
        }
    }
    func testAuthenticatedPreviewAndApprovalRequireServerReceipt() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MacPairingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); MacPairingURLProtocol.handler = nil }
        let data = try preview()
        MacPairingURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/devices/mac/pairing/preview")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owner-token")
            let body = try JSONSerialization.jsonObject(with: MacPairingURLProtocol.body(request)) as? [String: String]
            XCTAssertEqual(body, ["nonce": String(repeating: "a", count: 43)])
            return data
        }
        let request = try qr()
        let value = try await RealtimeMacPairingAPI.preview(request, pairing: pairing(), session: session)
        XCTAssertEqual(value.status, .pending)
        MacPairingURLProtocol.handler = { _ in Data("{}".utf8) }
        do {
            try await RealtimeMacPairingAPI.approve(request, pairing: pairing(), ownerProof: [:], session: session)
            XCTFail("A 200 response without an approval receipt must fail")
        } catch { XCTAssertTrue(error is RealtimeDevicePairingError) }
        MacPairingURLProtocol.handler = { _ in Data("{\"status\":\"approved\"}".utf8) }
        try await RealtimeMacPairingAPI.approve(request, pairing: pairing(), ownerProof: [:], session: session)
    }
}

private final class MacPairingURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    static func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw try XCTUnwrap(stream.streamError) }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let data = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
