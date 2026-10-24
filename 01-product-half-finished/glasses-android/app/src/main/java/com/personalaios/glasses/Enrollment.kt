package com.personalaios.glasses

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.subtle.X25519
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.net.HttpURLConnection
import java.net.URL

internal val DEFAULT_GATEWAY = BuildConfig.PAIOS_GATEWAY_ORIGIN

/** Owner imports a server-issued pairing; registration exports only the recipient public key. */
class Enrollment internal constructor(private val preferences: android.content.SharedPreferences,
    private val cipher: EnrollmentCipher) {
    constructor(context: Context) : this(context.getSharedPreferences("owner-enrollment", Context.MODE_PRIVATE), AndroidEnrollmentCipher())
    companion object { private val pairingLock = Any() }
    private val alias = "paios.glasses.enrollment.v1"
    var companionEnabled: Boolean
        get() = preferences.getBoolean("companion-enabled", false)
        set(value) { check(preferences.edit().putBoolean("companion-enabled", value).commit()) }
    /** 随身模式 on the glasses: the owner's own switch, separate from the iPhone's. Off until he turns it on. */
    var ambientMode: Boolean
        get() = preferences.getBoolean("ambient-mode", false)
        set(value) { check(preferences.edit().putBoolean("ambient-mode", value).commit()) }
    var localWakeEnabled: Boolean
        get() = preferences.getBoolean("local-wake-enabled", false)
        set(value) { check(preferences.edit().putBoolean("local-wake-enabled", value).commit()) }
    var largeText: Boolean
        get() = preferences.getBoolean("large-text", false)
        set(value) { check(preferences.edit().putBoolean("large-text", value).commit()) }
    /** Stored only after the map disclosure is shown and the owner explicitly chooses. */
    var mapPrivacyChoice: Boolean?
        get() = if (preferences.contains("amap-privacy")) preferences.getBoolean("amap-privacy", false) else null
        set(value) { check(preferences.edit().putBoolean("amap-privacy", value!!).commit()) }
    fun recordLaunch(): Int = (preferences.getInt("launch-count", 0) + 1).also {
        check(preferences.edit().putInt("launch-count", it.coerceAtMost(4)).commit())
    }
    fun clearPairing() = synchronized(pairingLock) {
        check(preferences.edit().remove("pairing").remove("control-journal").remove("reply-journal")
            .remove("capture-request").remove("ambient-mode").remove("local-wake-enabled").putBoolean("companion-enabled", false).commit())
    }
    @Synchronized fun captureRequest(): JSONObject? = read("capture-request")?.let { JSONObject(String(it, Charsets.UTF_8)) }
    @Synchronized fun saveCaptureRequest(value: JSONObject?) {
        if (value == null) check(preferences.edit().remove("capture-request").commit())
        else write("capture-request", value.toString().toByteArray(Charsets.UTF_8))
    }


    private fun read(name: String): ByteArray? = preferences.getString(name, null)?.let { cipher.open(name, it) }
    private fun write(name: String, value: ByteArray) {
        check(preferences.edit().putString(name, cipher.seal(name, value)).commit()) { "Enrollment could not be saved" }
    }

    @Synchronized fun recipientPrivateKey(): ByteArray {
        read("recipient")?.let { require(it.size == 32); return it }
        return X25519.generatePrivateKey().also { write("recipient", it) }
    }

    @Synchronized fun registrationText(): String {
        val secret = recipientPrivateKey()
        val public = try { X25519.publicFromPrivate(secret) } finally { secret.fill(0) }
        return JSONObject().put("schema", "paios.realtime-e2ee-recipient-registration.v1")
            .put("device_type", "glasses").put("capabilities", org.json.JSONArray(listOf("display", "speaker", "microphone", "continuous_audio", "local_wake", "camera", "notifications", "wear_state")))
            .put("public_raw32_base64url", Base64.encodeToString(public, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
            .put("public_sha256", sha256(public)).put("local_slot_ref_hash", sha256(alias.toByteArray()))
            .put("created_at", GatewayClient.timestamp()).toString(2)
    }

    val isPaired: Boolean get() = preferences.contains("pairing")
    fun pairing(): JSONObject? = synchronized(pairingLock) { read("pairing")?.let { JSONObject(String(it, Charsets.UTF_8)) } }

    internal fun saveOrigin(expected: JSONObject, updated: JSONObject): Boolean = synchronized(pairingLock) {
        try {
            val stored = pairing() ?: return@synchronized false
            if (canonicalJson(stored) != canonicalJson(expected)) return@synchronized false
            val previous = preferences.getString("pairing", null)
            val sealed = cipher.seal("pairing", updated.toString().toByteArray(Charsets.UTF_8))
            if (preferences.edit().putString("pairing", sealed).commit()) true else {
                // A failed commit changes SharedPreferences' cache. All pairing writers hold this lock.
                preferences.edit().putString("pairing", previous).commit()
                false
            }
        } catch (_: java.security.GeneralSecurityException) { false
        } catch (_: java.io.IOException) { false }
    }

    suspend fun exchange(text: String, configuredGateway: String): JSONObject = withContext(Dispatchers.IO) {
        val payload = parseEnrollmentPayload(text, configuredGateway)
        val connection = URL(payload.getString("origin") + "/v1/devices/glasses/enrollment/exchange").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.instanceFollowRedirects = false; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("token", payload.getString("token")).put("registration", JSONObject(registrationText())).toString().toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            check(connection.responseCode == 200) { "配对码已失效或无法使用，请在 iPhone 上重新添加眼镜" }
            val pairing = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            currentCoroutineContext().ensureActive()
            importPairing(pairing, configuredGateway)
        } finally { connection.disconnect() }
    }

    @Synchronized fun controlJournal(): JSONObject? = read("control-journal")?.let { JSONObject(String(it, Charsets.UTF_8)) }
    @Synchronized fun saveControlJournal(value: JSONObject?) {
        if (value == null) check(preferences.edit().remove("control-journal").commit())
        else write("control-journal", value.toString().toByteArray(Charsets.UTF_8))
    }
    @Synchronized fun replyJournal(): JSONObject? = read("reply-journal")?.let { JSONObject(String(it, Charsets.UTF_8)) }
    @Synchronized fun saveReplyJournal(value: JSONObject?) {
        if (value == null) check(preferences.edit().remove("reply-journal").commit())
        else write("reply-journal", value.toString().toByteArray(Charsets.UTF_8))
    }

    fun importPairing(text: String, configuredGateway: String): JSONObject = synchronized(pairingLock) {
        require(text.toByteArray().size in 2..16384) { "Pairing file is too large" }
        val value = JSONObject(text)
        require(value.getString("schema") == "paios.device-pairing.v1") { "Unsupported pairing schema" }
        require(value.getString("origin") == gatewayOrigin(configuredGateway)) { "Pairing belongs to a different gateway" }
        require(value.getString("device_type") == "glasses") { "This pairing is for another terminal" }
        val previous = pairing()
        val replacing = previous?.getString("device_id") != value.getString("device_id") || previous?.getString("paired_at") != value.getString("paired_at")
        check(!replacing || controlJournal() == null) { "先停止旧连接，再导入新的配对" }
        write("pairing", value.toString().toByteArray(Charsets.UTF_8))
        if (replacing) { saveControlJournal(null); saveReplyJournal(null) }
        companionEnabled = true
        value
    }
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
internal fun parseEnrollmentPayload(text: String, configuredGateway: String, now: Long = System.currentTimeMillis()): JSONObject {
    require(text.toByteArray().size in 2..2048) { "二维码无法用于眼镜配对" }
    val value = JSONObject(text)
    require(value.keys().asSequence().toSet() == setOf("schema", "origin", "token", "expires_at") &&
        value.getString("schema") == "paios.glasses-enrollment.v1" && value.getString("origin") == gatewayOrigin(configuredGateway) &&
        Regex("^[A-Za-z0-9_-]{43}$").matches(value.getString("token"))) { "请扫描已配对 iPhone 上的眼镜配对码" }
    require(java.time.Instant.parse(value.getString("expires_at")).toEpochMilli() > now) { "配对码已过期，请在 iPhone 上重新添加眼镜" }
    return value
}
internal fun gatewayOrigin(value: String): String {
    val uri = URI(value.trim())
    require(uri.scheme in setOf("https", "wss") && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) {
        "Gateway must be an HTTPS or WSS address"
    }
    require(uri.port == -1 || uri.port in 1..65535)
    return URI("https", null, uri.host.lowercase(), if (uri.port == 443) -1 else uri.port, null, null, null).toString()
}
