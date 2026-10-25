package com.personalaios.glasses

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.AtomicFile
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.net.URI
import java.net.HttpURLConnection
import java.time.Instant

data class AvatarProfile(val version: Long, val lookId: String, val style: String,
    val imageUrl: String, val x: Double, val y: Double, val updatedAt: String) {
    fun json() = JSONObject().put("version", version).put("look_id", lookId).put("style", style)
        .put("image_url", imageUrl).put("focus", JSONObject().put("x", x).put("y", y)).put("updated_at", updatedAt)
    companion object {
        fun decode(value: JSONObject): AvatarProfile {
            require(value.keys().asSequence().toSet() == setOf("version", "look_id", "style", "image_url", "focus", "updated_at"))
            fun text(key: String) = (value.get(key) as String)
            val version = value.get("version")
            require(version is Number && version.toDouble() in 1.0..9007199254740991.0 && version.toDouble() == version.toLong().toDouble())
            val imageUrl = text("image_url"); require(imageUrl.length <= 2048)
            val lookId = text("look_id"); require(Regex("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$").matches(lookId))
            val style = text("style"); require(style.length in 1..80)
            val uri = URI(imageUrl)
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.userInfo == null)
            val focus = value.getJSONObject("focus")
            require(focus.keys().asSequence().toSet() == setOf("x", "y"))
            fun coordinate(key: String): Double = (focus.get(key) as Number).toDouble().also { require(it in 0.0..1.0) }
            val updated = text("updated_at"); Instant.parse(updated)
            return AvatarProfile(version.toLong(), lookId, style,
                uri.toString(), coordinate("x"), coordinate("y"), updated)
        }
    }
}
data class AvatarPortrait(val profile: AvatarProfile, val bitmap: Bitmap)

/** A private display cache. Only authenticated formal state selects an image. */
class AppearanceState(context: Context, private val scope: CoroutineScope,
    private val changed: (AvatarPortrait?) -> Unit) {
    private val cache = AtomicFile(File(context.noBackupFilesDir, "avatar-display"))
    private val lock = Any()
    private var owner: String? = null
    private var apiOrigin: String? = null
    private var selected: AvatarProfile? = null
    private var selectedVersion: Long? = null
    private var loadedVersion: Long? = null
    private var sender: (suspend (JSONObject) -> Unit)? = null
    private var reportedVersion: Long? = null
    @Volatile private var generation = 0L
    private var loading: Job? = null

    fun bind(pair: JSONObject?) {
        apiOrigin = pair?.getString("origin")
        val identity = pair?.let { it.getString("device_id") + ":" + it.getString("paired_at") }
        if (identity != null && identity == owner) return
        synchronized(lock) { owner = identity; selected = null; selectedVersion = null; loadedVersion = null; generation++ }
        disconnected()
        loading?.cancel(); changed(null)
        if (identity == null) { cache.delete(); return }
        val revision = generation
        loading = scope.launch {
            try {
                val saved = withContext(Dispatchers.IO) {
                    synchronized(lock) {
                        if (generation != revision || !cache.baseFile.exists()) null else DataInputStream(cache.openRead()).use { input ->
                            val header = JSONObject(input.readUTF())
                            if (header.getString("owner") != identity) { cache.delete(); null }
                            else {
                                val profile = if (header.isNull("profile")) null else AvatarProfile.decode(header.getJSONObject("profile"))
                                Triple(profile, header.optLong("loaded_version", profile?.version ?: 0), input.readBytes())
                            }
                        }
                    }
                } ?: return@launch
                val portrait = saved.first?.let { profile -> withContext(Dispatchers.IO) { AvatarPortrait(profile, decodeImage(saved.third)) } }
                if (generation == revision) {
                    selected = saved.first; selectedVersion = saved.second
                    changed(portrait); loadedVersion = saved.second; reportLoaded()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { Log.w("Yimi", "avatar_cache_failed ${error.javaClass.simpleName}") }
        }
    }

    suspend fun connected(send: suspend (JSONObject) -> Unit) {
        sender = send; reportedVersion = null; reportLoaded()
    }

    fun disconnected() { sender = null; reportedVersion = null }

    private suspend fun reportLoaded() {
        val version = loadedVersion ?: return
        val send = sender ?: return
        if (reportedVersion == version) return
        send(JSONObject().put("operation", "avatar_loaded").put("profile_version", version))
        if (sender === send && loadedVersion == version) reportedVersion = version
    }

    fun accept(message: JSONObject) {
        require(message.has("profile"))
        val profile = if (message.isNull("profile")) null else AvatarProfile.decode(message.getJSONObject("profile"))
        val rawVersion = message.get("profile_version")
        require(rawVersion is Number && rawVersion.toDouble() in 0.0..9007199254740991.0 && rawVersion.toDouble() == rawVersion.toLong().toDouble())
        val version = rawVersion.toLong()
        require(profile == null || profile.version == version)
        val identity = checkNotNull(owner)
        if (selectedVersion != null && version < selectedVersion!!) return
        if (selectedVersion == version) {
            require(selected == profile) { "Avatar revision changed" }
            if (loadedVersion == version || loading?.isActive == true) return
        }
        synchronized(lock) { selected = profile; selectedVersion = version; generation++ }
        val revision = generation
        loading?.cancel()
        loading = scope.launch {
            try {
                val portrait = withContext(Dispatchers.IO) {
                    val bytes = if (profile == null) ByteArray(0) else {
                        val connection = URI(profile.imageUrl).toURL().openConnection() as HttpURLConnection
                        try {
                            connection.connectTimeout = 10000; connection.readTimeout = 15000
                            connection.instanceFollowRedirects = false
                            val status = connection.responseCode
                            if (gatewayOrigin(URI(profile.imageUrl).resolve("/").toString()) == apiOrigin)
                                ServerClock.shared.learn(connection)
                            check(status == 200) { "Avatar image unavailable" }
                            connection.inputStream.use { input ->
                                val data = java.io.ByteArrayOutputStream()
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    require(data.size() + count <= 5 * 1024 * 1024)
                                    data.write(buffer, 0, count)
                                }
                                data.toByteArray()
                            }
                        } finally { connection.disconnect() }
                    }
                    val bitmap = profile?.let { decodeImage(bytes) }
                    synchronized(lock) {
                        if (generation == revision) {
                            val output = cache.startWrite()
                            try {
                                val data = DataOutputStream(output)
                                data.writeUTF(JSONObject().put("owner", identity).put("loaded_version", version)
                                    .put("profile", profile?.json() ?: JSONObject.NULL).toString())
                                data.write(bytes); data.flush(); cache.finishWrite(output)
                            } catch (error: Exception) { cache.failWrite(output); throw error }
                        }
                    }
                    if (profile == null) null else AvatarPortrait(profile, checkNotNull(bitmap))
                }
                if (generation == revision) {
                    changed(portrait); loadedVersion = version; reportLoaded()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { Log.w("Yimi", "avatar_image_failed ${error.javaClass.simpleName}") }
        }
    }

    private fun decodeImage(bytes: ByteArray): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 24000000)
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 1024) inSampleSize *= 2
        }
        return requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
    }
}
