package com.personalaios.glasses

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.*
import org.json.JSONObject

/** Occupies only this app's camera. Reports failure if same-UID arbitration cannot exercise recovery. */
class CameraAvailabilityProbe(context: Context) {
    private val manager = context.getSystemService(CameraManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    @SuppressLint("MissingPermission")
    suspend fun run(capture: FirstPersonCapture, pause: (Boolean) -> Unit,
        frames: () -> Long, report: (JSONObject) -> Unit) {
        val id = manager.cameraIdList.first {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        }
        val unavailable = CompletableDeferred<Long>()
        val released = CompletableDeferred<Long>()
        val opened = CompletableDeferred<CameraDevice>()
        var holder: CameraDevice? = null
        var openingHolder = false
        var releasing = false
        var closed = false
        var holderLost = false
        var prematurelyAvailable = false
        val callback = object : CameraManager.AvailabilityCallback() {
            override fun onCameraAvailable(cameraId: String) {
                if (cameraId == id) {
                    report(JSONObject().put("event", "native_available").put("camera_id", id).put("after_release", releasing))
                    if (releasing) released.complete(SystemClock.elapsedRealtime())
                    else if (openingHolder && unavailable.isCompleted) prematurelyAvailable = true
                }
            }
            override fun onCameraUnavailable(cameraId: String) {
                if (cameraId == id) {
                    report(JSONObject().put("event", "native_unavailable").put("camera_id", id).put("holder_opening", openingHolder))
                    if (openingHolder && !releasing) unavailable.complete(SystemClock.elapsedRealtime())
                }
            }
        }
        pause(true)
        manager.registerAvailabilityCallback(callback, handler)
        try {
            delay(2500)
            openingHolder = true
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    if (closed) camera.close() else { holder = camera; opened.complete(camera) }
                }
                override fun onDisconnected(camera: CameraDevice) { holderLost = true; camera.close(); report(JSONObject().put("event", "holder_disconnected")) }
                override fun onError(camera: CameraDevice, error: Int) {
                    holderLost = true; camera.close(); opened.completeExceptionally(IllegalStateException("Debug holder camera error $error"))
                    report(JSONObject().put("event", "holder_error").put("code", error))
                }
            }, handler)
            withTimeout(10000) { opened.await() }
            report(JSONObject().put("event", "holder_acquired"))
            pause(false)
            capture.trigger("user_request")
            val unavailableAt = withTimeout(10000) { unavailable.await() }
            withTimeout(8000) {
                while (true) {
                    val state = capture.state.value
                    if (!state.paused && state.worn == true && state.status in setOf("unavailable", "error")) {
                        report(JSONObject().put("event", "capture_unavailable_while_held").put("status", state.status)
                            .put("paused", state.paused).put("worn", state.worn))
                        break
                    }
                    delay(250)
                }
            }
            delay(8000)
            check(!holderLost && !prematurelyAvailable) { "Camera became available before holder release; held recovery not proven" }
            val priorFrames = frames()
            releasing = true
            holder?.close(); holder = null
            report(JSONObject().put("event", "holder_released"))
            val availableAt = withTimeout(15000) { released.await() }
            report(JSONObject().put("event", "availability_restored").put("unavailable_duration_ms", availableAt - unavailableAt))
            withTimeout(45000) { while (frames() == priorFrames) delay(500) }
            report(JSONObject().put("event", "recovered_frame").put("frames_after_release", frames() - priorFrames).put("unavailable_duration_ms", availableAt - unavailableAt))
        } finally { closed = true; holder?.close(); manager.unregisterAvailabilityCallback(callback); pause(false) }
    }
}
