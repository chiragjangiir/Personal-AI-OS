import Foundation

enum AssistantAppearanceImageUpload {
    static func upload(_ jpeg: Data, pairing: RealtimeDevicePairing, session: URLSession? = nil) async throws -> AssistantAppearanceLook {
        guard !jpeg.isEmpty, jpeg.count <= 5_242_880,
              try EndpointResolver.canonicalRealtimeOrigin(from: pairing.origin) == pairing.origin,
              let url = URL(string: pairing.origin + "/v1/appearance/images") else { throw RealtimeDevicePairingError.invalidPairing }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 30; request.httpBody = jpeg
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + pairing.token, forHTTPHeaderField: "Authorization")
        let transport = session ?? ProductionRealtimePublicControlProvider.makeSession()
        defer { if session == nil { transport.finishTasksAndInvalidate() } }
        let (bytes, response) = try await transport.bytes(for: request, delegate: RealtimeNoRedirectDelegate())
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        guard http.statusCode == 201 else { throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(http.statusCode, nil) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 16_384 else { throw RealtimeDevicePairingError.invalidPairing }
            data.append(byte)
        }
        return try JSONDecoder().decode(AssistantAppearanceLook.self, from: data)
    }
}
