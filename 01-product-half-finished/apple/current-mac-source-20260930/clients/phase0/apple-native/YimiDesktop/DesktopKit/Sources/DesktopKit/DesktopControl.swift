import Foundation

/// The boundary between the Mac app and the desktop authority. `Desktop` is the
/// shared implementation; app previews and UI tests may use their own fake. Preserve existing
/// signatures when adding capabilities.
public protocol DesktopControl: AnyObject, Sendable {
    /// Serve `paios.desktop.mcp.v1` and `paios.desktop.file.v1` over the paired session (C5.3, C7, C12.8). Idempotent;
    /// `stop()` cancels in-flight calls and transfers.
    func start(transport: DesktopTransport) async
    func stop() async

    /// C6.3 #1–2: owner-chosen folders, stored canonical; a forbidden root throws `DesktopError.folderNotAllowed`.
    func toolLockReason() async -> String?
    func folders() async -> [AuthorizedFolder]
    func authorize(folder: URL, write: Bool) async throws -> AuthorizedFolder
    func setWrite(_ write: Bool, folder: AuthorizedFolder.ID) async throws
    func remove(folder: AuthorizedFolder.ID) async throws

    /// A6.4: files the owner hands over directly (drag or paste). Exactly these files, never their folders.
    func grant(files: [URL], via: FileGrant.Via) async throws -> [FileGrant]
    func grants() async -> [FileGrant]
    func revoke(grant: FileGrant.ID) async throws

    /// One pause state for manual and phone controls. Either resume clears their reasons.
    func pause(_ reason: PauseReason) async
    func resume(_ reason: PauseReason) async
    func pauseState() async -> PauseState

    /// C6.4–C6.5.
    func resetTrashConsent() async throws
    func audit(before: Date?, limit: Int) async throws -> [AuditEntry]
    func undo(_ entry: AuditEntry.ID) async throws

    /// Owner-visible changes (menu icon, chat bubble, activity window). Each call returns an independent stream.
    func subscribe() -> AsyncStream<DesktopEvent>
}

public extension DesktopControl {
    func toolLockReason() async -> String? { nil }
}

/// Implemented by the app over Core's encrypted, sender-checked session (C5.3, C7.1, I15).
public protocol DesktopTransport: Sendable {
    /// The paired Mac device_id for C6.5 audit records. App transport supplies its pairing identity.
    var auditDeviceID: String? { get }
    /// send/upload/completion implementations must abort their byte writer when the calling Task is cancelled.

    /// Whole JSON-RPC messages on `paios.desktop.mcp.v1`.
    func send(_ frame: Data) async throws
    func frames() -> AsyncStream<DesktopFrame>
    /// Channel rotation invalidates relay readiness while the logical frame subscription stays open.
    func onReset(_ handler: @escaping @Sendable () -> Void)
    /// One byte stream per file on `paios.desktop.file.v1`; attributes per C7.1.
    func upload(file: URL, attributes: [String: String]) async throws
    /// Incoming `dir:"down"` streams, written by the app to `file` (a temporary file it owns) as bytes arrive.
    func downloads() -> AsyncStream<DesktopIncomingFile>
}

/// The room authority's validity fence travels with buffered bytes until dispatch.
public enum DesktopFrame: Sendable {
    case message(Data, current: @Sendable () -> Bool)
    case reset
    public init(_ data: Data, current: @escaping @Sendable () -> Bool = { true }) {
        self = .message(data, current: current)
    }
}

public struct DesktopIncomingFile: Sendable {
    public let attributes: [String: String]
    public let file: URL
    public let current: @Sendable () -> Bool
    public let completion: @Sendable () async throws -> Void
    /// Must abort and await the incoming writer, even when completion was never claimed.
    public let abort: @Sendable () async -> Void
    public init(attributes: [String: String], file: URL, completion: @escaping @Sendable () async throws -> Void, abort: @escaping @Sendable () async -> Void, current: @escaping @Sendable () -> Bool = { true }) {
        self.attributes = attributes; self.file = file; self.current = current; self.completion = completion; self.abort = abort
    }
}

public struct AuthorizedFolder: Identifiable, Sendable, Equatable, Codable {
    public let id: String       // canonical path
    public let label: String    // 中文 label shown to the owner and to her (`list_allowed_directories`)
    public var write: Bool
    public init(id: String, label: String, write: Bool) { self.id = id; self.label = label; self.write = write }
}

public struct FileGrant: Identifiable, Sendable, Equatable, Codable {
    public enum Via: String, Sendable, Codable { case drag, paste }
    public let id: String
    public let path: String     // canonical (F_GETPATH)
    public let name: String
    public let size: Int64
    public let kind: String     // a C6.2 `find_files` kind, or "other"
    public let via: Via
    public let grantedAt: Date
    public let expiresAt: Date
    public init(id: String, path: String, name: String, size: Int64, kind: String, via: Via, grantedAt: Date, expiresAt: Date) {
        self.id = id; self.path = path; self.name = name; self.size = size; self.kind = kind; self.via = via
        self.grantedAt = grantedAt; self.expiresAt = expiresAt
    }
}

public enum PauseReason: String, Sendable, Codable, Hashable {
    case manual, phone
    /// Retained for existing callers. Screen sharing does not change the pause state.
    case screenShare
}

public struct PauseState: Sendable, Equatable {
    public var reasons: Set<PauseReason>
    public var paused: Bool { !reasons.isEmpty }
    public init(reasons: Set<PauseReason>) { self.reasons = reasons }
}

/// C6.5 as the activity window shows it; never file contents.
public struct AuditEntry: Identifiable, Sendable, Equatable {
    public enum Undo: String, Sendable { case create, overwrite, move, trash, grant }
    public let id: String
    public let at: Date
    public let tool: String
    public let toolClass: String
    public let names: [String]
    public let count: Int
    public let decision: String         // allowed | denied | consent_requested
    public let result: String?          // ok | error | cancelled
    public let errorCode: String?
    public let undo: Undo?
    public let undoneAt: Date?
    public let reveal: URL?             // created or saved file, for 「在访达中显示」
    public init(id: String, at: Date, tool: String, toolClass: String, names: [String], count: Int, decision: String,
                result: String?, errorCode: String?, undo: Undo?, undoneAt: Date?, reveal: URL?) {
        self.id = id; self.at = at; self.tool = tool; self.toolClass = toolClass; self.names = names; self.count = count
        self.decision = decision; self.result = result; self.errorCode = errorCode; self.undo = undo
        self.undoneAt = undoneAt; self.reveal = reveal
    }
}

public enum DesktopEvent: Sendable, Equatable {
    case ready(Bool)                         // server relay has accepted this peer
    case pause(PauseState)
    case activity(inFlight: Int)            // menu icon 正在操作
    case audit(AuditEntry)                  // new or updated entry
    case permissionRequired(folder: String) // C6.3 #12
    case foldersChanged
    case grantsChanged
}

public enum DesktopError: Error, Equatable {
    case folderNotAllowed(String)
    case sensitivePath(String)
    case notAFile(String)
    case unavailable
}

// Source-compatible boundary addition. A paired production transport must supply auditDeviceID before tool execution.
public extension DesktopTransport {
    var auditDeviceID: String? { nil }
    func onReset(_ handler: @escaping @Sendable () -> Void) {}
}
