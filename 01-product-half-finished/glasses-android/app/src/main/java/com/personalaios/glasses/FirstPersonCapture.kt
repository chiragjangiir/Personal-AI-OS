package com.personalaios.glasses

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.*
import android.hardware.*
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.*
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.track.LocalVideoTrack
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import livekit.org.webrtc.*
import org.json.JSONObject
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.math.abs

class CapturePolicy(value: JSONObject) {
    val enabled = value.get("enabled") as Boolean
    val privatePaused = value.get("private_paused") as Boolean
    val intervalMs = value.get("interval_ms").let { require(it is Int || it is Long); (it as Number).toLong().also { ms -> require(ms > 0) } }
    val triggers = value.getJSONArray("triggers").let { list -> (0 until list.length()).map { list.get(it) as String }.toSet() }
    fun allowsCall(available: Boolean, privacyPending: Boolean, worn: Boolean?) = available && !privacyPending && worn == true && !privatePaused
    /** First-person memory is automatic capture: only with 随身模式 on. A call's own video follows [allowsCall]. */
    fun allows(ambient: Boolean, available: Boolean, privacyPending: Boolean, worn: Boolean?) = ambient && enabled && allowsCall(available, privacyPending, worn)
    internal fun requestAvailable(pending: String?, uploading: Boolean, retryAt: Long, lastFrame: Long, now: Long,
        reason: String) = pending == null && !uploading && retryAt <= now &&
        now - lastFrame >= (if (reason == "user_request") 2000 else intervalMs)
}
data class CaptureState(val worn: Boolean? = null, val paused: Boolean = true, val capturing: Boolean = false,
    val status: String = "unavailable", val error: String? = null, val privatePaused: Boolean = true,
    val privacyPending: Boolean = false, val policyCurrent: Boolean = false,
    val callCameraRequested: Boolean = true, val callCameraPublished: Boolean = false, val closing: Boolean = false)

internal fun MutableStateFlow<CaptureState>.reconcileCapture(
    clearError: Boolean = false, project: (CaptureState) -> CaptureState
) {
    val current = value
    val next = if (clearError) current.copy(error = null) else current
    value = project(next)
}

internal fun captureIntervalDue(nextInterval: Long, lastFrame: Long, duration: Long) = maxOf(nextInterval, lastFrame + duration)

internal fun captureFailureReason(error: Throwable): String = when (error) {
    is SecurityException -> "摄像头未获授权"
    is TimeoutCancellationException -> "摄像头响应超时"
    is CameraAccessException -> when (error.reason) {
        CameraAccessException.CAMERA_IN_USE, CameraAccessException.MAX_CAMERAS_IN_USE -> "摄像头被占用"
        CameraAccessException.CAMERA_DISABLED -> "摄像头已停用"
        CameraAccessException.CAMERA_DISCONNECTED -> "摄像头连接中断"
        else -> "摄像头暂不可用"
    }
    is java.io.IOException -> "画面上传失败"
    else -> "摄像头暂不可用"
}

