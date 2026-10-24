import Foundation
import Darwin
import MCP

extension Desktop {
    func perform(id: Value, name: String, arguments args: [String: Value], record: inout AuditRecord) async throws -> Value {
        var caps: [String: FileCapability] = [:]
        let write = record.toolClass != "read" && name != "upload_to_workshop"
        for key in ["path", "source", "destination", "folder"] {
            if let raw = args[key]?.stringValue { caps[key] = try opened(raw, tool: name, write: write) }
        }
        let trashCaps = try (args["paths"]?.arrayValue ?? []).map { try opened($0.stringValue!, tool: name, write: true) }
        let epoch = generation
        try await interleave("authorized"); try checkCommit(epoch)
        for cap in caps.values { try cap.validate() }; for cap in trashCaps { try cap.validate() }
        let path = caps["path"]
        let upload = name == "upload_to_workshop" ? (path?.info?.st_size ?? 0) : 0
        if upload > 26214400 { throw ToolFailure("TRANSFER_TOO_LARGE", "文件超过25 MiB") }
        try policy.charge(kind: record.toolClass, count: max(1, trashCaps.count), upload: upload)
        switch name {
        case "window_capture":
            let image = try await windowSharing.capture(windowID: args["window_id"]?.intValue.map(UInt32.init))
            try checkCommit(epoch); return image
        case "list_allowed_directories": return try ToolContract.result(["directories": .array(policy.config.folders.map { ["path": .string($0.id), "label": .string($0.label), "write": .bool($0.write)] })])
        case "find_files":
            let cap = caps["folder"]!, indexed = try await NativeTools.spotlight(folder: cap.path, query: args["query"]?.stringValue ?? "")
            let value = try await Self.offActor { try NativeFileExecutor.find(cap, args: args, indexed: indexed) }; try checkCommit(epoch); return try ToolContract.result(value)
        case "extract_text":
            let fd = try path!.requireFile(); let value = try await Self.offActor { try await NativeTools.extract(args, fd: fd) }; try checkCommit(epoch); return try ToolContract.result(value)
        case "upload_to_workshop": return try await uploadFile(path!, request: id, expectedSize: upload, epoch: epoch)
        case "save_from_workshop": return try await saveFile(args, request: id, record: &record, epoch: epoch)
        case "trash": return try await trash(trashCaps, id: id, record: &record, epoch: epoch)
        case "read_text_file":
            let cap = path!, fd = try cap.requireFile()
            let text = try await Self.offActor { try FileText.read(fd: fd, size: cap.info!.st_size, args: args) }; try checkCommit(epoch); return try textResult(text)
        case "get_file_info":
            guard let info = path?.info else { throw ToolFailure("GUARD_NOT_FOUND", "找不到这个文件") }; return FileText.value(FileText.info(info))
        case "list_directory", "list_directory_with_sizes":
            let cap = path!; return try await Self.offActor { try NativeFileExecutor.listing(cap, sizes: name == "list_directory_with_sizes", args: args) }
        case "search_files":
            let cap = path!; return try await Self.offActor { try NativeFileExecutor.search(cap, args: args) }
        case "write_file", "edit_file":
            let cap = path!
            if cap.grant && (name == "write_file" || args["dryRun"]?.boolValue != true) { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "临时授权文件保留原文件，请将处理结果另存到文稿/依米") }
            let content: String, result: String
            if name == "write_file" { content = try FileText.writeContent(args); result = "Successfully wrote to " + args["path"]!.stringValue! }
            else {
                let fd = try cap.requireFile()
                let edited = try await Self.offActor { try FileText.edit(content: FileText.content(fd: fd), args: args, path: args["path"]!.stringValue!) }
                content = edited.text; result = edited.diff
                if args["dryRun"]?.boolValue == true { return try textResult(result) }
            }
            guard cap.tail.count == 1 else { throw ToolFailure("GUARD_NOT_FOUND", "父文件夹不存在") }
            let value = try textResult(result)
            let stage = try await Self.offActor { () -> FileStage in
                let stage = try FileStage(target: cap), fd = try stage.fileDescriptor(); defer { close(fd) }
                try Task.checkCancellation(); try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: Data(content.utf8))
                guard fsync(fd) == 0 else { throw GuardPath.posix(cap.path) }; return stage
            }
            record.undo = try await prepareWrite(cap, audit: record.id); try recordAudit(record)
            _ = try await commitStage(stage, epoch: epoch, record: &record); return value
        case "create_directory":
            let cap = path!
            if cap.info == nil {
                let stage = try FileStage(target: cap, directory: true), fd = try stage.fileDescriptor(makeDirectory: true); close(fd)
                record.undo = UndoRecord(kind: "create", originalPath: cap.committedPath); try recordAudit(record)
                try await interleave("staged"); try checkCommit(epoch); bind(&record, info: try stage.commit(), path: cap.committedPath)
            } else if cap.info!.st_mode & S_IFMT != S_IFDIR { throw ToolFailure("GUARD_EXISTS", "目标已存在") }
            return FileText.value("Successfully created directory " + args["path"]!.stringValue!)
        case "move_file":
            let from = caps["source"]!, to = caps["destination"]!
            guard from.info != nil, to.tail.count == 1 else { throw ToolFailure("GUARD_NOT_FOUND", "找不到文件或目标文件夹") }
            try await Self.offActor { try NativeFileExecutor.validateTree(from) }
            record.undo = UndoRecord(kind: "move", originalPath: from.path, movedTo: to.path); try recordAudit(record)
            try await interleave("move"); try checkCommit(epoch); try from.validate(); try to.validate()
            _ = try moveCapability(from, to: to, record: &record)
            return FileText.value("Successfully moved " + args["source"]!.stringValue! + " to " + args["destination"]!.stringValue!)
        default: throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "这个工具不在电脑的工具清单里")
        }
    }
    func textResult(_ text: String) throws -> Value {
        let value = FileText.value(text)
        guard try JSONEncoder().encode(value).count <= 262144 else { throw ToolFailure("GUARD_TOO_LARGE", "文本超过256 KiB，请缩小范围") }; return value
    }
    func bind(_ record: inout AuditRecord, info: stat, path: String) {
        record.undo?.device = UInt64(UInt32(bitPattern: info.st_dev)); record.undo?.inode = info.st_ino
        record.undo?.size = info.st_size; record.undo?.mtime = Self.mtime(info)
    }
    nonisolated static func mtime(_ info: stat) -> Double { Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1e9 }
    func prepareWrite(_ cap: FileCapability, audit: String) async throws -> UndoRecord {
        guard cap.info != nil else { return UndoRecord(kind: "create", originalPath: cap.committedPath) }
        let source = try cap.requireFile()
        let directory = store.appendingPathComponent("undo").appendingPathComponent(audit)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let backup = directory.appendingPathComponent((cap.path as NSString).lastPathComponent)
        try await Self.offActor {
            let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parent >= 0 else { throw GuardPath.posix(backup.path) }; defer { close(parent) }
            if fclonefileat(source, parent, backup.lastPathComponent, 0) != 0 {
                guard [EXDEV, ENOTSUP, EINVAL].contains(errno) else { throw GuardPath.posix(backup.path) }
                let fd = openat(parent, backup.lastPathComponent, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
                guard fd >= 0 else { throw GuardPath.posix(backup.path) }; defer { close(fd) }
                _ = try Self.copyDescriptor(source, to: fd, maximum: cap.info!.st_size)
            }
            let saved = openat(parent, backup.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard saved >= 0 else { throw GuardPath.posix(backup.path) }; defer { close(saved) }
            guard fsync(saved) == 0, fsync(parent) == 0 else { throw GuardPath.posix(backup.path) }
            for ancestor in [directory.deletingLastPathComponent(), directory.deletingLastPathComponent().deletingLastPathComponent()] {
                let fd = open(ancestor.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw GuardPath.posix(ancestor.path) }; defer { close(fd) }
                guard fsync(fd) == 0 else { throw GuardPath.posix(ancestor.path) }
            }
            try Task.checkCancellation()
        }
        return UndoRecord(kind: "overwrite", originalPath: cap.path, backupPath: backup.path, previousDevice: UInt64(UInt32(bitPattern: cap.info!.st_dev)), previousInode: cap.info!.st_ino, previousSize: cap.info!.st_size, previousMtime: Self.mtime(cap.info!))
    }
    @discardableResult func commitStage(_ stage: FileStage, epoch: UInt64, record: inout AuditRecord) async throws -> stat {
        try await interleave("staged"); try checkCommit(epoch)
        record.undo?.replacement = try stage.replacementRecord(); try recordAudit(record)
        let info = try stage.commit(checkpoint: fileCheckpoint)
        bind(&record, info: info, path: stage.target.committedPath)
        try await finishBackup(stage, record: &record)
        fileCheckpoint("backed-up")
        return info
    }
    func finishBackup(_ stage: FileStage, record: inout AuditRecord) async throws {
        guard let captured = stage.retainedBackupPath, let durable = record.undo?.backupPath else { return }
        try recordAudit(record)
        // Complete the committed backup even when a later pause cancels the caller.
        let task = Task.detached {
            try FileStage.preserveBackup(source: stage.target.fd!, holding: stage.holding.fd,
                                         name: (captured as NSString).lastPathComponent, durable: durable)
            stage.holding.retained = false
        }
        try await task.value
    }

    func trash(_ caps: [FileCapability], id: Value, record: inout AuditRecord, epoch: UInt64) async throws -> Value {
        if policy.config.consents["trash"] == nil {
            record.decision = "consent_requested"; try recordAudit(record)
            guard let host else { throw ToolFailure("GUARD_CONSENT_DENIED", "主人没有同意") }
            let suffix = caps.count > 1 ? "等\(caps.count)个" : ""
            let message = "依米第一次要把电脑上的文件移到废纸篓：\((caps[0].path as NSString).lastPathComponent)\(suffix)。以后你明确让她删的文件会直接移到废纸篓，可在电脑的“活动”里恢复。允许吗？"
            guard try await host.consent(related: id, message: String(message.prefix(200))) else { throw ToolFailure("GUARD_CONSENT_DENIED", "主人没有同意") }
            try checkCommit(epoch); var next = policy.config; next.consents["trash"] = .init(granted_at: Date()); try policy.install(next)
        }
        var files: [Value] = []
        for cap in caps {
            try await Self.offActor { try NativeFileExecutor.validateTree(cap) }; try checkCommit(epoch); try cap.validate()
            var item = record; item.id = auditID(); item.paths = [cap.path]; item.names = [(cap.path as NSString).lastPathComponent]; item.count = 1
            item.undo = UndoRecord(kind: "trash", originalPath: cap.path); try recordAudit(item)
            let target = try trashCapability(cap, record: &item)
            item.undo?.trashPath = target.path; bind(&item, info: cap.info!, path: cap.path); item.result = "ok"; try recordAudit(item)
            files.append(["path": .string(cap.path), "trash_path": .string(target.path)])
        }
        record.undo = nil; return try ToolContract.result(["files": .array(files)])
    }
    func trashCapability(_ cap: FileCapability, record: inout AuditRecord) throws -> URL {
        if let trashHandler { return try trashHandler(URL(fileURLWithPath: cap.path)) }
        let directory = try FileManager.default.url(for: .trashDirectory, in: .userDomainMask, appropriateFor: URL(fileURLWithPath: cap.path), create: true)
        let target = directory.appendingPathComponent((cap.path as NSString).lastPathComponent + "-" + UUID().uuidString)
        // Internal recoverable Trash destination; it is never an authorized resource root.
        let destination = try FileCapability.open(root: directory.path, path: target.path)
        record.undo?.trashPath = target.path
        _ = try moveCapability(cap, to: destination, record: &record)
        return target
    }
    public func undo(_ entry: AuditEntry.ID) async throws {
        let ticket = UUID(); try await writes.acquire(ticket)
        var row = permissionRow("undo", paths: []); row.toolClass = "write"; row.undoOf = entry
        do {
            try FileStage.recoverPending(history)
            guard let original = try history.record(entry), original.result == "ok", original.undoneAt == nil, let undo = original.undo else { throw ToolFailure("GUARD_NOT_FOUND", "这条活动不能撤销") }
            if undo.kind == "grant" { try await revoke(grant: original.id) }
            else {
                let currentPath = undo.kind == "move" ? undo.movedTo! : undo.kind == "trash" ? undo.trashPath! : undo.originalPath
                let current = try policy.openUndo(currentPath, trashSource: undo.kind == "trash")
                guard let info = current.info, undo.device == UInt64(UInt32(bitPattern: info.st_dev)), undo.inode == info.st_ino else { throw ToolFailure("GUARD_PATH_NOT_AUTHORIZED", "文件身份已经改变，保留当前文件") }
                if undo.kind == "create" || undo.kind == "overwrite" {
                    guard undo.size == info.st_size, undo.mtime == Self.mtime(info) else { throw ToolFailure("GUARD_EXISTS", "文件已经改变，保留当前文件") }
                }
                let epoch = generation; row.paths = [undo.originalPath]; row.names = [(undo.originalPath as NSString).lastPathComponent]; row.count = 1; try recordAudit(row)
                switch undo.kind {
                case "create":
                    try await Self.offActor { try NativeFileExecutor.validateTree(current) }; try checkCommit(epoch)
                    row.undo = UndoRecord(kind: "trash", originalPath: current.path)
                    _ = try trashCapability(current, record: &row)
                case "overwrite":
                    let backup = try FileCapability.open(root: (undo.backupPath! as NSString).deletingLastPathComponent, path: undo.backupPath!)
                    row.undo = try await prepareWrite(current, audit: row.id); try recordAudit(row)
                    let stage = try await Self.offActor { () -> FileStage in
                        let stage = try FileStage(target: current), out = try stage.fileDescriptor(); defer { close(out) }
                        _ = try Self.copyDescriptor(backup.requireFile(), to: out, maximum: backup.info!.st_size); return stage
                    }
                    let restored = try await commitStage(stage, epoch: epoch, record: &row)
                    if let dev = undo.previousDevice, let ino = undo.previousInode, let size = undo.previousSize, let mtime = undo.previousMtime { try history.rebindRestoredIdentity(device: dev, inode: ino, size: size, mtime: mtime, to: restored) }
                case "move", "trash":
                    let target = try policy.openUndo(undo.originalPath)
                    guard target.tail.count == 1 else { throw ToolFailure("GUARD_NOT_FOUND", "原文件夹不存在") }
                    try await Self.offActor { try NativeFileExecutor.validateTree(current) }; try await interleave("move"); try checkCommit(epoch); try current.validate()
                    row.undo = UndoRecord(kind: "move", originalPath: current.path, movedTo: target.path)
                    _ = try moveCapability(current, to: target, record: &row)
                default: throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "不能撤销这种活动")
                }
            }
            try history.markUndone(entry, at: Date()); row.result = "ok"; try recordAudit(row)
            if let updated = try history.record(entry) { events.emit(.audit(updated.entry)) }; await writes.release(ticket)
        } catch {
            let failure = error
            row.result = "error"; row.errorCode = mapped(failure, path: row.paths.first ?? "文件").code
            do { try recordAudit(row) } catch { await writes.release(ticket); throw error }
            await writes.release(ticket); throw failure
        }
    }
}
