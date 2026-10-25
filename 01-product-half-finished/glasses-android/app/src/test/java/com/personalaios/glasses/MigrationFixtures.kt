package com.personalaios.glasses

import android.content.SharedPreferences
import org.json.JSONObject
import java.lang.reflect.Proxy
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream

/** Platform boundaries only: real Enrollment, CAS, journal and GatewayClient operate above these. */
internal class PreferenceDisk(private val disk: MutableMap<String, Any> = mutableMapOf()) {
    val memory = disk.toMutableMap()
    var pairingCommits = 0
    var failPairingCommit = false
    var beforePairingCommit: (() -> Unit)? = null
    fun restart() = PreferenceDisk(disk)
    @Suppress("UNCHECKED_CAST")
    val preferences = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
        val key = args?.getOrNull(0) as? String
        when (method.name) {
            "getString", "getBoolean", "getInt" -> memory[key] ?: args!![1]
            "contains" -> memory.containsKey(key)
            "edit" -> editor()
            else -> error("Unexpected preference call ${method.name}")
        }
    } as SharedPreferences
    private fun editor(): SharedPreferences.Editor {
        val changes = mutableMapOf<String, Any?>()
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when (method.name) {
                "putString", "putBoolean", "putInt" -> { changes[args!![0] as String] = args[1]; editor }
                "remove" -> { changes[args!![0] as String] = null; editor }
                "commit" -> {
                    if (changes.containsKey("pairing")) { pairingCommits++; beforePairingCommit?.invoke() }
                    changes.forEach { (key, value) -> if (value == null) memory.remove(key) else memory[key] = value }
                    val fail = changes.containsKey("pairing") && failPairingCommit
                    if (fail) failPairingCommit = false
                    else { disk.clear(); disk.putAll(memory) }
                    !fail
                }
                else -> error("Unexpected editor call ${method.name}")
            }
        } as SharedPreferences.Editor
        return editor
    }
}
internal object PlainTestCipher : EnrollmentCipher {
    override fun open(name: String, stored: String) = java.util.Base64.getDecoder().decode(stored)
    override fun seal(name: String, value: ByteArray) = java.util.Base64.getEncoder().encodeToString(value)
}
internal fun pair(origin: String = OriginMigration.LEGACY, device: String = "glasses-1") = JSONObject()
    .put("schema", "paios.device-pairing.v1").put("device_type", "glasses").put("origin", origin)
    .put("token", "original-token").put("device_id", device).put("user_id", "owner-1").put("paired_at", "original-time")
    .put("governance", bootstrapTemplate().getJSONObject("governance"))
internal fun bootstrapRequest() = JSONObject().put("operation", "bootstrap").put("bootstrap_mode", "initial")
    .put("request_id", "durable-request-1").put("device_id", "glasses-1").put("governance", pair().getJSONObject("governance"))
    .put("requested_media", JSONObject().put("audio", true).put("video", false).put("data", true))
    .put("start", JSONObject().put("kind", "explicit_user_start").put("device_id", "glasses-1")
        .put("modalities", org.json.JSONArray(listOf("audio", "data"))))
// Authoritative gateway contract fixture; only request echoes, granted device/media and time are rebound.
private fun bootstrapTemplate() = JSONObject(PreferenceDisk::class.java.getResourceAsStream("/realtime-bootstrap.valid.json")!!.bufferedReader().use { it.readText() })
internal fun accepted(request: JSONObject = bootstrapRequest()): JSONObject {
    val value = bootstrapTemplate()
    listOf("request_id", "bootstrap_mode", "governance").forEach { value.put(it, request.get(it)) }
    value.put("canonical_api_origin", DEFAULT_GATEWAY)
    value.getJSONObject("livekit").put("credential_expires_at", "2099-01-01T00:00:00Z")
    val envelope = value.getJSONObject("e2ee_key_envelope").put("governance", request.getJSONObject("governance"))
        .put("expires_at", "2099-01-01T00:00:00Z")
    val channels = listOf("audio", "video", "data").filter { request.getJSONObject("requested_media").getBoolean(it) }
    envelope.getJSONObject("scope").put("device_id", request.getString("device_id")).put("channels", org.json.JSONArray(channels))
    for (media in listOf("audio", "video", "data")) {
        val grant = if (media in channels) value.getJSONObject("media_grants").getJSONObject(media)
            .put("device_id", request.getString("device_id")).put("expires_at", "2099-01-01T00:00:00Z")
            .put("start_binding", JSONObject(request.getJSONObject("start").toString()).also { it.remove("started_at") })
            else JSONObject().put("enabled", false)
        value.getJSONObject("media_grants").put(media, grant)
    }
    return value.put("central_text_transport", JSONObject().put("schema", "paios.central.text-transport.v1")
        .put("execution_owner", "hermes_text").put("expected_gateway_identity", "gateway-1")
        .put("input_topic", "paios.central.text.v1").put("output_topic", "paios.central.sealed-text.v1").put("max_packet_bytes", 12288))
}
internal fun stopped(request: JSONObject): JSONObject = JSONObject(request.toString()).also { it.remove("idempotency_context"); it.remove("transport_aliases") }
    .put("status", "success").put("operation_outcome", JSONObject().put("outcome_class", "committed_success").put("resolution_mode", "direct")
        .put("recorded_result_ref", JSONObject().put("idempotency_context", request.getJSONObject("idempotency_context"))
            .put("fencing_epoch", "17").put("outcome_class", "committed_success")
            .put("result_schema_id", "https://personal-ai-os.local/contracts/realtime/realtime-terminal-result.v1.schema.json")
            .put("result_schema_version", "1.0.0").put("result_schema_sha256", "1".repeat(64)).put("result_payload_sha256", "2".repeat(64))))
    .put("execution_facts", JSONObject().put("closure_status", "verified_closed").put("device_lease_release", "released")
        .put("participant_cleanup", "verified_absent").put("track_cleanup", "verified_absent").put("room_cleanup", "verified_absent"))
internal fun provenPair(origin: String = DEFAULT_GATEWAY): JSONObject = OriginMigration.switched(
    OriginMigration.announced(pair(), accepted()) { accepted().put("status", "committed") }!!, origin)
internal fun Enrollment.seed(value: JSONObject) = importPairing(value.toString(), value.getString("origin"))
internal class FakeControl(url: URL, private val respond: (FakeControl) -> Pair<Int, String>) : HttpURLConnection(url) {
    val bytes = ByteArrayOutputStream()
    var disconnected = false
    var date: String? = null
    private var result: Pair<Int, String>? = null
    override fun getOutputStream() = bytes
    override fun getResponseCode(): Int = (result ?: respond(this).also { result = it }).first
    override fun getHeaderField(name: String): String? = if (name.equals("Date", ignoreCase = true)) date else null
    override fun getInputStream() = (result ?: respond(this).also { result = it }).second.byteInputStream()
    override fun getErrorStream() = inputStream
    override fun disconnect() { disconnected = true }
    override fun usingProxy() = false
    override fun connect() {}
}
