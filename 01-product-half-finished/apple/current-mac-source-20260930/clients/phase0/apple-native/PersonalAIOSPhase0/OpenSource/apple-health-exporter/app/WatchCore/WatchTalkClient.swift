import Combine
import Foundation
#if os(watchOS)
import WatchKit
#endif

@MainActor
protocol WatchUtteranceRecording: AnyObject {
    var onFinish: ((Result<(Data, Int), Error>) -> Void)? { get set }
    func requestPermission() async -> Bool
    func start() throws
    func finish(wristDown: Bool)
    func cancel()
}

@MainActor
final class WatchTalkClient: ObservableObject {
    @Published private(set) var state = WatchTalkState()
    private let credential: () -> WatchCredential?
    private let refreshCredential: () -> Void
    private let recorder: any WatchUtteranceRecording
    private let session: URLSession
    private var task: Task<Void, Never>?
    private var foreground = true
    private var generation = UUID()
    private var scope: WatchBindingScope?
    private var polling = false

    init(credential: @escaping () -> WatchCredential?, refreshCredential: @escaping () -> Void = {},
         recorder: any WatchUtteranceRecording, session: URLSession = .shared) {
        self.credential = credential
        self.refreshCredential = refreshCredential
        self.recorder = recorder
        self.session = session
        self.recorder.onFinish = { [weak self] result in self?.recorded(result) }
    }

    func startByUser() {
        guard foreground, state.phase != .listening, state.phase != .thinking else { return }
        guard let value = credential() else { state.recordingFailed(WatchTalkFailure.credential_missing.message, screen: .registration); refreshCredential(); return }
        task?.cancel()
        generation = UUID()
        let run = generation
        scope = value.scope
        guard state.startByUser() else { return }
        task = Task { [weak self] in
            guard let self else { return }
            let permitted = await recorder.requestPermission()
            guard generation == run, foreground, state.phase == .listening, !Task.isCancelled else { return }
            guard credential()?.scope == scope else {
                state.recordingFailed(WatchTalkFailure.credential_missing.message, screen: .registration)
                refreshCredential(); return
            }
            guard permitted else { state.recordingFailed("请在设置中允许依米使用麦克风。"); return }
            do { try recorder.start() }
            catch { state.recordingFailed("麦克风没能打开，请再点一次说话。") }
        }
    }
    func finishByUser() { finish(wristDown: false) }
    private func finish(wristDown: Bool) {
        guard state.phase == .listening else { return }
        // Also closes the permission-await race before any recorder exists.
        generation = UUID()
        task?.cancel(); task = nil
        recorder.finish(wristDown: wristDown)
        if state.phase == .listening { state.reset() }
    }
    func setForeground(_ active: Bool) {
        foreground = active
        if !active {
            finish(wristDown: true)
            if polling {
                generation = UUID()
                task?.cancel(); task = nil
                polling = false
                state.pausePoll()
            }
        } else { pollIfNeeded() }
    }
    func retryByUser() {
        guard foreground, let request = state.retryByUser() else { return }
        perform(request)
    }
    func cancel() { reset() }
    func reset() {
        generation = UUID()
        task?.cancel(); task = nil
        recorder.cancel()
        polling = false
        scope = nil
        state.reset()
    }
    func bindingScopeChanged(_ value: WatchBindingScope?) {
        if value != scope { reset() }
    }
    private func recorded(_ result: Result<(Data, Int), Error>) {
        guard state.phase == .listening, let scope else { return }
        switch result {
        case .success(let (bytes, duration)):
            let audio = WatchUtterance(id: UUID(), bytes: bytes, durationMilliseconds: duration, scope: scope)
            if let request = state.recorded(audio) { perform(request) }
        case .failure: state.recordingFailed("录音没能保存，请再点一次说话。")
        }
    }
    private func pollIfNeeded() {
        guard foreground, let request = state.resumePoll() else { return }
        perform(request)
    }
    private func perform(_ request: WatchTalkState.Request) {
        guard let scope, let value = credential(), value.scope == scope else {
            state.receivedFailure(.credential_missing, polling: false)
            refreshCredential()
            return
        }
        generation = UUID()
        let run = generation
        if case .poll = request { polling = true } else { polling = false }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let wire = try WatchTalkHTTP.request(request, credential: value)
                let (data, response) = try await session.data(for: wire)
                guard generation == run, self.scope == scope, !Task.isCancelled else { return }
                guard let response = response as? HTTPURLResponse else { throw WatchTalkHTTP.WireError.invalidResponse }
                let reply = try WatchTalkHTTP.decode(data, statusCode: response.statusCode, action: request)
                let wasPolling = polling
                polling = false
                switch reply {
                case .heard(let text): state.receivedHeard(text); pollIfNeeded()
                case .working: state.receivedWorking(); state.prolongedThinking(); pollIfNeeded()
                case .replied(let text):
                    state.receivedReply(text)
#if os(watchOS)
                    WKInterfaceDevice.current().play(.notification)
#endif
                case .failed(let reason):
                    state.receivedFailure(reason, polling: wasPolling)
                    if reason.needsCredential { refreshCredential() }
                }
            } catch {
                guard generation == run, self.scope == scope, !Task.isCancelled else { return }
                polling = false
                state.transportFailed(screen: error is URLError ? .network : .server)
            }
        }
    }
}
