package com.personalaios.glasses

/** Presentation only: capture, playback and server work retain their existing owners. */
fun voiceStatus(state: HudState): String = when {
    state.status == "已停止" || state.status == "正在断开连接" -> state.status
    state.callClosing -> "正在结束通话"
    state.callId != null && state.callPlayback -> "依米正在说话"
    state.callId != null && state.callId in state.foregroundCalls -> "正在想"
    state.callId != null && (state.backgroundWorkCount ?: 0) > 0 -> "已交给依米处理"
    state.callId != null && state.micMuted && state.microphoneApplied != Microphone.Muted -> "正在静音"
    state.callId != null && !state.micMuted && state.microphoneApplied == Microphone.Muted -> "正在取消静音"
    state.callId != null && state.micMuted && state.microphoneApplied == Microphone.Muted -> "麦克风已静音"
    state.callId != null && (state.microphoneApplied == Microphone.On || state.callPcmPublished) -> "正在听你说"
    state.callId != null -> "正在连接通话"
    state.callPcmPublished || state.callPlayback -> "正在结束通话"
    state.callEnded && state.listening && !state.ambient && !state.recording && state.microphoneApplied != Microphone.Off -> "正在结束通话"
    state.callEnded && (state.backgroundWorkCount ?: 0) > 0 -> "通话已结束 · 还有 ${state.backgroundWorkCount} 件在办"
    state.callEnded -> "通话已结束"
    (state.backgroundWorkCount ?: 0) > 0 -> "后台事项 ${state.backgroundWorkCount} 件在办"
    state.localWakeEnabled && wakeTaps(state) && state.localWake == LocalWakeState.LocalReady -> "唤醒词待命 · 仅本机"
    state.localWakeEnabled && wakeTaps(state) && state.localWake in setOf(LocalWakeState.WaitingForAudio, LocalWakeState.Unavailable) -> "唤醒不可用"
    else -> localWakeStatus(state)
}
