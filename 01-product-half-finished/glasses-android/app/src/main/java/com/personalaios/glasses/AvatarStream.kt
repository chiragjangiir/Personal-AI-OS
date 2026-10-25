package com.personalaios.glasses

import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject

/** Avatar intent only. CallLifecycle remains the authority for the call itself. Main-thread confined. */
internal class AvatarStream(private val now: () -> Long = ServerClock.shared::nowMillis) {
    // Credentials must never appear in a generated data-class toString or HUD snapshot.
    class Media(val token: String, val user: String, val expires: Long)
    enum class Phase { Off, Waiting, Joining, Playing, Failed }
    val media = MutableStateFlow<Media?>(null)
    val phase = MutableStateFlow(Phase.Off)
    private var call: String? = null
    private var revision = 0L
    private var wanted = false
    private var pendingOff: JSONObject? = null

    fun request(id: String, enabled: Boolean): JSONObject? {
        if (call == id && enabled && wanted) return null
        if (call != id) { end(); call = id }
        if (!enabled && pendingOff != null) return pendingOff
        revision++
        pendingOff = null
        wanted = enabled
        media.value = null
        phase.value = if (enabled) Phase.Waiting else Phase.Off
        return JSONObject().put("operation", "call_avatar").put("call_id", id)
            .put("avatar", enabled).put("avatar_revision", revision).also { if (!enabled) pendingOff = it }
    }

    fun receive(packet: JSONObject, activeCall: String?): JSONObject? {
        val id = packet.getString("call_id")
        val state = packet.getString("state")
        if (id == call && state in setOf("closing", "closed", "failed")) { end(); return null }
        if (state !in setOf("opening", "connecting", "live")) return null
        // Replayed avatar state may precede the base call state. Only an OFF is permitted before it.
        if (id != activeCall && (activeCall != null || wanted)) return null
        if (call != id) { end(); call = id }
        val next = packet.getLong("avatar_revision")
        if (next < revision) return pendingOff
        revision = next
        if (pendingOff?.getLong("avatar_revision")?.let { it < next } == true) pendingOff = null
        if (!packet.getBoolean("avatar")) {
            pendingOff = null; wanted = false; media.value = null
            if (phase.value != Phase.Failed) phase.value = Phase.Off
            return null
        }
        if (!wanted) return request(id, false)
        if (!packet.has("media")) return null
        val value = packet.getJSONObject("media")
        require(value.getString("provider") == "artc" && value.getString("audio_input") == "gateway")
        val token = value.getString("token"); val user = value.getString("user_id")
        val expires = value.getString("token_expire_at").toLong()
        require(token.isNotBlank() && token.length <= 8192 && user.isNotBlank() && user.length <= 200)
        require(expires > now() / 1000) { "Avatar credential expired" }
        if (media.value?.let { it.token == token && it.user == user && it.expires == expires } == true) return null
        media.value = Media(token, user, expires)
        phase.value = Phase.Joining
        return null
    }

    fun drawn(source: Media) { if (media.value === source) phase.value = Phase.Playing }
    fun failed(source: Media): JSONObject? {
        if (media.value !== source) return null
        return unavailable()
    }
    fun unavailable(): JSONObject? {
        if (!wanted) return null
        val off = request(checkNotNull(call), false)
        phase.value = Phase.Failed
        return off
    }
    fun linkLost() { media.value = null; phase.value = if (wanted) Phase.Waiting else Phase.Off }
    fun replayOff(): JSONObject? = pendingOff
    fun end() {
        pendingOff = null; wanted = false; call = null; revision = 0
        media.value = null; phase.value = Phase.Off
    }
}
