package com.personalaios.glasses

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.alivc.rtc.AliRtcEngine.*

/** ARTC's synchronized 48 kHz mono PCM. Bounded native buffer; callback never waits for playback. */
internal class AvatarAudio(private val failed: () -> Unit) : AliRtcAudioFrameObserver {
    private var output: AudioTrack? = AudioTrack(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
        AudioFormat.Builder().setSampleRate(48_000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build(),
        maxOf(19_200, AudioTrack.getMinBufferSize(48_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)),
        AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
    init {
        val player = checkNotNull(output)
        if (player.state != AudioTrack.STATE_INITIALIZED) { player.release(); error("Avatar audio unavailable") }
        player.play()
    }
    @Synchronized override fun onPlaybackAudioFrame(frame: AliRtcAudioFrame): Boolean {
        val player = output ?: return false
        val bytes = frame.data
        if (frame.samplesPerSec != 48_000 || frame.numChannels != 1 || frame.bytesPerSample != 2 ||
            frame.numSamples !in 1..4800 || bytes == null || bytes.size < frame.numSamples * 2) {
            failed(); return false
        }
        val written = player.write(bytes, 0, frame.numSamples * 2, AudioTrack.WRITE_NON_BLOCKING)
        if (written != frame.numSamples * 2) { failed(); return false }
        return true
    }
    @Synchronized fun flush() { output?.let { it.pause(); it.flush(); it.play() } }
    @Synchronized fun close() { output?.let { output = null; it.pause(); it.flush(); it.release() } }
    override fun onCapturedAudioFrame(frame: AliRtcAudioFrame) = false
    override fun onProcessCapturedAudioFrame(frame: AliRtcAudioFrame) = false
    override fun onPublishAudioFrame(frame: AliRtcAudioFrame) = false
    override fun onMixedAllAudioFrame(frame: AliRtcAudioFrame) = false
    override fun onRemoteUserAudioFrame(uid: String, frame: AliRtcAudioFrame) = false
}
