import Foundation
import XCTest

final class WatchSourcePolicyTests: XCTestCase {
    func testShippingWatchHasNoGestureShortcut() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let forbidden = "handGesture" + "Shortcut"
        for folder in ["WatchApp", "WatchCore"] {
            let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent(folder), includingPropertiesForKeys: nil)
            for file in files where file.pathExtension == "swift" {
                XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains(forbidden), file.lastPathComponent)
            }
        }
        let design = root.appendingPathComponent("App/YimiDesign.swift")
        XCTAssertFalse(try String(contentsOf: design, encoding: .utf8).contains(forbidden))
    }
}
