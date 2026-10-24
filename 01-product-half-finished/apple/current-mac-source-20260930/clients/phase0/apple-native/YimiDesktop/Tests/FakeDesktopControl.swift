import DesktopKit
import Foundation

/// Shared app-test boundary fake. It models pause ownership and records direct file authorization.
actor FakeDesktopControl: DesktopControl {
    private var state = PauseState(reasons: [])
    private(set) var pauseCalls: [PauseReason] = []
    private(set) var resumeCalls: [PauseReason] = []
    private(set) var grantedURLs: [URL] = []
    private(set) var grantVia: FileGrant.Via?
    private(set) var fileGrants: [FileGrant] = []
    var grantError: DesktopError?
    private var grantBarrier: (@Sendable () async -> Void)?
    func setGrantBarrier(_ barrier: @escaping @Sendable () async -> Void) { grantBarrier = barrier }

    func setGrantError(_ error: DesktopError?) { grantError = error }
    func start(transport: any DesktopTransport) async {}
    private(set) var stopCalls = 0
    private var stopBarrier: (@Sendable () async -> Void)?
    func setStopBarrier(_ barrier: @escaping @Sendable () async -> Void) { stopBarrier = barrier }
    func stop() async { stopCalls += 1; await stopBarrier?() }
    func folders() async -> [AuthorizedFolder] { [] }
    func authorize(folder: URL, write: Bool) async throws -> AuthorizedFolder {
        AuthorizedFolder(id: folder.path, label: folder.lastPathComponent, write: write)
    }
    func setWrite(_ write: Bool, folder: AuthorizedFolder.ID) async throws {}
    func remove(folder: AuthorizedFolder.ID) async throws {}
    func grant(files: [URL], via: FileGrant.Via) async throws -> [FileGrant] {
        if let grantBarrier { await grantBarrier() }
        if let grantError { throw grantError }
        let now = Date()
        let granted = try files.map { file in
            let attributes = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard attributes.isRegularFile == true else { throw DesktopError.notAFile(file.path) }
            return FileGrant(id: UUID().uuidString, path: file.path, name: file.lastPathComponent,
                             size: Int64(attributes.fileSize ?? 0), kind: "other", via: via,
                             grantedAt: now, expiresAt: now.addingTimeInterval(86400))
        }
        grantedURLs += files
        grantVia = via
        fileGrants += granted
        return granted
    }
    func grants() async -> [FileGrant] { fileGrants }
    func revoke(grant: FileGrant.ID) async throws { fileGrants.removeAll { $0.id == grant } }
    func pause(_ reason: PauseReason) async {
        pauseCalls.append(reason)
        if reason != .screenShare { state.reasons.insert(reason) }
    }
    func resume(_ reason: PauseReason) async {
        resumeCalls.append(reason)
        if reason != .screenShare { state.reasons.removeAll() }
    }
    func pauseState() async -> PauseState { state }
    func resetTrashConsent() async throws {}
    func audit(before: Date?, limit: Int) async throws -> [AuditEntry] { [] }
    func undo(_ entry: AuditEntry.ID) async throws {}
    nonisolated func subscribe() -> AsyncStream<DesktopEvent> { AsyncStream { $0.finish() } }
}
