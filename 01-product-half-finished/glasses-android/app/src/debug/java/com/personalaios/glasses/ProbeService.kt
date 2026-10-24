package com.personalaios.glasses

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.*

/** Signature-protected debug entry point. Some probes control the real companion and its capture/call intent. */
class ProbeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var tasks = 0
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("probes", "Debug device probes", NotificationManager.IMPORTANCE_LOW))
        startForeground(2, Notification.Builder(this, "probes").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Debug device probe").build(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val request = requireNotNull(intent)
        val probe = requireNotNull(request.getStringExtra("probe")) { "probe extra required" }
        tasks++
        scope.launch {
            try {
                check(DeviceDiagnostics.run(this@ProbeService, probe, request) {
                    CompanionService.state.value = CompanionService.state.value.copy(capture = it)
                }) { "Unknown debug probe $probe" }
                Log.i("YimiProbe", "probe_complete probe=$probe")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                Log.e("YimiProbe", "probe_failed probe=$probe", error)
            } finally {
                tasks--
                if (tasks == 0) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
            }
        }
        return START_NOT_STICKY
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
