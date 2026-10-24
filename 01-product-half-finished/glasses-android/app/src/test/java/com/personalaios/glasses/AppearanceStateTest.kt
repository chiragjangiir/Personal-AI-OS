package com.personalaios.glasses

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [32])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppearanceStateTest {
    private fun profile() = JSONObject("""{"version":2,"look_id":"look-2","style":"photo","image_url":"https://example.com/immutable/look-2.jpg","focus":{"x":0.2,"y":0.7},"updated_at":"2026-10-17T00:00:00Z"}""")

    @Test fun acceptsCanonicalStateAndRetainsFocus() {
        val packet = JSONObject().put("schema_version", "paios.central.text-envelope.v1")
            .put("session_id", "session").put("operation", "avatar_state").put("profile_version", 2).put("profile", profile())
        val decoded = AvatarProfile.decode(formalPacket(packet.toString().toByteArray(), "session").getJSONObject("profile"))
        assertEquals(2L, decoded.version)
        assertEquals(0.2, decoded.x, 0.0)
        assertEquals(0.7, decoded.y, 0.0)
        assertEquals(decoded, AvatarProfile.decode(decoded.json()))
    }

    @Test fun rejectsUntrustedImageAndMalformedRevision() {
        listOf(profile().put("image_url", "http://example.com/look.jpg"),
            profile().put("image_url", "https://user:secret@example.com/look.jpg"),
            profile().put("version", 0), profile().put("version", 1.5), profile().put("version", "2"),
            profile().put("version", 9007199254740992L), profile().put("look_id", ""),
            profile().put("style", 42), profile().put("style", ""), profile().put("extra", true),
            profile().put("focus", JSONObject().put("x", 1.1).put("y", 0.5)),
            profile().put("focus", JSONObject().put("x", "0.5").put("y", 0.5)),
            profile().put("updated_at", "yesterday")).forEach { invalid ->
            assertThrows(Exception::class.java) { AvatarProfile.decode(invalid) }
        }
    }

    @Test fun nullProfileUsesSameAuthenticatedEnvelope() {
        val packet = JSONObject().put("schema_version", "paios.central.text-envelope.v1")
            .put("session_id", "session").put("operation", "avatar_state").put("profile_version", 0).put("profile", JSONObject.NULL)
        assertTrue(formalPacket(packet.toString().toByteArray(), "session").isNull("profile"))
        assertThrows(IllegalArgumentException::class.java) { formalPacket(packet.toString().toByteArray(), "different") }
    }

    private class Fixture {
        val context: Context = RuntimeEnvironment.getApplication()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val pair = JSONObject().put("device_id", "glasses").put("paired_at", "pair-1")
        val receipts = mutableListOf<Long>()
        var shown: AvatarPortrait? = null
        val appearance = AppearanceState(context, scope) { shown = it }
        val cache = File(context.noBackupFilesDir, "avatar-display")
        suspend fun settle() { scope.coroutineContext.job.children.toList().joinAll() }
        suspend fun connect() { appearance.connected { receipts += it.getLong("profile_version") } }
        fun state(version: Long, profile: JSONObject? = null) = JSONObject()
            .put("profile", profile ?: JSONObject.NULL).put("profile_version", version)
        fun seed(profile: JSONObject?, version: Long, bytes: ByteArray = byteArrayOf()) {
            DataOutputStream(cache.outputStream()).use {
                it.writeUTF(JSONObject().put("owner", "glasses:pair-1").put("loaded_version", version)
                    .put("profile", profile ?: JSONObject.NULL).toString())
                it.write(bytes)
            }
        }
        fun png(): ByteArray = ByteArrayOutputStream().also {
            Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
    }

    @Test fun cachedImageReportsOnlyAfterDecodeAndReconnectReportsAgain() = runBlocking {
        val f = Fixture()
        try {
            f.seed(profile(), 2, f.png())
            f.appearance.bind(f.pair); f.settle(); f.connect()
            assertEquals(2L, f.shown!!.profile.version)
            assertEquals(listOf(2L), f.receipts)
            repeat(3) { f.appearance.accept(f.state(2, profile())) }; f.settle()
            assertEquals(listOf(2L), f.receipts)
            f.appearance.disconnected(); f.connect()
            assertEquals(listOf(2L, 2L), f.receipts)
        } finally { f.scope.cancel(); f.cache.delete() }
    }

    @Test fun restoringDefaultPersistsItsRevisionAndOfflineRestartCatchesUp() = runBlocking {
        val f = Fixture()
        try {
            f.seed(profile(), 2, f.png())
            f.appearance.bind(f.pair); f.settle(); f.connect()
            f.appearance.accept(f.state(3)); f.settle()
            assertNull(f.shown)
            assertEquals(listOf(2L, 3L), f.receipts)
            f.appearance.accept(f.state(2, profile())); f.settle()
            assertNull(f.shown)
            assertEquals(listOf(2L, 3L), f.receipts)
            f.appearance.disconnected(); f.scope.cancel()
            val restarted = AppearanceState(f.context, this) { f.shown = it }
            restarted.bind(f.pair)
            coroutineContext.job.children.toList().joinAll()
            restarted.connected { f.receipts += it.getLong("profile_version") }
            assertEquals(listOf(2L, 3L, 3L), f.receipts)
            assertNull(f.shown)
        } finally { f.scope.cancel(); f.cache.delete() }
    }

    @Test fun supersededOrOtherOwnerCacheCannotPublishAReceipt() = runBlocking {
        val f = Fixture()
        try {
            f.seed(profile(), 2, f.png())
            f.appearance.bind(f.pair)
            f.appearance.accept(f.state(3)); f.settle(); f.connect()
            assertNull(f.shown)
            assertEquals(listOf(3L), f.receipts)
            f.appearance.bind(f.pair.put("paired_at", "pair-2")); f.settle(); f.connect()
            assertEquals(listOf(3L), f.receipts)
            assertNull(f.shown)
            assertFalse(f.cache.exists())
        } finally { f.scope.cancel(); f.cache.delete() }
    }

    @Test fun undecodableCacheAndInvalidStateNeverClaimLoaded() = runBlocking {
        val f = Fixture()
        try {
            val invalidImage = byteArrayOf(1, 2, 3)
            assertNull(BitmapFactory.decodeByteArray(invalidImage, 0, invalidImage.size))
            f.seed(profile(), 2, invalidImage)
            f.appearance.bind(f.pair); f.settle(); f.connect()
            assertTrue(f.receipts.isEmpty())
            listOf(-1, 1.5, "2").forEach { version ->
                assertThrows(IllegalArgumentException::class.java) {
                    f.appearance.accept(f.state(2, profile()).put("profile_version", version))
                }
            }
            assertThrows(IllegalArgumentException::class.java) { f.appearance.accept(f.state(3, profile())) }
            assertTrue(f.receipts.isEmpty())
        } finally { f.scope.cancel(); f.cache.delete() }
    }

}
