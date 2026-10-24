import AppKit
import MCP
import PDFKit
import UniformTypeIdentifiers
import Vision

/// Framework transforms consume only bytes from the executor's authorized descriptor.
internal enum NativeTools {
    static func kind(_ path: String) -> String {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        if ext == "pdf" { return "pdf" }
        if UTType(filenameExtension: ext)?.conforms(to: .image) == true { return "image" }
        if ["doc", "docx", "rtf", "rtfd", "odt", "pages"].contains(ext) { return "document" }
        if ["xls", "xlsx", "ods", "numbers", "csv", "tsv"].contains(ext) { return "spreadsheet" }
        if ["ppt", "pptx", "odp", "key"].contains(ext) { return "presentation" }
        if ["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].contains(ext) { return "archive" }
        if UTType(filenameExtension: ext)?.conforms(to: .text) == true { return "text" }
        return "other"
    }

    /// Index candidates only. The executor must authorize and open every returned item.
    @MainActor static func spotlight(folder: String, query text: String) async throws -> Set<String> {
        guard !text.isEmpty else { return [] }
        let query = NSMetadataQuery()
        query.searchScopes = [folder]
        query.predicate = NSPredicate(format: "kMDItemFSName CONTAINS[cd] %@ OR kMDItemTextContent CONTAINS[cd] %@", text, text)
        guard query.start() else { return [] }
        defer { query.stop() }
        for _ in 0..<20 {
            try await Task.sleep(for: .milliseconds(100))
            if !query.isGathering { break }
        }
        query.disableUpdates()
        return Set(query.results.compactMap { ($0 as? NSMetadataItem)?.value(forAttribute: NSMetadataItemPathKey) as? String })
    }

    private static func recognize(_ handler: VNImageRequestHandler) async throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.usesLanguageCorrection = true
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try handler.perform([request])
            try Task.checkCancellation()
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        } onCancel: { request.cancel() }
    }

    static func extract(_ args: [String: MCP.Value], fd: Int32) async throws -> MCP.Value {
        try Task.checkCancellation()
        guard let path = args["path"]?.stringValue else { throw ToolFailure("GUARD_PATH_INVALID", "缺少文件路径") }
        let url = URL(fileURLWithPath: path), type = kind(path)
        let maximum = min(50_000, max(1, args["max_chars"]?.intValue ?? 50_000))
        // Match the 25 MiB upload source budget before PDF/AppKit/Vision decoding.
        let data = try DescriptorRead.data(fd: fd, maximum: 25 * 1024 * 1024, message: "提取源文件超过25 MiB")
        try Task.checkCancellation()
        var text = "", truncated = false
        func append(_ value: String) {
            let room = maximum - text.count
            let part = String(value.prefix(room))
            text += part
            truncated = truncated || part.count < value.count
        }
        if type == "pdf" {
            guard let document = PDFDocument(data: data), !document.isLocked else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "无法读取此PDF，可能已加密或损坏") }
            let pages = args["pages"]?.arrayValue?.compactMap(\.intValue) ?? Array(1...max(1, document.pageCount))
            for (offset, number) in pages.enumerated() {
                try Task.checkCancellation()
                guard number > 0, let page = document.page(at: number - 1) else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "PDF页码超出范围") }
                let layer = page.string ?? ""
                let content: String
                if layer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let thumbnail = page.thumbnail(of: NSSize(width: 2048, height: 2048), for: .mediaBox)
                    guard let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "无法读取PDF页面") }
                    content = try await recognize(VNImageRequestHandler(cgImage: image, options: [:]))
                } else { content = layer }
                append((offset == 0 ? "" : "\n") + content)
                if text.count == maximum { truncated = truncated || offset < pages.count - 1; break }
            }
        } else if type == "image" {
            append(try await recognize(VNImageRequestHandler(data: data, options: [:])))
        } else if type == "text" || type == "document" {
            @Sendable func read() throws -> String {
                var options: [NSAttributedString.DocumentReadingOptionKey: Any] = [:]
                if UTType(filenameExtension: url.pathExtension)?.conforms(to: .plainText) == true { options[.documentType] = NSAttributedString.DocumentType.plain }
                return try NSAttributedString(data: data, options: options, documentAttributes: nil).string
            }
            // AppKit's HTML importer requires the main thread; other document reads stay concurrent.
            if ["html", "htm"].contains(url.pathExtension.lowercased()) { append(try await MainActor.run { try read() }) }
            else { append(try read()) }
        } else { throw ToolFailure("GUARD_TYPE_UNSUPPORTED", "这个文件类型不能提取文字") }
        try Task.checkCancellation()
        // 50,000 Unicode scalars can exceed the text budget after JSON escaping.
        while try JSONEncoder().encode(MCP.Value.string(text)).count > 250 * 1024 {
            text = String(text.prefix(max(0, text.count - 1024))); truncated = true
        }
        return .object(["path": .string(path), "text": .string(text), "truncated": .bool(truncated)])
    }
}
