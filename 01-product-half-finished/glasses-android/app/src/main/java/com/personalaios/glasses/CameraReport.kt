package com.personalaios.glasses

import org.json.JSONObject

/** Project local capture phases onto the shared camera_status wire contract. */
internal fun cameraReport(value: CaptureState): JSONObject {
    val failed = value.error != null || value.status == "error"
    val status = if (failed) "error" else when (value.status) {
        "ready", "capturing", "call", "closing" -> "available"
        else -> value.status
    }
    return JSONObject().put("operation", "camera_status").put("status", status)
        .put("error", if (failed) (value.error?.ifEmpty { "Camera failure" } ?: "Camera failure").take(512) else JSONObject.NULL)
}
