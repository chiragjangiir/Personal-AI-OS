package com.personalaios.glasses

import org.json.JSONObject
import java.util.UUID

data class GlassesLockState(val enabled: Boolean = false, val locked: Boolean = false,
    val reason: String? = null, val approvalUntil: Long? = null, val bannerUntil: Long = 0,
    val wearPollMs: Long = 2000, val connectionWaitUntil: Long? = null) {
    /** An enabled lock waiting on the owner's iPhone; only then does a click re-request approval. */
    val awaitingPhone: Boolean get() = locked && enabled && reason !in LOCAL_REASONS && reason != "not_worn"
    // Masked only until the gateway answers: the iPhone has nothing to confirm then.
    fun line(now: Long): String? = when {
        locked && reason in LOCAL_REASONS -> if (connectionWaitUntil?.let { now >= it } == true)
            "连接超时 · 正在重试" else "正在连接依米…"
        locked && !awaitingPhone -> null
        locked -> when {
            reason == "denied" -> "依米已锁定 · iPhone 未允许解锁"
            reason == "expired" || approvalUntil?.let { now >= it } == true -> "依米已锁定 · 请在 iPhone 上重新确认"
            else -> "依米已锁定 · 请在 iPhone 上确认"
        }
        now < bannerUntil -> "已解锁 · 戴着有效，摘下会重新上锁"
        else -> null
    }
    private companion object { val LOCAL_REASONS = setOf("offline", "connecting") }
}

/** Server lease projection and process-local cycle; reconnect invalidates local authorization. */
class UnlockLease(private val now: () -> Long = ::monotonicMillis,
    private val id: () -> String = { UUID.randomUUID().toString() }) {
    var lockCycle = 0L
        private set
    var state = GlassesLockState(enabled = true, locked = true, reason = "offline",
        connectionWaitUntil = now() + GATEWAY_READY_TIMEOUT_MS)
        private set
    private var connected = false
    private var worn = false
    private var screenOn = true
    private var current = false
    private var requested: String? = null
    private var automaticRequest = true

    fun restart() {
        connected = false; current = false; worn = false; screenOn = true; automaticRequest = true
        state = state.copy(connectionWaitUntil = now() + GATEWAY_READY_TIMEOUT_MS)
        relock()
    }
    fun connection(up: Boolean) {
        connected = up; current = false; automaticRequest = true
        relock()
    }
    fun ready(): JSONObject? {
        connected = true
        if (state.reason == "offline") state = state.copy(reason = "connecting")
        refreshDisabledVisibility()
        return request()
    }
    fun wear(value: Boolean): JSONObject? {
        if (worn != value) {
            worn = value; requested = null; automaticRequest = true
            if (!value) relock("not_worn")
        }
        refreshDisabledVisibility()
        return request()
    }
    fun screen(value: Boolean): JSONObject? {
        screenOn = value
        if (value) { automaticRequest = true; refreshDisabledVisibility(); return request() }
        relock()
        return JSONObject().put("operation", "glasses_lock").put("reason", "screen_off")
    }
    fun lock(): JSONObject {
        automaticRequest = false; relock()
        return JSONObject().put("operation", "glasses_lock").put("reason", "user")
    }
    fun accept(message: JSONObject, now: Long): JSONObject? {
        val enabled = message.get("lock_enabled") as Boolean
        val locked = message.get("locked") as Boolean
        val cycle = if (message.has("lock_cycle")) message.wireLong("lock_cycle") else null
        val poll = message.wireLong("wear_poll_ms", 1)
        val until = if (message.has("approval_expires_in_ms")) now + message.wireLong("approval_expires_in_ms") else null
        val reason = message.optString("reason").takeIf { it.isNotEmpty() }
        require(reason == null || reason in setOf("awaiting_phone", "not_worn", "expired", "denied", "disabled"))
        if (locked && !state.locked) relock(reason)
        current = true
        // Disabled locks have no lease. Enabled leases must echo this local cycle before content can be shown.
        val hidden = !connected || !screenOn || !worn || locked || enabled && (cycle != lockCycle || requested == null)
        val unlocked = !hidden && state.locked && enabled
        state = GlassesLockState(enabled, hidden, reason, until, if (unlocked) now + 3000 else state.bannerUntil, poll)
        if (!enabled) requested = null
        // A pending/denied/expired server approval must not be recreated by each snapshot or wear poll.
        if (reason in setOf("denied", "expired") || until != null) return null
        return request()
    }
    fun wearMessage(value: Boolean): JSONObject = JSONObject().put("operation", "wear_state")
        .put("control_id", id()).put("worn", value).put("lock_cycle", lockCycle)
    private fun relock(reason: String? = null) {
        lockCycle++; requested = null
        // Until the gateway's lock state is current, the mask means "not connected yet", never an iPhone approval.
        val local = if (!connected) "offline" else if (!current) "connecting" else reason
        // This is a display deadline for the entire wait, not a new budget for each transport retry.
        val deadline = if (local == "offline" || local == "connecting") state.connectionWaitUntil ?: (now() + GATEWAY_READY_TIMEOUT_MS) else null
        state = state.copy(locked = true, reason = local, approvalUntil = null, bannerUntil = 0, connectionWaitUntil = deadline)
    }
    private fun refreshDisabledVisibility() {
        if (current && !state.enabled) state = state.copy(locked = !connected || !worn || !screenOn)
    }
    fun retry(): JSONObject? {
        requested = null; automaticRequest = true
        if (connected && current) state = state.copy(reason = null, approvalUntil = null)
        return request()
    }
    fun receipt(message: JSONObject) {
        if (message.optString("control_id") != requested || message.get("ok") == true) return
        state = state.copy(locked = true, reason = "denied", approvalUntil = null, bannerUntil = 0)
    }
    private fun request(): JSONObject? {
        if (!connected || !current || !worn || !screenOn || !state.enabled || !state.locked || requested != null || !automaticRequest ||
            state.reason in setOf("denied", "expired")) return null
        requested = id()
        return JSONObject().put("operation", "glasses_unlock_request").put("control_id", requested).put("lock_cycle", lockCycle)
    }
}

/** Strict integers at the external JSON boundary; org.json getters otherwise coerce strings and fractions. */
internal fun JSONObject.wireLong(key: String, minimum: Long = 0, maximum: Long = 9007199254740991): Long {
    val value = get(key)
    require(value is Int || value is Long) { "$key must be an integer" }
    return (value as Number).toLong().also { require(it in minimum..maximum) { "$key out of range" } }
}
