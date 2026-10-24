import Darwin
import Foundation
import CoreGraphics
import CoreText
import MCP
import XCTest
@testable import DesktopKit

final class NativeToolsTests: XCTestCase {
    private func fixture(_ body: (URL) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-native-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try await body(root)
    }

    func testI5DiscoveryPrunesSensitiveSubtreeAndFilters() async throws {
        try await fixture { root in
            let work = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let hidden = work.appendingPathComponent(".ssh")
            try FileManager.default.createDirectory(at: hidden, withIntermediateDirectories: true)
            try Data("private".utf8).write(to: hidden.appendingPathComponent("secret.txt"))
            try Data("发票".utf8).write(to: work.appendingPathComponent("发票.txt"))
            try Data().write(to: work.appendingPathComponent("other.zip"))
            let desktop = try TestDesktop.make(store: root.appendingPathComponent("state"), resources: root.appendingPathComponent("unused"))
            await desktop.start(transport: RegressionWire())
            _ = try await desktop.authorize(folder: work, write: true)
            let result = try await desktop.call(id: "find", name: "find_files", arguments: ["folder": .string(work.path), "kinds": ["text"]])
            let files = try XCTUnwrap(result.objectValue?["structuredContent"]?.objectValue?["files"]?.arrayValue)
            XCTAssertEqual(files.count, 1)
            XCTAssertEqual(files.first?.objectValue?["name"]?.stringValue, "发票.txt")
            let capped = try await desktop.call(id: "cap", name: "find_files", arguments: ["folder": .string(work.path), "limit": 1])
            XCTAssertEqual(capped.objectValue?["structuredContent"]?.objectValue?["truncated"], true)
            let empty = try await desktop.call(id: "time", name: "find_files", arguments: ["folder": .string(work.path), "modified_before": "2000-01-01T00:00:00Z"])
            XCTAssertEqual(empty.objectValue?["structuredContent"]?.objectValue?["files"]?.arrayValue?.count, 0)
            await desktop.stop()
        }
    }
    private func extract(_ args: [String: Value]) async throws -> Value {
        try Task.checkCancellation()
        let fd = open(try XCTUnwrap(args["path"]?.stringValue), O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw DesktopError.unavailable }
        defer { close(fd) }
        return try await NativeTools.extract(args, fd: fd)
    }
    func testTextExtractionAndBoundedUnicode() async throws {
        try await fixture { root in
            let file = root.appendingPathComponent("样本.txt")
            try Data(String(repeating: "发票金额\n", count: 20_000).utf8).write(to: file)
            let result = try await extract(["path": .string(file.path), "max_chars": 7])
            XCTAssertEqual(result.objectValue?["text"]?.stringValue, "发票金额\n发票")
            XCTAssertEqual(result.objectValue?["truncated"]?.boolValue, true)
            let capped = try await extract(["path": .string(file.path)])
            XCTAssertLessThanOrEqual(try JSONEncoder().encode(capped).count, 256 * 1024)
        }
    }

    func testEditSourceBudgetAllowsExactBoundaryAndBoundsGrowingFileRead() async throws {
        try await fixture { root in
            let file = root.appendingPathComponent("edit.txt"), maximum = 1_048_576
            try Data(repeating: 97, count: maximum).write(to: file)
            let fd = open(file.path, O_RDWR)
            guard fd >= 0 else { throw DesktopError.unavailable }
            defer { close(fd) }
            XCTAssertEqual(try FileText.content(fd: fd), String(repeating: "a", count: maximum))
            XCTAssertEqual(lseek(fd, 0, SEEK_CUR), off_t(maximum))
            var authorized = stat()
            XCTAssertEqual(fstat(fd, &authorized), 0)
            XCTAssertEqual(authorized.st_size, off_t(maximum))
            // The descriptor remains authorized, but its earlier size is now stale.
            XCTAssertEqual(ftruncate(fd, off_t(maximum + 1_000_000)), 0)
            XCTAssertThrowsError(try FileText.content(fd: fd)) { error in
                XCTAssertEqual((error as? ToolFailure)?.code, "GUARD_TOO_LARGE")
            }
            XCTAssertEqual(lseek(fd, 0, SEEK_CUR), off_t(maximum + 1))
        }
    }

