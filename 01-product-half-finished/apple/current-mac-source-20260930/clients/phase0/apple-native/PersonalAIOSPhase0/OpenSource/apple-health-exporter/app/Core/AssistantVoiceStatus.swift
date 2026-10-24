import Foundation

/// A display projection of the existing wake, publication, playback and server turn owners.
struct AssistantVoiceStatus: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case inactive, standby, wakeUnavailable, connecting, listening, thinking, handedOff, speaking, ending, ended, endedWithWork
    }
    let phase: Phase
    let title: String
    let compactTitle: String
    let symbol: String
    let detail: String
    let standby: String?
    let backgroundCount: Int?

    init(call: CentralCall = CentralCall(), media: AssistantMediaSnapshot = AssistantMediaSnapshot(), isDialing: Bool = false, isEnding: Bool = false) {
        backgroundCount = call.backgroundWorkCount
        standby = media.wakeArmed ? (media.wake == .localReady ? "唤醒词待命 · 仅本机" : media.wake == .unavailable ? "唤醒不可用" : nil) : nil
        let mic: String
        switch call.isActive ? media.callMicrophone : media.microphone {
        case .on: mic = "麦克风在用"
        case .off: mic = call.isActive ? "已静音" : "麦克风已关"
        case .opening: mic = "麦克风正在打开"
        case .closing: mic = "麦克风正在关闭"
        case .unknown: mic = "静音未确认 · 你仍可能被听到"
        }
        detail = !call.isActive && media.wake == .localReady
            ? (media.ambient == .on ? "仅本机检测唤醒词 · 随身开，随身收音上传" : "仅本机检测唤醒词 · 随身关")
            : (media.ambient == .on ? "随身开 · " : "随身关 · ") + mic
        if isEnding {
            phase = .ending; title = "正在结束通话"; compactTitle = "正在结束"; symbol = "phone.down"
        } else if isDialing || !call.voiceIsLive && (call.state == "opening" || call.state == "connecting") {
            phase = .connecting; title = "正在接通依米"; compactTitle = "正在接通"; symbol = "phone"
        } else if call.state == "closing" || (!call.isActive && (media.callMicrophone != .off || media.callAudioPlaying)) {
            phase = .ending; title = "正在结束通话"; compactTitle = "正在结束"; symbol = "phone.down"
        } else if call.isActive {
            if media.callAudioPlaying {
                phase = .speaking; title = "依米正在说话"; compactTitle = "正在说"; symbol = "speaker.wave.2"
            } else if call.foregroundReplyInFlight == true {
                phase = .thinking; title = "正在想"; compactTitle = "正在想"; symbol = "ellipsis"
            } else if let count = call.backgroundWorkCount, count > 0 {
                phase = .handedOff; title = "已交给依米处理"; compactTitle = "已交办"; symbol = "tray"
            } else if media.callMicrophone == .on {
                phase = .listening; title = "正在听你说"; compactTitle = "正在听"; symbol = "mic"
            } else {
                phase = .inactive; title = mic; compactTitle = mic; symbol = "mic.slash"
            }
        } else if call.id != nil {
            if let count = call.backgroundWorkCount, count > 0 {
                phase = .endedWithWork; title = "通话已结束 · 还有 \(count) 件在办"; compactTitle = "通话已结束"; symbol = "tray"
            } else {
                phase = .ended; title = "通话已结束"; compactTitle = "已结束"; symbol = "phone.down"
            }
        } else if media.wake == .localReady && media.wakeArmed {
            phase = .standby; title = "唤醒词待命 · 仅本机"; compactTitle = "本地待命"; symbol = "ear"
        } else if media.wake == .unavailable && media.wakeArmed {
            phase = .wakeUnavailable; title = "唤醒不可用"; compactTitle = "唤醒不可用"; symbol = "mic.slash"
        } else if media.wakeArmed && (media.wake == .loading || media.wake == .waitingForAudio) {
            phase = .inactive; title = media.wake == .loading ? "正在准备本地唤醒" : "本地唤醒等待麦克风"
            compactTitle = "唤醒未就绪"; symbol = "mic.slash"
        } else {
            phase = .inactive; title = "本地唤醒已关闭"; compactTitle = "唤醒已关"; symbol = "mic.slash"
        }
    }
}
