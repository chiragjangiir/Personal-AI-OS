package com.personalaios.glasses

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import org.json.JSONObject

/** One camera owner uploads one frame at a time; only its gateway receipt completes that upload. */
internal class CameraFrameReceipt {
    private var pending: Pair<String, CompletableDeferred<Unit>>? = null

    fun start(frameId: String): Deferred<Unit> {
        check(pending == null) { "Camera frame upload already pending" }
        return CompletableDeferred<Unit>().also { pending = frameId to it }
    }

    fun receive(value: JSONObject) {
        val current = pending ?: return
        when (value.getString("operation")) {
            "camera_ack" -> if (value.getString("frame_id") == current.first) current.second.complete(Unit)
            "rejected" -> if (value.getString("request_operation") == "camera_frame" &&
                value.optString("frame_id") == current.first)
                current.second.completeExceptionally(IllegalStateException(value.getString("error_code")))
        }
    }

    fun finish(receipt: Deferred<Unit>) { if (pending?.second === receipt) pending = null }

    fun disconnected(error: Throwable) {
        pending?.second?.completeExceptionally(error)
        pending = null
    }
}
