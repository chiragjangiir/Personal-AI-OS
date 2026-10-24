package com.personalaios.glasses

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout

/** Foreground enrollment owns the camera only while the companion is stopped. */
@SuppressLint("MissingPermission")
internal suspend fun scanEnrollment(context: Context): String = withTimeout(60_000) {
    val cameras = context.getSystemService(CameraManager::class.java)
    val id = cameras.cameraIdList.first { cameras.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
    val traits = cameras.getCameraCharacteristics(id)
    val size = checkNotNull(traits.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)).getOutputSizes(ImageFormat.YUV_420_888)
        .minBy { kotlin.math.abs(it.width * it.height - 1280 * 720) }
    val source = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
    // Frames are decoded off the main thread so temple gestures stay responsive while scanning.
    val thread = HandlerThread("yimi-qr").apply { start() }; val handler = Handler(thread.looper)
    val opened = EnrollmentResource<CameraDevice> { it.close() }; val configured = EnrollmentResource<CameraCaptureSession> { it.close() }
    val result = CompletableDeferred<String>()
    val decoder = MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))) }
    try {
        source.setOnImageAvailableListener({ reader ->
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            var text: String? = null; var failure: Exception? = null
            try {
                val plane = image.planes[0]; val bytes = ByteArray(plane.rowStride * image.height)
                plane.buffer.get(bytes, 0, plane.buffer.remaining())
                val luminance = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                try { text = decoder.decodeWithState(BinaryBitmap(HybridBinarizer(luminance))).text }
                catch (_: NotFoundException) {} finally { decoder.reset() }
            } catch (error: Exception) { failure = error }
            finally { image.close() }
            failure?.let { result.completeExceptionally(it) }
            text?.let { result.complete(it) }
        }, handler)
        cameras.openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(value: CameraDevice) { opened.complete(value) }
            override fun onDisconnected(value: CameraDevice) { val error = IllegalStateException("相机连接中断"); opened.fail(value, error); configured.fail(error); result.completeExceptionally(error) }
            override fun onError(value: CameraDevice, error: Int) { val failure = IllegalStateException("相机不可用 ($error)"); opened.fail(value, failure); configured.fail(failure); result.completeExceptionally(failure) }
        }, handler)
        val camera = opened.await()
        camera.createCaptureSession(listOf(source.surface), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(value: CameraCaptureSession) { configured.complete(value) }
            override fun onConfigureFailed(value: CameraCaptureSession) { configured.fail(value, IllegalStateException("相机无法扫描二维码")) }
        }, handler)
        val session = configured.await()
        val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
            addTarget(source.surface)
            if (traits.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) == true)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
        }.build()
        session.setRepeatingRequest(request, null, handler)
        result.await()
    } finally {
        result.cancel()
        handler.post { source.setOnImageAvailableListener(null, null); configured.close(); opened.close(); source.close(); thread.quitSafely() }
    }
}
