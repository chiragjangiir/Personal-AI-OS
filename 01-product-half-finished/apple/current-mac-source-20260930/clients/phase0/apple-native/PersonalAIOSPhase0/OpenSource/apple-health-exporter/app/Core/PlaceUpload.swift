import Foundation

struct PlaceRegion: Codable, Equatable, Sendable {
    let id: String
    let label: String
    let latitude: Double
    let longitude: Double
    let radius_m: Double
}

struct PlaceEvent: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case visitArrival = "visit_arrival", visitDeparture = "visit_departure"
        case regionEnter = "region_enter", regionExit = "region_exit"
    }
    let id: String
    let kind: Kind
    let location: AssistantRetainedLocation
    let arrivalAt: Date?
    let departureAt: Date?
    let regionID: String?

    init(id: String = UUID().uuidString.lowercased(), kind: Kind, location: AssistantLocationObservation,
         arrivalAt: Date? = nil, departureAt: Date? = nil, regionID: String? = nil) {
        self.id = id; self.kind = kind; self.location = AssistantRetainedLocation(location)
        self.arrivalAt = arrivalAt; self.departureAt = departureAt; self.regionID = regionID
    }
}

enum PlaceUploadBatch {
    static func encode(deviceID: String, events: [PlaceEvent], regionVersion: Int?) throws -> Data {
        guard events.count <= 64 else { throw RealtimePublicControlAdapterError.canonicalBodyTooLarge }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let items = events.map { event -> [String: Any] in
            let location = AssistantCentralTextWire.wire(event.location.observation)
            var item: [String: Any] = ["id": event.id, "kind": event.kind.rawValue,
                                      "sensor_at": location["observed_at"]!, "location": location]
            if let at = event.arrivalAt { item["arrival_at"] = formatter.string(from: at) }
            if let at = event.departureAt { item["departure_at"] = formatter.string(from: at) }
            if let id = event.regionID { item["region_id"] = id }
            return item
        }
        var body: [String: Any] = ["schema": "paios.place-upload.v1", "device_id": deviceID, "events": items]
        if let version = regionVersion { body["region_version"] = version }
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        guard data.count <= 128 * 1024 else { throw RealtimePublicControlAdapterError.canonicalBodyTooLarge }
        return data
    }
}

struct PlaceRegionSet: Codable, Equatable, Sendable {
    let version: Int
    let items: [PlaceRegion]?
}

struct PlaceUploadResponse: Codable, Equatable, Sendable {
    let schema: String
    let stored_ids: [String]
    let duplicate_ids: [String]
    let expired_ids: [String]
    let regions: PlaceRegionSet
}

/// One request per call. Durable replay and credential recovery belong to the place service.
struct PlaceGatewayClient: Sendable {
    private let session: URLSession?
    init(session: URLSession? = nil) { self.session = session }

    func upload(credential: PlaceCredential, events: [PlaceEvent], regionVersion: Int?) async throws -> PlaceUploadResponse {
        let body = try PlaceUploadBatch.encode(deviceID: credential.deviceID, events: events, regionVersion: regionVersion)
        let data = try await post(origin: credential.origin, path: "/v1/place/upload", token: credential.token, body: body)
        let response = try JSONDecoder().decode(PlaceUploadResponse.self, from: data)
        let ids = response.stored_ids + response.duplicate_ids + response.expired_ids
        // Regions are checked where they are monitored, so one bad region never blocks the acknowledgements.
        guard response.schema == "paios.place-upload-response.v1", response.regions.version >= 0,
              Set(ids).count == ids.count, Set(ids) == Set(events.map(\.id)) else {
            throw RealtimePublicControlAdapterError.invalidHTTPResponse
        }
        return response
    }

    func manageCredential(pairing: RealtimeDevicePairing, action: String) async throws -> PlaceCredential? {
        guard ["rotate", "revoke"].contains(action) else { throw RealtimeDevicePairingError.invalidPairing }
        let body = try JSONSerialization.data(withJSONObject: ["device_id": pairing.deviceID, "action": action])
        let data = try await post(origin: pairing.origin, path: "/v1/place/credential", token: pairing.token, body: body)
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["schema"] as? String == "paios.place-credential.v1",
              response["device_id"] as? String == pairing.deviceID,
              response["scope"] as? String == "place_upload" else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        if action == "revoke" {
            guard response["revoked"] as? Bool == true, response["token"] == nil else {
                throw RealtimePublicControlAdapterError.invalidHTTPResponse
            }
            return nil
        }
        guard let token = response["token"] as? String,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              response["revoked"] == nil else { throw RealtimePublicControlAdapterError.invalidBearerCredential }
        return PlaceCredential(pairing: pairing, token: token)
    }

    private func post(origin: String, path: String, token: String, body: Data) async throws -> Data {
        let origin = try EndpointResolver.canonicalRealtimeOrigin(from: origin)
        guard token.range(of: "^[A-Za-z0-9_-]{16,512}$", options: .regularExpression) != nil,
              let url = URL(string: origin + path) else { throw RealtimePublicControlAdapterError.invalidBearerCredential }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let transport = session ?? ProductionRealtimePublicControlProvider.makeSession()
        defer { if session == nil { transport.finishTasksAndInvalidate() } }
        let (data, response) = try await transport.data(for: request, delegate: RealtimeNoRedirectDelegate())
        guard let http = response as? HTTPURLResponse else { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
        guard data.count <= 128 * 1024 else { throw RealtimePublicControlAdapterError.responseTooLarge }
        guard http.statusCode == 200 else {
            throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(http.statusCode,
                ProductionRealtimePublicControlProvider.sanitizedServerErrorCode(from: data))
        }
        return data
    }
}
