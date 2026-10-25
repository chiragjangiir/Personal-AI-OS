package com.personalaios.glasses

import org.json.JSONObject
import java.util.UUID

enum class VoiceSupplementPhase { Idle, AwaitingPhone, Starting, Talking, Paused, Checked, Saving, Saved, Failed }
data class VoiceSupplementState(val phase: VoiceSupplementPhase = VoiceSupplementPhase.Idle,
    val cleanMs: Int = 0, val targetMs: Int = 30_000, val message: String = "单击申请 · iPhone 上用 Face ID 允许")

/** The optional ordinary voice supplement on these glasses. The paired iPhone approves it; the server's conversation
 *  enrollment owns the session, the call, measurement and storage. The glasses only send the existing controls. */
class VoiceSupplement(private val id: () -> String = { UUID.randomUUID().toString() }) {
    var state = VoiceSupplementState()
        private set
    private var controls = mutableSetOf<String>()
    private var session: String? = null
    private var callId: String? = null
    private var callRequested = false
    private val running get() = state.phase in setOf(VoiceSupplementPhase.Starting, VoiceSupplementPhase.Talking,
        VoiceSupplementPhase.Paused, VoiceSupplementPhase.Checked, VoiceSupplementPhase.Saving)

    fun request(worn: Boolean, locked: Boolean): List<JSONObject> {
        if (!worn || locked) { state = VoiceSupplementState(VoiceSupplementPhase.Failed, message = "请先戴好并解锁眼镜"); return emptyList() }
        val discard = cancel()
        state = VoiceSupplementState(VoiceSupplementPhase.AwaitingPhone, message = "请在 iPhone 上用 Face ID 允许")
        return discard + JSONObject().put("operation", "voiceprint_enrol_request").put("control_id", control()).put("purpose", "conversation")
    }

    /** payment_lock_state carries the phone's approval for this wear session. */
    fun grant(message: JSONObject): List<JSONObject> {
        val granted = message.optJSONObject("voice_enrollment")?.getBoolean("granted") == true
        if (state.phase == VoiceSupplementPhase.AwaitingPhone && granted) {
            callId = id()
            state = state.copy(phase = VoiceSupplementPhase.Starting, message = "正在接通依米")
            return listOf(command("start"))
        }
        // Saving consumes the grant before its enrollment receipt arrives; that receipt owns the outcome.
        if (!granted && running && state.phase != VoiceSupplementPhase.Saving) fail("授权已结束，请重新申请")
        return emptyList()
    }

    /** voice_enrollment_state from the server-owned draft. */
    fun accept(message: JSONObject) {
        if (!running) return
        val value = message.getJSONObject("enrollment")
        if (!value.isNull("call_id") && value.getString("call_id") != callId) return
        if (!value.isNull("session_id")) session = value.getString("session_id")
        val issue = if (value.isNull("issue")) null else value.getString("issue")
        val phase = when (value.getString("phase")) {
            "collecting" -> VoiceSupplementPhase.Talking
            "paused" -> VoiceSupplementPhase.Paused
            "checked" -> VoiceSupplementPhase.Checked
            "committed" -> VoiceSupplementPhase.Saved
            else -> VoiceSupplementPhase.Idle
        }
        state = state.copy(phase = phase, cleanMs = value.getInt("clean_speech_ms"), targetMs = value.getInt("target_speech_ms"),
            message = issue?.let(::issueText) ?: when (phase) {
                VoiceSupplementPhase.Talking -> "和依米聊聊最近的生活 · 单击结束并检查"
                VoiceSupplementPhase.Paused -> if (value.getInt("clean_speech_ms") >= value.getInt("target_speech_ms")) "已暂停 · 单击检查这段录音" else "已暂停 · 单击继续聊"
                VoiceSupplementPhase.Checked -> "这段可以使用 · 单击保存"
                VoiceSupplementPhase.Saved -> "已保存，依米更熟悉你在眼镜上的声音"
                else -> "这段录音已放弃"
            })
        if (phase == VoiceSupplementPhase.Saved || phase == VoiceSupplementPhase.Idle) { session = null; callId = null; callRequested = false }
    }

    /** The enrollment call to open once the server draft is collecting: (call_id, enrollment_session_id). */
    fun callToOpen(): Pair<String, String>? {
        if (state.phase != VoiceSupplementPhase.Talking || callRequested) return null
        callRequested = true
        return checkNotNull(callId) to checkNotNull(session)
    }

    fun tap(): List<JSONObject> = when (state.phase) {
        VoiceSupplementPhase.Talking -> listOf(command("check"))
        VoiceSupplementPhase.Paused -> if (state.cleanMs >= state.targetMs) listOf(command("check")) else {
            callId = id(); callRequested = false
            state = state.copy(phase = VoiceSupplementPhase.Starting, message = "正在接通依米")
            listOf(command("resume"))
        }
        VoiceSupplementPhase.Checked -> { state = state.copy(phase = VoiceSupplementPhase.Saving, message = "正在保存"); listOf(command("commit")) }
        else -> emptyList()
    }

    /** Leaves the screen: discard also cancels approval before a draft exists. */
    fun cancel(): List<JSONObject> {
        val discard = if (state.phase == VoiceSupplementPhase.AwaitingPhone || running || session != null && state.phase != VoiceSupplementPhase.Saved)
            listOf(command("discard")) else emptyList()
        session = null; callId = null; callRequested = false; controls.clear()
        state = VoiceSupplementState()
        return discard
    }

    /** A rejected request or control of ours. */
    fun rejected(message: JSONObject): Boolean {
        if (message.optString("control_id") !in controls) return false
        fail("这次没成功，单击重新申请")
        return true
    }

    fun receipt(message: JSONObject) {
        if (message.optString("control_id") in controls && message.get("ok") == false) fail("iPhone 未允许，单击重新申请")
    }

    private fun fail(text: String) {
        session = null; callId = null; callRequested = false
        state = VoiceSupplementState(VoiceSupplementPhase.Failed, message = text)
    }
    private fun control() = id().also { controls += it }
    private fun command(action: String) = JSONObject().put("operation", "voice_enrollment_control").put("control_id", control())
        .put("action", action).apply { session?.let { put("enrollment_session_id", it) }; callId?.let { put("call_id", it) } }
    private fun issueText(issue: String) = when (issue) {
        "multiple_speakers" -> "这段有多人声音"
        "VOICE_ENROLLMENT_OTHER_SPEAKER" -> "这段声音还没确认是你，请继续说"
        "no_speech", "too_short", "too_quiet" -> "说话声音再大一点"
        "low_snr" -> "背景声有点大"
        "clipped" -> "声音有些失真"
        "VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED", "VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES" -> "清晰语音还不够，继续聊一会儿"
        "VOICEPRINT_ENROLLMENT_INCONSISTENT" -> "声音片段不够一致，请重新申请"
        else -> "这段声音暂时不能使用"
    }
}
