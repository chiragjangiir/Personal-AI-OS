import Foundation
import Combine

struct CentralOwnerOverride: Decodable, Sendable, Equatable {
    let available: Bool
    let enabled: Bool
    let expires_at: String?
    let enabled_by_device: String?
    let remaining_s: Int?
    func statusText(at now: Date) -> String {
        guard enabled else { return "未开启" }
        guard let expires_at else { return "已开启" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: expires_at)
        formatter.formatOptions = [.withInternetDateTime]
        guard let deadline = fractional ?? formatter.date(from: expires_at) else { return "已开启" }
        let remaining = max(0, Int(ceil(deadline.timeIntervalSince(now))))
        return remaining == 0 ? "已到期" : String(format: "已开启 · 剩余 %02d:%02d", remaining / 60, remaining % 60)
    }
}

/// In-memory projection of the server authority; credentials never enter the chat/outbox.
@MainActor
final class YimiOwnerOverrideModel: ObservableObject {
    @Published private(set) var status: CentralOwnerOverride?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private var sessionID: String?
    private var events: Task<Void, Never>?
    var send: ((Data, String) async throws -> CentralTextPacket)?
    var connected: Bool { sessionID != nil }

    func connect(_ coordinator: AssistantSessionCoordinator) {
        let channel = coordinator.paymentChannel
        send = { try await channel.request($0, id: $1, timeout: 15) }
        events?.cancel()
        let (stream, continuation) = AsyncStream<AssistantPaymentEvent>.makeStream()
        events = Task { [weak self] in
            await channel.setOwnerObserver { continuation.yield($0) }
            for await event in stream {
                guard !Task.isCancelled else { return }
                self?.receive(event)
            }
        }
    }

    func receive(_ event: AssistantPaymentEvent) {
        switch event {
        case .attached(let binding):
            sessionID = binding.sessionID; status = nil; error = nil
            if send != nil { Task { await request("owner_override_status") } }
        case .detached, .failed:
            sessionID = nil; status = nil
        case .output(let packet):
            guard (try? packet.fields.value("session_id", as: String.self)) == sessionID else { return }
            do {
                status = try packet.fields.value("owner_override", as: CentralOwnerOverride.self)
                let code = try packet.fields.value("error_code", as: String.self)
                error = code.map {
                    switch $0 {
                    case "OWNER_OVERRIDE_INVALID_PASSPHRASE": return "口令不正确，请重试"
                    case "OWNER_OVERRIDE_LOCKED": return "尝试次数过多，请 15 分钟后重试"
                    case "OWNER_OVERRIDE_UNAVAILABLE": return "服务器尚未配置最高权限口令"
                    default: return "最高权限操作未完成，请稍后重试"
                    }
                }
            } catch { self.error = "最高权限状态未能读取，请重新连接" }
        }
    }

    func enable(passphrase: inout String) -> Task<Void, Never> {
        let secret = passphrase
        passphrase = ""
        return Task { await request("owner_override_enable", fields: ["passphrase": secret]) }
    }

    func request(_ operation: String, fields: [String: Any] = [:]) async {
        guard !busy, let send, let sessionID else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let id = UUID().uuidString.lowercased()
            var input = fields; input["control_id"] = id
            let packet = try await send(AssistantCentralTextWire.encode(operation, fields: input), id)
            guard self.sessionID == sessionID else { return }
            receive(.output(packet))
        } catch { self.error = "最高权限操作未完成，请检查连接后重试" }
    }
}
