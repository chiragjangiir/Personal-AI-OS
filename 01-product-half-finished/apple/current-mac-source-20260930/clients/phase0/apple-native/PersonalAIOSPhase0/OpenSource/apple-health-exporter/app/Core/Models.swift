import CryptoKit
import Foundation

enum SyncMode: String, Codable, Sendable {
    case backfill
    case incremental
}

enum RecordOperation: String, Codable, Sendable {
    case upsert
}

struct SourceInfo: Codable, Equatable, Sendable {
    let name: String
    let bundleIdentifier: String
    let version: String?
    let productType: String?
}

struct DeviceInfo: Codable, Equatable, Sendable {
    let name: String?
    let manufacturer: String?
    let model: String?
    let hardwareVersion: String?
    let firmwareVersion: String?
    let softwareVersion: String?
    let localIdentifier: String?
    let udiDeviceIdentifier: String?
}

struct WorkoutValue: Codable, Equatable, Sendable {
    let activityType: UInt
    let durationSeconds: Double
    let totalEnergyKilocalories: Double?
    let totalDistanceMeters: Double?
}

enum RecordValue: Codable, Equatable, Sendable {
    case numeric(Double)
    case category(Int)
    case workout(WorkoutValue)

    private enum CodingKeys: String, CodingKey {
        case kind
        case numericValue
        case categoryValue
        case workout
    }

    private enum Kind: String, Codable {
        case numeric
        case category
        case workout
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .numeric:
            self = .numeric(try container.decode(Double.self, forKey: .numericValue))
        case .category:
            self = .category(try container.decode(Int.self, forKey: .categoryValue))
        case .workout:
            self = .workout(try container.decode(WorkoutValue.self, forKey: .workout))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .numeric(let value):
            try container.encode(Kind.numeric, forKey: .kind)
            try container.encode(value, forKey: .numericValue)
        case .category(let value):
            try container.encode(Kind.category, forKey: .kind)
            try container.encode(value, forKey: .categoryValue)
        case .workout(let workout):
            try container.encode(Kind.workout, forKey: .kind)
            try container.encode(workout, forKey: .workout)
        }
    }
}

struct HealthRecord: Codable, Equatable, Sendable {
    let operation: RecordOperation
    let sampleType: String
    let sampleId: UUID
    let start: Date
    let end: Date
    let value: RecordValue
    let unit: String
    let source: SourceInfo
    let device: DeviceInfo?
    let metadata: [String: String]

    init(
        operation: RecordOperation = .upsert,
        sampleType: String,
        sampleId: UUID,
        start: Date,
        end: Date,
        value: RecordValue,
        unit: String,
        source: SourceInfo,
        device: DeviceInfo?,
        metadata: [String: String]
    ) {
        self.operation = operation
        self.sampleType = sampleType
        self.sampleId = sampleId
        self.start = start
        self.end = end
        self.value = value
        self.unit = unit
        self.source = source
        self.device = device
        self.metadata = metadata
    }
}

struct DeletedRecord: Codable, Equatable, Sendable {
    let sampleType: String
    let sampleId: UUID
}

struct ExportBatch: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let batchId: UUID
    let deviceId: UUID
    let createdAt: Date
    let timezone: String
    let mode: SyncMode
    let records: [HealthRecord]
    let deletedRecords: [DeletedRecord]

    init(
        schemaVersion: Int = ExportBatch.currentSchemaVersion,
        batchId: UUID,
        deviceId: UUID,
        createdAt: Date,
        timezone: String,
        mode: SyncMode,
        records: [HealthRecord],
        deletedRecords: [DeletedRecord]
    ) {
        self.schemaVersion = schemaVersion
        self.batchId = batchId
        self.deviceId = deviceId
        self.createdAt = createdAt
        self.timezone = timezone
        self.mode = mode
        self.records = records
        self.deletedRecords = deletedRecords
    }
}

protocol PayloadEncoding: Sendable {
    func encode(_ batch: ExportBatch) throws -> Data
    func decode(_ data: Data) throws -> ExportBatch
}

struct JSONPayloadEncoder: PayloadEncoding {
    func encode(_ batch: ExportBatch) throws -> Data {
        let encoder = JSONEncoder.exporter
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(batch)
    }

    func decode(_ data: Data) throws -> ExportBatch {
        try JSONDecoder.exporter.decode(ExportBatch.self, from: data)
    }
}

