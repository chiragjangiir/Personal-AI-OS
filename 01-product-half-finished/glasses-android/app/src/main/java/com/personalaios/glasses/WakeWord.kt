package com.personalaios.glasses

import android.content.res.AssetManager
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Automatic local capture requires 随身模式 and yields to phone audio outside our own call. */
fun localCaptureArmed(state: HudState): Boolean = state.paired && state.localWakeEnabled && state.ambient &&
    state.capture.worn == true && (!state.phoneAudio || state.callId != null && !state.callClosing)

/** Standby wake belongs to this glasses service, independent of transport. */
fun wakeTaps(state: HudState, paying: Boolean = false): Boolean =
    localCaptureArmed(state) && state.callId == null && !state.busy && !paying && state.voiceEnrollment.phase !in enrolmentWindow

enum class LocalWakeState { Off, Loading, WaitingForAudio, LocalReady, Unavailable }

/** The existing SDK recorder supplies local-only samples. No standby samples are written or uploaded. */
class WakeWord(private val assets: AssetManager, private val onWake: () -> Unit,
    private val onState: (LocalWakeState) -> Unit = {}) : AudioTrackSink {
    private val lock = Object()
    private val ring = FloatArray(48000) // At most one second at supported WebRTC rates.
    private var start = 0
    private var size = 0
    private var rate = 0
    private var fresh = true
    private var closed = false
    @Volatile private var hearing = false
    private var modelReady = false
    private var modelFailed = false
    private var receiving = false
    private var lastAudio = 0L
    private var reported: LocalWakeState? = null
    private fun report() {
        val next = when {
            closed -> LocalWakeState.Off
            modelFailed -> LocalWakeState.Unavailable
            !hearing -> LocalWakeState.Off
            !modelReady -> LocalWakeState.Loading
            !receiving -> LocalWakeState.WaitingForAudio
            else -> LocalWakeState.LocalReady
        }
        if (reported != next) { reported = next; onState(next) }
    }

    init { Thread(::spot, "yimi-wake").apply { isDaemon = true }.start() }

    /** Hear only while a wake would count; each hearing starts on a new stream, with no audio from before it. */
    fun listen(on: Boolean) = synchronized(lock) { if (on != hearing) { hearing = on; size = 0; start = 0; ring.fill(0f); receiving = false; fresh = true; report(); lock.notifyAll() } }
    fun close() = synchronized(lock) { closed = true; hearing = false; size = 0; ring.fill(0f); receiving = false; report(); lock.notifyAll() }

    private fun captureLost() {
        receiving = false; fresh = true; size = 0; start = 0; ring.fill(0f); report()
    }

    // WebRTC's recording thread, every 10 ms: copy into the ring and return.
    override fun onData(audio: ByteBuffer, bits: Int, sampleRate: Int, channels: Int, frames: Int, captureMs: Long) {
        if (!hearing || bits != 16 || sampleRate !in 8000..48000 || channels <= 0 ||
            frames <= 0 || frames.toLong() > audio.remaining().toLong() / (2L * channels)) return
        audio.order(ByteOrder.LITTLE_ENDIAN)
        synchronized(lock) {
            if (!hearing) return
            val now = SystemClock.elapsedRealtime()
            if (receiving && now - lastAudio >= 1000) captureLost()
            lastAudio = now
            if (!receiving) { receiving = true; report() }
            if (sampleRate != rate) { rate = sampleRate; size = 0; fresh = true }
            for (frame in 0 until frames) {
                var sum = 0
                for (channel in 0 until channels) sum += audio.getShort(audio.position() + 2 * (frame * channels + channel))
                ring[(start + size) % ring.size] = sum / (channels * 32768f)
                if (size < sampleRate) size++ else { start = (start + 1) % ring.size; fresh = true }
            }
            if (size >= rate / 10) lock.notify()
        }
    }

    private fun spot() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
        val loading = SystemClock.elapsedRealtime()
        val spotter = try { KeywordSpotter(assets, CONFIG) }
            catch (error: Throwable) {
                synchronized(lock) { modelFailed = true; report() }
                Log.w("Yimi", "wake_word unavailable ${error.message}"); return
            }
        synchronized(lock) { modelReady = true; report() }
        Log.i("Yimi", "wake_word ready load_ms=${SystemClock.elapsedRealtime() - loading}")
        var stream: OnlineStream? = null
        var streamRate = 0
        var chunk = FloatArray(0)
        try {
            while (true) {
                synchronized(lock) {
                    while (!closed && (rate == 0 || size < rate / 10)) {
                        lock.wait(1000)
                        if (receiving && SystemClock.elapsedRealtime() - lastAudio >= 1000) {
                            captureLost()
                        }
                    }
                    if (closed) return
                    // A stream never changes its input rate (sherpa exits the process on that), so a new rate gets a new stream.
                    if (fresh || streamRate != rate) { stream?.release(); stream = null; fresh = false; streamRate = rate }
                    if (chunk.size != rate / 10) chunk = FloatArray(rate / 10)
                    for (i in chunk.indices) chunk[i] = ring[(start + i) % ring.size]
                    start = (start + chunk.size) % ring.size; size -= chunk.size
                }
                val active = stream ?: spotter.createStream().also { stream = it }
                active.acceptWaveform(chunk, streamRate)
                while (spotter.isReady(active)) {
                    spotter.decode(active)
                    if (spotter.getResult(active).keyword.isNotEmpty()) {
                        spotter.reset(active)
                        val accepted = synchronized(lock) {
                            if (receiving && SystemClock.elapsedRealtime() - lastAudio >= 1000) captureLost()
                            if (!hearing || !receiving || fresh || closed) false else {
                                hearing = false; size = 0; start = 0; ring.fill(0f); receiving = false; report(); true
                            }
                        }
                        if (accepted) onWake()
                    }
                }
            }
        } catch (error: Exception) {
            synchronized(lock) { modelFailed = true; report() }
            Log.w("Yimi", "wake_word failed ${error.message}")
        } finally { stream?.release(); spotter.release() }
    }

    private companion object {
        // The server's calibrated spotter (personal-aios-integration src/voiceprint/engine.ts, same pinned model files):
        // assets/kws/keywords.txt uses "y ī m ǐ @依米" with score 2.0 and threshold 0.15.
        const val SCORE = 2.0f
        const val THRESHOLD = 0.15f
        val CONFIG = KeywordSpotterConfig(FeatureConfig(), OnlineModelConfig(OnlineTransducerModelConfig(
            "kws/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "kws/decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "kws/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"), tokens = "kws/tokens.txt"),
            maxActivePaths = 4, keywordsFile = "kws/keywords.txt", keywordsScore = SCORE, keywordsThreshold = THRESHOLD, numTrailingBlanks = 1)
    }
}
