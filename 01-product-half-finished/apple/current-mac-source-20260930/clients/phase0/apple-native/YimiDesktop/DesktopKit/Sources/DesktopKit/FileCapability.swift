import Foundation
import Darwin

struct FileIdentity: Equatable, Sendable {
    let dev: Int32
    let ino: UInt64
    init(_ value: stat) { dev = value.st_dev; ino = value.st_ino }
    init(dev: Int32, ino: UInt64) { self.dev = dev; self.ino = ino }
}

/// An opened namespace and object, never a path to reopen after authorization.
final class FileCapability: @unchecked Sendable {
    let parent: Int32
    let fd: Int32?
    let path: String
    let parentPath: String
    let tail: [String]
    let info: stat?
    let grant: Bool
    let protectedApps: [String]
    var name: String { tail[0] }
    var committedPath: String { parentPath + "/" + name }
    init(parent: Int32, fd: Int32?, path: String, tail: [String], info: stat?, grant: Bool, protectedApps: [String] = []) throws {
        self.protectedApps = protectedApps
        self.parent = parent; self.fd = fd; self.path = path; self.tail = tail; self.info = info; self.grant = grant
        parentPath = try Self.path(parent)
    }
    deinit { close(parent); if let fd { close(fd) } }
    static func path(_ fd: Int32) throws -> String {
        var chars = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard fcntl(fd, F_GETPATH, &chars) == 0 else { throw GuardPath.posix("文件") }
        return String(cString: chars)
    }
    static func checkedStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0 else { throw GuardPath.posix("文件") }
        if value.st_mode & S_IFMT == S_IFLNK { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在授权文件夹里") }
        guard [S_IFREG, S_IFDIR].contains(value.st_mode & S_IFMT), value.st_mode & S_IFMT != S_IFREG || value.st_nlink == 1 else {
            throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "只能操作普通、无硬链接的文件或文件夹")
        }
        return value
    }
    static func open(root: String, path: String, expected: FileIdentity? = nil, protectedApps: [String] = []) throws -> FileCapability {
        guard GuardPath.within(path, root) else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不在授权文件夹里") }
        // Walk from / even for a grant: neither an ancestor nor the selected root can be a symlink.
        let parts = path.split(separator: "/").map(String.init)
        var parent = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw GuardPath.posix(path) }
        do {
            for (index, part) in parts.enumerated() {
                let last = index == parts.count - 1
                let file = openat(parent, part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (last ? 0 : O_DIRECTORY))
                if file < 0 {
                    guard errno == ENOENT, expected == nil else { throw GuardPath.posix(path) }
                    return try FileCapability(parent: parent, fd: nil, path: path, tail: Array(parts[index...]), info: nil, grant: false, protectedApps: protectedApps)
                }
                let value: stat
                do { value = try checkedStat(file) } catch { close(file); throw error }
                if last {
                    if let expected, FileIdentity(value) != expected { close(file); throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "临时文件授权已失效") }
                    return try FileCapability(parent: parent, fd: file, path: path, tail: [part], info: value, grant: expected != nil, protectedApps: protectedApps)
                }
                close(parent); parent = file
            }
            throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "不能操作文件系统根目录")
        } catch { close(parent); throw error }
    }
    func validate(unchanged: Bool = false) throws {
        guard try Self.path(parent) == parentPath else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件夹位置已经改变") }
        if let info {
            var current = stat()
            guard fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 else { throw GuardPath.posix(path) }
            guard FileIdentity(current) == FileIdentity(info), current.st_mode & S_IFMT != S_IFLNK else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件身份已经改变") }
            guard try Self.path(fd!) == path else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件位置已经改变") }
            _ = try Self.checkedStat(fd!)
            if unchanged && (current.st_size != info.st_size || current.st_mtimespec.tv_sec != info.st_mtimespec.tv_sec || current.st_mtimespec.tv_nsec != info.st_mtimespec.tv_nsec) {
                throw ToolFailure("GUARD_EXISTS", "文件已经改变，保留当前文件")
            }
        }
    }
    func requireFile() throws -> Int32 {
        guard let fd, let info else { throw ToolFailure("GUARD_NOT_FOUND", "找不到这个文件") }
        guard info.st_mode & S_IFMT == S_IFREG else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "只能操作普通文件") }
        try validate(); return fd
    }
    func children() throws -> [String] {
        guard let fd, info.map({ $0.st_mode & S_IFMT == S_IFDIR }) == true else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "需要一个文件夹") }
        try validate()
        guard let directory = fdopendir(dup(fd)) else { throw GuardPath.posix(path) }
        defer { closedir(directory) }; rewinddir(directory)
        var names: [String] = []
        errno = 0
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) } }
            if name != "." && name != ".." { names.append(name) }
        }
        guard errno == 0 else { throw GuardPath.posix(path) }
        return names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    }
    func child(_ name: String) throws -> FileCapability {
        guard let fd else { throw ToolFailure("GUARD_NOT_FOUND", "找不到文件夹") }
        let childPath = path + "/" + name
        if GuardPath.sensitive(childPath, protectedApps: protectedApps) { throw ToolFailure("GUARD_SENSITIVE_PATH", "这个文件不能碰") }
        let opened = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard opened >= 0 else { throw GuardPath.posix(childPath) }
        do { return try FileCapability(parent: dup(fd), fd: opened, path: childPath, tail: [name], info: Self.checkedStat(opened), grant: false, protectedApps: protectedApps) }
        catch { close(opened); throw error }
    }
    /// Capture first, then verify the captured inode. Destination collisions never replace a file.
    @discardableResult func move(to destination: FileCapability, journal: (FileMovement) throws -> Void = { _ in }, checkpoint: (String) -> Void = { _ in }) throws -> stat {
        guard let info else { throw ToolFailure("GUARD_NOT_FOUND", "找不到这个文件") }
        try validate(); try destination.validate()
        guard destination.tail.count == 1 else { throw ToolFailure("GUARD_NOT_FOUND", "目标文件夹不存在") }
        let holding = try FileTransactionDirectory(parent: parent)
        guard fsync(holding.fd) == 0, fsync(parent) == 0 else { throw GuardPath.posix(path) }
        try journal(FileMovement(source: path, destination: destination.path, directory: holding.path,
                                 directoryDevice: holding.identity.dev, directoryInode: holding.identity.ino,
                                 device: info.st_dev, inode: info.st_ino, mode: info.st_mode & S_IFMT))
        checkpoint("prepared")
        guard renameatx_np(parent, name, holding.fd, "captured", UInt32(RENAME_EXCL)) == 0 else { throw GuardPath.posix(path) }
        holding.retained = true
        guard fsync(holding.fd) == 0, fsync(parent) == 0 else { throw GuardPath.posix(path) }
        checkpoint("captured")
        do {
            let captured = try holding.stat("captured")
            guard FileIdentity(captured) == FileIdentity(info), captured.st_mode & S_IFMT == info.st_mode & S_IFMT,
                  captured.st_mode & S_IFMT != S_IFREG || captured.st_nlink == 1,
                  try Self.path(fd!) == holding.path + "/captured" else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件身份已经改变") }
            try destination.validate(); try holding.validate()
            guard renameatx_np(holding.fd, "captured", destination.parent, destination.name, UInt32(RENAME_EXCL)) == 0 else { throw GuardPath.posix(destination.path) }
            guard fsync(holding.fd) == 0, fsync(destination.parent) == 0 else { throw GuardPath.posix(destination.path) }
            holding.retained = false
            checkpoint("delivered")
            return captured
        } catch {
            if renameatx_np(holding.fd, "captured", parent, name, UInt32(RENAME_EXCL)) == 0 { holding.retained = false }
            else { throw ToolFailure("GUARD_RECOVERY_REQUIRED", "文件保留在恢复目录：" + holding.path + "/captured") }
            throw error
        }
    }

}

