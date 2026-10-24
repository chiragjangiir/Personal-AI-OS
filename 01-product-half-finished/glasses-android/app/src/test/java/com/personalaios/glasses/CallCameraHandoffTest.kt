package com.personalaios.glasses

import android.app.Application
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.SensorManager
import android.hardware.camera2.*
import android.hardware.camera2.params.StreamConfigurationMap
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.mockito.MockedStatic
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.nio.ByteBuffer
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class CallCameraHandoffTest {
    private class Fixture(private val imageReaders: MockedStatic<ImageReader>) : AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val main = shadowOf(Looper.getMainLooper())
        val context = mock(Context::class.java)
        val cameras = mock(CameraManager::class.java)
        val traits = mock(CameraCharacteristics::class.java)
        val participant = mock(LocalParticipant::class.java)
        val track = mock(LocalVideoTrack::class.java)
        val publishEntered = CountDownLatch(1)
        val publishAllowed = CountDownLatch(1)
        val disposed = CountDownLatch(1)
        val failures = mutableListOf<Throwable>()
        val frames = mutableListOf<Long>()
        var publishFailure: Throwable? = null
        val observed = mutableListOf<CaptureState>()
        val hud = MutableStateFlow(HudState(paired = true, listening = true, ambient = true))
        val capture: FirstPersonCapture
        val calls: CallLifecycle
        init {
            `when`(context.getSystemService(CameraManager::class.java)).thenReturn(cameras)
            `when`(context.getSystemService(SensorManager::class.java)).thenReturn(mock(SensorManager::class.java))
            `when`(cameras.cameraIdList).thenReturn(arrayOf("back"))
            `when`(cameras.getCameraCharacteristics("back")).thenReturn(traits)
            `when`(traits.get(CameraCharacteristics.LENS_FACING)).thenReturn(CameraCharacteristics.LENS_FACING_BACK)
            val sizes = mock(StreamConfigurationMap::class.java)
            `when`(sizes.getOutputSizes(ImageFormat.JPEG)).thenReturn(arrayOf(Size(1440, 1080)))
            `when`(traits.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)).thenReturn(sizes)
            `when`(traits.get(CameraCharacteristics.SENSOR_ORIENTATION)).thenReturn(0)
            `when`(participant.videoTrackCaptureDefaults).thenReturn(LocalVideoTrackOptions())
            `when`(participant.videoTrackPublishDefaults).thenReturn(VideoTrackPublishDefaults())
            `when`(track.options).thenReturn(LocalVideoTrackOptions())
            doReturn(track).`when`(participant).createVideoTrack(anyString(), anyOptions(), any())
            runBlocking {
                doAnswer {
                    publishEntered.countDown()
                    check(publishAllowed.await(5, TimeUnit.SECONDS))
                    publishFailure?.let { throw it }
                    check(disposed.count == 1L) { "MediaStreamTrack has been disposed." }
                    true
                }.`when`(participant).publishVideoTrack(eq(track) ?: track, anyPublishOptions(), isNull())
            }
            doAnswer { disposed.countDown(); null }.`when`(track).dispose()
            doAnswer {
                // Make the old parallel disposal/unpublish race deterministic.
                disposed.await(100, TimeUnit.MILLISECONDS)
                check(disposed.count == 1L) { "MediaStreamTrack has been disposed." }
                null
            }.`when`(participant).unpublishTrack(track, false)
            val reader = mock(ImageReader::class.java)
            `when`(reader.surface).thenReturn(mock(Surface::class.java))
            imageReaders.`when`<ImageReader> { ImageReader.newInstance(1440, 1080, ImageFormat.JPEG, 2) }.thenReturn(reader)
            val image = mock(Image::class.java)
            val plane = mock(Image.Plane::class.java)
            `when`(plane.buffer).thenAnswer { ByteBuffer.wrap(byteArrayOf(1, 2, 3)) }
            `when`(image.planes).thenReturn(arrayOf(plane))
            `when`(image.width).thenReturn(1440); `when`(image.height).thenReturn(1080)
            `when`(reader.acquireLatestImage()).thenReturn(image)
            var listener: ImageReader.OnImageAvailableListener? = null
            doAnswer { listener = it.getArgument(0); null }.`when`(reader).setOnImageAvailableListener(any(), any())
            val camera = mock(CameraDevice::class.java)
            val session = mock(CameraCaptureSession::class.java)
            val metadata = Class.forName("android.hardware.camera2.impl.CameraMetadataNative")
            val constructor = CaptureRequest.Builder::class.java.getConstructor(metadata, Boolean::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java, Set::class.java)
            val builder = constructor.newInstance(metadata.getConstructor().newInstance(), false, -1, "back", null)
            `when`(camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)).thenReturn(builder)
            doAnswer { invocation ->
                val callback = invocation.getArgument<CameraDevice.StateCallback>(1)
                invocation.getArgument<Handler>(2).post { callback.onOpened(camera) }; null
            }.`when`(cameras).openCamera(anyString(), any(), any<Handler>())
            doAnswer { invocation ->
                val callback = invocation.getArgument<CameraCaptureSession.StateCallback>(1)
                invocation.getArgument<Handler>(2).post { callback.onConfigured(session) }; null
            }.`when`(camera).createCaptureSession(anyList(), any(), any())
            doAnswer { Handler(Looper.getMainLooper()).post { listener!!.onImageAvailable(reader) }; 1 }
                .`when`(session).capture(any(), any(), any())
            val senses = mock(DeviceSenses::class.java)
            `when`(senses.wearState()).thenReturn("WEARING")
            capture = FirstPersonCapture(context, scope, { _, _, _, _ -> frames += SystemClock.elapsedRealtime() }, {}, failures::add, senses)
            scope.launch { capture.state.collect { observed += it } }
            calls = CallLifecycle(scope, hud, capture::setCall, {})
            capture.attach(participant)
            capture.setAmbient(true)
            capture.applyPolicy(JSONObject("""{"enabled":true,"private_paused":false,"interval_ms":1000,"triggers":["interval"]}"""))
            capture.setAvailable(true)
            await { capture.state.value.status == "ready" }
        }
        fun await(condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!condition() && System.nanoTime() < deadline) { main.idle(); Thread.sleep(2) }
            main.idle(); assertTrue("state=${capture.state.value}; failures=$failures", condition())
        }
        fun state(phase: String) = JSONObject().put("call_id", "camera-call").put("state", phase)
        override fun close() {
            publishAllowed.countDown(); capture.close(); main.idle(); scope.cancel()
        }
    }

    @Test fun hangupDuringOpeningReturnsToJpegAtTheExistingInterval() = handoff(false)
    @Test fun hangupAfterLiveReturnsToJpegAtTheExistingInterval() = handoff(true)

    @Test fun aRealCaptureFailureProducesChineseRetryText() = fixture { f ->
        f.publishFailure = IllegalStateException("MediaStreamTrack has been disposed.")
        runBlocking { f.calls.open("camera-call") }
        f.calls.receive(f.state("opening")); f.publishAllowed.countDown()
        f.await { f.capture.state.value.status == "error" && !f.capture.state.value.closing }
        assertEquals("摄像头暂不可用", f.capture.state.value.error)
        val display = ambientDisplay(f.hud.value.copy(capture = f.capture.state.value))
        assertEquals("错误 · 摄像头暂不可用 · 重试", display.text)
        assertTrue(display.retry)
        assertEquals("MediaStreamTrack has been disposed.", f.failures.first().message)
    }

    private fun fixture(block: (Fixture) -> Unit) = mockStatic(ImageReader::class.java).use { readerFactory ->
        Fixture(readerFactory).use(block)
    }

    private fun handoff(live: Boolean) = fixture { f ->
        runBlocking { f.calls.open("camera-call") }
        assertTrue(f.calls.receive(f.state("opening")))
        f.await { f.publishEntered.count == 0L }
        if (live) {
            f.publishAllowed.countDown()
            f.await { f.capture.state.value.callCameraPublished }
            assertTrue(f.calls.receive(f.state("live")))
        }
        f.calls.hangup()
        assertTrue(f.calls.receive(f.state("closed")))
        if (!live) {
            f.main.idleFor(Duration.ofSeconds(4))
            assertTrue(f.capture.state.value.closing)
            assertEquals(1L, f.disposed.count)
            assertTrue(f.frames.isEmpty())
        }
        f.publishAllowed.countDown()
        f.await { f.capture.state.value.status == "ready" && !f.capture.state.value.closing }
        assertNull(f.capture.state.value.error)
        assertFalse(f.capture.state.value.callCameraPublished)
        assertFalse(f.capture.state.value.paused)
        assertEquals(0L, f.disposed.count)
        verify(f.participant, times(1)).unpublishTrack(f.track, false)
        verify(f.track, times(1)).dispose()
        assertTrue(f.failures.toString(), f.failures.isEmpty())
        assertTrue(f.observed.none { it.error != null })
        assertEquals("available", cameraReport(f.capture.state.value).getString("status"))
        assertTrue(cameraReport(f.capture.state.value).isNull("error"))
        f.main.idleFor(Duration.ofMillis(999))
        assertTrue(f.frames.isEmpty())
        f.main.idleFor(Duration.ofMillis(1))
        f.await { f.frames.size == 1 }
        assertNull(f.capture.state.value.error)
    }

    companion object {
        // Mockito matchers return null; these SDK parameters are non-null Kotlin types.
        private fun anyOptions(): LocalVideoTrackOptions = any() ?: LocalVideoTrackOptions()
        private fun anyPublishOptions(): VideoTrackPublishOptions = any() ?: VideoTrackPublishOptions()
    }
}
