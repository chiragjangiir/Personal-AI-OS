package com.personalaios.glasses

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.URI
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Private device evidence. Captured JPEG bytes are measured and discarded, never uploaded or saved. */
object DeviceDiagnostics {
    private val fixtureCards = HudCards("glasses")
    private var capture: FirstPersonCapture? = null
    private var captureEvidence: File? = null
    private var capturedFrames = 0L
    private var cameraFailures = 0L
    fun trigger(): Boolean {
        val active = capture ?: return false
        append(checkNotNull(captureEvidence), JSONObject().put("event", "external_trigger_request").put("trigger", "user_request"))
        active.trigger("user_request")
        return true
    }
    private var policy: JSONObject? = null
    fun setPrivatePause(value: Boolean) {
        val active = checkNotNull(capture) { "No active capture soak" }
        active.applyPolicy(checkNotNull(policy).put("private_paused", value))
    }
    suspend fun run(context: Context, action: String, intent: Intent, onState: (CaptureState) -> Unit): Boolean {
        val probe = DeviceProbe(context, DeviceSenses(context))
        when (action) {
            "facts" -> probe.facts()
            "mic" -> probe.microphones()
            "ambient" -> probe.microphones(180, continuous = true)
            "imu" -> probe.imu()
            "private" -> setPrivatePause(intent.getBooleanExtra("paused", true))
            // Enabling requests confirmation; the signed test caller must confirm separately.
            "ambient_mode" -> context.startService(Intent(context, CompanionService::class.java).setAction("AMBIENT")
                .putExtra("on", intent.getBooleanExtra("on", false)))
            "ambient_confirm", "ambient_cancel" -> context.startService(Intent(context, CompanionService::class.java).setAction(action.uppercase()))
            // Debug builds only: the temple click's talk (TAP) and hang-up (STOP) for adb acceptance runs.
            "tap", "stop" -> context.startService(Intent(context, CompanionService::class.java).setAction(action.uppercase()))
            "availability" -> cameraAvailability(context)
            "card" -> {
                val message = JSONObject(File(context.filesDir, "device-probes/display-card.json").readText())
                CompanionService.state.value = CompanionService.state.value.copy(paired = true, status = "Debug card fixture", cards = fixtureCards.accept(message))
                context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            "soak" -> soak(context, probe, intent.getBooleanExtra("synthetic_worn", false), onState)
            "user_request" -> check(trigger()) { "No active capture soak" }
            "reconnect" -> reconnect(context, checkNotNull(intent.getStringExtra("gateway")) { "gateway origin required" })
            else -> return false
        }
        return true
    }
    private fun evidence(context: Context, name: String): File {
        val directory = File(context.filesDir, "device-probes")
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create private evidence directory" }
        return File(directory, "$name-${System.currentTimeMillis()}.jsonl")
    }
    private fun append(file: File, event: JSONObject) {
        val line = event.put("elapsed_ms", SystemClock.elapsedRealtime()).toString()
        synchronized(file) { file.appendText("$line\n") }
        Log.i("YimiProbe", line)
    }
    private fun temperature(context: Context): Any {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return if (battery?.hasExtra(BatteryManager.EXTRA_TEMPERATURE) == true)
            battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0 else JSONObject.NULL
    }
    private suspend fun soak(context: Context, probe: DeviceProbe, syntheticWorn: Boolean, onState: (CaptureState) -> Unit) = coroutineScope {
        val file = evidence(context, "capture-soak")
        val power = context.getSystemService(PowerManager::class.java)
        val realSenses = DeviceSenses(context)
        val actualWear = java.util.concurrent.atomic.AtomicReference(withContext(Dispatchers.IO) { realSenses.wearState() })
        val senses = object : DeviceSenses(context) {
            override fun wearState(): String {
                val actual = realSenses.wearState(); actualWear.set(actual)
                return if (syntheticWorn) "WEARING" else actual
            }
        }
        check(capture == null) { "Capture soak already active" }
        val start = SystemClock.elapsedRealtime()
        var frames = 0L
        var bytes = 0L
        var previous = start
        var operationStarted = 0L
        val byTrigger = JSONObject().put("interval", 0).put("scene_change", 0).put("head_dwell", 0).put("user_request", 0)
        var audio: JSONObject? = null
        var outcome = "failed"
        var terminalError: String? = null
        append(file, JSONObject().put("event", "start").put("duration_seconds", 1800)
            .put("synthetic_worn", syntheticWorn).put("actual_wear_state", actualWear.get())
            .put("sample_rate", 16000).put("microphone_source", "MIC").put("wake_lock", "microphone_recording_only").put("delivery", "captured_bytes_only_no_upload"))
        capturedFrames = 0; cameraFailures = 0
        val controller = FirstPersonCapture(context, this, { jpeg, width, height, trigger ->
            val now = SystemClock.elapsedRealtime()
            frames++; capturedFrames++; bytes += jpeg.size
            byTrigger.put(trigger, byTrigger.optLong(trigger) + 1)
            append(file, JSONObject().put("event", "captured").put("frame_count", frames)
                .put("captured_bytes", jpeg.size).put("total_captured_bytes", bytes)
                .put("width", width).put("height", height).put("trigger", trigger).put("worn", capture?.state?.value?.worn ?: JSONObject.NULL)
                .put("capture_operation_to_delivery_ms", if (operationStarted == 0L) JSONObject.NULL else now - operationStarted)
                .put("since_previous_ms", now - previous).put("thermal_status", power.currentThermalStatus).put("battery_temperature_c", temperature(context)))
            previous = now
        }, { worn -> append(file, JSONObject().put("event", "wear").put("worn", worn).put("synthetic_worn", syntheticWorn)) },
            { error ->
                if (capture?.state?.value?.status == "error") cameraFailures++
                append(file, JSONObject().put("event", "failure").put("error", error.toString()))
            }, senses)
        capture = controller; captureEvidence = file
        try {
            policy = JSONObject().put("enabled", true).put("interval_ms", 30000)
                .put("triggers", JSONArray(listOf("interval", "scene_change", "head_dwell", "user_request")))
                .put("private_paused", false)
            controller.applyPolicy(checkNotNull(policy))
            controller.setAmbient(true) // the soak is an explicit capture test, not 随身模式
            controller.setAvailable(true)
            val hud = launch(start = CoroutineStart.UNDISPATCHED) { controller.state.collect {
                if (it.status == "capturing" && operationStarted == 0L) {
                    operationStarted = SystemClock.elapsedRealtime()
                    append(file, JSONObject().put("event", "capture_operation_start"))
                } else if (it.status != "capturing") operationStarted = 0
                onState(it)
            } }
            val microphone = async { probe.microphones(1800, continuous = true) { audio = it; append(file, it) } }
            val monitoring = launch {
                while (isActive) {
                    val state = controller.state.value
                    append(file, JSONObject().put("event", "state").put("thermal_status", power.currentThermalStatus).put("battery_temperature_c", temperature(context))
                        .put("worn", state.worn ?: JSONObject.NULL).put("paused", state.paused)
                        .put("capturing", state.capturing).put("frame_count", frames))
                    delay(10000)
                }
            }
            try { microphone.await() }
            finally { monitoring.cancelAndJoin(); hud.cancelAndJoin() }
            check(frames > 0) { "Capture soak produced no frames; inspect wear and camera evidence" }
            outcome = "complete"
        } catch (error: Exception) {
            outcome = if (error is CancellationException) "cancelled" else "failed"
            terminalError = error.toString()
            throw error
        } finally {
            capture = null; captureEvidence = null; policy = null; controller.close(); onState(controller.state.value)
            append(file, JSONObject().put("event", "summary").put("outcome", outcome)
                .put("synthetic_worn", syntheticWorn).put("actual_wear_state", actualWear.get())
                .put("duration_ms", SystemClock.elapsedRealtime() - start).put("frame_count", frames)
                .put("total_captured_bytes", bytes).put("frames_by_trigger", byTrigger).put("camera_failures", cameraFailures)
                .put("microphone", audio ?: JSONObject.NULL).put("error", terminalError ?: JSONObject.NULL)
                .put("thermal_status", power.currentThermalStatus).put("battery_temperature_c", temperature(context)))
        }
    }
    private suspend fun cameraAvailability(context: Context) {
        val controller = checkNotNull(capture) { "No active capture soak" }
        check(controller.state.value.worn == true && !controller.state.value.paused) { "Recovery probe requires worn, active capture" }
        val file = evidence(context, "camera-availability")
        CameraAvailabilityProbe(context).run(controller, ::setPrivatePause, { capturedFrames }) { append(file, it) }
    }
    private suspend fun reconnect(context: Context, gateway: String) = coroutineScope {
        val origin = URI(gatewayOrigin(gateway))
        val file = evidence(context, "socket-reconnect")
        val done = CompletableDeferred<Unit>()
        val loop = ConnectionLoop()
        var attempts = 0
        var actionCompletions = 0
        var queued: Job? = null
        val driver = launch {
            loop.run({ connected ->
                withContext(Dispatchers.IO) {
                    (SSLSocketFactory.getDefault().createSocket() as SSLSocket).use { socket ->
                        socket.connect(InetSocketAddress(origin.host, if (origin.port == -1) 443 else origin.port), 10000)
                        socket.soTimeout = 10000
                        socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                        socket.startHandshake()
                        attempts++; connected()
                        append(file, JSONObject().put("event", "tls_connected").put("attempt", attempts)
                            .put("host", origin.host).put("proof", "socket_retry_driver_only_not_authenticated_livekit"))
                        if (attempts == 1) {
                            socket.close()
                            throw IOException("Debug probe closed its own TLS socket")
                        }
                        awaitCancellation()
                    }
                }
            }, { error, delay ->
                append(file, JSONObject().put("event", "retry").put("delay_ms", delay)
                    .put("error_class", error.javaClass.name).put("error", error.toString()))
                if (attempts == 1 && queued == null) queued = launch {
                    append(file, JSONObject().put("event", "tap_queued_during_backoff").put("delay_ms", delay))
                    loop.awaitConnected()
                    actionCompletions++
                    append(file, JSONObject().put("event", "tap_completed").put("count", actionCompletions).put("attempt", attempts)
                        .put("proof", "tls_probe_ready_gate_only_not_production_livekit"))
                    done.complete(Unit)
                }
            })
        }
        try { withTimeout(45000) { done.await() } } finally { driver.cancelAndJoin(); queued?.cancelAndJoin() }
        check(attempts == 2 && actionCompletions == 1) { "Reconnect action did not complete exactly once" }
        append(file, JSONObject().put("event", "complete").put("attempts", attempts).put("action_completions", actionCompletions))
    }
}