/// A private namespace owns captured originals until restoration or durable undo takes ownership.
final class FileTransactionDirectory {
    let parent: Int32
    let name = ".yimi-" + UUID().uuidString
    let fd: Int32
    let identity: FileIdentity
    var retained = false
    var path: String { (try? FileCapability.path(fd)) ?? "恢复目录不可定位" }
    init(parent: Int32) throws {
        self.parent = dup(parent)
        guard self.parent >= 0 else { throw GuardPath.posix("文件夹") }
        guard mkdirat(parent, name, 0o700) == 0 else { close(self.parent); throw GuardPath.posix("文件夹") }
        fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { close(self.parent); throw GuardPath.posix("文件夹") }
        do { identity = try FileIdentity(FileCapability.checkedStat(fd)) }
        catch { close(fd); close(self.parent); throw error }
    }
    func stat(_ name: String) throws -> Darwin.stat {
        var value = Darwin.stat()
        guard fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else { throw GuardPath.posix(path) }
        return value
    }
    func validate() throws {
        var current = Darwin.stat()
        guard fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              FileIdentity(current) == identity else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "暂存文件夹位置已经改变") }
    }
    deinit {
        if !retained {
            var current = Darwin.stat()
            if fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0, FileIdentity(current) == identity { unlinkat(parent, name, AT_REMOVEDIR) }
        }
        close(fd); close(parent)
    }
}

