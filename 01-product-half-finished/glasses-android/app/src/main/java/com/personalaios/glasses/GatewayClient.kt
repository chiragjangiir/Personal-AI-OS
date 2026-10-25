package com.personalaios.glasses

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.IOException
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

internal fun canonicalJson(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonicalJson(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonicalJson(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean, is Number -> value.toString()
    else -> error("Unsupported control JSON value")
}

/** One retained authoritative bootstrap binding for this device's formal control plane. */
class GatewayClient internal constructor(private val enrollment: Enrollment,
    private val discoveryScope: CoroutineScope? = null,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val now: () -> Long = ::monotonicMillis,
    private val openKey: (JSONObject, JSONObject, ByteArray) -> ByteArray = { request, response, secret -> E2ee.open(request, response, secret) },
    private val clock: ServerClock = ServerClock.shared) {
    data class Connection(val url: String, val token: String, val contentKey: ByteArray, val sessionId: String,
        val deviceId: String, val gatewayIdentity: String, val callRejoinWindowS: Long? = null)
    private var pairing: JSONObject? = null
    private var bootstrap: JSONObject? = null
    private var discovery: Job? = null
    @Volatile private var nextDiscoveryAt = 0L
    @Volatile private var discoveryBackoff = 1000L
    var current: Connection? = null
        private set

    suspend fun connect(suppliedPairing: JSONObject): Connection = withContext(Dispatchers.IO) {
        val pairing = enrollment.pairing() ?: suppliedPairing
        this@GatewayClient.pairing = pairing
        recover()
        if (bootstrap != null) stop()
        val media = pairing.getJSONArray("media")
        val names = (0 until media.length()).map { media.getString(it) }.toSet()
        val modalities = JSONArray(listOf("audio", "video", "data").filter { it in names })
        val device = pairing.getString("device_id")
        val body = JSONObject().put("operation", "bootstrap").put("bootstrap_mode", "initial").put("request_id", requestId())
            .put("device_id", device).put("governance", pairing.getJSONObject("governance"))
            .put("start", JSONObject().put("kind", "explicit_user_start").put("device_id", device).put("modalities", modalities).put("started_at", timestamp(clock.nowMillis())))
            .put("requested_media", JSONObject().put("audio", "audio" in names).put("video", "video" in names).put("data", "data" in names))
        val response = post("bootstrap", "/v1/realtime/bootstrap", body)
        resolveConnection(response).also { current = it }
    }

    private fun resolveConnection(binding: JSONObject): Connection {
        val request = bound("realtime_e2ee_key_resolve")
        val envelope = binding.getJSONObject("e2ee_key_envelope")
        val aliases = binding.getJSONArray("transport_aliases")
        val audience = (0 until aliases.length()).map { aliases.getJSONObject(it) }.single { it.getString("alias_type") == "participant" }
        request.put("key_envelope_ref", envelope.getJSONObject("key_envelope_ref")).put("key_index", envelope.getInt("key_index"))
            .put("key_generation", envelope.getString("key_generation")).put("device_id", pairing!!.getString("device_id"))
            .put("recipient_device_credential_ref", binding.getJSONObject("recipient_device_credential_ref")).put("participant_audience", audience)
        var key: ByteArray? = null
        post("e2ee-key-resolve", "/v1/realtime/e2ee/key/resolve", request) { key = it.copyOf() }
        val livekit = binding.getJSONObject("livekit")
        val transport = binding.getJSONObject("central_text_transport")
        require(livekit.getString("server_url").startsWith("wss://")) { "LiveKit requires TLS" }
        return Connection(livekit.getString("server_url"), livekit.getString("participant_token"), checkNotNull(key),
            binding.getString("continuity_id"), pairing!!.getString("device_id"),
            transport.getString("expected_gateway_identity"),
            if (transport.has("call_rejoin_window_s")) transport.getLong("call_rejoin_window_s") else null)
    }

    suspend fun stop() = withContext(Dispatchers.IO) {
        current?.contentKey?.fill(0); current = null
        pairing = pairing ?: enrollment.pairing()
        if (pairing != null) recover()
        if (bootstrap != null) post("media-stop", "/v1/realtime/media/stop", bound("media_stop")
            .put("reason", "user_stop").put("release_scope", "media_device_lease_only"))
    }
    fun clear() { discovery?.cancel(); current?.contentKey?.fill(0); current = null; bootstrap = null; pairing = null }

    private fun journal(pending: JSONObject? = null): JSONObject = JSONObject().put("device_id", pairing!!.getString("device_id"))
        .put("paired_at", pairing!!.getString("paired_at")).put("bootstrap", bootstrap ?: JSONObject.NULL).put("pending", pending ?: JSONObject.NULL)
    private fun recover() {
        val saved = enrollment.controlJournal() ?: return
        require(saved.getString("device_id") == pairing!!.getString("device_id") && saved.getString("paired_at") == pairing!!.getString("paired_at")) { "Control recovery belongs to another pairing" }
        bootstrap = saved.optJSONObject("bootstrap")
        saved.optJSONObject("pending")?.let { post(it.getString("slug"), it.getString("path"), it.getJSONObject("body")) }
    }
    private fun accept(slug: String, value: JSONObject) {
        if (slug == "bootstrap") {
            bootstrap = value
        } else if (slug != "e2ee-key-resolve") {
            bootstrap = null
        }
        if (slug != "e2ee-key-resolve") enrollment.saveControlJournal(if (bootstrap == null) null else journal())
    }

    private fun bound(operation: String): JSONObject {
        val b = checkNotNull(bootstrap) { "Bootstrap is required" }
        val body = JSONObject().put("operation", operation).put("request_id", requestId())
            .put("realtime_session_ref", b.getJSONObject("realtime_session_ref")).put("continuity_id", b.getString("continuity_id"))
            .put("connection_epoch", b.getString("connection_epoch")).put("governance", pairing!!.getJSONObject("governance"))
        body.put("device_lease_ref", b.getJSONObject("device_lease_ref")).put("transport_aliases", b.getJSONArray("transport_aliases"))
        return body
    }

    internal fun post(slug: String, path: String, body: JSONObject, receiveKey: ((ByteArray) -> Unit)? = null): JSONObject {
        return try { postAttempt(slug, path, body, receiveKey) }
        catch (answered: GatewayControlAnswered) {
            if (slug != "bootstrap" || answered.code != "PAIRED_DEVICE_START_TIME_INVALID" || !answered.timeLearned) throw answered
            // A coded refusal is final in the gateway ledger. A corrected Start needs a fresh identity and hash.
            val corrected = JSONObject(body.toString()).apply {
                remove("idempotency_context")
                put("request_id", requestId())
                getJSONObject("start").put("started_at", timestamp(clock.nowMillis()))
            }
            postAttempt(slug, path, corrected, receiveKey)
        }
    }

    private fun postAttempt(slug: String, path: String, body: JSONObject, receiveKey: ((ByteArray) -> Unit)?): JSONObject {
        pairing = enrollment.pairing() ?: checkNotNull(pairing)
        val snapshot = JSONObject(pairing.toString())
        val profile = "https://personal-ai-os.local/contracts/realtime/idempotency/$slug"
        val kind = when (slug) {
            "bootstrap" -> "realtime_bootstrap"; "e2ee-key-resolve" -> "realtime_e2ee_key_resolve"
            "media-stop" -> "realtime_media_stop"; else -> error("Unknown control operation")
        }
        val targetType = if (slug == "media-stop") "DeviceLease" else "RealtimeSession"
        val scope = JSONObject().put("owner_module", "T11B").put("operation_kind", kind).put("target_object_type", targetType).put("user_id", pairing!!.getString("user_id"))
        val target = if (slug == "media-stop") "device_lease_ref" else "realtime_session_ref"
        if (body.has(target)) scope.put("target_object_id", body.getJSONObject(target).getString("ref_id"))
        if (!body.has("idempotency_context")) body.put("idempotency_context", JSONObject().put("idempotency_scope", scope).put("idempotency_key", body.getString("request_id"))
            .put("idempotency_profile_id", profile).put("idempotency_profile_version", "1.0.0")
            .put("idempotency_profile_sha256", sha256(canonicalJson(JSONObject().put("profile_id", profile).put("profile_version", "1.0.0").put("hash_algorithm", "sha256_rfc8785_jcs")).toByteArray()))
            .put("idempotency_request_sha256", sha256(canonicalJson(body).toByteArray())))
        if (slug != "e2ee-key-resolve") enrollment.saveControlJournal(journal(JSONObject().put("slug", slug).put("path", path).put("body", body)))
        val bytes = canonicalJson(body).toByteArray(Charsets.UTF_8)
        var selected = snapshot
        val value = try {
            try { request(bytes, snapshot, body.getString("request_id"), openConnection(URL(snapshot.getString("origin") + path))) }
            catch (error: IOException) {
                val alternate = OriginMigration.fallback(snapshot)
                if (error is PairingAuthenticationLost || error is GatewayControlAnswered || alternate == null) throw error
                selected = OriginMigration.switched(snapshot, alternate)
                request(bytes, snapshot, body.getString("request_id"), openConnection(URL(alternate + path)))
            }
        } catch (answered: GatewayControlAnswered) {
            // An answered control ends its replay duty: the next Start is a fresh request, which supersedes this device's
            // old session on the gateway, never the same answered bytes again. A refused stop leaves nothing to stop either.
            if (slug == "media-stop") bootstrap = null
            if (slug != "e2ee-key-resolve") enrollment.saveControlJournal(if (bootstrap == null) null else journal())
            throw answered
        }
        val key = when (slug) {
            "bootstrap" -> { ControlResponse.bootstrap(value, body, snapshot); null }
            "media-stop" -> { ControlResponse.stop(value, body); null }
            "e2ee-key-resolve" -> {
                val secret = enrollment.recipientPrivateKey()
                try { openKey(body, value, secret) } finally { secret.fill(0) }
            }
            else -> error("Unknown control operation")
        }
        try {
            pairing = selected
            accept(slug, value)
            val confirmed = OriginMigration.confirmed(selected) ?: selected
            if (canonicalJson(snapshot) != canonicalJson(confirmed)) enrollment.saveOrigin(snapshot, confirmed)
            if (slug == "bootstrap" && selected === snapshot) discover(snapshot, value, bytes, body.getString("request_id"))
            if (key != null) receiveKey?.invoke(key)
            return value
        } finally { key?.fill(0) }
    }

    private fun discover(snapshot: JSONObject, binding: JSONObject, bytes: ByteArray, requestId: String) {
        val scope = discoveryScope ?: return
        if (discovery?.isActive == true || now() < nextDiscoveryAt) return
        if (snapshot.optString("origin") != OriginMigration.LEGACY || binding.optString("canonical_api_origin") != DEFAULT_GATEWAY) return
        discovery = scope.launch(Dispatchers.IO) {
            val verified = try { withTimeoutOrNull(5000L) {
                suspendCancellableCoroutine<JSONObject?> { pending ->
                    val connection = openConnection(URL(DEFAULT_GATEWAY + "/v1/realtime/bootstrap/reconcile"))
                    val worker = launch(Dispatchers.IO) {
                        val response = try { request(bytes, snapshot, requestId, connection, 5000) }
                        catch (_: IOException) { null }
                        catch (_: GatewayControlRejected) { null }
                        catch (_: org.json.JSONException) { null }
                        pending.resume(response)
                    }
                    pending.invokeOnCancellation { worker.cancel(); connection.disconnect() }
                }
            } } catch (_: IOException) { null }
            val migrated = OriginMigration.announced(snapshot, binding) { verified }
            if (migrated != null) enrollment.saveOrigin(snapshot, migrated)
            nextDiscoveryAt = now() + discoveryBackoff
            discoveryBackoff = (discoveryBackoff * 2).coerceAtMost(60000L)
        }
    }

    private fun request(bytes: ByteArray, credentials: JSONObject, requestId: String, connection: HttpURLConnection, timeout: Int = 15000): JSONObject {
        try {
            connection.requestMethod = "POST"; connection.connectTimeout = timeout; connection.readTimeout = timeout * 2
            connection.instanceFollowRedirects = false; connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer " + credentials.getString("token"))
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val timeLearned = clock.learn(connection)
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            if (status !in 200..299) {
                val rejection = runCatching { JSONObject(text) }.getOrNull()
                val code = rejection?.optString("error").orEmpty()
                if (code in setOf("CONTROL_CAPABILITY_INVALID", "PAIRED_DEVICE_REVOKED", "CONTROL_CAPABILITY_DEVICE_MISMATCH", "PAIRED_DEVICE_BEARER_MISMATCH") ||
                    rejection?.optString("status") == "revoked" && rejection.optString("request_id") == requestId) {
                    throw PairingAuthenticationLost("眼镜配对已失效，请重新配对")
                }
                val message = "Gateway control HTTP $status $code"
                // The gateway's ledger replays this coded answer to every retry of the same idempotency key (for example,
                // a stored ACCEPTED_ACTIVITY_FUTURE); only a running attempt is still open.
                if (code.isNotEmpty() && code != "PUBLIC_OPERATION_RECEIPT_IN_FLIGHT") throw GatewayControlAnswered(message, code, timeLearned)
                if (status >= 500 || status in 300..399) throw IOException(message)
                throw GatewayControlRejected(message)
            }
            return JSONObject(text)
        } finally { connection.disconnect() }
    }
    companion object {
        fun timestamp(now: Long = ServerClock.shared.nowMillis()): String = java.time.format.DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC).format(Instant.ofEpochMilli(now))
    }
    private fun requestId(): String {
        val b = ByteArray(16).also { SecureRandom().nextBytes(it) }; val ms = clock.nowMillis()
        for (i in 0..5) b[i] = (ms ushr ((5 - i) * 8)).toByte()
        b[6] = ((b[6].toInt() and 15) or 112).toByte(); b[8] = ((b[8].toInt() and 63) or 128).toByte()
        val bb = java.nio.ByteBuffer.wrap(b); return UUID(bb.long, bb.long).toString()
    }
}

private class GatewayControlRejected(message: String) : Exception(message)
/** The gateway's own coded error for a control request; retrying the same request can only repeat it. */
private class GatewayControlAnswered(message: String, val code: String, val timeLearned: Boolean) : IOException(message)
