import AppKit
import DesktopKit
import UniformTypeIdentifiers
import XCTest
@testable import LiveKit
@testable import LiveKitNanopb

@MainActor final class DesktopComposerTests: XCTestCase {
    func testA64OwnerFileGrantIsExactlyWhatFormalMessageCarries() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("invoice.txt"); try Data("invoice".utf8).write(to: file)
        let control = FakeDesktopControl(), composer = DesktopComposer(desktop: control, attachments: root)
        try await composer.attach([file], via: .drag)
        let grants = await control.grants(), message = composer.prepare()
        XCTAssertEqual(message.count, 1)
        XCTAssertEqual(message.first?.grant_id, grants.first?.id)
        XCTAssertEqual(message.first?.path, grants.first?.path)
        XCTAssertEqual(message.first?.size, 7)
        let bytes = try AssistantCentralTextWire.submit(eventID: "019f2a70-0000-7000-8000-000000000001", capturedAt: "2026-10-16T00:00:00.000Z", text: "整理", attachments: message)
        let packet = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? XCTAnyDictionary)
        XCTAssertEqual((packet["attachments"] as? [XCTAnyDictionary])?.first?["grant_id"] as? String, grants.first?.id)
    }
    func testA64FoldersAndEleventhFileAreRefusedBeforeGrant() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let control = FakeDesktopControl(), composer = DesktopComposer(desktop: control, attachments: root)
        do { try await composer.attach([root], via: .drag); XCTFail("folder attached") } catch { XCTAssertEqual(error.localizedDescription, "文件夹请到设置里添加") }
        let paths = await control.grantedURLs; XCTAssertTrue(paths.isEmpty)
        do { try await composer.attach(Array(repeating: root, count: 11), via: .paste); XCTFail("11 files attached") } catch { XCTAssertEqual(error.localizedDescription, "每条消息最多添加 10 个文件") }
        let after = await control.grantedURLs; XCTAssertTrue(after.isEmpty)
    }
    func testA64OverlappingGrantsShareTenFileBudgetAndUnpairDiscardsLateGrant() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("invoice.txt"); try Data("invoice".utf8).write(to: file)
        let control = FakeDesktopControl(), composer = DesktopComposer(desktop: control)
        let started = AsyncStream<Void>.makeStream(), release = AsyncStream<Void>.makeStream()
        await control.setGrantBarrier { started.continuation.yield(()); for await _ in release.stream { break } }
        let first = Task { try await composer.attach(Array(repeating: file, count: 6), via: .drag) }
        var iterator = started.stream.makeAsyncIterator(); _ = await iterator.next()
        do { try await composer.attach(Array(repeating: file, count: 5), via: .paste); XCTFail("overlapping grants exceeded ten") }
        catch { XCTAssertEqual(error.localizedDescription, "每条消息最多添加 10 个文件") }
        composer.clear(); release.continuation.yield(())
        do { try await first.value; XCTFail("late grant survived unpair") } catch is CancellationError { }
        let grants = await control.grants(); XCTAssertTrue(grants.isEmpty); XCTAssertTrue(composer.prepare().isEmpty)
    }
    func testRecoverableReconnectRetainsDraftAndAttachments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("draft.txt"); try Data([1]).write(to: file)
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root,
                                        sleep: { _ in throw CancellationError() })
        model.composer.text = "keep draft"
        try await model.composer.attach([file], via: .drag)
        let attachments = model.composer.files
        await model.accept(AssistantSessionSnapshot(state: .failed(code: "network"), revision: 1,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false))
        XCTAssertEqual(model.composer.text, "keep draft"); XCTAssertEqual(model.composer.files, attachments)
        await model.accept(AssistantSessionSnapshot(state: .active(encryptionActive: true), revision: 2,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false))
        XCTAssertEqual(model.composer.text, "keep draft"); XCTAssertEqual(model.composer.files, attachments)
    }
    func testSubmittedDraftDoesNotEraseNewTextOrAttachments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("invoice.txt"); try Data("invoice".utf8).write(to: file)
        let composer = DesktopComposer(desktop: FakeDesktopControl())
        composer.text = "first"; try await composer.attach([file], via: .drag)
        let submitted = Set(composer.files.map(\.id))
        composer.text = "next"; try await composer.attach([file], via: .paste)
        composer.submitted(text: "first", files: submitted)
        XCTAssertEqual(composer.text, "next"); XCTAssertEqual(composer.files.count, 1); XCTAssertEqual(composer.files.first?.via, .paste)
    }
    func testA64NonFilePastePersistsUnderDateFolderAndIsGrantedWhilePlainTextStaysText() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let control = FakeDesktopControl(), composer = DesktopComposer(desktop: control, attachments: root)
        let board = NSPasteboard.withUniqueName(); defer { board.releaseGlobally() }
        for (type, bytes) in [(UTType.png, Data([137, 80, 78, 71])), (.jpeg, Data([255, 216, 255, 217]))] {
            board.clearContents(); board.setData(bytes, forType: .init(type.identifier))
            let pasted = try await composer.paste(board); XCTAssertTrue(pasted)
            let file = try XCTUnwrap(composer.files.last)
            XCTAssertTrue(file.path.hasPrefix(root.path + "/"))
            XCTAssertEqual(URL(fileURLWithPath: file.path).pathExtension, type.preferredFilenameExtension)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file.path)), bytes)
            XCTAssertEqual(file.via, .paste)
        }
        board.clearContents(); board.setString("hello", forType: .string)
        let plain = try await composer.paste(board); XCTAssertFalse(plain); XCTAssertEqual(composer.files.count, 2)
    }
}
private typealias XCTAnyDictionary = [String: Any]

