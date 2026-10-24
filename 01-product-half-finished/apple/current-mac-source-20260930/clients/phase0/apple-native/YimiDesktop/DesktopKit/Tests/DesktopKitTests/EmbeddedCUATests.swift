import XCTest
import Darwin
@testable import DesktopKit

final class EmbeddedCUATests: XCTestCase {
    func testHostLifecycleFencesOldSocketAndPreservesOutput() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = root.appendingPathComponent("依米's candidate.app")
        let directory = root.appendingPathComponent("owner-ssh")
        let marker = root.appendingPathComponent("arguments")
        try makeExecutable(bundle.appendingPathComponent("Contents/Helpers/CuaDriver.app/Contents/MacOS/cua-driver"),
            "#!/bin/sh\nprintf '%s\\n' \"$$\" \"$CUA_DRIVER_EMBEDDED\" \"$@\" > '\(marker.path)'\nexec /bin/cat\n")
        try makeExecutable(bundle.appendingPathComponent("Contents/Resources/opengcua/python/bin/python3.12"),
            "#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
        let host = EmbeddedCUA(directory: directory, bundle: bundle)
        defer { try? host.stop() }
        try host.start()
        let first = try waitForMarker(marker)
        let pid = try XCTUnwrap(Int32(first[0]))
        XCTAssertEqual(first[1], "1")
        XCTAssertEqual(Array(first[2...5]), ["serve", "--embedded", "--socket", first[5]])
        XCTAssertEqual(first[6], "--parent-liveness-stdio")
        let socketRoot = URL(fileURLWithPath: first[5]).deletingLastPathComponent()
        XCTAssertLessThan(first[5].utf8.count, 104)
        XCTAssertEqual(try permissions(socketRoot), 0o700)
        let launcher = directory.appendingPathComponent("opengcua")
        XCTAssertEqual(try permissions(launcher), 0o700)
        XCTAssertFalse(host.failed)
        let command = Process(), pipe = Pipe()
        command.executableURL = launcher; command.arguments = ["a batch's path.py"]
        command.standardOutput = pipe; try command.run()
        let arguments = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        command.waitUntilExit()
        XCTAssertEqual(command.terminationStatus, 0)
        XCTAssertTrue(arguments.hasPrefix("-I\n-B\n\(bundle.path)/Contents/Resources/opengcua/run.py\n"))
        XCTAssertTrue(arguments.hasSuffix("a batch's path.py\n"))
        let evidence = directory.appendingPathComponent("opengcua-output/result.txt")
        try Data("unknown result; inspect before retry".utf8).write(to: evidence)
        try host.stop()
        XCTAssertEqual(kill(pid, 0), -1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: launcher.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: socketRoot.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: evidence.path))
        try FileManager.default.removeItem(at: marker)
        try host.start()
        let second = try waitForMarker(marker)
        XCTAssertNotEqual(first[5], second[5], "Resume must not reconnect an old unknown action")
        try host.stop(); try host.stop()
    }

    func testMissingBundledHelperDoesNotPublishAnEntry() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let host = EmbeddedCUA(directory: root.appendingPathComponent("owner-ssh"), bundle: root)
        XCTAssertThrowsError(try host.start())
        XCTAssertTrue(host.failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("owner-ssh/opengcua").path))
        try host.stop()
    }

    private func makeExecutable(_ path: URL, _ source: String) throws {
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(source.utf8).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
    }

    private func waitForMarker(_ path: URL) throws -> [String] {
        let ready = expectation(description: "Synthetic child starts without a GUI or permissions")
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline {
                if let value = try? String(contentsOf: path, encoding: .utf8), value.split(separator: "\n").count == 7 {
                    ready.fulfill(); return
                }
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        wait(for: [ready], timeout: 4)
        return try String(contentsOf: path, encoding: .utf8).split(separator: "\n").map(String.init)
    }

    private func permissions(_ path: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber).intValue
    }
}
