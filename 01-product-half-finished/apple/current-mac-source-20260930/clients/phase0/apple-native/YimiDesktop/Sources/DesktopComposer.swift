import AppKit
import Combine
import DesktopKit
import UniformTypeIdentifiers

@MainActor final class DesktopComposer: ObservableObject {
    @Published var text = ""
    @Published private(set) var files: [FileGrant] = []
    @Published var error: String?
    private let desktop: any DesktopControl
    private let attachments: URL
    private(set) var dropTasks: [UUID: Task<Void, Never>] = [:]
    private var dropProgress: [UUID: Progress] = [:]
    private var pending = 0
    private var generation = UUID()
    init(desktop: any DesktopControl, attachments: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/依米/附件", isDirectory: true)) {
        self.desktop = desktop; self.attachments = attachments
    }
    enum InputError: LocalizedError {
        case folder, limit
        var errorDescription: String? {
            switch self { case .folder: return "文件夹请到设置里添加"; case .limit: return "每条消息最多添加 10 个文件" }
        }
    }
    func checkAddition(count: Int) throws {
        guard files.count + pending + count <= 10 else { throw InputError.limit }
    }
    func attach(_ urls: [URL], via: FileGrant.Via) async throws {
        try Task.checkCancellation()
        try checkAddition(count: urls.count)
        for url in urls {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory != true else { throw InputError.folder }
        }
        let generation = generation
        pending += urls.count; defer { pending -= urls.count }
        let grants = try await desktop.grant(files: urls, via: via)
        guard self.generation == generation, !Task.isCancelled else {
            for grant in grants { try await desktop.revoke(grant: grant.id) }
            throw CancellationError()
        }
        files.append(contentsOf: grants)
        error = nil
    }
    func attach(data: Data, type: UTType, via: FileGrant.Via) async throws {
        try checkAddition(count: 1)
        let day = DateFormatter(); day.locale = Locale(identifier: "en_US_POSIX"); day.dateFormat = "yyyy-MM-dd"
        let directory = attachments.appendingPathComponent(day.string(from: Date()), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent(UUID().uuidString.lowercased()).appendingPathExtension(type.preferredFilenameExtension ?? "data")
        try data.write(to: file, options: .withoutOverwriting)
        do { try await attach([file], via: via) }
        catch { try FileManager.default.removeItem(at: file); throw error }
    }
    /// Returning false leaves the normal text editor's paste behaviour intact.
    func paste(_ pasteboard: NSPasteboard) async throws -> Bool {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            try await attach(urls, via: .paste); return true
        }
        let types = Self.nonFileTypes(pasteboard.types?.map(\.rawValue) ?? [], plainText: pasteboard.string(forType: .string) != nil)
        for type in types {
            if let data = pasteboard.data(forType: .init(type.identifier)) {
                try await attach(data: data, type: type, via: .paste); return true
            }
        }
        return false
    }
    static func nonFileTypes(_ identifiers: [String], plainText: Bool) -> [UTType] {
        let types = identifiers.compactMap { UTType($0) }
        let binary = types.filter { $0.conforms(to: .image) || $0.conforms(to: .pdf) }
        return binary + (plainText ? [] : types.filter { $0.conforms(to: .rtf) || $0.conforms(to: .html) })
    }
    func remove(id: String) { files.removeAll { $0.id == id } }
    func prepare() -> [CentralAttachment] {
        files.map { CentralAttachment(grantID: $0.id, path: $0.path, name: $0.name, size: $0.size, kind: $0.kind) }
    }
    func clear() {
        generation = UUID(); text = ""; files = []; error = nil
        for task in dropTasks.values { task.cancel() }
        for progress in dropProgress.values { progress.cancel() }
    }
    func submitted(text: String, files ids: Set<String>) {
        if self.text == text { self.text = "" }
        files.removeAll { ids.contains($0.id) }; error = nil
    }
}

extension DesktopComposer {
    @MainActor func receive(providers: [NSItemProvider]) -> Bool {
        func acceptedType(_ provider: NSItemProvider) -> UTType? {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return .fileURL }
            return Self.nonFileTypes(provider.registeredTypeIdentifiers,
                plainText: provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)).first
        }
        guard providers.contains(where: { acceptedType($0) != nil }) else { return false }
        let batch = UUID(), generation = generation
        dropTasks[batch] = Task {
            defer { dropTasks[batch] = nil; dropProgress[batch] = nil }
            do {
                try checkAddition(count: providers.filter { acceptedType($0) != nil }.count)
                for provider in providers {
                    guard let type = acceptedType(provider) else { continue }
                    guard self.generation == generation else { throw CancellationError() }
                    try Task.checkCancellation()
                    let stream = AsyncThrowingStream<Data, Error> { continuation in
                        dropProgress[batch] = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
                            if let data { continuation.yield(data); continuation.finish() }
                            else { continuation.finish(throwing: error ?? CocoaError(.fileReadUnknown)) }
                        }
                    }
                    var iterator = stream.makeAsyncIterator()
                    guard let data = try await iterator.next() else { throw CancellationError() }
                    guard self.generation == generation else { throw CancellationError() }
                    try Task.checkCancellation()
                    if type == .fileURL {
                        guard let url = URL(dataRepresentation: data, relativeTo: nil) else { throw CocoaError(.fileReadInvalidFileName) }
                        try await attach([url], via: .drag)
                    } else { try await attach(data: data, type: type, via: .drag) }
                }
            } catch {
                if self.generation == generation, !Task.isCancelled {
                    self.error = DesktopUserFacingError.message(error)
                }
            }
        }
        return true
    }
}
