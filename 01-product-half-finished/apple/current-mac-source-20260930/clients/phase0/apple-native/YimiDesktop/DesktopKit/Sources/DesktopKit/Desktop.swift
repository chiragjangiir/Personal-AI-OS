import Foundation
import Darwin
import MCP

final class DesktopEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var subscribers: [UUID: AsyncStream<DesktopEvent>.Continuation] = [:]
    func stream() -> AsyncStream<DesktopEvent> {
        AsyncStream { continuation in
            let id = UUID(); lock.lock(); subscribers[id] = continuation; lock.unlock()
            continuation.onTermination = { [weak self] _ in self?.remove(id) }
        }
    }
    private func remove(_ id: UUID) { lock.lock(); subscribers.removeValue(forKey: id); lock.unlock() }
    func emit(_ event: DesktopEvent) { lock.lock(); let targets = Array(subscribers.values); lock.unlock(); for target in targets { target.yield(event) } }
}

/// The single authority for permissions, operation generations and durable history.
public actor Desktop: DesktopControl {
    let store: URL
    let resources: URL
    let home: URL
    let trashHandler: (@Sendable (URL) throws -> URL)?
    var policy: GuardPolicy
    let history: AuditStore
    let contract: ToolContract
    let writes = WriteGate()
    let windowSharing: WindowSharing
    nonisolated let events = DesktopEvents()
    var host: ToolHost?
    var transport: DesktopTransport?
    var downloadLoop: Task<Void, Never>?
    var acceptingIncoming = true
    var incoming: [String: DesktopIncomingFile] = [:]
    var activeIncoming: [String: DesktopIncomingFile] = [:]
    var downloadWaiters: [String: CheckedContinuation<DesktopIncomingFile, Error>] = [:]
    var cancelledTransfers: Set<String> = []
    var grantExpiry: Task<Void, Never>?
    var generation: UInt64 = 0
    var inFlight = 0
    var interleave: @Sendable (String) async throws -> Void = { _ in }
    func setInterleave(_ hook: @escaping @Sendable (String) async throws -> Void) { interleave = hook }
    var fileCheckpoint: @Sendable (String) -> Void = { _ in }
    func setFileCheckpoint(_ hook: @escaping @Sendable (String) -> Void) { fileCheckpoint = hook }
    public init(store: URL, resources: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser,
                trash: (@Sendable (URL) throws -> URL)? = nil, windowSharing: WindowSharing = WindowSharing()) throws {
        let audit = try AuditStore(store: store)
        let canonicalStore = URL(fileURLWithPath: try GuardPath.canonical(store.path))
        var guardPolicy = try GuardPolicy(store: canonicalStore, audit: audit)
        let pending = try audit.unresolvedRetirements()
        if !pending.isEmpty && !guardPolicy.poisoned {
            var next = guardPolicy.config; let ids = Set(pending.map(\.requestID)); next.files.removeAll { ids.contains($0.grant.id) }
            try guardPolicy.install(next) { for var row in pending { row.result = "ok"; try audit.append(row) } }
        }
        try FileStage.recoverPending(audit)
        if !guardPolicy.poisoned {
            for directory in try audit.prune(auditDays: guardPolicy.config.audit_retention_days, undoDays: guardPolicy.config.undo_retention_days) {
                if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
            }
        }
        self.store = canonicalStore; self.resources = resources; self.home = home; trashHandler = trash
        history = audit; policy = guardPolicy; contract = try ToolContract(); self.windowSharing = windowSharing
    }
    public func start(transport: DesktopTransport) async {
        guard self.transport == nil else { return }; self.transport = transport; acceptingIncoming = true; scheduleGrantExpiry()
        let server = ToolHost(transport: transport, tools: contract.tools, call: { [weak self] id, name, arguments in
            guard let self else { throw DesktopError.unavailable }; return try await self.call(id: id, name: name, arguments: arguments)
        }, phonePause: { [weak self] paused in
            if paused { await self?.pause(.phone) } else { await self?.resume(.phone) }
        }, readiness: { [weak self] ready in
            guard let self else { return }
            await self.relayReadiness(ready)
        }, reset: { [weak self] server in
            await self?.relayReset(server)
        })
        host = server
        transport.onReset { [events] in events.emit(.ready(false)) }
        downloadLoop = Task { [weak self] in for await file in transport.downloads() { await self?.received(file) } }
        await server.start()
    }
    private func relayReset(_ server: ToolHost) async {
        guard host === server else { return }
        generation &+= 1
        await abortIncoming()
    }
    private func relayReadiness(_ ready: Bool) async {
        if ready {
            guard let host else { return }
            do { try await host.state(policy.pause.paused) }
            catch { events.emit(.ready(false)); return }
        }
        events.emit(.ready(ready))
    }
    public func stop() async {
        generation &+= 1; acceptingIncoming = false; downloadLoop?.cancel(); downloadLoop = nil
        await abortIncoming(); let previous = host; host = nil; transport = nil; await previous?.stop()
    }
    public func toolLockReason() async -> String? { policy.poisoned ? "电脑工具已锁定：权限写入需修复。聊天照常；请保留权限数据并联系支持恢复。" : nil }
    public func folders() async -> [AuthorizedFolder] { policy.config.folders }
    func permission(_ candidate: GuardConfig, records: [AuditRecord]) throws {
        for record in records { try recordAudit(record) }
        try policy.install(candidate) {
            for var row in records { row.result = "ok"; try history.append(row) }
        }
        generation &+= 1
        for var row in records { row.result = "ok"; events.emit(.audit(row.entry)) }
    }
    func permissionRow(_ tool: String, paths: [String]) -> AuditRecord {
        var row = AuditRecord(deviceID: localDeviceID, requestID: "local", tool: tool, toolClass: "grant")
        row.paths = paths; row.names = paths.map { ($0 as NSString).lastPathComponent }; row.count = paths.count; return row
    }
    public func authorize(folder: URL, write: Bool) async throws -> AuthorizedFolder {
        let path = try GuardPath.canonical(folder.path, protectedApps: policy.config.protectedApps)
        let homePath = try GuardPath.canonical(home.path, protectedApps: policy.config.protectedApps)
        guard !GuardPath.forbiddenRoot(path, home: homePath, protectedApps: policy.config.protectedApps) else { throw DesktopError.folderNotAllowed(path) }
        let cap = try FileCapability.open(root: path, path: path, protectedApps: policy.config.protectedApps)
        if let info = cap.info, info.st_mode & S_IFMT != S_IFDIR { throw DesktopError.folderNotAllowed(path) }
        let name = (path as NSString).lastPathComponent
        let label = path == homePath + "/Documents/依米" ? "文稿/依米" : ["Downloads":"下载", "Documents":"文稿", "Desktop":"桌面"][name] ?? name
        let value = AuthorizedFolder(id: path, label: label, write: write)
        var next = policy.config; next.folders.removeAll { $0.id == path }; next.folders.append(value)
        try permission(next, records: [permissionRow("authorize_folder", paths: [path])]); events.emit(.foldersChanged); await host?.cancelCalls(); return value
    }
    public func setWrite(_ write: Bool, folder: AuthorizedFolder.ID) async throws {
        guard let i = policy.config.folders.firstIndex(where: { $0.id == folder }) else { throw DesktopError.folderNotAllowed(folder) }
        var next = policy.config; next.folders[i].write = write
        try permission(next, records: [permissionRow("set_folder_write", paths: [folder])]); events.emit(.foldersChanged); await host?.cancelCalls()
    }
    public func remove(folder: AuthorizedFolder.ID) async throws {
        var next = policy.config; next.folders.removeAll { $0.id == folder }
        try permission(next, records: [permissionRow("revoke_folder", paths: [folder])]); events.emit(.foldersChanged); await host?.cancelCalls()
    }
    public func grant(files: [URL], via: FileGrant.Via) async throws -> [FileGrant] {
        guard !files.isEmpty, files.count <= 10 else { throw ToolFailure("GUARD_TOO_LARGE", "每条消息最多附加10个文件") }
        var next = policy.config, rows: [AuditRecord] = [], granted: [FileGrant] = []
        for file in files {
            let path = try GuardPath.canonical(file.path, protectedApps: policy.config.protectedApps), cap = try FileCapability.open(root: (path as NSString).deletingLastPathComponent, path: path, protectedApps: policy.config.protectedApps)
            guard let info = cap.info, info.st_mode & S_IFMT == S_IFREG else { throw DesktopError.notAFile(path) }
            let now = Date(), grant = FileGrant(id: auditID(), path: path, name: (path as NSString).lastPathComponent, size: info.st_size,
                kind: NativeTools.kind(path), via: via, grantedAt: now, expiresAt: now.addingTimeInterval(next.desktop.attachments.grant_ttl_h * 3600))
            next.files.append(StoredGrant(grant: grant, dev: info.st_dev, ino: info.st_ino)); granted.append(grant)
            var row = permissionRow("file_grant", paths: [path]); row.id = grant.id; row.undo = UndoRecord(kind: "grant", originalPath: path); rows.append(row)
        }
        try permission(next, records: rows); events.emit(.grantsChanged); scheduleGrantExpiry(); return granted
    }
    func retireGrants() throws {
        var retired: [StoredGrant] = []
        for record in policy.config.files {
            if record.grant.expiresAt <= Date() { retired.append(record); continue }
            do {
                let info = try GuardPath.info(record.grant.path)
                if FileIdentity(info) != FileIdentity(dev: record.dev, ino: record.ino) || info.st_mode & S_IFMT != S_IFREG { retired.append(record) }
            } catch let error as ToolFailure {
                if ["GUARD_NOT_FOUND", "GUARD_PATH_NOT_AUTHORIZED", "GUARD_PATH_INVALID"].contains(error.code) { retired.append(record) }
                else if error.code != "GUARD_PERMISSION_REQUIRED" { throw error }
            }
        }
        if retired.isEmpty { return }
        var next = policy.config; let ids = Set(retired.map { $0.grant.id }); next.files.removeAll { ids.contains($0.grant.id) }
        do { try permission(next, records: retired.map { item in var row = permissionRow("retire_file_grant", paths: [item.grant.path]); row.requestID = item.grant.id; return row }) }
        catch { policy.poisoned = true; throw error }; events.emit(.grantsChanged)
    }
    public func grants() async -> [FileGrant] {
        do { guard !policy.poisoned else { return [] }; try retireGrants(); return policy.config.files.map(\.grant) }
        catch { policy.poisoned = true; return [] }
    }
    public func revoke(grant: FileGrant.ID) async throws {
        guard let record = policy.config.files.first(where: { $0.grant.id == grant }) else { throw ToolFailure("GUARD_NOT_FOUND", "找不到这条临时文件授权") }
        var next = policy.config; next.files.removeAll { $0.grant.id == grant }
        try permission(next, records: [permissionRow("revoke_file_grant", paths: [record.grant.path])]); events.emit(.grantsChanged); scheduleGrantExpiry(); await host?.cancelCalls()
    }
    public func pause(_ reason: PauseReason) async {
        let previous = policy.pause; policy.paused(reason)
        if previous != policy.pause { await pauseChanged() }
    }
    public func resume(_ reason: PauseReason) async {
        let previous = policy.pause; policy.resumed(reason)
        if previous != policy.pause { await pauseChanged() }
    }
    private func pauseChanged() async {
        events.emit(.pause(policy.pause))
        if policy.pause.paused { generation &+= 1; await host?.cancelCalls(); await abortIncoming() }
        do { try await host?.state(policy.pause.paused) } catch { events.emit(.ready(false)) }
    }
    public func pauseState() async -> PauseState { policy.pause }
    public func resetTrashConsent() async throws { var next = policy.config; next.consents.removeValue(forKey: "trash"); try policy.install(next) }
    public func audit(before: Date?, limit: Int) async throws -> [AuditEntry] { try history.records(before: before, limit: limit).map(\.entry) }
    public nonisolated func subscribe() -> AsyncStream<DesktopEvent> { let stream = events.stream(); Task { await self.scheduleGrantExpiry() }; return stream }
    private func scheduleGrantExpiry() {
        grantExpiry?.cancel()
        guard let next = policy.config.files.map(\.grant.expiresAt).filter({ $0 > Date() }).min() else { return }
        grantExpiry = Task { [weak self] in do { try await Task.sleep(for: .seconds(max(0, next.timeIntervalSinceNow))) } catch { return }; await self?.grantExpired() }
    }
    private func grantExpired() { events.emit(.grantsChanged); scheduleGrantExpiry() }
    var localDeviceID: String { transport?.auditDeviceID ?? "local-unpaired" }
    func recordAudit(_ record: AuditRecord) throws {
        var persisted = record
        // Retire recovery intent atomically with success; failed appends leave the caller's intent intact.
        if persisted.result == "ok" { persisted.undo?.replacement = nil; persisted.undo?.movement = nil }
        try history.append(persisted); events.emit(.audit(persisted.entry))
    }
    func opened(_ path: String, tool: String, write: Bool) throws -> FileCapability {
        try retireGrants()
        do { return try policy.open(path, tool: tool, write: write) }
        catch { try retireGrants(); throw error }
    }
    func checked(_ path: String, tool: String, write: Bool) throws -> String { try opened(path, tool: tool, write: write).path }
    func checkCommit(_ epoch: UInt64) throws {
        try Task.checkCancellation()
        guard epoch == generation, !policy.pause.paused else { throw ToolFailure("DESKTOP_PAUSED", "主人暂停了依米操作电脑") }
    }
    nonisolated static func offActor<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let task = Task.detached(operation: work)
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }
    func call(id: Value, name: String, arguments: [String: Value]) async throws -> Value {
        let started = Date(); var record = AuditRecord(deviceID: localDeviceID, requestID: id.stringValue ?? id.description, tool: name, toolClass: "unknown")
        let definition = try contract.tool(name)
        do { try contract.validate(name, arguments) } catch { await cancelTransfer(name: name, arguments: arguments); throw error }
        record.toolClass = definition["x-paios"]!.objectValue!["class"]!.stringValue!
        record.paths = ["path", "source", "destination", "folder"].compactMap { arguments[$0]?.stringValue } + (arguments["paths"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        record.names = record.paths.map { ($0 as NSString).lastPathComponent }; record.count = record.paths.count
        record.bytesIn = try JSONEncoder().encode(arguments).count
        inFlight += 1; events.emit(.activity(inFlight: inFlight)); defer { inFlight -= 1; events.emit(.activity(inFlight: inFlight)) }
        let ticket = UUID(); var locked = false
        do {
            if record.toolClass != "read" { try await writes.acquire(ticket); locked = true; try FileStage.recoverPending(history) }
            try checkCommit(generation)
            if transport != nil && transport?.auditDeviceID?.isEmpty != false { throw ToolFailure("DESKTOP_OFFLINE", "电脑配对身份未提供") }
            let result = try await perform(id: id, name: name, arguments: arguments, record: &record)
            record.result = "ok"; record.bytesOut = try JSONEncoder().encode(result).count
            guard record.bytesOut <= 1048000 else { throw ToolFailure("DESKTOP_FRAME_TOO_LARGE", "结果太大") }
            record.durationMS = Int(Date().timeIntervalSince(started) * 1000); try recordAudit(record)
            if locked { await writes.release(ticket) }; return result
        } catch {
            await cancelTransfer(name: name, arguments: arguments)
            let failure = mapped(error, path: record.paths.first ?? "文件夹")
            record.decision = record.undo == nil ? "denied" : "allowed"; record.result = error is CancellationError || Task.isCancelled || failure.code == "DESKTOP_PAUSED" ? "cancelled" : "error"
            record.guardCode = failure.code; record.errorCode = failure.code; record.durationMS = Int(Date().timeIntervalSince(started) * 1000)
            do { try recordAudit(record) } catch {
                if locked { await writes.release(ticket) }
                return ToolFailure("DESKTOP_AUDIT_STORE", "活动记录无法写入，操作已停止").result
            }
            if failure.code == "GUARD_PERMISSION_REQUIRED" { events.emit(.permissionRequired(folder: record.paths.first ?? "文件夹")) }
            if locked { await writes.release(ticket) }; return failure.result
        }
    }
    func mapped(_ error: Error, path: String) -> ToolFailure {
        if error is CancellationError || Task.isCancelled { return ToolFailure("DESKTOP_CANCELLED", "操作已取消") }
        if let error = error as? ToolFailure {
            if error.code == "DESKTOP_TOOL_FAILED" { return ToolFailure(error.hint.contains("Could not find exact match") ? "GUARD_NOT_FOUND" : "GUARD_TYPE_UNSUPPORTED", "文件处理未完成：" + error.hint) }
            return error
        }
        if let error = error as? WindowSharingError { return ToolFailure("WINDOW_CAPTURE_DENIED", error.localizedDescription) }
        let e = error as NSError
        if (e.domain == NSCocoaErrorDomain && [257,513].contains(e.code)) || (e.domain == NSPOSIXErrorDomain && [1,13].contains(e.code)) { return ToolFailure("GUARD_PERMISSION_REQUIRED", "这件事要先在电脑上允许依米访问“\((path as NSString).lastPathComponent)”") }
        return ToolFailure("GUARD_PATH_INVALID", e.localizedDescription)
    }
}
