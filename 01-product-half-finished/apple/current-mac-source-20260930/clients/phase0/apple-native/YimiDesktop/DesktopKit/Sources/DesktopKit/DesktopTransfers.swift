import Foundation
import CryptoKit
import Darwin
import MCP

extension Desktop {
    static let transferIDPattern = "^dt-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    func discard(_ file: DesktopIncomingFile) async { await file.abort(); unlink(file.file.path) }
    func received(_ file: DesktopIncomingFile) async {
        let a = file.attributes
        guard file.current(), acceptingIncoming, !policy.pause.paused, a["v"] == "1", a["dir"] == "down", let id = a["transfer"], id.range(of: Self.transferIDPattern, options: .regularExpression) != nil,
              let size = a["size"].flatMap(Int64.init), size >= 0, size <= 52428800,
              let sha = a["sha256"], sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              a["request"] != nil, a["name"]?.isEmpty == false, (a["name"]?.utf8.count ?? 0) <= 255,
              a["name"]?.contains("/") == false, a["name"]?.utf8.contains(0) == false, !cancelledTransfers.contains(id) else { await discard(file); return }
        if let waiter = downloadWaiters.removeValue(forKey: id) { activeIncoming[id] = file; waiter.resume(returning: file) }
        else if incoming[id] == nil && activeIncoming[id] == nil && incoming.count < 4 { incoming[id] = file }
        else { await discard(file) }
    }
    func abortIncoming() async {
        let files = Array(incoming.values) + Array(activeIncoming.values)
        incoming.removeAll(); activeIncoming.removeAll()
        for waiter in downloadWaiters.values { waiter.resume(throwing: CancellationError()) }; downloadWaiters.removeAll()
        await withTaskGroup(of: Void.self) { group in for file in files { group.addTask { await self.discard(file) } } }
    }
    func cancelTransfer(name: String, arguments: [String: Value]) async {
        if name == "save_from_workshop", let id = arguments["_transfer"]?.objectValue?["transfer_id"]?.stringValue,
           id.range(of: Self.transferIDPattern, options: .regularExpression) != nil { await cancelDownload(id) }
    }
    func waitForDownload(_ id: String) async throws -> DesktopIncomingFile {
        try Task.checkCancellation()
        if let file = incoming.removeValue(forKey: id) { activeIncoming[id] = file; return file }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { downloadWaiters[id] = $0 }
        }, onCancel: { Task { await self.cancelDownload(id) } })
    }
    func cancelDownload(_ id: String) async {
        downloadWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
        let queued = incoming.removeValue(forKey: id), active = activeIncoming.removeValue(forKey: id)
        if cancelledTransfers.count >= 64 { cancelledTransfers.removeFirst() }; cancelledTransfers.insert(id)
        if let queued { await discard(queued) }; if let active { await discard(active) }
    }
    /// Copy the already-authorized descriptor with fixed memory. Only transfers compute an integrity digest.
    nonisolated static func copyDescriptor(_ fd: Int32, to out: Int32?, maximum: Int64, digest: Bool = false) throws -> (Int64, String) {
        let info = try FileCapability.checkedStat(fd)
        guard info.st_mode & S_IFMT == S_IFREG, info.st_size <= maximum else { throw ToolFailure("TRANSFER_TOO_LARGE", "文件超过传输上限") }
        let reader = FileHandle(fileDescriptor: fd, closeOnDealloc: false), writer = out.map { FileHandle(fileDescriptor: $0, closeOnDealloc: false) }
        try reader.seek(toOffset: 0)
        var hash = SHA256(), bytes: Int64 = 0
        while let data = try reader.read(upToCount: 65536), !data.isEmpty {
            try Task.checkCancellation(); bytes += Int64(data.count)
            guard bytes <= maximum else { throw ToolFailure("TRANSFER_TOO_LARGE", "文件超过传输上限") }
            if digest { hash.update(data: data) }; try writer?.write(contentsOf: data)
        }
        try writer?.synchronize()
        let after = try FileCapability.checkedStat(fd)
        guard bytes == info.st_size, after.st_size == info.st_size, Self.mtime(after) == Self.mtime(info) else { throw ToolFailure("TRANSFER_INTEGRITY", "传输时文件发生变化") }
        return (bytes, digest ? hash.finalize().map { String(format: "%02x", $0) }.joined() : "")
    }
    func uploadFile(_ cap: FileCapability, request: Value, expectedSize: Int64, epoch: UInt64) async throws -> Value {
        guard let transport else { throw ToolFailure("DESKTOP_OFFLINE", "电脑现在未连接") }
        let name = (cap.path as NSString).lastPathComponent
        guard !name.hasPrefix("."), name.utf8.count <= 255 else { throw ToolFailure("GUARD_PATH_INVALID", "上传文件名无效") }
        let directory = store.appendingPathComponent("transfers")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let id = "dt-" + auditID(), snapshot = directory.appendingPathComponent(id)
        defer { unlink(snapshot.path) }
        let copied = try await Self.offActor {
            let out = open(snapshot.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard out >= 0 else { throw GuardPath.posix(snapshot.path) }; defer { close(out) }
            return try Self.copyDescriptor(cap.requireFile(), to: out, maximum: 26214400, digest: true)
        }
        guard copied.0 == expectedSize else { throw ToolFailure("TRANSFER_INTEGRITY", "上传前文件大小发生变化") }
        try checkCommit(epoch); try cap.validate()
        try await transport.upload(file: snapshot, attributes: ["v":"1", "transfer":id, "dir":"up", "name":name, "size":String(copied.0), "sha256":copied.1, "request":request.stringValue ?? request.description])
        try checkCommit(epoch)
        return try ToolContract.result(["transfer_id": .string(id), "workshop_path": .string("/owner/in/\(id)/\(name)"), "size": .int(Int(copied.0)), "sha256": .string(copied.1)])
    }
    func saveFile(_ args: [String: Value], request: Value, record: inout AuditRecord, epoch: UInt64) async throws -> Value {
        let source = args["workshop_path"]!.stringValue!
        guard !source.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }), !source.utf8.contains(0), source.utf8.count <= 512,
              let transfer = args["_transfer"]?.objectValue, let id = transfer["transfer_id"]?.stringValue, id.range(of: Self.transferIDPattern, options: .regularExpression) != nil,
              let size = transfer["size"]?.intValue, size >= 0, size <= 52428800,
              let sha = transfer["sha256"]?.stringValue, sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw ToolFailure("TRANSFER_INTEGRITY", "缺少工坊文件传输信息") }
        let folder = args["folder"]?.stringValue ?? home.appendingPathComponent("Documents/依米").path
        let name = args["name"]?.stringValue ?? (source as NSString).lastPathComponent
        guard name != ".", name != "..", !name.contains("/"), !name.utf8.contains(0), !name.isEmpty, name.utf8.count <= 255 else { throw ToolFailure("GUARD_PATH_INVALID", "保存文件名无效") }
        let target = try opened((folder as NSString).appendingPathComponent(name), tool: "save_from_workshop", write: true)
        let file = try await waitForDownload(id)
        do {
            guard file.attributes["request"] == (request.stringValue ?? request.description), file.attributes["sha256"] == sha, file.attributes["size"] == String(size) else { throw ToolFailure("TRANSFER_INTEGRITY", "文件与请求不匹配") }
            try await withTaskCancellationHandler(operation: { try await file.completion() }, onCancel: { Task { await self.cancelDownload(id) } })
            guard file.current() else { throw CancellationError() }
            try checkCommit(epoch)
            // Transport owns this private temporary file; anchor it just as an owner file, with single-link validation.
            let canonical = try GuardPath.canonical(file.file.path, protectedApps: policy.config.protectedApps), incoming = try FileCapability.open(root: (canonical as NSString).deletingLastPathComponent, path: canonical, protectedApps: policy.config.protectedApps)
            let staged = try await Self.offActor { () -> (FileStage, Int64, String) in
                let stage = try FileStage(target: target), out = try stage.fileDescriptor(); defer { close(out) }
                let copied = try Self.copyDescriptor(incoming.requireFile(), to: out, maximum: 52428800, digest: true)
                return (stage, copied.0, copied.1)
            }
            guard staged.1 == Int64(size), staged.2 == sha else { throw ToolFailure("TRANSFER_INTEGRITY", "文件校验失败，原文件保持不变") }
            record.paths = [target.path]; record.names = [name]; record.count = 1
            record.undo = try await prepareWrite(target, audit: record.id); try recordAudit(record)
            try await commitStage(staged.0, epoch: epoch, record: &record)
            activeIncoming.removeValue(forKey: id); unlink(file.file.path)
            return try ToolContract.result(["path": .string(target.path), "size": .int(size), "sha256": .string(sha)])
        } catch { await cancelDownload(id); throw error }
    }
}
