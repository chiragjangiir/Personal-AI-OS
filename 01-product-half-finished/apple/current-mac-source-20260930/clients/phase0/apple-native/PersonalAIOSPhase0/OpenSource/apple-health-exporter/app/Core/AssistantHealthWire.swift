import CryptoKit
import Foundation

/// Converts the exporter's canonical records at the formal HEALTH boundary. Never drops a record.
enum AssistantHealthWire {
    typealias Chunk = CentralOwnerDataBatch
    static func chunks(page: HealthQueryPage, metric: HealthMetric, maximumBytes: Int) throws -> [Chunk] {
        var result: [Chunk] = []
        var recordOffset = 0
        var deletedOffset = 0
        repeat {
            let id = "health-" + UUID().uuidString.lowercased()
            var sources: [String] = []
            var samples: [[String: Any]] = []
            var deleted: [String] = []
            func bytes() throws -> Data {
                try AssistantCentralTextWire.encode("health_batch", fields: [
                    "control_id": id, "metric": metric.rawValue, "unit": metric.canonicalUnit.symbol,
                    "tz": TimeZone.current.identifier, "sources": sources, "samples": samples, "deleted": deleted
                ])
            }
            while recordOffset < page.records.count, samples.count < 64 {
                let record = page.records[recordOffset]
                let fullSource = [record.source.bundleIdentifier.isEmpty ? record.source.name : record.source.bundleIdentifier,
                    record.source.productType ?? "", record.device?.localIdentifier ?? "", record.device?.model ?? ""]
                    .joined(separator: "|")
                // Long source identifiers retain identity without exposing an unbounded label on the wire.
                let source = fullSource.unicodeScalars.count <= 160 ? fullSource : "sha256:" + SHA256.hash(data: Data(fullSource.utf8)).map { String(format: "%02x", $0) }.joined()
                let previousSources = sources
                if !sources.contains(source) {
                    if sources.count == 16 { break }
                    sources.append(source)
                }
                var sample: [String: Any] = ["id": record.sampleId.uuidString.lowercased(),
                    "s": Int64((record.start.timeIntervalSince1970 * 1000).rounded(.down)),
                    "e": Int64((record.end.timeIntervalSince1970 * 1000).rounded(.down)),
                    "src": sources.firstIndex(of: source)!]
                switch record.value {
                case .numeric(let value): sample["v"] = value
                case .category(let category): sample["c"] = category
                case .workout(let workout):
                    var fields: [String: Any] = ["type": workout.activityType, "dur": workout.durationSeconds]
                    if let value = workout.totalEnergyKilocalories { fields["kcal"] = value }
                    if let value = workout.totalDistanceMeters { fields["dist"] = value }
                    sample["w"] = fields
                }
                samples.append(sample)
                // Encoding checks the source contract's total budget as well as the connection's budget.
                if (try? bytes().count).map({ $0 <= maximumBytes }) != true {
                    samples.removeLast(); sources = previousSources
                    if samples.isEmpty { throw CentralTextError.invalidPacket }
                    break
                }
                recordOffset += 1
            }
            while deletedOffset < page.deletedRecords.count, deleted.count < 128 {
                deleted.append(page.deletedRecords[deletedOffset].sampleId.uuidString.lowercased())
                if (try? bytes().count).map({ $0 <= maximumBytes }) != true {
                    deleted.removeLast()
                    if samples.isEmpty && deleted.isEmpty { throw CentralTextError.invalidPacket }
                    break
                }
                deletedOffset += 1
            }
            result.append(Chunk(bytes: try bytes(), controlID: id, stored: samples.count, deleted: deleted.count))
        } while recordOffset < page.records.count || deletedOffset < page.deletedRecords.count
        return result
    }
}

/// Bounded owner-data transport: HEALTH and CONTACTS share one receipt matcher and send lifecycle.
struct CentralOwnerDataBatch: Sendable {
    let operation: String
    let bytes: Data
    let controlID: String
    let stored: Int
    let deleted: Int
    init(operation: String = "health_batch", bytes: Data, controlID: String, stored: Int, deleted: Int) {
        self.operation = operation; self.bytes = bytes; self.controlID = controlID; self.stored = stored; self.deleted = deleted
    }
    func matchesReceipt(_ fields: CentralBody, sessionID: String) throws -> Bool {
        guard try fields.value("operation", as: String.self) == operation.replacingOccurrences(of: "_batch", with: "_ack"),
              try fields.value("control_id", as: String.self) == controlID,
              try fields.value("session_id", as: String.self) == sessionID,
              try fields.value("schema_version", as: String.self) == AssistantCentralTextWire.schema,
              let count = try fields.value("stored", as: Int.self), (0...stored).contains(count),
              let removed = try fields.value("deleted", as: Int.self), (0...deleted).contains(removed) else { return false }
        return true
    }
}

struct AssistantHealthFailure: Error, Sendable { let code: String }

/// One pairing identity rule for all owner-data state. Keep the original digest domain for existing HEALTH anchors.
enum CentralOwnerDataIdentity {
    static func pairing(_ pairing: RealtimeDevicePairing) -> String {
        SHA256.hash(data: Data("HEALTH\n\(pairing.originalOrigin)\n\(pairing.userID)\n\(pairing.deviceID)\n\(pairing.pairedAt)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}
