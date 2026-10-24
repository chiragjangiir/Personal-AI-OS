import Foundation
import LiveKit

struct StreamProbeConfig: Decodable, Sendable {
    let url: String, token: String, key_file: String, mode: String, run: String
    let file: String?
}
struct StreamProbeReceipt: Decodable, Sendable { let run: String, status: String; let bytes: Int }
final class StreamProbeReceipts: NSObject, RoomDelegate, @unchecked Sendable {
    let updates = AsyncThrowingStream<(StreamProbeReceipt, Double), Error>.makeStream(bufferingPolicy: .bufferingNewest(32))
    func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard participant?.identity?.stringValue == "desktop-stream-probe-receiver", encryptionType != .none,
              topic == "paios.desktop.probe.receipt.v1", data.count <= 512,
              let receipt = try? JSONDecoder().decode(StreamProbeReceipt.self, from: data) else { return }
        updates.continuation.yield((receipt, ProcessInfo.processInfo.systemUptime))
    }
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) { updates.continuation.finish(throwing: LiveKitSessionError.notConnected) }
}

func runDesktopStreamSpike(_ path: String) async throws {
    let config = try JSONDecoder().decode(StreamProbeConfig.self, from: SpikeFiles.read(path))
    guard ["file", "json", "disconnect", "cancel"].contains(config.mode), config.url.hasPrefix("wss://"),
          URL(string: config.url)?.host != URL(string: RealtimeAPIOriginMigration.legacyOrigin)?.host, URL(string: config.url)?.host != URL(string: RealtimeAPIOriginMigration.canonicalOrigin)?.host,
          config.run.range(of: "^[A-Za-z0-9_-]{1,60}$", options: .regularExpression) != nil else { throw CentralTextError.unavailable }
    let key = try SpikeFiles.read(config.key_file), provider = BaseKeyProvider(isSharedKey: true), receipts = StreamProbeReceipts()
    guard key.count == 32 else { throw LiveKitSessionError.e2eeUnavailable }; provider.setKey(keyData: key)
    let room = Room(delegate: receipts, connectOptions: ConnectOptions(autoSubscribe: false, enableMicrophone: false),
        roomOptions: RoomOptions(encryptionOptions: EncryptionOptions(keyProvider: provider, encryptionType: .gcm)))
    do {
        try await room.connect(url: config.url, token: config.token)
        guard SystemLiveKitRoomOperator.isDataChannelEncryptionActive(room.e2eeManager) else { throw LiveKitSessionError.e2eeUnavailable }
        let deadline = Task { try await Task.sleep(for: .seconds(180)); await room.disconnect() }
        defer { deadline.cancel(); receipts.updates.continuation.finish() }
        print("status=stream_e2ee_active")
        var starts: [String: Double] = [:]
        if config.mode == "json" {
            let payloads = (0..<20).map { Data((String(format: "{\"jsonrpc\":\"2.0\",\"id\":\"%02d\",\"method\":\"ping\",\"params\":{\"_meta\":{\"probe\":\"", $0) + String(repeating: "x", count: 65461) + "\"}}}").utf8) }
            try await withThrowingTaskGroup(of: (String, Double).self) { group in
                for index in 0..<20 { group.addTask {
                    let run = config.run + "-\(index)", start = ProcessInfo.processInfo.systemUptime
                    let writer = try await room.localParticipant.streamBytes(options: StreamByteOptions(topic: "paios.desktop.probe.json.v1",
                        attributes: ["v": "1", "run": run], destinationIdentities: [.init(from: "desktop-stream-probe-receiver")], mimeType: "application/json", totalSize: payloads[index].count))
                    guard writer.info.encryptionType != .none else { throw LiveKitSessionError.e2eeUnavailable }
                    try await writer.write(payloads[index]); try await writer.close(); return (run, start)
                } }
                for try await (run, start) in group { starts[run] = start }
            }
        } else {
            guard let file = config.file else { throw CentralTextError.unavailable }
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: file)); defer { try? handle.close() }
            let size = try handle.seekToEnd(); try handle.seek(toOffset: 0)
            guard size > 0, size <= 50 * 1048576 else { throw CentralTextError.unavailable }
            starts[config.run] = ProcessInfo.processInfo.systemUptime
            let writer = try await room.localParticipant.streamBytes(options: StreamByteOptions(topic: "paios.desktop.probe.file.v1",
                attributes: ["v": "1", "run": config.run, "cancel": config.mode == "cancel" ? "1" : "0"],
                destinationIdentities: [.init(from: "desktop-stream-probe-receiver")], mimeType: "application/octet-stream", totalSize: Int(size)))
            guard writer.info.encryptionType != .none else { throw LiveKitSessionError.e2eeUnavailable }
            var sent = 0
            while let chunk = try handle.read(upToCount: 65536), !chunk.isEmpty {
                try await writer.write(chunk); sent += chunk.count
                if config.mode == "disconnect", sent >= 1048576 {
                    await room.disconnect(); print("status=sender_disconnected bytes=\(sent)"); return
                }
            }
            try await writer.close(); print("status=sender_closed bytes=\(sent)")
        }
        for try await (receipt, received) in receipts.updates.stream {
            guard let start = starts.removeValue(forKey: receipt.run), receipt.bytes >= 0, receipt.bytes <= 50 * 1048576,
                  receipt.status == (config.mode == "cancel" ? "receiver_cancel" : "ok") else { throw CentralTextError.invalidPacket }
            print("status=stream_receipt run=\(receipt.run) bytes=\(receipt.bytes) elapsed_ms=\(Int((received - start) * 1000))")
            if starts.isEmpty { break }
        }
        guard starts.isEmpty else { throw CentralTextError.unavailable }
        await room.disconnect()
    } catch { await room.disconnect(); throw error }
}