/// Staging and rollback are synchronous; Desktop checks its generation immediately before commit.
final class FileStage: @unchecked Sendable {
    let target: FileCapability
    let fd: Int32
    let directory: Bool
    let holding: FileTransactionDirectory
    var temporary: String { holding.name }
    private(set) var retainedBackupPath: String?
    private var committed = false
    private struct OwnedNode { let parent: Int32; let name: String; let fd: Int32; let identity: FileIdentity; let directory: Bool }
    private var nodes: [OwnedNode] = []
    init(target: FileCapability, directory: Bool = false) throws {
        self.target = target; self.directory = directory || target.tail.count > 1
        holding = try FileTransactionDirectory(parent: target.parent)
        if self.directory {
            guard mkdirat(holding.fd, "payload", 0o700) == 0 else { throw GuardPath.posix(target.path) }
            fd = openat(holding.fd, "payload", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        } else { fd = openat(holding.fd, "payload", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, target.info.map { $0.st_mode & 0o777 } ?? 0o600) }
        guard fd >= 0 else { throw GuardPath.posix(target.path) }
        do { try own(parent: holding.fd, name: "payload", fd: fd, directory: self.directory) }
        catch { close(fd); throw error }
    }
    private func own(parent: Int32, name: String, fd: Int32, directory: Bool) throws {
        nodes.append(OwnedNode(parent: dup(parent), name: name, fd: dup(fd), identity: try FileIdentity(FileCapability.checkedStat(fd)), directory: directory))
    }
    deinit {
        // Walk only nodes this operation created. Never enumerate or reopen a substituted outer name.
        for node in nodes.reversed() {
            if !committed {
                var current = stat()
                if fstatat(node.parent, node.name, &current, AT_SYMLINK_NOFOLLOW) == 0, FileIdentity(current) == node.identity {
                    unlinkat(node.parent, node.name, node.directory ? AT_REMOVEDIR : 0)
                }
            }
            close(node.fd); close(node.parent)
        }
        close(fd)
    }
    func fileDescriptor(makeDirectory: Bool = false) throws -> Int32 {
        if !directory { return dup(fd) }
        var parent = dup(fd)
        do {
            for component in target.tail.dropFirst().dropLast(makeDirectory ? 0 : 1) {
                guard mkdirat(parent, component, 0o700) == 0 else { throw GuardPath.posix(target.path) }
                let next = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard next >= 0 else { throw GuardPath.posix(target.path) }
                try own(parent: parent, name: component, fd: next, directory: true)
                close(parent); parent = next
            }
            if makeDirectory { return parent }
            let file = openat(parent, target.tail.last!, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { throw GuardPath.posix(target.path) }
            try own(parent: parent, name: target.tail.last!, fd: file, directory: false)
            close(parent); return file
        } catch { close(parent); throw error }
    }
    func replacementRecord() throws -> FileReplacement? {
        guard target.info != nil else { return nil }
        let payload = try FileCapability.checkedStat(fd)
        return FileReplacement(directory: holding.path, device: holding.identity.dev, inode: holding.identity.ino,
                               payloadDevice: payload.st_dev, payloadInode: payload.st_ino,
                               payloadSize: payload.st_size, payloadMtime: Desktop.mtime(payload))
    }
    func commit(checkpoint: (String) -> Void = { _ in }) throws -> stat {
        try target.validate(unchanged: true); try holding.validate()
        let payload = try FileCapability.checkedStat(fd)
        guard FileIdentity(try holding.stat("payload")) == FileIdentity(payload) else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "暂存文件身份已经改变") }
        guard fsync(fd) == 0, fsync(holding.fd) == 0, fsync(target.parent) == 0 else { throw GuardPath.posix(target.path) }
        checkpoint("prepared")
        if let previous = target.info {
            // Exchange the two names atomically: the public path always names a complete file.
            guard renameatx_np(holding.fd, "payload", target.parent, target.name, UInt32(RENAME_SWAP)) == 0 else { throw GuardPath.posix(target.path) }
            holding.retained = true; committed = true
            retainedBackupPath = holding.path + "/payload"
            checkpoint("swapped")
            do {
                let captured = try holding.stat("payload")
                guard FileIdentity(captured) == FileIdentity(previous), captured.st_mode & S_IFMT == previous.st_mode & S_IFMT,
                      captured.st_mode & S_IFMT != S_IFREG || captured.st_nlink == 1,
                      captured.st_size == previous.st_size, captured.st_mtimespec.tv_sec == previous.st_mtimespec.tv_sec,
                      captured.st_mtimespec.tv_nsec == previous.st_mtimespec.tv_nsec,
                      try FileCapability.path(target.fd!) == holding.path + "/payload" else { throw ToolFailure("GUARD_EXISTS", "原文件已经改变，保留当前文件") }
            } catch {
                let failure = error
                var current = stat()
                guard fstatat(target.parent, target.name, &current, AT_SYMLINK_NOFOLLOW) == 0,
                      FileIdentity(current) == FileIdentity(payload),
                      renameatx_np(holding.fd, "payload", target.parent, target.name, UInt32(RENAME_SWAP)) == 0 else {
                    throw ToolFailure("GUARD_RECOVERY_REQUIRED", "原文件保留在恢复目录：" + retainedBackupPath!)
                }
                holding.retained = false; committed = false; retainedBackupPath = nil
                throw failure
            }
            guard renameatx_np(holding.fd, "payload", holding.fd, "previous", UInt32(RENAME_EXCL)) == 0 else { throw GuardPath.posix(target.path) }
            retainedBackupPath = holding.path + "/previous"
            checkpoint("captured")
        } else { try place(payload) }
        guard fsync(holding.fd) == 0, fsync(target.parent) == 0 else { throw GuardPath.posix(target.path) }
        return payload
    }

