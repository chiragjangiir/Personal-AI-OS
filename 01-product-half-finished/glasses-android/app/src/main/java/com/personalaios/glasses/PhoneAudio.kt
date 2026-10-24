package com.personalaios.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Build

/** Observe the platform's phone audio owner without opening SCO or taking audio focus. */
internal class PhoneAudio(private val context: Context, private val changed: (Boolean) -> Unit) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private var sco = false
    private val mode = AudioManager.OnModeChangedListener { report() }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            sco = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED)
                .let { it == AudioManager.SCO_AUDIO_STATE_CONNECTING || it == AudioManager.SCO_AUDIO_STATE_CONNECTED }
            report()
        }
    }
    private fun report() = changed(sco || audio.mode == AudioManager.MODE_IN_CALL ||
        audio.mode == AudioManager.MODE_IN_COMMUNICATION || audio.isBluetoothScoOn)
    fun start() {
        audio.addOnModeChangedListener(context.mainExecutor, mode)
        val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else context.registerReceiver(receiver, filter)
        report()
    }
    fun close() {
        context.unregisterReceiver(receiver)
        audio.removeOnModeChangedListener(mode)
    }
}
