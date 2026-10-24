import Foundation
import Darwin
import MCP

struct ToolFailure: Error, Sendable {
    let code: String
    let hint: String
    let retryAfter: Int?
    init(_ code: String, _ hint: String, retryAfter: Int? = nil) { self.code = code; self.hint = hint; self.retryAfter = retryAfter }
    var result: Value {
        var details: [String: Value] = ["code": .string(code), "retryable": .bool(retryAfter != nil || code == "DESKTOP_BUSY")]
        if let retryAfter { details["retry_after_s"] = .int(retryAfter) }
        return ["isError": true, "content": [["type": "text", "text": .string(hint)]], "structuredContent": ["error": .object(details)]]
    }
}

/// The single path-policy boundary. F_GETPATH supplies spelling and resolves existing ancestors; never infer scope from prefixes.
enum GuardPath {
    static func within(_ path: String, _ root: String) -> Bool { root == "/" ? path.hasPrefix("/") : path == root || path.hasPrefix(root + "/") }
    private static let sensitiveNames: Set<String> = [".ssh", ".gnupg", ".aws", ".kube", "keychains", ".trash", ".env", ".netrc", "1password", "bitwarden", "safari", "firefox", "mail", "messages"]
    private static let sensitiveSuffixes = [".keychain-db", ".p12", ".pfx", ".pem", ".key"]
    private static let sensitivePrefixes = ["id_rsa", "id_ed25519"]
    static func sensitive(_ path: String, protectedApps: [String] = []) -> Bool {
        let parts = path.lowercased().split(separator: "/").map(String.init)
        if zip(parts, parts.dropFirst()).contains(where: { $0.0 == ".config" && $0.1 == "gh" }) { return true }
        if parts.contains(where: { $0.contains("1password") || $0.contains("bitwarden") || $0.contains("firefox") || $0.hasPrefix("com.apple.safari") }) { return true }
        if parts.contains(where: { ["login data", "cookies", "web data"].contains($0) }), parts.contains(where: { ["chrome", "edge", "microsoft edge", "brave", "brave-browser", "arc"].contains($0) }) { return true }
        return parts.contains {
            sensitiveNames.contains($0) || protectedApps.contains(where: $0.contains) || sensitivePrefixes.contains(where: $0.hasPrefix) || sensitiveSuffixes.contains(where: $0.hasSuffix)
        }
    }
    static func canonical(_ raw: String, protectedApps: [String] = []) throws -> String {
        let path = (raw as NSString).expandingTildeInPath
        guard !raw.isEmpty, !raw.utf8.contains(0), raw.utf8.count <= 1024, path.hasPrefix("/"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else { throw ToolFailure("GUARD_PATH_INVALID", "路径无效") }
        if sensitive(path, protectedApps: protectedApps) { throw ToolFailure("GUARD_SENSITIVE_PATH", "这个文件不能碰；请换一个不含敏感资料的文件") }
        var probe = path, tail: [String] = []
        while true {
            let fd = open(probe, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)
            if fd >= 0 {
                defer { close(fd) }
                var info = stat()
                guard fstat(fd, &info) == 0 else { throw posix(probe) }
                if !tail.isEmpty && info.st_mode & S_IFMT != S_IFDIR { throw ToolFailure("GUARD_PATH_INVALID", "父路径不是文件夹") }
                // O_EVTONLY may open the symlink itself with O_NOFOLLOW: explicitly refuse it.
                guard info.st_mode & S_IFMT != S_IFLNK else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在授权文件夹里") }
                var chars = [CChar](repeating: 0, count: Int(PATH_MAX))
                guard fcntl(fd, F_GETPATH, &chars) == 0 else { throw posix(probe) }
                let existing = String(cString: chars)
                let result = tail.reversed().reduce(existing) { ($0 as NSString).appendingPathComponent($1) }
                if sensitive(result, protectedApps: protectedApps) { throw ToolFailure("GUARD_SENSITIVE_PATH", "这个文件不能碰；请换一个不含敏感资料的文件") }
                return result
            }
            guard errno == ENOENT else { throw posix(probe) }
            let name = (probe as NSString).lastPathComponent
            guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else { throw ToolFailure("GUARD_PATH_INVALID", "路径无效") }
            tail.append(name); probe = (probe as NSString).deletingLastPathComponent
        }
    }
    static func forbiddenRoot(_ path: String, home: String = FileManager.default.homeDirectoryForCurrentUser.path, protectedApps: [String] = []) -> Bool {
        let value = path.hasPrefix("/System/Volumes/Data/") ? String(path.dropFirst("/System/Volumes/Data".count)) : path
        return value == "/" || value == "/Users" || value == "/Volumes" || within(home, value)
            || ["/System", "/Library", "/Applications", home + "/Library"].contains { within(value, $0) } || sensitive(value, protectedApps: protectedApps)
    }
    static func info(_ path: String) throws -> stat {
        let fd = open(path, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw posix(path) }
        defer { close(fd) }
        var result = stat()
        guard fstat(fd, &result) == 0 else { throw posix(path) }
        guard result.st_mode & S_IFMT != S_IFLNK else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在授权文件夹里") }
        return result
    }
    static func posix(_ path: String) -> ToolFailure {
        switch errno {
        case EPERM, EACCES: return ToolFailure("GUARD_PERMISSION_REQUIRED", "这件事要先在电脑上允许依米访问“\((path as NSString).lastPathComponent)”")
        case ENOENT: return ToolFailure("GUARD_NOT_FOUND", "找不到这个文件")
        case EEXIST: return ToolFailure("GUARD_EXISTS", "目标已存在")
        case ELOOP, ENOTDIR: return ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在授权文件夹里")
        default: return ToolFailure("GUARD_PATH_INVALID", String(cString: strerror(errno)))
        }
    }
}

struct StoredGrant: Codable {
    let grant: FileGrant
    let dev: Int32
    let ino: UInt64
    private enum CodingKeys: String, CodingKey { case id, path, name, size, kind, via, dev, ino, granted_at, expires_at }
    init(grant: FileGrant, dev: Int32, ino: UInt64) { self.grant = grant; self.dev = dev; self.ino = ino }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grant = try FileGrant(id: c.decode(String.self, forKey: .id), path: c.decode(String.self, forKey: .path),
            name: c.decode(String.self, forKey: .name), size: c.decode(Int64.self, forKey: .size), kind: c.decode(String.self, forKey: .kind),
            via: c.decode(FileGrant.Via.self, forKey: .via), grantedAt: c.decode(Date.self, forKey: .granted_at), expiresAt: c.decode(Date.self, forKey: .expires_at))
        dev = try c.decode(Int32.self, forKey: .dev); ino = try c.decode(UInt64.self, forKey: .ino)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(grant.id, forKey: .id); try c.encode(grant.path, forKey: .path); try c.encode(grant.name, forKey: .name)
        try c.encode(grant.size, forKey: .size); try c.encode(grant.kind, forKey: .kind); try c.encode(grant.via, forKey: .via)
        try c.encode(grant.grantedAt, forKey: .granted_at); try c.encode(grant.expiresAt, forKey: .expires_at)
        try c.encode(dev, forKey: .dev); try c.encode(ino, forKey: .ino)
    }
}
struct GuardConfig: Codable {
    struct Rates: Codable {
        var reads_per_minute = 120
        var writes_per_minute = 30
        var writes_per_day = 1000
        var trash_items_per_day = 100
        var transfers_per_hour = 20
        var upload_bytes_per_day: Int64 = 209715200
    }
    struct DesktopSettings: Codable {
        struct Attachments: Codable { var grant_ttl_h: Double = 24 }
        var attachments = Attachments()
    }
    struct Consent: Codable { let granted_at: Date }
    struct Usage: Codable { let at: Date; let kind: String; let count: Int; let upload: Int64 }
    var protected_apps: [String]? = nil
    var protectedApps: [String] {
        (protected_apps ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
    }
    var folders: [AuthorizedFolder] = []
    var files: [StoredGrant] = []
    var apps: [String: String] = [:] // Reserved C6.6 policy; v1 has no app tools.
    var consents: [String: Consent] = [:]
    var rates = Rates()
    var desktop = DesktopSettings()
    var undo_retention_days = 30
    var audit_retention_days = 365
    var usage: [Usage] = []
}

struct GuardPolicy {
    var config: GuardConfig
    var pause = PauseState(reasons: [])
    let file: URL
    struct Journal: Codable { let id: String; let config: GuardConfig; var committed = false }
    let audit: AuditStore
    init(store: URL, audit: AuditStore) throws {
        file = store.appendingPathComponent("guard.json"); self.audit = audit
        config = GuardConfig()
        let markers = try FileManager.default.contentsOfDirectory(atPath: store.path).filter { $0.hasPrefix(".guard-") }
        let saved = try audit.guardJournal()
        let journal = saved.flatMap { try? JSONDecoder().decode(Journal.self, from: $0) }
        if !markers.isEmpty || journal?.committed == false {
            guard let journal, markers.isEmpty || markers == [".guard-v2-" + journal.id] else { poisoned = true; return }
            do { try recover(journal, marker: ".guard-v2-" + journal.id) }
            catch { poisoned = true; return }
        }
        let exists = FileManager.default.fileExists(atPath: file.path)
        config = exists ? try JSONDecoder().decode(GuardConfig.self, from: Data(contentsOf: file)) : GuardConfig()
        if !exists { try persist() }
    }
    private func recover(_ journal: Journal, marker: String) throws {
        let parent = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw GuardPath.posix(file.path) }; defer { close(parent) }
        // Keep recovery replayable until the published inode is verified and durable.
        try audit.setGuardJournal(JSONEncoder().encode(Journal(id: journal.id, config: journal.config)))
        let fd = openat(parent, marker, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GuardPath.posix(file.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              ftruncate(fd, 0) == 0 else { throw ToolFailure("DESKTOP_AUDIT_STORE", "权限恢复文件无效") }
        try handle.write(contentsOf: JSONEncoder().encode(journal.config)); try handle.synchronize()
        var named = stat()
        guard fstatat(parent, marker, &named, AT_SYMLINK_NOFOLLOW) == 0, FileIdentity(named) == FileIdentity(info) else {
            throw ToolFailure("DESKTOP_AUDIT_STORE", "权限恢复文件身份已经改变")
        }
        guard renameat(parent, marker, parent, "guard.json") == 0, fsync(parent) == 0 else { throw GuardPath.posix(file.path) }
        guard fstatat(parent, "guard.json", &named, AT_SYMLINK_NOFOLLOW) == 0, FileIdentity(named) == FileIdentity(info) else {
            throw ToolFailure("DESKTOP_AUDIT_STORE", "权限恢复提交身份已经改变")
        }
        try audit.setGuardJournal(JSONEncoder().encode(Journal(id: journal.id, config: journal.config, committed: true)))
    }
    var checkpoint: @Sendable (String) -> Void = { _ in }
    var poisoned = false
    mutating func install(_ candidate: GuardConfig, finalize: () throws -> Void = {}) throws {
        guard !poisoned else { throw ToolFailure("DESKTOP_AUDIT_STORE", "权限状态无法确认") }
        let parent = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw GuardPath.posix(file.path) }; defer { close(parent) }
        let id = UUID().uuidString, name = ".guard-v2-" + id
        try audit.setGuardJournal(JSONEncoder().encode(Journal(id: id, config: config)))
        let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GuardPath.posix(file.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var cleanup = true
        defer { try? handle.close(); if cleanup { unlinkat(parent, name, 0) } }
        checkpoint("created")
        try handle.write(contentsOf: JSONEncoder().encode(candidate)); try handle.synchronize()
        checkpoint("written")
        var info = stat()
        let existed = fstatat(parent, "guard.json", &info, AT_SYMLINK_NOFOLLOW) == 0
        if existed && (info.st_mode & S_IFMT != S_IFREG || info.st_nlink != 1) { throw ToolFailure("GUARD_PATH_INVALID", "权限配置不是普通文件") }
        guard renameatx_np(parent, name, parent, "guard.json", UInt32(existed ? RENAME_SWAP : RENAME_EXCL)) == 0 else { throw GuardPath.posix(file.path) }
        do {
            guard fsync(parent) == 0 else { throw GuardPath.posix(file.path) }
            checkpoint("swapped")
            try audit.transaction {
                try finalize()
                try audit.setGuardJournal(JSONEncoder().encode(Journal(id: id, config: candidate, committed: true)))
            }
        } catch {
            let restored = existed ? renameatx_np(parent, name, parent, "guard.json", UInt32(RENAME_SWAP)) : renameat(parent, "guard.json", parent, name)
            if restored != 0 || fsync(parent) != 0 { cleanup = false; poisoned = true; throw ToolFailure("DESKTOP_AUDIT_STORE", "权限状态恢复失败，电脑操作已停止") }
            throw error
        }
        checkpoint("audited")
        config = candidate
        cleanup = false
        guard (!existed || unlinkat(parent, name, 0) == 0), fsync(parent) == 0 else { poisoned = true; throw ToolFailure("DESKTOP_AUDIT_STORE", "权限写入清理失败，电脑操作已停止") }
        checkpoint("unlinked")
    }
    mutating func persist() throws { try install(config) }
    func open(_ raw: String, tool: String, write: Bool) throws -> FileCapability {
        guard !poisoned else { throw ToolFailure("DESKTOP_AUDIT_STORE", "权限状态无法确认") }
        guard !pause.paused else { throw ToolFailure("DESKTOP_PAUSED", "主人暂停了依米操作电脑") }
        let path = try GuardPath.canonical(raw, protectedApps: config.protectedApps)
        if let record = config.files.first(where: { $0.grant.path == path && $0.grant.expiresAt > Date() }) {
            guard ["read_text_file", "get_file_info", "extract_text", "upload_to_workshop", "write_file", "edit_file", "trash"].contains(tool) else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "临时授权只适用于这个文件，不能移动或创建相邻文件") }
            return try FileCapability.open(root: (path as NSString).deletingLastPathComponent, path: path, expected: FileIdentity(dev: record.dev, ino: record.ino), protectedApps: config.protectedApps)
        }
        guard let root = config.folders.filter({ GuardPath.within(path, $0.id) }).max(by: { $0.id.count < $1.id.count }), !write || root.write else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在可用的授权文件夹里") }
        return try FileCapability.open(root: root.id, path: path, protectedApps: config.protectedApps)
    }
    func openUndo(_ raw: String, trashSource: Bool = false) throws -> FileCapability {
        guard !poisoned else { throw ToolFailure("DESKTOP_AUDIT_STORE", "权限状态无法确认") }
        guard !pause.paused else { throw ToolFailure("DESKTOP_PAUSED", "主人暂停了依米操作电脑") }
        // This is the owner's local Undo action on one successful audit record, never an MCP tool or a persistent grant.
        let path: String
        if trashSource {
            // Trash is an internal destination. Resolve its OS spelling without authorizing it as a tool root.
            let fd = Darwin.open(raw, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw GuardPath.posix(raw) }; defer { close(fd) }
            path = try FileCapability.path(fd)
        } else { path = try GuardPath.canonical(raw, protectedApps: config.protectedApps) }
        return try FileCapability.open(root: (path as NSString).deletingLastPathComponent, path: path, protectedApps: config.protectedApps)
    }
    mutating func charge(kind: String, count: Int = 1, upload: Int64 = 0, now: Date = Date()) throws {
        var next = config
        next.usage.removeAll { $0.at < now.addingTimeInterval($0.kind == "read" ? -60 : -86400) }
        let recent = next.usage, day = Calendar.current.startOfDay(for: now)
        func check(_ sum: Int64, _ cap: Int64, _ retry: Int) throws { if sum > cap { throw ToolFailure("GUARD_RATE_LIMITED", "操作太频繁，稍后再试", retryAfter: retry) } }
        if kind == "read" { try check(Int64(recent.filter { $0.kind == "read" && $0.at > now.addingTimeInterval(-60) }.count + 1), Int64(config.rates.reads_per_minute), 60) }
        else {
            try check(Int64(recent.filter { $0.kind != "read" && $0.at > now.addingTimeInterval(-60) }.count + 1), Int64(config.rates.writes_per_minute), 60)
            try check(Int64(recent.filter { $0.kind != "read" && $0.at >= day }.count + 1), Int64(config.rates.writes_per_day), 86400)
        }
        if kind == "trash" { try check(Int64(recent.filter { $0.kind == "trash" && $0.at >= day }.reduce(count) { $0 + $1.count }), Int64(config.rates.trash_items_per_day), 86400) }
        if kind == "transfer" { try check(Int64(recent.filter { $0.kind == "transfer" && $0.at > now.addingTimeInterval(-3600) }.count + 1), Int64(config.rates.transfers_per_hour), 3600) }
        try check(recent.filter { $0.at >= day }.reduce(upload) { $0 + $1.upload }, config.rates.upload_bytes_per_day, 86400)
        next.usage.append(.init(at: now, kind: kind, count: count, upload: upload)); try install(next)
    }
    mutating func paused(_ reason: PauseReason) {
        guard reason != .screenShare else { return }
        pause.reasons.insert(reason)
    }
    mutating func resumed(_ reason: PauseReason) {
        guard reason != .screenShare else { return }
        pause.reasons.removeAll()
    }
}