    /// Shared by normal completion and launch recovery; the audit keeps the same undo retention policy.
    static func preserveBackup(source: Int32, holding: Int32, name: String, durable: String) throws {
        let parent = open((durable as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw GuardPath.posix(durable) }; defer { close(parent) }
        let temporary = ".backup-" + UUID().uuidString
        defer { unlinkat(parent, temporary, 0) }
        if fclonefileat(source, parent, temporary, 0) != 0 {
            guard [EXDEV, ENOTSUP, EINVAL].contains(errno) else { throw GuardPath.posix(durable) }
            let out = openat(parent, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard out >= 0 else { throw GuardPath.posix(durable) }; defer { close(out) }
            _ = try Desktop.copyDescriptor(source, to: out, maximum: (try FileCapability.checkedStat(source)).st_size)
        }
        let backup = openat(parent, temporary, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard backup >= 0 else { throw GuardPath.posix(durable) }; defer { close(backup) }
        guard fsync(backup) == 0, renameat(parent, temporary, parent, (durable as NSString).lastPathComponent) == 0,
              fsync(parent) == 0 else { throw GuardPath.posix(durable) }
        var held = stat()
        guard fstatat(holding, name, &held, AT_SYMLINK_NOFOLLOW) == 0,
              FileIdentity(held) == FileIdentity(try FileCapability.checkedStat(source)) else { throw ToolFailure("GUARD_RECOVERY_REQUIRED", "备份身份已经改变") }
        guard unlinkat(holding, name, 0) == 0, fsync(holding) == 0 else { throw GuardPath.posix(durable) }
    }

    static func recoverPending(_ history: AuditStore) throws {
        try FileMove.recoverPending(history)
        for var row in try history.unresolvedReplacements() {
            let restored = try recover(&row)
            try history.transaction {
                if row.result == "ok", let entry = row.undoOf, let original = try history.record(entry), let undo = original.undo {
                    if let restored, let dev = undo.previousDevice, let ino = undo.previousInode, let size = undo.previousSize, let mtime = undo.previousMtime {
                        try history.rebindRestoredIdentity(device: dev, inode: ino, size: size, mtime: mtime, to: restored)
                    }
                    try history.markUndone(entry, at: Date())
                }
                try history.append(row)
            }
        }
    }
    private static func recover(_ row: inout AuditRecord) throws -> stat? {
        guard let undo = row.undo, let replacement = undo.replacement else { return nil }
        let parent = (undo.originalPath as NSString).deletingLastPathComponent
        let namespace = try FileCapability.open(root: parent, path: parent)
        var current = stat()
        let found: Bool
        if let fd = namespace.fd {
            found = fstatat(fd, (undo.originalPath as NSString).lastPathComponent, &current, AT_SYMLINK_NOFOLLOW) == 0
            if !found && ![ENOENT, ENOTDIR].contains(errno) { throw GuardPath.posix(undo.originalPath) }
        } else { found = false }
        let info: stat? = found ? current : nil
        let stage = try FileCapability.open(root: parent, path: replacement.directory)
        let applied = info.map(FileIdentity.init) == FileIdentity(dev: replacement.payloadDevice, ino: replacement.payloadInode)
        let untouched = info.map { undo.previousDevice == UInt64(UInt32(bitPattern: $0.st_dev)) && undo.previousInode == $0.st_ino } == true
        if let fd = stage.fd {
            guard stage.info.map(FileIdentity.init) == FileIdentity(dev: replacement.device, ino: replacement.inode) else {
                throw ToolFailure("GUARD_RECOVERY_REQUIRED", "恢复目录身份已经改变")
            }
            let names = try stage.children()
            let name = names.contains("previous") ? "previous" : "payload"
            if names.contains(name) {
                let held = try stage.child(name), heldFD = try held.requireFile(), heldInfo = try FileCapability.checkedStat(heldFD)
                if undo.previousDevice == UInt64(UInt32(bitPattern: heldInfo.st_dev)), undo.previousInode == heldInfo.st_ino {
                    try preserveBackup(source: heldFD, holding: fd, name: name, durable: undo.backupPath!)
                } else if !applied, FileIdentity(heldInfo) == FileIdentity(dev: replacement.payloadDevice, ino: replacement.payloadInode) {
                    guard unlinkat(fd, name, 0) == 0 else { throw GuardPath.posix(replacement.directory) }
                } else { throw ToolFailure("GUARD_RECOVERY_REQUIRED", "恢复备份身份已经改变") }
            }
            try stage.validate()
            guard unlinkat(stage.parent, stage.name, AT_REMOVEDIR) == 0, fsync(stage.parent) == 0 else { throw GuardPath.posix(replacement.directory) }
        }
        if applied || !untouched {
            let backup = try FileCapability.open(root: (undo.backupPath! as NSString).deletingLastPathComponent, path: undo.backupPath!)
            _ = try backup.requireFile()
        }
        if applied, let info {
            row.undo?.device = UInt64(UInt32(bitPattern: info.st_dev)); row.undo?.inode = info.st_ino
            row.undo?.size = replacement.payloadSize; row.undo?.mtime = replacement.payloadMtime; row.result = "ok"
            row.errorCode = nil; row.guardCode = nil
        } else if untouched { row.result = "cancelled"; row.errorCode = "DESKTOP_INTERRUPTED" }
        else { row.result = "error"; row.errorCode = "GUARD_RECOVERY_REQUIRED" }
        row.undo?.replacement = nil
        if applied, let info, info.st_size == replacement.payloadSize, Desktop.mtime(info) == replacement.payloadMtime { return info }
        return nil
    }
    private func place(_ payload: stat) throws {
        try holding.validate()
        guard try FileCapability.path(target.parent) == target.parentPath else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件夹位置已经改变") }
        guard renameatx_np(holding.fd, "payload", target.parent, target.name, UInt32(RENAME_EXCL)) == 0 else { throw GuardPath.posix(target.path) }
        committed = true
        var placed = stat()
        guard fstatat(target.parent, target.name, &placed, AT_SYMLINK_NOFOLLOW) == 0, FileIdentity(placed) == FileIdentity(payload) else { throw ToolFailure("GUARD_RECOVERY_REQUIRED", "提交时文件身份发生改变，原文件已保留") }
    }
}
