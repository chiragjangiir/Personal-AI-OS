import Foundation
import MCP
import XCTest
@testable import DesktopKit

final class GrantedFilesTests: XCTestCase {
    func testExactGrantReadDryRunAndExplicitWriteRefusal() async throws {
        try await TestDesktop.fixture { desktop, _, root in
            let file = root.appendingPathComponent("given.txt")
            try Data("before\n".utf8).write(to: file)
            _ = try await desktop.grant(files: [file], via: .paste)
            let read = try await desktop.call(id: "read", name: "read_text_file", arguments: ["path": .string(file.path)])
            XCTAssertTrue(read.description.contains("before"))
            let dry = try await desktop.call(id: "dry", name: "edit_file", arguments: ["path": .string(file.path), "edits": [["oldText": "before", "newText": "after"]], "dryRun": true])
            XCTAssertNotEqual(dry.objectValue?["isError"], true)
            for (tool, args): (String, [String: Value]) in [
                ("write_file", ["path": .string(file.path), "content": "after"]),
                ("edit_file", ["path": .string(file.path), "edits": [["oldText": "before", "newText": "after"]]])] {
                let result = try await desktop.call(id: .string(tool), name: tool, arguments: args)
                XCTAssertEqual(TestDesktop.code(result), "GUARD_TYPE_UNSUPPORTED")
            }
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "before\n")
        }
    }
}
