import Foundation
import WatchKit

@MainActor
final class WatchYimiHandler {
    let store: WatchYimiStore
    private var sequence: WatchSenderSequence
    var isReachable: () -> Bool = { false }
    var send: ((Data, @escaping (Data?) -> Void, @escaping (Error) -> Void) -> Void)?
    init(store: WatchYimiStore, defaults: UserDefaults?, clock: (() -> Date)?, haptics: (any WatchHapticPlaying)? = nil) {
        self.store = store
        sequence = WatchSenderSequence(key: "paios.watch.request-sequence.v1", defaults: defaults, clock: clock)
        store.sendAction = { [weak self] action, args in self?.request(action, args: args) }
        if let haptics {
            store.onReceipt = { status in
                switch status {
                case .accepted: haptics.play(.success)
                case .conflict, .rejected: haptics.play(.failure)
                case .duplicate, .unknown: break
                }
            }
        }
    }
    @discardableResult
    func request(_ action: WatchAssistantAction, args: WatchYimiActionArguments) -> String? {
        guard let scope = store.currentScope, isReachable(), let send else {
            store.report("paired_phone_unreachable", userMessage: "请靠近 iPhone 后再试。"); return nil
        }
        do {
            guard let value = sequence.next() else { throw WatchYimiError.invalidValue }
            let envelope = WatchLocalEnvelope(kind: .request, action: action,
                requestID: UUID().uuidString.lowercased(), sequence: value, version: 1, args: args)
            let bytes = try envelope.encodedStrict()
            try store.begin(envelope, scope: scope)
            send(bytes, { [weak self] data in
                guard let self, self.store.currentScope == scope else { return }
                guard let data else { self.store.fail(envelope.requestID, error: "iPhone 未返回操作回执"); return }
                self.store.receiveReceipt(data, scope: scope)
            }, { [weak self] error in
                guard let self, self.store.currentScope == scope else { return }
                self.store.fail(envelope.requestID, error: "操作发送失败：\(error)")
            })
            return envelope.requestID
        } catch { store.report("操作无法发送：\(error)"); return nil }
    }
}
