import Foundation

// Endpoint-local operational history only. This is never a T10 DeliveryReceipt SoT.
struct AppleLocalOperationReceipt: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case start
        case stop
        case reconnect
        case encryptionFailure
    }

    let operationID: String
    let kind: Kind
    let recordedAt: Date
    let localCleanupComplete: Bool
    let remoteConfirmationPresent: Bool
    let statusCode: String
    let opaqueRemoteReference: String?
}

enum AppleReceiptStoreError: Error, Equatable, Sendable {
    case unsafeField(String)
    case corruptPersistence
}

protocol AppleReceiptRecording: Sendable {
    func append(_ receipt: AppleLocalOperationReceipt) async throws
    func recent() async throws -> [AppleLocalOperationReceipt]
}

actor AppleReceiptStore: AppleReceiptRecording {
    private struct PersistedReceipt: Codable, Equatable, Sendable {
        let operationID: String
        let kind: AppleLocalOperationReceipt.Kind
        let recordedAt: Date
        let localCleanupComplete: Bool
        let remoteConfirmationPresent: Bool
        let statusCode: String

        init(_ receipt: AppleLocalOperationReceipt) {
            operationID = receipt.operationID
            kind = receipt.kind
            recordedAt = receipt.recordedAt
            localCleanupComplete = receipt.localCleanupComplete
            remoteConfirmationPresent = receipt.remoteConfirmationPresent
            statusCode = receipt.statusCode
        }

        var receipt: AppleLocalOperationReceipt {
            AppleLocalOperationReceipt(
                operationID: operationID,
                kind: kind,
                recordedAt: recordedAt,
                localCleanupComplete: localCleanupComplete,
                remoteConfirmationPresent: remoteConfirmationPresent,
                statusCode: statusCode,
                opaqueRemoteReference: nil
            )
        }
    }

    private let fileURL: URL?
    private let capacity: Int
    private let localPendingCache: (any AppleLocalPendingCaching)?
    private var receipts: [AppleLocalOperationReceipt]

    init(
        fileURL: URL? = nil,
        capacity: Int = 128,
        localPendingCache: (any AppleLocalPendingCaching)? = nil
    ) {
        self.fileURL = fileURL
        self.capacity = max(1, capacity)
        self.localPendingCache = localPendingCache
        self.receipts = []
    }

    func append(_ receipt: AppleLocalOperationReceipt) async throws {
        try Self.validate(receipt)
        try loadIfNeeded()
        if receipts.contains(where: { Self.sameSafeReceipt($0, receipt) }) {
            try localPendingCache?.cache(receipt)
            return
        }
        receipts.append(receipt)
        if receipts.count > capacity {
            receipts.removeFirst(receipts.count - capacity)
        }
        try persist()
        try localPendingCache?.cache(receipt)
    }

    func recent() async throws -> [AppleLocalOperationReceipt] {
        try loadIfNeeded()
        return receipts
    }

    private var hasLoaded = false

    private func loadIfNeeded() throws {
        guard !hasLoaded else {
            return
        }
        guard
            let fileURL,
            FileManager.default.fileExists(atPath: fileURL.path)
        else {
            hasLoaded = true
            return
        }
        let data = try Data(contentsOf: fileURL)
        guard data.count <= 256 * 1024,
              !data.starts(with: [0xef, 0xbb, 0xbf]) else {
            throw AppleReceiptStoreError.corruptPersistence
        }
        let allowedKeys: Set<String> = [
            "operationID", "kind", "recordedAt",
            "localCleanupComplete", "remoteConfirmationPresent",
            "statusCode"
        ]
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let array = object as? [[String: Any]],
              array.allSatisfy({ entry in
                  Set(entry.keys) == allowedKeys
              }) else {
            throw AppleReceiptStoreError.corruptPersistence
        }
        let persisted: [PersistedReceipt]
        do {
            persisted = try JSONDecoder().decode(
                [PersistedReceipt].self,
                from: data
            )
        } catch {
            throw AppleReceiptStoreError.corruptPersistence
        }
        for item in persisted {
            try Self.validate(item)
        }
        receipts = persisted.map { $0.receipt }
        if receipts.count > capacity {
            receipts = Array(receipts.suffix(capacity))
        }
        hasLoaded = true
    }

    private func persist() throws {
        guard let fileURL else {
            return
        }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(
            receipts.map { PersistedReceipt($0) }
        )
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = fileURL
        try mutableURL.setResourceValues(values)
    }

    private static func sameSafeReceipt(
        _ lhs: AppleLocalOperationReceipt,
        _ rhs: AppleLocalOperationReceipt
    ) -> Bool {
        lhs.operationID == rhs.operationID
            && lhs.kind == rhs.kind
            && lhs.recordedAt == rhs.recordedAt
            && lhs.localCleanupComplete == rhs.localCleanupComplete
            && lhs.remoteConfirmationPresent == rhs.remoteConfirmationPresent
            && lhs.statusCode == rhs.statusCode
    }

    private static func validate(_ receipt: AppleLocalOperationReceipt) throws {
        try validate(
            operationID: receipt.operationID,
            statusCode: receipt.statusCode
        )
    }

    private static func validate(_ receipt: PersistedReceipt) throws {
        try validate(
            operationID: receipt.operationID,
            statusCode: receipt.statusCode
        )
    }

    private static func validate(
        operationID: String,
        statusCode: String
    ) throws {
        guard isSafeIdentifier(operationID, maximumLength: 128) else {
            throw AppleReceiptStoreError.unsafeField("operationID")
        }
        guard isSafeIdentifier(statusCode, maximumLength: 128) else {
            throw AppleReceiptStoreError.unsafeField("statusCode")
        }
    }

    private static func isSafeIdentifier(
        _ value: String,
        maximumLength: Int
    ) -> Bool {
        guard !value.isEmpty, value.count <= maximumLength else {
            return false
        }
        let normalized = value.lowercased()
        let forbidden = [
            "bearer", "token", "secret", "password", "credential",
            "privatekey", "contentkey", "e2eekey", "authorization"
        ]
        guard forbidden.allSatisfy({ !normalized.contains($0) }) else {
            return false
        }
        return value.unicodeScalars.allSatisfy { scalar in
            let code = scalar.value
            return (code >= 48 && code <= 57)
                || (code >= 65 && code <= 90)
                || (code >= 97 && code <= 122)
                || code == 95
                || code == 45
                || code == 46
        }
    }
}