/** One camera owner: short JPEG sessions for memory, or a published call track with optional memory sampling. */
class FirstPersonCapture(context: Context, parent: CoroutineScope,
    private val onFrame: suspend (ByteArray, Int, Int, String) -> Unit,
    private val onWear: (Boolean) -> Unit, private val onFailure: (Throwable) -> Unit,
    private val senses: DeviceSenses = DeviceSenses(context)
) : SensorEventListener {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]) + Dispatchers.Main.immediate)
    private val cameras = context.getSystemService(CameraManager::class.java)
    private val sensors = context.getSystemService(SensorManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val motion = HeadMotion()
    private val mutable = MutableStateFlow(CaptureState())
    val state: StateFlow<CaptureState> = mutable
    private val wearPollMs = MutableStateFlow(2000L)
    fun setWearPollMs(value: Long) { require(value > 0); wearPollMs.value = value }
    private var policy: CapturePolicy? = null
    private var policyCurrent = false
    private var available = false
    private var ambient = false
    // Safety gate only while an owner privacy request awaits authoritative server policy.
    private var privacyPending = false
    private var participant: LocalParticipant? = null
    private var call = false
    @Volatile private var epoch = 0
    private var operation: Job? = null
    private var callSetup: CompletableDeferred<Unit>? = null
    private class CallVideo(val owner: LocalParticipant, val track: LocalVideoTrack, val setup: Deferred<Unit>) {
        val retired = java.util.concurrent.atomic.AtomicBoolean()
    }
    private var video: CallVideo? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var closing = 0
    private var cameraId: String? = null
    private var cameraTraits: CameraCharacteristics? = null
    private val cameraAvailable = mutableMapOf<String, Boolean>()
    private var photoDeadline: Job? = null
    @Volatile private var pending: String? = null
    private var lastFrame = 0L
    private var failures = 0
    private var retryAt = 0L
    private var lastFailure = 0L
    private var retry: Job? = null
    private var interval: Job? = null
    private var intervalMs = 0L
    private var nextInterval = 0L
    private val rtcQueued = java.util.concurrent.atomic.AtomicBoolean()
    private fun externallyBusy() = cameraId?.let { cameraAvailable[it] == false } == true && video == null && operation == null && closing == 0
    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraUnavailable(id: String) {
            cameraAvailable[id] = false
            if (id == cameraId && externallyBusy()) reconcile()
        }
        override fun onCameraAvailable(id: String) {
            cameraAvailable[id] = true
            if (id == cameraId) {
                if (SystemClock.elapsedRealtime() - lastFailure >= 5000) { retryAt = 0; retry?.cancel() }
                reconcile()
            }
        }
    }
    init {
        scope.launch {
            pollWear(wearPollMs, {
                try {
                    val worn = withTimeout(3000) { io { senses.wearState() == "WEARING" } }
                    if (mutable.value.worn != worn) {
                        mutable.value = mutable.value.copy(worn = worn); motion.reset()
                        sensors.unregisterListener(this@FirstPersonCapture)
                        if (worn) sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
                            sensors.registerListener(this@FirstPersonCapture, it, SensorManager.SENSOR_DELAY_GAME, handler)
                        }
                        onWear(worn); reconcile(clearError = true)
                    }
                } catch (cancelled: CancellationException) { if (cancelled !is TimeoutCancellationException) throw cancelled; wearFailure(cancelled) }
                catch (error: Exception) { wearFailure(error) }
            })
        }
    }
    private fun discoverCamera() {
        val generation = epoch
        operation = scope.launch {
            try {
                val selected = withTimeout(3000) { io { cameras.cameraIdList.asSequence().map { it to cameras.getCameraCharacteristics(it) }
                    .first { it.second.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK } } }
                if (generation != epoch) return@launch
                withTimeout(3000) { io {
                    cameras.registerAvailabilityCallback(availability, handler)
                    if (!scope.isActive) cameras.unregisterAvailabilityCallback(availability)
                } }
                if (generation == epoch) { cameraId = selected.first; cameraTraits = selected.second }
            } catch (error: TimeoutCancellationException) { failed(error) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { failed(error) }
            finally { if (generation == epoch) { operation = null; reconcile() } }
        }
    }
    private fun wearFailure(error: Throwable) {
        val known = mutable.value.worn != null
        mutable.value = mutable.value.copy(worn = null); sensors.unregisterListener(this); stop()
        mutable.value = mutable.value.copy(status = "unavailable", error = "佩戴状态读取失败")
        if (known) onWear(false)
        onFailure(error)
    }
    fun attach(value: LocalParticipant?) { if (participant !== value) { stop(); participant = value; reconcile() } }
    fun setCall(value: Boolean) {
        if (call != value) {
            stop(); call = value
            if (!value) mutable.value = mutable.value.copy(callCameraRequested = true)
            reconcile()
        }
    }
    fun setCallCamera(value: Boolean) {
        if (mutable.value.callCameraRequested != value) {
            mutable.value = mutable.value.copy(callCameraRequested = value)
            reconcile()
        }
    }
    fun retry() {
        retry?.cancel(); retryAt = 0
        reconcile(clearError = true)
    }
    fun applyPolicy(value: JSONObject) { policy = CapturePolicy(value); policyCurrent = true; reconcile() }
    fun setAmbient(value: Boolean) { ambient = value; reconcile() }
    fun setAvailable(value: Boolean) { available = value; if (!value) policyCurrent = false; reconcile() }
    fun setPrivacyPending(value: Boolean) { privacyPending = value; reconcile() }
    private fun memoryAllowed() = (!call || mutable.value.callCameraRequested) && policyCurrent && policy?.allows(ambient, available, privacyPending, mutable.value.worn) == true
    private fun callAllowed() = call && mutable.value.callCameraRequested && participant != null && policyCurrent && policy?.allowsCall(available, privacyPending, mutable.value.worn) == true
    private fun scheduleInterval() {
        val now = SystemClock.elapsedRealtime()
        val duration = policy?.takeIf { memoryAllowed() && "interval" in it.triggers }?.intervalMs
        if (duration != intervalMs) { interval?.cancel(); interval = null; intervalMs = duration ?: 0; nextInterval = 0 }
        if (duration == null || cameraId == null || externallyBusy() || retryAt > now || !scope.isActive) {
            interval?.cancel(); interval = null; return
        }
        if (interval?.isActive == true) return
        if (nextInterval == 0L) nextInterval = now + duration
        interval = scope.launch(Dispatchers.Main) {
            while (isActive) {
                delay((captureIntervalDue(nextInterval, lastFrame, duration) - SystemClock.elapsedRealtime()).coerceAtLeast(0))
                val now = SystemClock.elapsedRealtime()
                // An upload receipt can move the deadline while this timer is asleep.
                if (now < captureIntervalDue(nextInterval, lastFrame, duration)) continue
                nextInterval = now + duration
                trigger("interval")
            }
        }
    }
    private fun reconcile(clearError: Boolean = false) {
        if (!memoryAllowed()) { pending = null; photoDeadline?.cancel() }
        if ((!callAllowed() && video != null) || (!memoryAllowed() && !callAllowed() && operation != null)) stop()
        mutable.reconcileCapture(clearError) { current -> current.copy(paused = !memoryAllowed(), capturing = video != null || device != null,
            privacyPending = privacyPending, policyCurrent = policyCurrent,
            privatePaused = privacyPending || !policyCurrent || policy?.privatePaused != false, closing = closing > 0,
            status = when { current.error != null -> "error"; externallyBusy() -> "unavailable"; !callAllowed() && !memoryAllowed() -> "paused"; cameraId == null -> "unavailable"; operation?.isActive == true -> "capturing"; video != null -> "call"; closing > 0 -> "closing"; else -> "ready" }) }
        if (cameraId == null && (callAllowed() || memoryAllowed()) && operation == null && closing == 0 && retryAt <= SystemClock.elapsedRealtime()) discoverCamera()
        if (callAllowed() && video == null && operation == null && closing == 0 && cameraId != null && !externallyBusy() && retryAt <= SystemClock.elapsedRealtime()) startCall()
        scheduleInterval()
    }
    private fun stop() {
        epoch++; operation?.cancel(); operation = null; pending = null; photoDeadline?.cancel(); interval?.cancel(); interval = null
        val oldVideo = video
        val oldSetup = callSetup; callSetup = null
        video = null
        closeStill()
        if (oldVideo != null) retireVideo(oldVideo)
        else if (oldSetup != null) teardown(after = oldSetup) {}
        mutable.value = mutable.value.copy(capturing = false, paused = !memoryAllowed(),
            callCameraPublished = mutable.value.callCameraPublished && closing > 0, closing = closing > 0)
    }
    private fun failed(error: Throwable) {
        stop(); failures = (failures + 1).coerceAtMost(5)
        lastFailure = SystemClock.elapsedRealtime()
        retryAt = lastFailure + (5000L shl (failures - 1))
        scheduleInterval()
        mutable.value = mutable.value.copy(status = "error", error = captureFailureReason(error))
        onFailure(error); retry?.cancel()
        retry = scope.launch { delay((retryAt - SystemClock.elapsedRealtime()).coerceAtLeast(0)); reconcile() }
    }
    private fun startCall() {
        val owner = checkNotNull(participant); val generation = epoch
        val setup = CompletableDeferred<Unit>(); callSetup = setup
        operation = scope.launch {
            try {
                withTimeout(8000) {
                    val opening = currentCoroutineContext().job
                    io {
                        try {
                            val processor = object : VideoProcessor {
                                @Volatile private var sink: VideoSink? = null
                                override fun setSink(value: VideoSink?) { sink = value }
                                override fun onCapturerStarted(success: Boolean) { if (!success) handler.post { if (generation == epoch) failed(IllegalStateException("Call camera failed to start")) } }
                                override fun onCapturerStopped() { handler.post { if (generation == epoch && callAllowed()) failed(IllegalStateException("Call camera stopped")) } }
                                override fun onFrameCaptured(frame: VideoFrame) {
                                    if (generation != epoch) return
                                    sink?.onFrame(frame)
                                    sampleCallFrame(frame, generation)
                                }
                            }
                            val track = owner.createVideoTrack(videoProcessor = processor)
                            val owned = CallVideo(owner, track, setup)
                            if (generation != epoch) { retireVideo(owned); return@io }
                            handler.post {
                                if (generation == epoch) { video = owned }
                                else retireVideo(owned)
                            }
                            try {
                                if (generation != epoch) return@io
                                track.startCapture()
                                if (generation != epoch) return@io
                                runBlocking(opening) { check(owner.publishVideoTrack(track)) { "Camera publication failed" } }
                                handler.post {
                                    if (generation == epoch && callAllowed()) {
                                        video = owned; failures = 0; retryAt = 0
                                        mutable.value = mutable.value.copy(capturing = true, status = "call", error = null, callCameraPublished = true)
                                    } else retireVideo(owned)
                                }
                            } catch (error: Throwable) { retireVideo(owned); throw error }
                        } finally { setup.complete(Unit) }
                    }
                }
            } catch (error: TimeoutCancellationException) { if (generation == epoch) failed(error) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generation == epoch) failed(error) }
            finally { if (generation == epoch) { operation = null; callSetup = null; reconcile() } }
        }
    }
    fun trigger(reason: String): Boolean {
        if (!memoryAllowed()) return false
        val currentPolicy = checkNotNull(policy)
        if (reason !in currentPolicy.triggers ||
            !currentPolicy.requestAvailable(pending, rtcQueued.get(), retryAt, lastFrame, SystemClock.elapsedRealtime(), reason)) return false
        if (call && callAllowed()) {
            if (video != null) {
                pending = reason
                photoDeadline = scope.launch {
                    delay(6000)
                    if (pending != null) { pending = null; onFailure(IllegalStateException("Call camera photo timed out")) }
                }
            }
            return video != null
        }
        if (operation != null || closing > 0 || externallyBusy() || cameraId == null) return false
        pending = reason; val generation = epoch
        operation = scope.launch {
            var succeeded = false
            try {
                val result = withTimeout(6000) { capture(generation) }
                if (generation == epoch) {
                    try { closeStill().joinAll(); if (generation == epoch) deliver(result.first, result.second, result.third) }
                    finally { result.first.fill(0) }
                } else result.first.fill(0)
                if (generation == epoch) { failures = 0; retryAt = 0; succeeded = true }
            } catch (error: TimeoutCancellationException) { if (generation == epoch) failed(error) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (generation == epoch) failed(error) }
            finally { if (generation == epoch) { operation = null; closeStill(); reconcile(clearError = succeeded) } }
        }
        reconcile()
        return true
    }
    @SuppressLint("MissingPermission")
    private suspend fun capture(generation: Int): Triple<ByteArray, Int, Int> {
        val id = checkNotNull(cameraId); val traits = checkNotNull(cameraTraits)
        val size = checkNotNull(traits.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)).getOutputSizes(ImageFormat.JPEG)
            .filter { it.width * it.height in 1_000_000..2_000_000 }.minBy { abs(it.width * it.height - 1_500_000) }
        val image = CompletableDeferred<Triple<ByteArray, Int, Int>>()
        val source = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2); reader = source
        source.setOnImageAvailableListener({ r -> if (generation == epoch && reader === r) {
            try {
                val result = r.acquireLatestImage()?.use {
                    val bytes = ByteArray(it.planes[0].buffer.remaining()); it.planes[0].buffer.get(bytes)
                    Triple(bytes, it.width, it.height)
                }
                // Completing may resume teardown inline; release the Image first.
                if (result != null) {
                    if (generation == epoch && image.isActive) image.complete(result) else result.first.fill(0)
                }
            } catch (error: Exception) { image.completeExceptionally(error) }
        } }, handler)
        val opened = CompletableDeferred<CameraDevice>()
        io { cameras.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(value: CameraDevice) {
                if (generation == epoch && opened.isActive) { device = value; opened.complete(value) } else teardown { value.close() }
            }
            override fun onDisconnected(value: CameraDevice) { teardown { value.close() }; opened.completeExceptionally(IllegalStateException("Camera disconnected")); image.completeExceptionally(IllegalStateException("Camera disconnected")) }
            override fun onError(value: CameraDevice, code: Int) { teardown { value.close() }; val error = IllegalStateException("Camera error $code"); opened.completeExceptionally(error); image.completeExceptionally(error) }
        }, handler) }
        val camera = opened.await()
        val configured = CompletableDeferred<CameraCaptureSession>()
        io { camera.createCaptureSession(listOf(source.surface), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(value: CameraCaptureSession) {
                if (generation == epoch && configured.isActive) { session = value; configured.complete(value) } else teardown { value.close() }
            }
            override fun onConfigureFailed(value: CameraCaptureSession) { teardown { value.close() }; configured.completeExceptionally(IllegalStateException("Camera session failed")) }
        }, handler) }
        val ready = configured.await()
        io { ready.capture(camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
            addTarget(source.surface); set(CaptureRequest.JPEG_QUALITY, 85.toByte())
            set(CaptureRequest.JPEG_ORIENTATION, checkNotNull(traits.get(CameraCharacteristics.SENSOR_ORIENTATION)))
        }.build(), object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureFailed(s: CameraCaptureSession, r: CaptureRequest, failure: CaptureFailure) { image.completeExceptionally(IllegalStateException("Camera capture failed ${failure.reason}")) }
        }, handler) }
        return image.await()
    }
    private fun closeStill(): List<Job> {
        val retired = listOfNotNull(session, reader, device); session = null; reader = null; device = null
        return retired.map { handle -> teardown { handle.close() } }
    }
    private suspend fun deliver(bytes: ByteArray, width: Int, height: Int) {
        val reason = pending; pending = null; photoDeadline?.cancel()
        try { if (reason != null && memoryAllowed()) {
            // Server admission charges the interval before image processing, including attempts that later fail.
            try { onFrame(bytes, width, height, reason) } finally { lastFrame = SystemClock.elapsedRealtime() }
        } }
        finally { bytes.fill(0) }
    }
    private fun sampleCallFrame(frame: VideoFrame, generation: Int) {
        if (pending == null || !rtcQueued.compareAndSet(false, true)) return
        frame.retain()
        handler.post {
            if (!scope.isActive) { frame.release(); rtcQueued.set(false); return@post }
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    if (generation != epoch || !memoryAllowed()) return@launch
                    val jpeg = withContext(Dispatchers.IO) {
                        val buffer = frame.buffer.toI420() ?: error("Call frame has no I420 buffer")
                        try {
                            val w = buffer.width; val h = buffer.height; val nv21 = ByteArray(w * h * 3 / 2)
                            val packed = java.nio.ByteBuffer.allocateDirect(nv21.size)
                            YuvHelper.I420ToNV12(buffer.dataY, buffer.strideY, buffer.dataV, buffer.strideV, buffer.dataU, buffer.strideU, packed, w, h)
                            packed.rewind(); packed.get(nv21)
                            try { val out = java.io.ByteArrayOutputStream(); check(YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 85, out)); Triple(out.toByteArray(), w, h) }
                            finally { nv21.fill(0) }
                        } finally { buffer.release() }
                    }
                    if (generation == epoch) deliver(jpeg.first, jpeg.second, jpeg.third) else jpeg.first.fill(0)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { pending = null; onFailure(error) }
                finally { frame.release(); rtcQueued.set(false) }
            }
        }
    }
    private fun retireVideo(owned: CallVideo) {
        if (Looper.myLooper() != Looper.getMainLooper()) { handler.post { retireVideo(owned) }; return }
        if (!owned.retired.compareAndSet(false, true)) return
        val track = owned.track
        // Publication and removal still use the RTC track. Release only after both finish.
        teardown(after = owned.setup) {
            try { owned.owner.unpublishTrack(track, false) } finally { track.dispose() }
        }
    }
    private fun teardown(after: Deferred<Unit>? = null, action: () -> Unit): Job {
        closing++
        mutable.value = mutable.value.copy(closing = true)
        return scope.launch(NonCancellable + Dispatchers.Main) {
            try {
                after?.await()
                val done = CompletableDeferred<Unit>()
                dispatch { try { action(); done.complete(Unit) } catch (error: Exception) { done.completeExceptionally(error) } }
                withTimeout(3000) { done.await() }
            }
            catch (error: TimeoutCancellationException) { failed(IllegalStateException("Camera teardown timed out", error)) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { failed(error) }
            finally {
                closing--
                mutable.value = mutable.value.copy(closing = closing > 0)
                if (closing == 0 && video == null) mutable.value = mutable.value.copy(callCameraPublished = false)
                if (scope.isActive) reconcile()
            }
        }
    }
    // Cancellation abandons blocked Binder work rather than retaining Main or waiting for its thread.
    private fun dispatch(action: () -> Unit) = Dispatchers.IO.dispatch(EmptyCoroutineContext, Runnable {
        try { action() } catch (error: Exception) { handler.post { if (scope.isActive) onFailure(error) } }
    })
    private suspend fun <T> io(action: () -> T): T = suspendCancellableCoroutine { continuation ->
        Dispatchers.IO.dispatch(EmptyCoroutineContext, Runnable {
            try { continuation.resumeWith(Result.success(action())) }
            catch (error: Exception) { continuation.resumeWith(Result.failure(error)) }
        })
    }
    override fun onSensorChanged(event: SensorEvent) {
        if (mutable.value.worn == true) motion.sample(event.timestamp, event.values[0], event.values[1], event.values[2])?.let(::trigger)
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    fun close() { available = false; stop(); retry?.cancel(); sensors.unregisterListener(this); dispatch { cameras.unregisterAvailabilityCallback(availability) }; scope.cancel() }
}
