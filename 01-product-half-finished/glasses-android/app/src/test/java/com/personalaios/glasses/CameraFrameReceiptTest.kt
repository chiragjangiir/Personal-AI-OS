package com.personalaios.glasses

import java.io.IOException
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CameraFrameReceiptTest {
    private fun ack(id: String) = JSONObject().put("operation", "camera_ack").put("frame_id", id)

    @Test fun onlyTheMatchingGatewayAcknowledgementCompletesAnUpload() = runBlocking {
        val receipts = CameraFrameReceipt()
        val upload = receipts.start("frame-one")
        receipts.receive(ack("previous-frame")); assertFalse(upload.isCompleted)
        receipts.receive(JSONObject().put("operation", "camera_policy")); assertFalse(upload.isCompleted)
        receipts.receive(ack("frame-one")); upload.await()
        receipts.finish(upload)
        val next = receipts.start("frame-two")
        receipts.receive(ack("frame-one")); assertFalse(next.isCompleted)
        receipts.receive(ack("frame-two")); next.await(); receipts.finish(next)
    }

    @Test fun cameraRejectionFailsThePendingUploadAndUnrelatedRejectionDoesNot() = runBlocking {
        val receipts = CameraFrameReceipt()
        val upload = receipts.start("frame")
        val rejection = JSONObject().put("operation", "rejected").put("request_operation", "call_open")
            .put("error_code", "CAMERA_CAPTURE_INTERVAL").put("frame_id", "frame")
        receipts.receive(rejection); assertFalse(upload.isCompleted)
        receipts.receive(rejection.put("request_operation", "camera_frame"))
        assertEquals("CAMERA_CAPTURE_INTERVAL", runCatching { upload.await() }.exceptionOrNull()?.message)
        receipts.finish(upload)
    }

    @Test fun disconnectFailsTheUploadAndItsLateCleanupCannotClearTheNewOne() = runBlocking {
        val receipts = CameraFrameReceipt()
        val old = receipts.start("old")
        val failure = IOException("gateway disconnected")
        receipts.disconnected(failure)
        val disconnected = runCatching { old.await() }.exceptionOrNull()
        assertTrue(disconnected is IOException)
        assertEquals(failure.message, disconnected?.message)
        val next = receipts.start("new")
        receipts.finish(old)
        receipts.receive(ack("old")); assertFalse(next.isCompleted)
        receipts.receive(ack("new")); next.await(); receipts.finish(next)
    }

    @Test fun timedOutUploadRejectionsCannotFailTheNextFrame() = runBlocking {
        val receipts = CameraFrameReceipt()
        val upload = receipts.start("missing")
        val failure = runCatching { withTimeout(1) { upload.await() } }.exceptionOrNull()
        assertTrue(failure is TimeoutCancellationException)
        receipts.finish(upload)
        val next = receipts.start("new")
        val rejection = JSONObject().put("operation", "rejected").put("request_operation", "camera_frame")
            .put("error_code", "CAMERA_CAPTURE_FAILED")
        receipts.receive(rejection); assertFalse(next.isCompleted)
        receipts.receive(rejection.put("frame_id", "missing")); assertFalse(next.isCompleted)
        receipts.receive(rejection.put("frame_id", "new"))
        assertEquals("CAMERA_CAPTURE_FAILED", runCatching { next.await() }.exceptionOrNull()?.message)
        receipts.finish(next)
    }
}
