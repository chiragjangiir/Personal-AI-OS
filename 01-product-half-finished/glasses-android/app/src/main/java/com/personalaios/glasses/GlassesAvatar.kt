package com.personalaios.glasses

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import com.alivc.rtc.AliRtcEngine
import com.alivc.rtc.AliRtcEngine.*
import com.alivc.rtc.AliRtcEngineEventListener
import com.alivc.rtc.AliRtcEngineNotify
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/** ARTC single-token adapter. LiveKit retains capture; one decoder feeds both optical previews. */
internal class GlassesAvatar(private val context: Context, private val scope: CoroutineScope,
    private val stream: AvatarStream, private val hosts: StateFlow<List<FrameLayout>?>,
    private val send: (JSONObject) -> Unit) {
    private var audio: AvatarAudio? = null
    fun flushPlayback() { audio?.flush() }
    fun start() {
        scope.launch { stream.phase.collectLatest { phase ->
            if (phase == AvatarStream.Phase.Waiting) {
                delay(15_000); stream.unavailable()?.let(send)
            }
        } }
        scope.launch {
            combine(stream.media, hosts) { media, views -> media to views }.distinctUntilChanged().collectLatest { (media, views) ->
                if (media == null) return@collectLatest
                if (views == null) { stream.failed(media)?.let(send); return@collectLatest }
                var rtc: AliRtcEngine? = null
                var current = true
                val first = CompletableDeferred<Unit>()
                fun fail() { scope.launch { if (current) stream.failed(media)?.let(send) } }
                engineLease.withLock {
                    try {
                        val engine = AliRtcEngine.getInstance(context.applicationContext,
                            "{\"user_specified_use_external_audio_record\":\"TRUE\",\"user_specified_use_external_audio_player\":\"TRUE\"}")
                        rtc = engine
                        AliRtcEngine.setLogLevel(AliRtcLogLevel.AliRtcLogLevelNone)
                        AliRtcEngine.enableUploadLog(false); engine.enableStatsReport(false)
                        fun checked(code: Int) { check(code == 0) { "ARTC operation failed: $code" } }
                        val source = engine.createRenderTextureView(views[0].context)
                        val previews = views.map { ImageView(it.context).apply { scaleType = ImageView.ScaleType.FIT_CENTER } }
                        views[0].addView(source, FrameLayout.LayoutParams(-1, -1))
                        views.zip(previews).forEach { (host, preview) -> host.addView(preview, FrameLayout.LayoutParams(-1, -1)) }
                        views.forEach { it.visibility = View.VISIBLE }
                        engine.setRtcEngineEventListener(object : AliRtcEngineEventListener() {
                            override fun onJoinChannelResult(result: Int, channel: String?, user: String?, elapsed: Int) {
                                if (result == 0) return
                                Log.w("YimiAvatar", "join_failed code=$result")
                                fail()
                            }
                            override fun onOccurError(error: Int, message: String?) {
                                // Subscribe-only engines report unused publishing/capture errors, as on iPhone.
                                if (error in unusedPathErrors) return
                                Log.w("YimiAvatar", "rtc_failed code=$error")
                                fail()
                            }
                            override fun onConnectionLost() { fail() }
                        })
                        engine.setRtcEngineNotify(object : AliRtcEngineNotify() {
                            override fun onRemoteTrackAvailableNotify(uid: String, audio: AliRtcAudioTrack, video: AliRtcVideoTrack) {
                                scope.launch bindView@{
                                    if (!current || video == AliRtcVideoTrack.AliRtcVideoTrackNo) return@bindView
                                    val track = if (video == AliRtcVideoTrack.AliRtcVideoTrackScreen) video else AliRtcVideoTrack.AliRtcVideoTrackCamera
                                    val canvas = AliRtcVideoCanvas().apply { view = source; renderMode = AliRtcRenderMode.AliRtcRenderModeAuto }
                                    if (engine.setRemoteViewConfig(canvas, uid, track) != 0) fail()
                                }
                            }
                            override fun onFirstRemoteVideoFrameDrawn(uid: String, track: AliRtcVideoTrack, width: Int, height: Int, elapsed: Int) {
                                scope.launch { if (current) { first.complete(Unit) } }
                            }
                            override fun onAuthInfoExpired() { fail() }
                            override fun onRtcRemoteVideoStats(stats: AliRtcRemoteVideoStats) {
                                Log.i("YimiAvatar", "decode width=${stats.width} height=${stats.height} fps=${stats.decodeFps} render_fps=${stats.renderFps} bitrate=${stats.recvBitrate}")
                            }
                        })
                        checked(engine.enableLocalVideo(false)); checked(engine.publishLocalVideoStream(false))
                        checked(engine.publishLocalAudioStream(false))
                        audio = AvatarAudio(::fail).also { engine.registerAudioFrameObserver(it) }
                        checked(engine.enableAudioFrameObserver(true, AliRtcAudioSource.AliRtcAudioSourcePlayback, AliRtcAudioFrameObserverConfig()))
                        engine.setVideoDecoderConfiguration(AliRtcVideoDecoderConfiguration().apply {
                            codecType = AliRtcVideoCodecType.AliRtcVideoCodecTypeHardware
                        })
                        checked(engine.setRemoteDefaultVideoStreamType(AliRtcVideoStreamType.AliRtcVideoStreamTypeLow))
                        checked(engine.joinChannel(media.token, null, media.user, media.user))
                        withTimeout(10_000) { first.await() }
                        // Copy only the small preview, never the decoded full-resolution frame. Reuse its bitmap.
                        val bitmap = Bitmap.createBitmap(144, 144, Bitmap.Config.ARGB_8888)
                        while (currentCoroutineContext().isActive) {
                            if (source.isAvailable) { source.getBitmap(bitmap); previews.forEach { it.setImageBitmap(bitmap); it.invalidate() }; stream.drawn(media) }
                            delay(67)
                        }
                    } catch (cancelled: CancellationException) {
                        if (cancelled is TimeoutCancellationException) stream.failed(media)?.let(send) else throw cancelled
                    } catch (error: Exception) {
                        Log.w("YimiAvatar", "receive_failed ${error.javaClass.simpleName}")
                        stream.failed(media)?.let(send)
                    } finally {
                        current = false
                        audio?.close(); audio = null
                        views.forEach { it.removeAllViews(); it.visibility = View.GONE }
                        withContext(NonCancellable) {
                            rtc?.let { engine ->
                                engine.enableAudioFrameObserver(false, AliRtcAudioSource.AliRtcAudioSourcePlayback, null)
                                engine.registerAudioFrameObserver(null)
                                engine.setRtcEngineEventListener(null); engine.setRtcEngineNotify(null)
                                engine.leaveChannel()
                                suspendCoroutine<Unit> { continuation -> engine.destroy { continuation.resume(Unit) } }
                            }
                        }
                    }
                }
            }
        }
    }

    fun receive(packet: JSONObject, activeCall: String?) {
        try { stream.receive(packet, activeCall)?.let(send) }
        catch (error: Exception) {
            Log.w("YimiAvatar", "media_rejected ${error.javaClass.simpleName}")
            stream.unavailable()?.let(send)
        }
    }
    companion object {
        private val engineLease = Mutex()
        private val unusedPathErrors = setOf(0x01030305, 0x01010406, 0x01010450, 0x01010451,
            0x01010452, 0x01010453, 0x01010454, 0x01040404, 0x01040406, 0x01040408,
            0x01040409, 0x01040104, 0x01040106)
    }
}