    func testExtractSourceBudgetStopsBeforeFrameworkDecode() async throws {
        try await fixture { root in
            let file = root.appendingPathComponent("oversized.pdf"), maximum = 25 * 1024 * 1024
            try Data().write(to: file)
            let fd = open(file.path, O_RDWR)
            guard fd >= 0 else { throw DesktopError.unavailable }
            defer { close(fd) }
            XCTAssertEqual(ftruncate(fd, off_t(maximum + 1_000_000)), 0)
            do {
                _ = try await NativeTools.extract(["path": .string(file.path), "max_chars": 1], fd: fd)
                XCTFail("Expected source byte limit before PDF decoding")
            } catch let error as ToolFailure {
                XCTAssertEqual(error.code, "GUARD_TOO_LARGE")
            }
            XCTAssertEqual(lseek(fd, 0, SEEK_CUR), off_t(maximum + 1))
        }
    }

    func testCancelledSourceReadsLeaveDescriptorUntouched() async throws {
        try await fixture { root in
            let file = root.appendingPathComponent("cancel.txt")
            try Data("content".utf8).write(to: file)
            let fd = open(file.path, O_RDONLY)
            guard fd >= 0 else { throw DesktopError.unavailable }
            defer { close(fd) }
            XCTAssertEqual(lseek(fd, 3, SEEK_SET), 3)
            let edit = Task {
                withUnsafeCurrentTask { $0?.cancel() }
                return try FileText.content(fd: fd)
            }
            do { _ = try await edit.value; XCTFail("Expected edit read cancellation") } catch is CancellationError { }
            XCTAssertEqual(lseek(fd, 0, SEEK_CUR), 3)
            let extraction = Task {
                withUnsafeCurrentTask { $0?.cancel() }
                return try await NativeTools.extract(["path": .string(file.path)], fd: fd)
            }
            do { _ = try await extraction.value; XCTFail("Expected extract read cancellation") } catch is CancellationError { }
            XCTAssertEqual(lseek(fd, 0, SEEK_CUR), 3)
        }
    }

    func testPDFTextAndScannedChinesePage() async throws {
        try await fixture { root in
            let pdf = root.appendingPathComponent("invoice.pdf")
            var box = CGRect(x: 0, y: 0, width: 1200, height: 400)
            let bitmap = try XCTUnwrap(CGContext(data: nil, width: 1200, height: 400, bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            bitmap.setFillColor(CGColor(gray: 1, alpha: 1)); bitmap.fill(box)
            bitmap.textPosition = CGPoint(x: 80, y: 200)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: "发票金额 128 元", attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("PingFangSC-Regular" as CFString, 64, nil)]))
            CTLineDraw(line, bitmap)
            let image = try XCTUnwrap(bitmap.makeImage()), context = try XCTUnwrap(CGContext(pdf as CFURL, mediaBox: &box, nil))
            context.beginPDFPage(nil); context.textPosition = CGPoint(x: 80, y: 200)
            CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: "Invoice 128", attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 64, nil)])), context)
            context.endPDFPage(); context.beginPDFPage(nil); context.draw(image, in: box); context.endPDFPage(); context.closePDF()
            let text = try await extract(["path": .string(pdf.path), "pages": [1]])
            XCTAssertTrue(text.objectValue?["text"]?.stringValue?.contains("Invoice 128") == true)
            let scanned = try await extract(["path": .string(pdf.path), "pages": [2]])
            XCTAssertTrue(scanned.objectValue?["text"]?.stringValue?.contains("发票") == true)
        }
    }

    func testCancellationStopsExtraction() async throws {
        try await fixture { root in
            let extraction = Task { () throws -> MCP.Value in
                withUnsafeCurrentTask { $0?.cancel() }
                return try await extract(["path": .string(root.appendingPathComponent("missing.txt").path)])
            }
            do { _ = try await extraction.value; XCTFail("Expected cancellation before file access") } catch is CancellationError { }
        }
    }
}