extension JSONEncoder {
    static var exporter: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.utc.string(from: date))
        }
        return encoder
    }
}

extension JSONDecoder {
    static var exporter: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = ISO8601.utc.date(from: value) ?? ISO8601.basic.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 UTC timestamp."
            )
        }
        return decoder
    }
}

enum ISO8601 {
    static let utc: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let basic: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()
}

enum BatchIDFactory {
    static func make(seed: String) -> UUID {
        let digest = SHA256.hash(data: Data(seed.utf8))
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    static func anchorFingerprint(_ data: Data?) -> String {
        guard let data else { return "none" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

struct OutboxItem: Codable, Equatable, Sendable {
    let batchId: UUID
    let payload: Data
    let requiredMetricKeys: [String]
    let createdAt: Date
    var attemptCount: Int
    var nextAttemptAt: Date
    var permanentFailure: Bool
    var lastError: String?
}

enum UploadDisposition: Equatable, Sendable {
    case accepted
    case retryable(message: String, retryAfter: TimeInterval?)
    case permanent(message: String)
}

struct MetricSelection: Codable, Equatable, Sendable {
    var oxygenSaturation = false
    var bodyMass = false
    var bodyFatPercentage = false
    var leanBodyMass = false
}

struct AppSettings: Codable, Equatable, Sendable {
    var endpoint = ""
    var metrics = MetricSelection()
    var authorizationRequested = false

    private enum CodingKeys: String, CodingKey {
        case endpoint
        case metrics
        case authorizationRequested
    }

    init(
        endpoint: String = "",
        metrics: MetricSelection = MetricSelection(),
        authorizationRequested: Bool = false
    ) {
        self.endpoint = endpoint
        self.metrics = metrics
        self.authorizationRequested = authorizationRequested
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        endpoint = try container.decodeIfPresent(String.self, forKey: .endpoint) ?? ""
        metrics = try container.decodeIfPresent(
            MetricSelection.self,
            forKey: .metrics
        ) ?? MetricSelection()
        authorizationRequested = try container.decodeIfPresent(
            Bool.self,
            forKey: .authorizationRequested
        ) ?? false
    }
}

struct ConsentReceipt: Codable, Equatable, Sendable {
    let destinationOrigin: String
    let selectedMetricKeys: [String]
    let consentedAt: Date

    func matches(origin: String, metricKeys: [String]) -> Bool {
        destinationOrigin.caseInsensitiveCompare(origin) == .orderedSame
            && selectedMetricKeys.sorted() == metricKeys.sorted()
    }

    private enum CodingKeys: String, CodingKey {
        case destinationOrigin
        case destinationHost
        case selectedMetricKeys
        case consentedAt
    }

    init(
        destinationOrigin: String,
        selectedMetricKeys: [String],
        consentedAt: Date
    ) {
        self.destinationOrigin = destinationOrigin
        self.selectedMetricKeys = selectedMetricKeys
        self.consentedAt = consentedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        destinationOrigin =
            try container.decodeIfPresent(String.self, forKey: .destinationOrigin)
            ?? container.decodeIfPresent(String.self, forKey: .destinationHost)
            ?? ""
        selectedMetricKeys = try container.decode(
            [String].self,
            forKey: .selectedMetricKeys
        )
        consentedAt = try container.decode(Date.self, forKey: .consentedAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(destinationOrigin, forKey: .destinationOrigin)
        try container.encode(selectedMetricKeys, forKey: .selectedMetricKeys)
        try container.encode(consentedAt, forKey: .consentedAt)
    }
}

enum BackendDataState: String, Codable, Equatable, Sendable {
    case current
    case stale
    case empty
}

struct BackendDataDomainStatus: Codable, Equatable, Sendable {
    let state: BackendDataState
    let recordCount: Int
    let latestRecordAt: Date?
}

struct BackendDataDomains: Codable, Equatable, Sendable {
    let recovery: BackendDataDomainStatus
    let sleep: BackendDataDomainStatus
    let activity: BackendDataDomainStatus
    let workouts: BackendDataDomainStatus
}

struct BackendDataStatusSnapshot: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let generatedAt: Date
    let state: BackendDataState
    let latestAcceptedBatchAt: Date?
    let latestRecordAt: Date?
    let activeRecordCount: Int
    let domains: BackendDataDomains
    let databaseSchemaVersion: Int
    let warnings: [String]
}

struct BackendDataStatusCache: Codable, Equatable, Sendable {
    let destinationOrigin: String
    let retrievedAt: Date
    let status: BackendDataStatusSnapshot
}

struct OperationalStatus: Codable, Equatable, Sendable {
    var lastObserverEvent: Date?
    var lastSyncAttempt: Date?
    var lastSuccessfulUpload: Date?
    var lastBackendReachabilityCheck: Date?
    var backendReachable: Bool?
    var pendingOutboxBatches = 0
    var lastRedactedError: String?
    var backgroundRegistration = "未注册"
}

struct HealthQueryPage: Equatable, Sendable {
    let records: [HealthRecord]
    let deletedRecords: [DeletedRecord]
    let newAnchor: Data
    let rawChangeCount: Int
}

struct QueryAnchorState: Codable, Equatable, Sendable {
    let anchor: Data
    let predicateStart: Date
}

struct BackfillCheckpoint: Codable, Equatable, Sendable {
    let runId: UUID
    let start: Date
    let end: Date
    let metricKeys: [String]
    var metricIndex: Int
    var chunkStart: Date
    var queryCursor: Data?
    var queuedBatches: Int
    var processedRecords: Int
}

struct BackfillProgress: Equatable, Sendable {
    let currentMetric: Int
    let totalMetrics: Int
    let chunkStart: Date
    let end: Date
    let queuedBatches: Int
    let processedRecords: Int
}

struct SyncRunResult: Equatable, Sendable {
    var completedMetricKeys: [String] = []
    var metricKeysWithMoreChanges: [String] = []
    var failures: [String: String] = [:]
}

struct MessageError: LocalizedError, Equatable {
    let message: String

    var errorDescription: String? {
        message
    }
}

enum ExporterError: LocalizedError, Equatable {
    case healthDataUnavailable
    case protectedDataUnavailable
    case unsupportedType(String)
    case invalidAnchor
    case invalidEndpoint
    case missingToken
    case consentRequired
    case payloadTooLarge(Int)
    case persistence(String)
    case responseMismatch
    case cancelled

    var errorDescription: String? {
        switch self {
        case .healthDataUnavailable:
            return "此设备无法使用健康数据。"
        case .protectedDataUnavailable:
            return "设备锁定期间暂时无法读取健康数据。"
        case .unsupportedType(let type):
            return "此系统或设备不支持“\(type)”。"
        case .invalidAnchor:
            return "无法解析已保存的 HealthKit 查询锚点。"
        case .invalidEndpoint:
#if DEBUG
            return "请输入 HTTPS 地址；调试测试也可使用本地或私有 HTTP 地址。地址中不能包含账号凭据、查询参数或片段。"
#else
            return "请输入不含账号凭据、查询参数或片段的 HTTPS 地址。"
#endif
        case .missingToken:
            return "请输入 API 令牌。"
        case .consentRequired:
            return "请查看并确认当前目标服务器和指标的上传同意。"
        case .payloadTooLarge(let bytes):
            return "生成的数据超过 \(bytes) 字节的安全上限。"
        case .persistence(let message):
            return "本地保存失败：\(message)"
        case .responseMismatch:
            return "服务器响应未确认本次上传批次标识。"
        case .cancelled:
            return "操作已取消，可以继续。"
        }
    }
}

enum UserFacingError {
    static func message(for error: Error) -> String {
        if error is CancellationError {
            return "操作已取消，可以重试。"
        }
        if let messageError = error as? MessageError {
            return messageError.message
        }
        if let exporterError = error as? ExporterError {
            return exporterError.localizedDescription
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                return "无法连接到服务器，请检查地址和服务状态。"
            case .timedOut:
                return "连接服务器超时，请稍后重试。"
            case .notConnectedToInternet, .networkConnectionLost:
                return "网络连接不可用或已中断。"
            case .secureConnectionFailed, .serverCertificateUntrusted,
                 .serverCertificateHasBadDate, .serverCertificateNotYetValid:
                return "服务器安全连接或证书验证失败。"
            case .cancelled:
                return "操作已取消，可以重试。"
            default:
                return "网络请求失败（错误代码 \(urlError.errorCode)）。"
            }
        }

        return "操作失败（错误代码 \((error as NSError).code)）。"
    }
}
