import AppKit
import DesktopKit
import UniformTypeIdentifiers
import XCTest

@MainActor final class DesktopComposerDropTests: XCTestCase {
    private func fixture() throws -> (URL, FakeDesktopControl, DesktopComposer) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let control = FakeDesktopControl()
        return (root, control, DesktopComposer(desktop: control, attachments: root))
    }
    func testLateImageAfterClearCreatesNoFileGrantOrDraft() async throws {
        let (root, control, composer) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let provider = HeldDropProvider(.png)
        XCTAssertTrue(composer.receive(providers: [provider.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [provider.requested], timeout: 2)
        composer.clear(); composer.text = "new draft"
        provider.finish(Data([137, 80, 78, 71]))
        for task in tasks { await task.value }
        XCTAssertTrue(composer.files.isEmpty)
        let grants = await control.grants(); XCTAssertTrue(grants.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertEqual(composer.text, "new draft"); XCTAssertNil(composer.error)
    }
    func testLateFileURLAfterClearDoesNotCreateGrant() async throws {
        let (root, control, composer) = try fixture()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("input.txt"); try Data([1]).write(to: file)
        let provider = HeldDropProvider(.fileURL)
        XCTAssertTrue(composer.receive(providers: [provider.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [provider.requested], timeout: 2)
        composer.clear(); provider.finish(file.dataRepresentation)
        for task in tasks { await task.value }
        XCTAssertTrue(composer.files.isEmpty)
        let grants = await control.grants(); XCTAssertTrue(grants.isEmpty)
        XCTAssertNil(composer.error)
    }
    func testClearWhileImageGrantIsPendingRevokesGrantAndDeletesImage() async throws {
        let (root, control, composer) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let started = AsyncStream<Void>.makeStream(), release = AsyncStream<Void>.makeStream()
        await control.setGrantBarrier { started.continuation.yield(()); for await _ in release.stream { break } }
        let provider = HeldDropProvider(.png)
        XCTAssertTrue(composer.receive(providers: [provider.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [provider.requested], timeout: 2)
        provider.finish(Data([1]))
        var iterator = started.stream.makeAsyncIterator(); _ = await iterator.next()
        composer.clear(); release.continuation.yield(())
        for task in tasks { await task.value }
        XCTAssertTrue(composer.files.isEmpty)
        let grants = await control.grants(); XCTAssertTrue(grants.isEmpty)
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        XCTAssertTrue(files.filter { $0.pathExtension == "png" }.isEmpty)
        XCTAssertNil(composer.error)
    }
    func testLateProviderErrorDoesNotReplaceNewDraftError() async throws {
        let (root, _, composer) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let provider = HeldDropProvider(.png)
        XCTAssertTrue(composer.receive(providers: [provider.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [provider.requested], timeout: 2)
        composer.clear(); composer.error = "current error"
        provider.finish(nil, CocoaError(.fileReadUnknown))
        for task in tasks { await task.value }
        XCTAssertEqual(composer.error, "current error")
    }
    func testWholeBatchKeepsOriginalIdentityWhenClearedBetweenProviders() async throws {
        let (root, control, composer) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = HeldDropProvider(.png), second = HeldDropProvider(.png)
        XCTAssertTrue(composer.receive(providers: [first.item, second.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [first.requested], timeout: 2)
        first.finish(Data([1]))
        await fulfillment(of: [second.requested], timeout: 2)
        let original = Set(composer.files.map(\.id))
        XCTAssertEqual(original.count, 1)
        composer.clear(); second.finish(Data([2]))
        for task in tasks { await task.value }
        XCTAssertTrue(composer.files.isEmpty)
        let grants = await control.grants()
        XCTAssertEqual(Set(grants.map(\.id)), original, "late second provider must not create a new authorization")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        XCTAssertEqual(files.filter { $0.pathExtension == "png" }.count, 1)
        XCTAssertNil(composer.error)
    }
    func testCurrentDropCompletesAndKeepsExistingDraft() async throws {
        let (root, control, composer) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        composer.text = "retain this draft"
        let provider = HeldDropProvider(.png)
        XCTAssertTrue(composer.receive(providers: [provider.item]))
        let tasks = Array(composer.dropTasks.values)
        await fulfillment(of: [provider.requested], timeout: 2)
        provider.finish(Data([1, 2, 3]))
        for task in tasks { await task.value }
        XCTAssertEqual(composer.files.count, 1)
        let grants = await control.grants(); XCTAssertEqual(grants, composer.files)
        XCTAssertEqual(composer.text, "retain this draft")
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(composer.files.first).pathURL), Data([1, 2, 3]))
        XCTAssertNil(composer.error)
    }
}

private final class HeldDropProvider: @unchecked Sendable {
    let item = NSItemProvider()
    let requested = XCTestExpectation(description: "provider requested")
    private let lock = NSLock()
    private var completion: ((Data?, Error?) -> Void)?
    init(_ type: UTType) {
        item.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { [weak self] completion in
            guard let self else { completion(nil, CancellationError()); return nil }
            lock.lock(); self.completion = completion; lock.unlock()
            requested.fulfill()
            return Progress(totalUnitCount: 1)
        }
    }
    func finish(_ data: Data?, _ error: Error? = nil) {
        lock.lock(); let callback = completion; completion = nil; lock.unlock()
        callback?(data, error)
    }
}

private extension FileGrant { var pathURL: URL { URL(fileURLWithPath: path) } }


extension DesktopComposerDropTests {
    func testExt13EditorPasteHandlerDoesNotRetainTheEditor() async throws {
        weak var released: ComposerTextView?
        autoreleasepool {
            let editor = ComposerTextView()
            editor.configurePaste(paste: { _ in false }, report: { _ in })
            released = editor
        }
        // AppKit may finish text-input registration on the next main-loop turn.
        for _ in 0..<200 {
            if released == nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNil(released)
    }
}


extension DesktopComposerDropTests {
    func testExt13DismantledEditorRejectsLatePasteResult() async throws {
        let started = expectation(description: "paste entered"), release = AsyncStream<Void>.makeStream()
        let editor = ComposerTextView(), clipboard = NSPasteboard.withUniqueName()
        defer { clipboard.releaseGlobally() }
        editor.string = "existing"; clipboard.setString("late", forType: .string)
        editor.configurePaste(paste: { _ in
            started.fulfill()
            for await _ in release.stream { break }
            return false
        }, report: { _ in XCTFail("A detached editor must not publish a late error") })
        editor.filePaste?(clipboard)
        let tasks = Array(editor.pasteTasks.values)
        await fulfillment(of: [started], timeout: 2)
        editor.invalidatePaste(); release.continuation.yield(())
        for task in tasks { await task.value }
        XCTAssertEqual(editor.string, "existing")
        XCTAssertNil(editor.filePaste); XCTAssertTrue(editor.pasteTasks.isEmpty)
    }

    func testExt13CancelledPasteRevokesGrantAfterItsAwait() async throws {
        let (root, control, composer) = try fixture()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("input.txt"); try Data([1]).write(to: file)
        let started = AsyncStream<Void>.makeStream(), release = AsyncStream<Void>.makeStream()
        await control.setGrantBarrier { started.continuation.yield(()); for await _ in release.stream { break } }
        let pending = Task { try await composer.attach([file], via: .paste) }
        var iterator = started.stream.makeAsyncIterator(); _ = await iterator.next()
        pending.cancel(); release.continuation.yield(())
        do { try await pending.value; XCTFail("Cancelled paste must not attach") } catch is CancellationError { }
        XCTAssertTrue(composer.files.isEmpty)
        let grants = await control.grants(); XCTAssertTrue(grants.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), Data([1]))
    }
}
