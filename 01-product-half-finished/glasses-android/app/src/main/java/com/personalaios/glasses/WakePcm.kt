package com.personalaios.glasses

import android.os.SystemClock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import livekit.org.webrtc.AudioTrackSink
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.Base64

/** User mute replaces samples before app retention; sequence and callback timing remain continuous. */
internal fun wakeCaptureSamples(audio: ByteBuffer, muted: Boolean): ByteBuffer =
    if (muted) ByteBuffer.allocate(audio.remaining()) else audio

/** One SDK tap, one ordered wake-call stream. Pending PCM (including the sending head) never exceeds five seconds. */
internal class WakePcm(private val available: () -> Unit, private val overflow: (String) -> Unit,
    private val wallMs: () -> Long = ServerClock.shared::nowMillis,
    private val elapsedMs: () -> Long = SystemClock::elapsedRealtime) : AudioTrackSink {
    data class Packet(val callId: String, val seq: Long, val capturedAtMs: Long, val pcm: ByteArray) {
        fun message(): JSONObject = JSONObject().put("operation", "call_pcm").put("call_id", callId).put("seq", seq)
            .put("captured_at_ms", capturedAtMs).put("sample_rate", 16000)
            .put("pcm_s16le_base64", Base64.getEncoder().encodeToString(pcm))
    }
    private data class Frame(val capturedAtMs: Long, val pcm: ByteArray, val seq: Long = -1)
    private val frames = ArrayDeque<Frame>()
    private var standby = false
    private var call: String? = null
    private var acknowledged = false
    private var receipt = CompletableDeferred<Boolean>()
    private val sending = Mutex()
    private var sealed = false
    private var sequence = 0L
    private var retainedSamples = 0
    private val partial = ByteArray(3200)
    private var used = 0
    private var anchorMs: Long? = null
    private var sampleCount = 0L
    private var lastCallbackMs: Long? = null
    private var lastRate = 0

    @Synchronized fun standby(on: Boolean) {
        standby = on
        if (!on && call == null) clear()
    }
    @Synchronized fun begin(id: String): Boolean {
        if (call != null) return false
        call = id; acknowledged = false; receipt = CompletableDeferred(); sealed = false; sequence = 0
        val preroll = frames.toList(); frames.clear()
        for (frame in preroll) frames.add(frame.copy(seq = sequence++))
        return true
    }
    @Synchronized fun acknowledge(id: String) {
        if (call == id) { acknowledged = true; receipt.complete(true); available() }
    }
    @Synchronized fun owns(id: String): Boolean = call == id
    @Synchronized fun seal(id: String): Boolean {
        if (call != id) return false
        flushPartial(); sealed = true
        return true
    }
    suspend fun awaitAcknowledged(id: String): Boolean {
        val pending = synchronized(this) { if (call != id) return false else receipt }
        return pending.await()
    }
    @Synchronized fun next(): Packet? {
        val id = call ?: return null
        if (!acknowledged) return null
        return frames.peekFirst()?.let { Packet(id, it.seq, it.capturedAtMs, it.pcm) }
    }
    @Synchronized fun sent(id: String, seq: Long) {
        if (call == id && frames.peekFirst()?.seq == seq) retainedSamples -= frames.removeFirst().pcm.size / 2
    }
    suspend fun drain(id: String, send: suspend (Packet) -> Unit) = sending.withLock {
        while (true) {
            val packet = next() ?: break
            if (packet.callId != id) break
            send(packet); sent(id, packet.seq)
        }
    }
    /** Explicit local close seals and delivers its final partial before the lifecycle publishes close. */
    suspend fun finish(id: String, send: suspend (Packet) -> Unit, close: suspend () -> Unit): Boolean {
        if (!seal(id) || !awaitAcknowledged(id)) return false
        drain(id, send)
        if (!owns(id)) return false
        close()
        return true
    }
    @Synchronized fun end(id: String? = null) {
        if (id != null && call != id) return
        receipt.complete(false); call = null; acknowledged = false; sealed = false; sequence = 0; clear()
    }
    private fun clear() {
        frames.clear(); retainedSamples = 0; used = 0; partial.fill(0); anchorMs = null; sampleCount = 0; lastCallbackMs = null; lastRate = 0
    }

    private fun flushPartial() {
        if (used == 0) return
        val at = checkNotNull(anchorMs) + (sampleCount - used / 2) * 1000L / 16000
        frames.add(Frame(at, partial.copyOf(used), if (call == null) -1 else sequence++))
        retainedSamples += used / 2; used = 0
        if (call != null) available()
    }

    @Synchronized override fun onData(audio: ByteBuffer, bits: Int, sampleRate: Int, channels: Int, inputFrames: Int, captureMs: Long) {
        if (sealed || (!standby && call == null) || bits != 16 || sampleRate !in 8000..48000 || channels <= 0) return
        // SDK times callback arrival, not ADC capture. A missing callback interval or rate change starts a new estimate.
        val durationMs = inputFrames * 1000L / sampleRate
        val interrupted = lastCallbackMs?.let { sampleRate != lastRate || captureMs - it >= durationMs * 2 } == true
        if (interrupted) {
            if (call == null) clear() else { flushPartial(); anchorMs = null; sampleCount = 0 }
        }
        if (anchorMs == null) anchorMs = wallMs() - (elapsedMs() - captureMs) - durationMs
        lastCallbackMs = captureMs; lastRate = sampleRate
        val samples = audio.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val outputFrames = inputFrames * 16000 / sampleRate
        fun mono(index: Int): Float {
            var sum = 0f
            for (channel in 0 until channels) sum += samples.getShort(samples.position() + 2 * (index * channels + channel))
            return sum / channels
        }
        // WebRTC emits 10ms frames; linear interpolation keeps their duration when converting to 16k mono.
        for (i in 0 until outputFrames) {
            val id = call
            if (id != null && retainedSamples + used / 2 >= 80000) {
                end(); overflow(id); return
            }
            val position = i * sampleRate.toDouble() / 16000
            val left = position.toInt().coerceAtMost(inputFrames - 1)
            val right = (left + 1).coerceAtMost(inputFrames - 1)
            val value = (mono(left) + (mono(right) - mono(left)) * (position - left)).toInt().coerceIn(-32768, 32767)
            partial[used++] = value.toByte(); partial[used++] = (value shr 8).toByte(); sampleCount++
            if (used == partial.size) flushPartial()
            if (id == null) while (retainedSamples + used / 2 > 16000) retainedSamples -= frames.removeFirst().pcm.size / 2
        }
    }
}
