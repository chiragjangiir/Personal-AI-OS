package com.personalaios.glasses

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class GatewayClockTest {
    private val epoch = Instant.parse("2026-10-24T14:00:00Z").toEpochMilli()
    private val date = "Sat, 24 Oct 2026 14:00:00 GMT"
    private fun enrollment() = Enrollment(PreferenceDisk().preferences, PlainTestCipher).also {
        it.seed(pair(DEFAULT_GATEWAY).put("media", JSONArray(listOf("audio", "data"))))
    }

    private fun correctedConnect(skew: Long) = runBlocking {
        val enrollment = enrollment()
        val clock = ServerClock({ epoch + skew }, { 1000 })
        val starts = mutableListOf<JSONObject>(); val calls = mutableListOf<FakeControl>()
        val client = GatewayClient(enrollment, clock = clock, openConnection = { url -> FakeControl(url) { connection ->
            val request = JSONObject(connection.bytes.toString())
            if (request.getString("operation") == "bootstrap") {
                starts += request
                val started = Instant.parse(request.getJSONObject("start").getString("started_at")).toEpochMilli()
                // Same freshness window as the gateway; do not relax it to accommodate the client.
                if (started > epoch + 120_000 || started < epoch - 600_000)
                    422 to "{\"error\":\"PAIRED_DEVICE_START_TIME_INVALID\"}"
                else 200 to accepted(request).toString()
            } else 200 to "{}"
        }.apply { date = this@GatewayClockTest.date; calls += this } }, openKey = { _, _, _ -> ByteArray(32) })
        assertEquals("glasses-1", client.connect(enrollment.pairing()!!).deviceId)
        assertEquals(2, starts.size)
        assertEquals(epoch + skew, Instant.parse(starts[0].getJSONObject("start").getString("started_at")).toEpochMilli())
        assertEquals(epoch, Instant.parse(starts[1].getJSONObject("start").getString("started_at")).toEpochMilli())
        val first = starts[0].getJSONObject("idempotency_context")
        val retry = starts[1].getJSONObject("idempotency_context")
        assertNotEquals(starts[0].getString("request_id"), starts[1].getString("request_id"))
        assertNotEquals(first.getString("idempotency_key"), retry.getString("idempotency_key"))
        assertNotEquals(first.getString("idempotency_request_sha256"), retry.getString("idempotency_request_sha256"))
        assertEquals(starts[1].getString("request_id"), enrollment.controlJournal()!!.getJSONObject("bootstrap").getString("request_id"))
        assertNull(enrollment.controlJournal()!!.optJSONObject("pending"))
        assertTrue(calls.all { it.disconnected })
        client.clear()
    }

    @Test fun fiftyTwoMinutesFastRetriesOnceAndConnects() { correctedConnect(52 * 60_000L) }
    @Test fun fiftyTwoMinutesSlowRetriesOnceAndConnects() { correctedConnect(-52 * 60_000L) }

    private fun rejected(code: String, header: String?, expectedAttempts: Int, operation: String = "bootstrap") {
        val enrollment = enrollment(); val clock = ServerClock({ epoch + 52 * 60_000L }, { 1000 })
        var attempts = 0
        val client = GatewayClient(enrollment, clock = clock, openConnection = { url -> FakeControl(url) {
            attempts++; 422 to JSONObject().put("error", code).toString()
        }.apply { date = header } })
        val error = assertThrows(java.io.IOException::class.java) {
            if (operation == "bootstrap") runBlocking { client.connect(enrollment.pairing()!!) }
            else client.post("media-stop", "/v1/realtime/media/stop", bootstrapRequest().put("operation", operation))
        }
        assertTrue(error.message!!.contains(code)); assertEquals(expectedAttempts, attempts)
        assertNull(enrollment.controlJournal())
        if (header == date) assertEquals(epoch, clock.nowMillis())
    }

    @Test fun secondTimeRejectionSurfacesWithoutLoop() { rejected("PAIRED_DEVICE_START_TIME_INVALID", date, 2) }
    @Test fun missingDateDoesNotRetryWithUncorrectedTime() { rejected("PAIRED_DEVICE_START_TIME_INVALID", null, 1) }
    @Test fun malformedDateDoesNotRetryWithUncorrectedTime() { rejected("PAIRED_DEVICE_START_TIME_INVALID", "invalid", 1) }
    @Test fun differentRejectionLearnsDateButDoesNotRetry() { rejected("PAIRED_DEVICE_POLICY_DENIED", date, 1) }
    @Test fun nonBootstrapDoesNotUseStartRetry() { rejected("PAIRED_DEVICE_START_TIME_INVALID", date, 1, "media_stop") }

    @Test fun successfulResponseAlsoUpdatesClock() {
        val enrollment = enrollment(); val clock = ServerClock({ 0 }, { 1000 })
        val client = GatewayClient(enrollment, clock = clock, openConnection = { url -> FakeControl(url) {
            200 to accepted(JSONObject(it.bytes.toString())).toString()
        }.apply { date = this@GatewayClockTest.date } })
        client.post("bootstrap", "/v1/realtime/bootstrap", bootstrapRequest())
        assertEquals(epoch, clock.nowMillis())
    }
}
