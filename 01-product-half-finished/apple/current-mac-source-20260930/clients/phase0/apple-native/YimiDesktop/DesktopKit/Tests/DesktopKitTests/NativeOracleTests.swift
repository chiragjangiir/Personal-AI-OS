import Darwin
import Foundation
import MCP
import XCTest
@testable import DesktopKit

final class NativeOracleTests: XCTestCase {
    private struct Fixture: Decodable { let scenarios: [Scenario] }
    private struct Scenario: Decodable {
        let id: String
        let files: [String: Value]
        let dirs: [String]
        let cases: [OracleCase]
    }
    private struct OracleCase: Decodable {
        let name: String
        let args: [String: Value]
        let result: Value
        let checkFiles: [String]?
        let after: [String: Value]?
    }
    private func expand(_ value: Value, root: String) -> Value {
        switch value {
        case .string(let text): return .string(text.replacingOccurrences(of: "$ROOT", with: root))
        case .array(let values): return .array(values.map { expand($0, root: root) })
        case .object(let object): return .object(object.mapValues { expand($0, root: root) })
        default: return value
        }
    }
    private func normalize(_ value: Value, root: String, canonicalRoot: String, metadata: Bool) -> Value {
        switch value {
        case .string(let text):
            var result = text.replacingOccurrences(of: canonicalRoot, with: "$ROOT").replacingOccurrences(of: root, with: "$ROOT")
            if metadata {
                for field in ["created", "modified", "accessed"] {
                    result = result.replacingOccurrences(of: "(?m)^\(field): [^\\n]*", with: "\(field): <\(field)>", options: .regularExpression)
                }
            }
            return .string(result)
        case .array(let values): return .array(values.map { normalize($0, root: root, canonicalRoot: canonicalRoot, metadata: metadata) })
        case .object(let object): return .object(object.mapValues { normalize($0, root: root, canonicalRoot: canonicalRoot, metadata: metadata) })
        default: return value
        }
    }
    func testNativeFilesystemMatchesOfficialOutputOracle() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/filesystem-oracle.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-native-oracle-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let root = temporary.resolvingSymlinksInPath()
        let canonicalRoot = try GuardPath.canonical(root.path)
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home"), trash = root.appendingPathComponent("trash")
        for directory in [home, trash] { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        let desktop = try Desktop(store: root.appendingPathComponent("state"), resources: root, home: home, trash: { file in
            let destination = trash.appendingPathComponent(UUID().uuidString)
            try FileManager.default.moveItem(at: file, to: destination)
            return destination
        })
        do {
            var sequence = 0
            for scenario in fixture.scenarios {
                let directory = root.appendingPathComponent(scenario.id)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                for relative in scenario.dirs {
                    try FileManager.default.createDirectory(at: directory.appendingPathComponent(relative), withIntermediateDirectories: true)
                }
                for (relative, value) in scenario.files {
                    let text: String
                    if let content = value.stringValue { text = content }
                    else {
                        let spec = try XCTUnwrap(value.objectValue)
                        text = String(repeating: try XCTUnwrap(spec["character"]?.stringValue), count: try XCTUnwrap(spec["count"]?.intValue))
                    }
                    let file = directory.appendingPathComponent(relative)
                    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data(text.utf8).write(to: file)
                    XCTAssertEqual(chmod(file.path, 0o640), 0)
                }
                _ = try await desktop.authorize(folder: directory, write: true)
                for (index, oracle) in scenario.cases.enumerated() {
                    sequence += 1
                    let args = oracle.args.mapValues { expand($0, root: canonicalRoot) }
                    let actual = try await desktop.call(id: .int(sequence), name: oracle.name, arguments: args)
                    XCTAssertEqual(normalize(actual, root: root.path, canonicalRoot: canonicalRoot, metadata: oracle.name == "get_file_info"), oracle.result, "\(scenario.id)[\(index)] \(oracle.name)")
                    for path in oracle.checkFiles ?? [] {
                        let file = URL(fileURLWithPath: path.replacingOccurrences(of: "$ROOT", with: canonicalRoot))
                        let expected = try XCTUnwrap(oracle.after?[path])
                        if expected == .null { XCTAssertFalse(FileManager.default.fileExists(atPath: file.path)) }
                        else { XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), expected.stringValue) }
                    }
                    if oracle.name == "create_directory" {
                        var isDirectory: ObjCBool = false
                        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(args["path"]?.stringValue), isDirectory: &isDirectory))
                        XCTAssertTrue(isDirectory.boolValue)
                    }
                }
            }
            XCTAssertEqual(sequence, 32)
            await desktop.stop()
        } catch { await desktop.stop(); throw error }
    }
}
