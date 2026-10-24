package com.personalaios.glasses

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** Owns the glasses' call presentation and capture intent. The gateway owns the recovery budget. */
internal class CallLifecycle(private val scope: CoroutineScope, private val hud: MutableStateFlow<HudState>,
    private val capture: (Boolean) -> Unit, private val onEnd: () -> Unit,
    private val now: () -> Long = System::currentTimeMillis, private val wait: suspend (Long) -> Unit = { delay(it) },
    private val diagnose: (String) -> Unit = {}, private val onFailure: (String) -> Unit = {}) {
    var windowS: Long? = null
    private var closing: String? = null
    private var ended: String? = null
    private var announcedDeadline: Long? = null
    private var lossDeadline: Long? = null
    private var lossQualified = false
    private var expiry: Job? = null
    private var pendingOpen: String? = null
    private var pendingEnrollment: String? = null
    private var openSent = false
    private var opening: Job? = null
    private var openingDeadline: Long? = null
    private class Close(val id: String, val reason: String) {
        var sent = false
        var sending = false
        val acknowledged = CompletableDeferred<Unit>()
    }
    private var pendingClose: Close? = null
    val hasPendingClose get() = pendingClose != null
    val hasPendingOpen get() = pendingOpen != null

    /** A new room reasserts the same owner intent; transport readiness never clears in-call mute. */
    fun ready() {
        openSent = false
        hud.value = hud.value.copy(listening = true)
    }

    /** Owner intent can change while the transport is recovering. */
    fun toggleMute() { if (hud.value.callId != null) hud.value = hud.value.copy(micMuted = !hud.value.micMuted) }

    fun openToSend(): JSONObject? {
        val id = pendingOpen ?: return null
        if (openSent || pendingClose != null) return null
        openSent = true
        return JSONObject().put("operation", "call_open").put("call_id", id).apply { pendingEnrollment?.let { put("enrollment_session_id", it) } }
    }

    suspend fun awaitClose() { pendingClose?.acknowledged?.await() }

    /** [enrollment] opens the server's conversation-enrollment call for that draft instead of an ordinary call. */
    suspend fun open(id: String, enrollment: String? = null) {
        awaitClose()
        clearRecovery(); announcedDeadline = null; closing = null
        pendingOpen = id; pendingEnrollment = enrollment; openSent = false
        hud.value = hud.value.copy(callId = id, callEnded = false, callClosing = false, busy = true, status = "请稍候",
            conversation = null, conversationPending = null, conversationError = null)
        stopOpening()
        val deadline = now() + GATEWAY_READY_TIMEOUT_MS
        openingDeadline = deadline
        opening = scope.launch {
            while (now() < deadline) wait(deadline - now())
            if (hud.value.callId == id) failOpening()
        }
    }

    /** A published open is not acceptance. Bound first-call waiting independently of the live-call rejoin lease. */
    fun failOpening() {
        if (openingDeadline == null) return
        hangup("error")
        if (hud.value.callId != null) end()
        failed("通话连接超时，请重试")
    }

    fun hangup(reason: String = "button"): String? {
        val id = hud.value.callId ?: return null
        val disconnected = lossDeadline != null
        if (pendingClose == null) pendingClose = Close(id, reason)
        pendingOpen = null; stopOpening()
        closing = id; capture(false)
        hud.value = hud.value.copy(callClosing = true, busy = true, status = "请稍候")
        if (disconnected) finishLocal(id)
        return id
    }

    fun retryClose() { pendingClose?.apply { sent = false; sending = false } }

    fun closePublished(id: String) { pendingClose?.takeIf { it.id == id }?.sending = false }

    fun closeToSend(): JSONObject? {
        val close = pendingClose ?: return null
        if (close.sent) return null
        close.sent = true; close.sending = true
        return JSONObject().put("operation", "call_close").put("call_id", close.id).put("reason", close.reason)
    }

    fun receive(message: JSONObject, offered: Boolean = false): Boolean {
        val id = message.getString("call_id"); val phase = message.getString("state")
        when (phase) {
            "opening", "connecting", "live" -> {
                if (pendingClose != null) {
                    if (pendingClose?.id == id) {
                        if (pendingClose?.sending == false) pendingClose?.sent = false
                        acceptDeadline(message)
                        if (lossDeadline?.let { now() >= it } == true) expire(id)
                        else if (lossDeadline != null) armExpiry(id)
                    }
                    return false
                }
                if (closing == id || ended == id || hud.value.callId != null && hud.value.callId != id) return false
                if (openingDeadline?.let { now() >= it } == true) { failOpening(); return false }
                pendingOpen = null
                if (phase == "live") stopOpening()
                acceptDeadline(message)
                if (lossDeadline?.let { now() >= it } == true) { end(); return false }
                if (phase == "live" && lossDeadline != null) { clearRecovery(); announcedDeadline = null }
                val conversation = CallConversation.fromWire(message)
                val pending = hud.value.conversationPending?.takeUnless { conversation == null || conversation.mode == it.mode }
                hud.value = hud.value.copy(callId = id, callEnded = false, callClosing = false, status = if (phase == "live") "通话中" else "请稍候", busy = phase != "live",
                    conversation = conversation, conversationPending = pending,
                    conversationError = if (conversation != hud.value.conversation) null else hud.value.conversationError)
                capture(true)
                if (lossDeadline != null) armExpiry(id)
            }
            "closing" -> if (hud.value.callId == id) {
                closing = id; capture(false); hud.value = hud.value.copy(callClosing = true, busy = true, status = "请稍候")
            } else if (pendingClose?.id != id) return false
            "closed", "failed" -> {
                if (pendingClose != null && pendingClose?.id != id) return false
                val startupFailure = hud.value.callId == id && openingDeadline != null
                if (pendingClose?.id == id && hud.value.callId == null) clearRecovery()
                else if (hud.value.callId == id || offered) end(id) else return false
                acknowledgeClose()
                if (startupFailure) failed("通话连接失败，请重试")
            }
            else -> return false
        }
        return true
    }

    fun setConversationMode(mode: String): JSONObject? {
        val state = hud.value
        val conversation = state.conversation ?: return null
        if (state.callId == null || state.callClosing || state.conversationPending != null || conversation.mode == mode) return null
        val pending = CallModeRequest(UUID.randomUUID().toString(), mode)
        hud.value = state.copy(conversationPending = pending, conversationError = null)
        return JSONObject().put("operation", "call_set_conversation_mode").put("call_id", state.callId)
            .put("control_id", pending.controlId).put("conversation_mode", mode)
    }

    fun retryThinking(): JSONObject? {
        val state = hud.value
        val conversation = state.conversation ?: return null
        if (state.callId == null || state.callClosing || "retry" !in conversation.actions) return null
        return JSONObject().put("operation", "call_retry").put("call_id", state.callId)
            .put("control_id", UUID.randomUUID().toString()).put("processed_event_id", checkNotNull(conversation.processedEventId))
    }

    fun conversationReceipt(message: JSONObject) {
        val pending = hud.value.conversationPending ?: return
        if (message.getString("requested_operation") != "call_set_conversation_mode" ||
            message.getString("control_id") != pending.controlId || message.getString("call_id") != hud.value.callId) return
        val confirmed = message.getJSONObject("receipt").getString("conversation_mode")
        require(confirmed in setOf("chat", "thinking"))
        hud.value = hud.value.copy(conversation = CallConversation(confirmed),
            conversationPending = null, conversationError = null)
    }

    fun conversationRejected(message: JSONObject): Boolean {
        if (message.getString("request_operation") != "call_set_conversation_mode" ||
            message.optString("control_id") != hud.value.conversationPending?.controlId) return false
        conversationFailed(message.getString("control_id"), message.getString("error_code"))
        return true
    }

    fun conversationFailed(controlId: String?, reason: String) {
        val pending = hud.value.conversationPending ?: return
        if (pending.controlId == controlId) hud.value = hud.value.copy(conversationPending = null, conversationError = reason)
    }

    fun linkLost() {
        retryClose()
        val id = hud.value.callId ?: pendingClose?.id ?: return
        if (closing == id && pendingClose == null) { end(id); return }
        val window = windowS ?: run { end(id); return }
        if (lossDeadline == null) {
            lossDeadline = announcedDeadline ?: (now() + window * 1000L)
            lossQualified = announcedDeadline != null
        }
        if (now() >= lossDeadline!!) { expire(id); return }
        if (pendingClose?.id == id) {
            if (hud.value.callId == id) finishLocal(id)
        } else hud.value = hud.value.copy(busy = true, status = "请稍候")
        armExpiry(id)
    }

    private fun acceptDeadline(message: JSONObject) {
        if (!message.has("rejoin_deadline")) return
        val deadline = Instant.parse(message.getString("rejoin_deadline")).toEpochMilli()
        val accepted = lossDeadline
        if (accepted == null) { announcedDeadline = deadline; return }
        if (lossQualified && deadline > accepted) {
            diagnose("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED")
            return
        }
        lossDeadline = deadline; lossQualified = true
    }

    private fun armExpiry(id: String) {
        expiry?.cancel()
        val deadline = checkNotNull(lossDeadline)
        expiry = scope.launch {
            while (now() < deadline) wait(deadline - now())
            if (lossDeadline == deadline && (hud.value.callId == id || pendingClose?.id == id)) expire(id)
        }
    }

    fun end(id: String? = hud.value.callId) {
        clearRecovery(); finishLocal(id)
    }

    private fun finishLocal(id: String?) {
        pendingOpen = null; stopOpening()
        ended = id ?: ended; closing = null; announcedDeadline = null
        capture(false)
        hud.value = hud.value.copy(callId = null, callEnded = hud.value.callEnded || id != null, callClosing = false, callPcmPublished = false, callPlayback = false, busy = false, micMuted = false, status = idleStatus(hud.value),
            conversation = null, conversationPending = null, conversationError = null)
        onEnd()
    }

    private fun expire(id: String) {
        // A peer can rejoin before the deadline while its live replay arrives after it.
        // Only the matching gateway terminal state acknowledges the owner's close.
        if (pendingClose?.id == id) {
            expiry?.cancel(); expiry = null
            if (hud.value.callId == id) finishLocal(id)
        } else end(id)
    }

    private fun acknowledgeClose() {
        val close = pendingClose; pendingClose = null; close?.acknowledged?.complete(Unit)
    }

    private fun clearRecovery() { expiry?.cancel(); expiry = null; lossDeadline = null; lossQualified = false }
    private fun stopOpening() { opening?.cancel(); opening = null; openingDeadline = null }
    private fun failed(message: String) { hud.value = hud.value.copy(status = message); onFailure(message) }
}
