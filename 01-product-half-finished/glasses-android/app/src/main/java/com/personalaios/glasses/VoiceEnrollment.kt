package com.personalaios.glasses

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class VoiceEnrollmentPhase { Idle, AwaitingPhone, Ready, Opening, Recording, Measuring, Result, Enrolling, Enrolled, Expired, Failed }
data class VoiceEnrollmentState(val phase: VoiceEnrollmentPhase = VoiceEnrollmentPhase.Idle,
    val sentences: List<String> = emptyList(), val index: Int = 0, val good: Int = 0,
    val until: Long? = null, val message: String = "请在 iPhone 上确认", val canFinish: Boolean = false,
    val ownerEnrolled: Boolean = false) {
    val sentence get() = sentences.getOrNull(index)
}

/** Coordinates existing server-owned audio windows; no recorder, PCM, embedding or biometric score on the glasses. */
class VoiceEnrollment(private val minimumGood: Int = 5, private val id: () -> String = { UUID.randomUUID().toString() }) {
    var state = VoiceEnrollmentState()
        private set
    private val samples = sortedMapOf<Int, String>()
    private var requestId: String? = null
    private var operationId: String? = null
    private var enrollId: String? = null
    private var readId: String? = null
    private var granted = false
    private var quality: String? = null

    fun request(worn: Boolean, locked: Boolean): List<JSONObject> {
        if (!worn || locked) return emptyList()
        val cancel = cancel()
        requestId = id(); state = state.copy(phase = VoiceEnrollmentPhase.AwaitingPhone, message = "请在 iPhone 上确认")
        return cancel + JSONObject().put("operation", "voiceprint_enrol_request").put("control_id", requestId)
    }
    fun grant(message: JSONObject, now: Long): List<JSONObject> {
        if (state.phase == VoiceEnrollmentPhase.Idle || state.phase == VoiceEnrollmentPhase.Enrolled) return emptyList()
        val value = message.optJSONObject("enrolment")
        if (value == null || value.get("granted") == false) {
            if (granted && state.phase != VoiceEnrollmentPhase.Enrolling) return expire(now, force = true)
            if (state.phase == VoiceEnrollmentPhase.AwaitingPhone) {
                if (message.has("approval_expires_in_ms")) state = state.copy(until = now + message.wireLong("approval_expires_in_ms"))
                if (message.optString("reason") == "denied") state = state.copy(phase = VoiceEnrollmentPhase.Failed, until = null, message = "iPhone 未允许录入，请重新申请")
            }
            return emptyList()
        }
        require(value.get("granted") is Boolean)
        val remaining = value.wireLong("expires_in_ms")
        val sentences = value.getJSONArray("sentences").let { a -> (0 until a.length()).map { a.get(it) as String } }
        require(sentences.isNotEmpty() && sentences.size <= 8 && sentences.all { it.isNotBlank() && it.length <= 200 })
        if (remaining == 0L) return expire(now, force = true)
        if (granted) {
            require(sentences == state.sentences) { "Enrolment sentences changed during a grant" }
            state = state.copy(until = now + remaining); return emptyList()
        }
        if (state.phase != VoiceEnrollmentPhase.AwaitingPhone) return emptyList()
        granted = true; samples.clear(); readId = id()
        state = state.copy(phase = VoiceEnrollmentPhase.Ready, sentences = sentences, until = now + remaining, message = "单击开始读 · 读完再单击")
        return listOf(JSONObject().put("operation", "voiceprint_read").put("control_id", readId))
    }
    fun tap(now: Long): List<JSONObject> {
        if (!live(now)) return expire(now)
        if (state.phase == VoiceEnrollmentPhase.Recording) {
            state = state.copy(phase = VoiceEnrollmentPhase.Measuring, message = "正在核对这句声音")
            return listOf(window("voiceprint_commit"))
        }
        if (state.phase !in setOf(VoiceEnrollmentPhase.Ready, VoiceEnrollmentPhase.Result)) return emptyList()
        if (quality == "ok") {
            if (samples.size == state.sentences.size) return finish(now)
            state = state.copy(index = state.sentences.indices.first { !samples.containsKey(it) })
        }
        quality = null; operationId = id()
        state = state.copy(phase = VoiceEnrollmentPhase.Opening, message = "正在打开录音")
        return listOf(window("voiceprint_open"))
    }
    fun finish(now: Long): List<JSONObject> {
        if (!live(now)) return expire(now)
        if (samples.size < minimumGood || state.phase !in setOf(VoiceEnrollmentPhase.Ready, VoiceEnrollmentPhase.Result)) return emptyList()
        enrollId = id(); state = state.copy(phase = VoiceEnrollmentPhase.Enrolling, canFinish = false, message = "正在记住你的声音")
        return listOf(JSONObject().put("operation", "voiceprint_enroll").put("control_id", enrollId).put("sample_ids", JSONArray(samples.values.toList())))
    }
    fun accept(message: JSONObject, now: Long) {
        when (message.getString("operation")) {
            "voiceprint_sample" -> {
                if (!live(now) || message.getString("operation_id") != operationId) return
                when (message.getString("status")) {
                    "recording" -> if (state.phase == VoiceEnrollmentPhase.Opening) state = state.copy(phase = VoiceEnrollmentPhase.Recording, message = "正在听 · 读完再单击")
                    "measured" -> if (state.phase == VoiceEnrollmentPhase.Measuring) {
                        val q = message.getString("quality"); require(q in setOf("ok", "too_short", "no_speech"))
                        if (q == "ok") samples[state.index] = message.getString("sample_id")
                        quality = q; operationId = null
                        state = state.copy(phase = VoiceEnrollmentPhase.Result, good = samples.size, canFinish = samples.size >= minimumGood,
                            message = when (q) { "ok" -> "好 · 这句好了"; "too_short" -> "太短 · 请完整读一遍"; else -> "没听到 · 请再读一次" })
                    }
                    "cancelled", "failed" -> { operationId = null; quality = null
                        state = state.copy(phase = VoiceEnrollmentPhase.Result, message = "这句没录好，请单击重读") }
                }
            }
            "voiceprint_owner" -> {
                val control = message.getString("control_id")
                if (control == readId) {
                    state = state.copy(ownerEnrolled = message.getJSONObject("owner").getBoolean("enrolled")); readId = null
                }
                if (control != enrollId || state.phase != VoiceEnrollmentPhase.Enrolling) return
                val result = message.getJSONObject("enrollment")
                when (result.getString("status")) {
                    "enrolled" -> {
                        granted = false; enrollId = null; samples.clear()
                        state = state.copy(phase = VoiceEnrollmentPhase.Enrolled, until = null, ownerEnrolled = true,
                            message = "已记住你在眼镜上的声音", canFinish = false)
                    }
                    "inconsistent" -> {
                        result.getJSONArray("samples").let { a -> for (i in 0 until a.length()) {
                            val s = a.getJSONObject(i)
                            if (!s.getBoolean("ok")) samples.entries.removeAll { it.value == s.getString("sample_id") }
                        } }
                        enrollId = null; quality = null
                        state = state.copy(phase = VoiceEnrollmentPhase.Ready, index = state.sentences.indices.firstOrNull { !samples.containsKey(it) } ?: 0,
                            good = samples.size, canFinish = samples.size >= minimumGood, message = "有几句不像同一个声音，请重读")
                    }
                }
            }
            "payment_receipt" -> if (message.optString("control_id") == requestId && message.get("ok") == false) {
                state = state.copy(phase = VoiceEnrollmentPhase.Failed, until = null, message = "录入未获授权，请在 iPhone 上重新确认")
            }
            "rejected" -> {
                val op = message.getString("request_operation")
                if (op in setOf("voiceprint_open", "voiceprint_commit", "voiceprint_enroll", "voiceprint_read")) {
                    operationId = null; enrollId = null; quality = null
                    state = state.copy(phase = VoiceEnrollmentPhase.Failed, message = "录入未完成，请重新申请授权", canFinish = false)
                }
            }
        }
    }
    fun expire(now: Long, force: Boolean = false): List<JSONObject> {
        if (!force && state.until?.let { now >= it } != true) return emptyList()
        val commands = cancel()
        state = state.copy(phase = VoiceEnrollmentPhase.Expired, message = "授权已过期，请在 iPhone 上重新确认")
        return commands
    }
    fun cancel(): List<JSONObject> {
        val commands = operationId?.let { listOf(window("voiceprint_cancel")) }.orEmpty()
        samples.clear(); operationId = null; requestId = null; enrollId = null; readId = null; granted = false; quality = null
        state = VoiceEnrollmentState(ownerEnrolled = state.ownerEnrolled)
        return commands
    }
    private fun live(now: Long) = granted && state.until?.let { now < it } == true
    private fun window(op: String) = JSONObject().put("operation", op).put("operation_id", operationId)
}
