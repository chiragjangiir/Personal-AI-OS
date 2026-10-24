import Foundation
import XCTest

/// The 依米 app has one NavigationStack bound to `[YimiRoute]` (YimiRootView). SwiftUI traps when a pushed page brings
/// its own NavigationStack into that bound path (`NavigationColumnState.boundPathChange` → `swift_unexpectedError`;
/// a crash on 她了解你 → 健康数据与诊断). The App target is not in this package, so these checks read its
/// sources: every view that owns a NavigationStack is never a push destination, and pushes on the root stack are values.
final class YimiNavigationTests: XCTestCase {
    private static let appDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App")

    private func sources() throws -> [String: String] {
        let files = try FileManager.default.contentsOfDirectory(at: Self.appDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty)
        return try Dictionary(uniqueKeysWithValues: files.map { ($0.lastPathComponent, try String(contentsOf: $0, encoding: .utf8)) })
    }

    /// View types whose declaration contains a NavigationStack (top-level `struct X: View` up to the next top-level type).
    private func stackOwners(in text: String) -> Set<String> {
        var owners = Set<String>(), current: String?
        for line in text.components(separatedBy: "\n") {
            if let match = line.range(of: #"^(private |fileprivate )?struct (\w+)(<[^>]*>)?: View"#, options: .regularExpression) {
                current = String(line[match]).components(separatedBy: "struct ")[1].components(separatedBy: CharacterSet(charactersIn: ":<"))[0]
            } else if line.range(of: #"^(final class|class|enum|struct|extension|actor) "#, options: .regularExpression) != nil {
                current = nil
            }
            if let current, line.contains("NavigationStack") { owners.insert(current) }
        }
        return owners
    }

    func testNoViewOwningANavigationStackIsPushed() throws {
        let all = try sources()
        let owners = all.values.reduce(into: Set<String>()) { $0.formUnion(stackOwners(in: $1)) }
        XCTAssertEqual(owners.intersection(["YimiRootView", "ContentView"]), ["YimiRootView", "ContentView"])
        for (file, text) in all {
            let compact = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            for owner in owners {
                // A view-destination link or a route destination constructing a stack owner nests its stack.
                XCTAssertNil(compact.range(of: #"NavigationLink(\([^)]*\))? \{ \#(owner)\("#, options: .regularExpression),
                             "\(file) pushes \(owner), which owns a NavigationStack")
                XCTAssertNil(compact.range(of: #"NavigationLink\(destination: \#(owner)\("#, options: .regularExpression),
                             "\(file) pushes \(owner), which owns a NavigationStack")
            }
        }
        let root = try XCTUnwrap(all["YimiRootView.swift"])
        let destinations = try XCTUnwrap(root.components(separatedBy: ".navigationDestination(for: YimiRoute.self)").last)
            .components(separatedBy: ".tint(").first ?? ""
        for owner in owners { XCTAssertFalse(destinations.contains(owner + "("), "route destination builds \(owner)") }
    }

    func testEveryRouteHasADestinationAndTheRootStackHasOnePathType() throws {
        let root = try XCTUnwrap(try sources()["YimiRootView.swift"])
        let declaration = try XCTUnwrap(root.range(of: #"enum YimiRoute: Hashable, CaseIterable \{ case [a-z, ]+ \}"#, options: .regularExpression))
        let cases = String(root[declaration]).components(separatedBy: "case ")[1].dropLast(2)
            .components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertTrue(cases.contains("health"))
        for route in cases { XCTAssertTrue(root.contains("case .\(route):"), "route \(route) has no destination") }
        XCTAssertEqual(root.components(separatedBy: "NavigationStack(").count - 1, 1, "one root stack")
        XCTAssertTrue(root.contains("@Published var path: [YimiRoute]"))
        XCTAssertEqual(root.components(separatedBy: ".navigationDestination(for:").count - 1, 1, "one destination type")
    }
}
