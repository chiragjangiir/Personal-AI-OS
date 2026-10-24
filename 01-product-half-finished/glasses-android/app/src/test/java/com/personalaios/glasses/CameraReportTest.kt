package com.personalaios.glasses

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CameraReportTest {
    @Test fun captureTransitionsProduceConsistentStatusAndErrorAtBothSendSites() {
        val reports = JSONArray()
        val phases = listOf("unavailable", "paused", "ready", "capturing", "call", "closing", "error")
        val errors = listOf(null, "", "CameraAccessException", "x".repeat(513), "摄".repeat(513), "📷".repeat(513))
        for (entry in listOf("state_change", "connection_ready")) for (phase in phases) for (error in errors) {
            val state = CaptureState(status = phase, error = error)
            // The state collector serializes for deduplication; connection-ready sends the projection directly.
            val report = (if (entry == "state_change") JSONObject(cameraReport(state).toString()) else cameraReport(state))
                .put("control_id", UUID.randomUUID().toString())
            val failed = phase == "error" || error != null
            assertEquals(if (failed) "error" else if (phase in listOf("unavailable", "paused")) phase else "available", report.getString("status"))
            if (failed) assertTrue(report.getString("error").length in 1..512) else assertTrue(report.isNull("error"))
            reports.put(JSONObject().put("entry", entry).put("phase", phase).put("input_error", error ?: JSONObject.NULL).put("payload", report))
            val projected = cameraReport(state).toString()
            for (worn in listOf(null, false, true)) for (bits in 0 until 256) {
                fun flag(bit: Int) = bits and (1 shl bit) != 0
                val combination = state.copy(worn = worn, paused = flag(0), capturing = flag(1), privatePaused = flag(2),
                    privacyPending = flag(3), policyCurrent = flag(4), callCameraRequested = flag(5), callCameraPublished = flag(6), closing = flag(7))
                assertEquals(projected, cameraReport(combination).toString())
            }
        }
        for (entry in listOf("state_change", "connection_ready")) for (callPhase in listOf("opening", "live")) {
            val active = CaptureState(worn = true, paused = false, capturing = true, status = "call",
                privatePaused = false, policyCurrent = true, callCameraPublished = true)
            val transitions = listOf(active,
                active.copy(status = "closing", capturing = false, closing = true),
                active.copy(status = "closing", capturing = false, callCameraPublished = false, closing = true),
                active.copy(status = "ready", capturing = false, callCameraPublished = false),
                active.copy(status = "capturing", callCameraPublished = false))
            for ((step, state) in transitions.withIndex()) {
                val report = cameraReport(state).put("control_id", UUID.randomUUID().toString())
                assertEquals("available", report.getString("status")); assertTrue(report.isNull("error"))
                reports.put(JSONObject().put("entry", entry).put("phase", state.status).put("call_phase", callPhase)
                    .put("step", step).put("payload", report))
            }
        }
        assertEquals(104, reports.length())
        // Exercise the ingress validator, including its conditional status/error constraint.
        val validator = File(javaClass.getResource("/validate-camera-reports.mjs")!!.toURI())
        val contract = File(javaClass.getResource("/formal-message.v1.json")!!.toURI())
        val process = ProcessBuilder("node", validator.absolutePath, contract.absolutePath, "-",
            File("src/main/java/com/personalaios/glasses/CompanionService.kt").absolutePath,
            File("../../backend/services/personal-aios-integration/package.json").absolutePath)
            .redirectErrorStream(true).start()
        process.outputStream.bufferedWriter().use { it.write(reports.toString()) }
        val validation = process.inputStream.bufferedReader().readText()
        assertEquals(validation, 0, process.waitFor())
        (System.getProperty("paios.cameraReports") ?: System.getenv("PAIOS_CAMERA_REPORTS"))?.let { path ->
            File(path).apply { parentFile.mkdirs(); writeText(reports.toString()) }
        }
    }
}
