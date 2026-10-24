import Darwin
import Foundation

struct FileMovement: Codable {
    let source: String
    let destination: String
    let directory: String
    let directoryDevice: Int32
    let directoryInode: UInt64
    let device: Int32
    let inode: UInt64
    let mode: mode_t

    func matches(_ info: stat?) -> Bool {
        info.map { FileIdentity($0) == FileIdentity(dev: device, ino: inode) && $0.st_mode & S_IFMT == mode &&
            (mode != S_IFREG || $0.st_nlink == 1) } == true
    }
}

/// Movement uses the same durable audit intent and completion protocol as replacement.
enum FileMove {
    static func recoverPending(_ history: AuditStore) throws {
        for var row in try history.unresolvedMovements() {
            do { try recover(&row) }
            catch {
                // Keep the journal and captured object on conflicts; the activity exposes the failure.
                row.result = "error"; row.errorCode = "GUARD_RECOVERY_REQUIRED"
            }
            try history.transaction {
                if row.result == "ok", let entry = row.undoOf { try history.markUndone(entry, at: Date()) }
                try history.append(row)
            }
        }
    }
    private static func recover(_ row: inout AuditRecord) throws {
        guard let move = row.undo?.movement else { return }
        let sourceParent = (move.source as NSString).deletingLastPathComponent
        let destinationParent = (move.destination as NSString).deletingLastPathComponent
        let source = try FileCapability.open(root: sourceParent, path: move.source)
        let destination = try FileCapability.open(root: destinationParent, path: move.destination)
        guard source.tail.count == 1, destination.tail.count == 1 else { throw conflict() }
        let holding = try FileCapability.open(root: sourceParent, path: move.directory)
        var applied = false
        if holding.fd != nil {
            guard holding.info.map(FileIdentity.init) == FileIdentity(dev: move.directoryDevice, ino: move.directoryInode),
                  holding.info!.st_mode & S_IFMT == S_IFDIR else { throw conflict() }
            let names = try holding.children()
            guard names.allSatisfy({ $0 == "captured" }) else { throw conflict() }
            if names.contains("captured") {
                let captured = try holding.child("captured")
                guard move.matches(captured.info), source.info == nil else { throw conflict() }
                try source.validate(); try holding.validate(); try captured.validate()
                guard renameatx_np(holding.fd!, "captured", source.parent, source.name, UInt32(RENAME_EXCL)) == 0,
                      fsync(source.parent) == 0, fsync(holding.fd!) == 0 else { throw GuardPath.posix(move.source) }
                var restored = stat()
                guard fstatat(source.parent, source.name, &restored, AT_SYMLINK_NOFOLLOW) == 0,
                      move.matches(restored), try FileCapability.path(captured.fd!) == source.committedPath else { throw conflict() }
            } else {
                applied = move.matches(destination.info)
                guard applied || move.matches(source.info) else { throw conflict() }
            }
            try holding.validate()
            guard unlinkat(holding.parent, holding.name, AT_REMOVEDIR) == 0, fsync(holding.parent) == 0 else { throw GuardPath.posix(move.directory) }
        } else {
            applied = move.matches(destination.info)
            guard applied || move.matches(source.info) else { throw conflict() }
        }
        if applied, let info = destination.info {
            row.undo?.device = UInt64(UInt32(bitPattern: info.st_dev)); row.undo?.inode = info.st_ino
            row.undo?.size = info.st_size; row.undo?.mtime = Desktop.mtime(info)
            row.result = "ok"; row.errorCode = nil; row.guardCode = nil
        } else { row.result = "cancelled"; row.errorCode = "DESKTOP_INTERRUPTED" }
        row.undo?.movement = nil
    }
    private static func conflict() -> ToolFailure { ToolFailure("GUARD_RECOVERY_REQUIRED", "移动恢复路径或文件身份已经改变，原文件仍保留在审计记录的恢复目录") }
}

extension Desktop {
    func moveCapability(_ source: FileCapability, to destination: FileCapability, record: inout AuditRecord) throws -> stat {
        let info = try source.move(to: destination, journal: { movement in
            record.undo?.movement = movement
            try recordAudit(record)
        }, checkpoint: fileCheckpoint)
        bind(&record, info: info, path: source.path)
        return info
    }
}