final class DesktopTransportLifecycleTests: XCTestCase {
    private func fixture(_ root: URL) async throws -> (SystemLiveKitRoomOperator, Room, DesktopSessionTransport) {
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let room = Room(), wire = try DesktopSessionTransport(room: core, temporary: root)
        let binding = CentralTransportBinding(sessionID: "session", deviceID: "C957EB67-6E63-4EE3-AD42-E3848E59BA21", connectionEpoch: "1", expectedGatewayIdentity: "gateway", maxPacketBytes: 12288)
        _ = try core.beginAttempt(attemptID: 1, events: { _ in }, capabilities: .none, roomName: "desktop", centralBinding: binding)
        XCTAssertTrue(core.attachRoom(room, attemptID: 1))
        let dependencies = ConnectionDependencies(room: room, roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: BaseKeyProvider(isSharedKey: true), encryptionType: .gcm)))
        try room._state.mutate { state in
            try state.stage.begin(dependencies); state.connectionState = .connected
            _ = state.updateRemoteParticipant(info: .with { $0.sid = "PA_gateway"; $0.identity = "gateway" }, room: room)
        }
        try await core.registerCentralByteStreams(in: room, attemptID: 1)
        return (core, room, wire)
    }
    private func deliver(_ bytes: Data, topic: String, id: String, room: Room, close: Bool = true) {
        let header = Livekit_DataStream.Header.with {
            $0.streamID = id; $0.topic = topic; $0.mimeType = topic == DesktopSessionTransport.frameTopic ? "application/json" : "application/octet-stream"
            $0.totalLength = UInt64(bytes.count); $0.attributes = ["v": "1", "dir": "down"]
            $0.contentHeader = .byteHeader(.with { $0.name = "download.bin" })
        }
        room.incomingStreamManager.handle(.header(header, "gateway", .gcm))
        room.incomingStreamManager.handle(.chunk(.with { $0.streamID = id; $0.chunkIndex = 0; $0.content = bytes }, .gcm))
        if close { room.incomingStreamManager.handle(.trailer(.with { $0.streamID = id }, .gcm)) }
    }
    func testContinuousConsumerReceivesEarlyFrameAndRetiresOldFrameAfterRotation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let (core, room, wire) = try await fixture(root)
        let started = expectation(description: "logical consumer listening")
        let oldReceived = expectation(description: "old frame received before rotation")
        let received = expectation(description: "same consumer receives new initialize")
        let rotated = AsyncStream<Void>.makeStream()
        let oldBytes = Data("old-initialize".utf8), newBytes = Data("new-initialize".utf8)
        let consumer = Task {
            let stream = wire.frames(); started.fulfill()
            for await frame in stream {
                guard case .message(let data, let current) = frame else { continue }
                if data == oldBytes {
                    XCTAssertTrue(current()); oldReceived.fulfill()
                    for await _ in rotated.stream { break }
                    XCTAssertFalse(current(), "the room authority retires bytes already delivered before rotation")
                } else {
                    XCTAssertEqual(data, newBytes); XCTAssertTrue(current())
                    received.fulfill(); break
                }
            }
        }
        await fulfillment(of: [started], timeout: 2)
        deliver(oldBytes, topic: DesktopSessionTransport.frameTopic, id: "old", room: room)
        await fulfillment(of: [oldReceived], timeout: 2)
        core.room(room, didStartReconnectWithMode: .quick)
        core.room(room, didCompleteReconnectWithMode: .quick)
        deliver(newBytes, topic: DesktopSessionTransport.frameTopic, id: "new", room: room)
        rotated.continuation.yield(()); rotated.continuation.finish()
        await fulfillment(of: [received], timeout: 3)
        consumer.cancel(); wire.finish(); await consumer.value
        try await wire.removeTemporaryFiles(); await core.stop(attemptID: 1)
    }
    func testClaimedDownloadCancellationStopsReaderAndPreservesEncryptedFrames() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let (core, room, wire) = try await fixture(root)
        let claimed = expectation(description: "download claimed")
        let consumer = Task { () throws -> URL in
            for await incoming in wire.downloads() {
                claimed.fulfill()
                do { try await incoming.completion(); XCTFail("cancelled completion returned success") }
                catch is CancellationError { return incoming.file }
                throw CentralTextError.unavailable
            }
            throw CancellationError()
        }
        deliver(Data("partial".utf8), topic: DesktopSessionTransport.fileTopic, id: "cancelled-download", room: room, close: false)
        await fulfillment(of: [claimed], timeout: 2)
        consumer.cancel()
        let file = try await consumer.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "Claimed cancellation must remove its partial download")
        let received = expectation(description: "same attachment still receives frames")
        let frameConsumer = Task { for await frame in wire.frames() { guard case .message(let data, let current) = frame else { continue }; XCTAssertEqual(data, Data("chat".utf8)); XCTAssertTrue(current()); received.fulfill(); break } }
        deliver(Data("chat".utf8), topic: DesktopSessionTransport.frameTopic, id: "after-cancellation", room: room)
        await fulfillment(of: [received], timeout: 2)
        frameConsumer.cancel(); await frameConsumer.value
        wire.finish(); try await wire.removeTemporaryFiles(); await core.stop(attemptID: 1)
    }
    func testUnclaimedDownloadAbortJoinsWriterIsRepeatableAndPreservesEncryptedFrames() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let (core, room, wire) = try await fixture(root)
        XCTAssertEqual(wire.auditDeviceID, "C957EB67-6E63-4EE3-AD42-E3848E59BA21")
        let consumer = Task { () throws -> DesktopIncomingFile in
            for await incoming in wire.downloads() { return incoming }
            throw CancellationError()
        }
        let partial = Data("partial".utf8)
        deliver(partial, topic: DesktopSessionTransport.fileTopic, id: "unclaimed-download", room: room, close: false)
        let incoming = try await consumer.value
        let deadline = ContinuousClock.now + .seconds(2)
        while (try? Data(contentsOf: incoming.file)) != partial, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try Data(contentsOf: incoming.file), partial)
        await incoming.abort()
        await incoming.abort()
        XCTAssertFalse(FileManager.default.fileExists(atPath: incoming.file.path))
        do { try await incoming.completion(); XCTFail("aborted writer returned success") }
        catch is CancellationError {}
        let received = expectation(description: "same encrypted attachment receives chat after abort")
        let frames = Task { for await frame in wire.frames() { guard case .message(let data, let current) = frame else { continue }; XCTAssertEqual(data, Data("chat".utf8)); XCTAssertTrue(current()); received.fulfill(); break } }
        deliver(Data("chat".utf8), topic: DesktopSessionTransport.frameTopic, id: "after-unclaimed-abort", room: room)
        await fulfillment(of: [received], timeout: 2)
        frames.cancel(); await frames.value
        wire.finish(); try await wire.removeTemporaryFiles(); await core.stop(attemptID: 1)
        XCTAssertNil(wire.auditDeviceID)
    }
    func testUnpairedTransportDoesNotSupplyAnAuditIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = SystemLiveKitRoomOperator(encryptionProvider: UnavailableLiveKitEncryptionOptionsProvider())
        let wire = try DesktopSessionTransport(room: core, temporary: root)
        XCTAssertNil(wire.auditDeviceID)
        wire.finish(); try await wire.removeTemporaryFiles()
    }
    func testCompletedDownloadSurvivesUntilConsumerStopThenIsReclaimed() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let (core, room, wire) = try await fixture(root)
        let received = expectation(description: "completed file")
        let consumer = Task { () throws -> URL in
            for await incoming in wire.downloads() {
                try await incoming.completion()
                XCTAssertEqual(try Data(contentsOf: incoming.file), Data("file".utf8))
                received.fulfill(); return incoming.file
            }
            throw CancellationError()
        }
        deliver(Data("file".utf8), topic: DesktopSessionTransport.fileTopic, id: "download", room: room)
        await fulfillment(of: [received], timeout: 3)
        let file = try await consumer.value
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        core.room(room, didStartReconnectWithMode: .full)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "Recovery cannot remove a file still owned by the Desktop consumer")
        let desktop = FakeDesktopControl(); await desktop.stop()
        try await wire.removeTemporaryFiles()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        wire.finish(); try await wire.removeTemporaryFiles(); await core.stop(attemptID: 1)
    }
}
