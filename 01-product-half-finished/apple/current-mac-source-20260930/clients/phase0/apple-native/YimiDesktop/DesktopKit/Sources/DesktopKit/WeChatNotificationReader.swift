import Foundation
import CSQLite
import Darwin

public struct WeChatPreview: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let chat: String
    public let subtitle: String
    public let body: String
    public let delivered_at: String
}

public struct WeChatPreviewCursor: Codable, Equatable, Sendable {
    public var delivered: Double
    public var record: Int64
    public init(since: Date) { delivered = since.timeIntervalSinceReferenceDate; record = 0 }
}

public struct WeChatPreviewPage: Sendable {
    public let previews: [WeChatPreview]
    public let cursor: WeChatPreviewCursor
}

/// Reads only WeChat's records. The OS database and plist layout are private, so schema errors surface to the owner.
public struct WeChatNotificationReader: Sendable {
    public let database: URL
    public init(database: URL) { self.database = database }
    public static func systemDatabase() throws -> URL {
        if ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15 {
            return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Group Containers/group.com.apple.usernoted/db2/db")
        }
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard confstr(_CS_DARWIN_USER_DIR, &path, path.count) > 0 else { throw POSIXError(.ENOENT) }
        return URL(fileURLWithPath: String(cString: path)).appendingPathComponent("com.apple.notificationcenter/db2/db")
    }

    public func read(after cursor: WeChatPreviewCursor, chats: Set<String>) throws -> WeChatPreviewPage {
        var db: OpaquePointer?
        guard sqlite3_open_v2(database.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }
            throw failure("无法只读访问通知数据库。请在系统设置中为依米开启完全磁盘访问，再重试。")
        }
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        let sql = """
        SELECT r.rec_id, hex(r.uuid), r.data, r.delivered_date FROM record r
        JOIN app a ON a.app_id = r.app_id WHERE a.identifier = 'com.tencent.xinWeChat'
        AND (r.delivered_date > ? OR (r.delivered_date = ? AND r.rec_id > ?))
        ORDER BY r.delivered_date, r.rec_id LIMIT 20
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw failure("通知数据库结构暂不支持。请交由维护者核对当前 macOS 版本。")
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, cursor.delivered)
        sqlite3_bind_double(statement, 2, cursor.delivered)
        sqlite3_bind_int64(statement, 3, cursor.record)
        var next = cursor, previews: [WeChatPreview] = []
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            let previous = next
            next.record = sqlite3_column_int64(statement, 0)
            next.delivered = sqlite3_column_double(statement, 3)
            guard let bytes = sqlite3_column_blob(statement, 2), sqlite3_column_bytes(statement, 2) <= 262_144 else {
                throw failure("微信通知载荷无效，未上传本批内容。")
            }
            let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 2)))
            guard let root = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let request = root["req"] as? [String: Any] else { throw failure("微信通知格式暂不支持，未上传本批内容。") }
            if let title = request["titl"] as? String, chats.contains(title) {
                let id = String(cString: sqlite3_column_text(statement, 1))
                guard id.count == 32, request["body"] == nil || request["body"] is String,
                      request["subt"] == nil || request["subt"] is String else { throw failure("微信通知字段暂不支持，未上传本批内容。") }
                let body = request["body"] as? String ?? "", subtitle = request["subt"] as? String ?? ""
                guard title.utf16.count <= 256, subtitle.utf16.count <= 512, body.utf16.count <= 8192 else {
                    throw failure("微信通知超出预览长度限制，未截断或上传，请自行查看。")
                }
                let preview = WeChatPreview(id: id, chat: title, subtitle: subtitle, body: body,
                    delivered_at: formatter.string(from: Date(timeIntervalSinceReferenceDate: next.delivered)))
                if try JSONEncoder().encode(previews + [preview]).count > 120_000 {
                    return WeChatPreviewPage(previews: previews, cursor: previous)
                }
                previews.append(preview)
            }
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw failure("读取通知数据库失败，请稍后重试。") }
        return WeChatPreviewPage(previews: previews, cursor: next)
    }
    private func failure(_ text: String) -> NSError {
        NSError(domain: "WeChatNotificationReader", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
