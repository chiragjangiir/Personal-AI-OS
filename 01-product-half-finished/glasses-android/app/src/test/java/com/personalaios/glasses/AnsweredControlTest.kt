package com.personalaios.glasses

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Regression: the gateway stored ACCEPTED_ACTIVITY_FUTURE for the glasses' first Start and replays that answer to
 *  its idempotency key, so replaying the journaled request kept the glasses offline. */
class AnsweredControlTest {
    private val pairing = pair(DEFAULT_GATEWAY).put("media", JSONArray(listOf("audio", "data")))

    /** Like the gateway ledger, every key keeps its first answer. [firstStart] answers the first Start; stops are refused. */
    private class Gateway(private val firstStart: Pair<Int, String>? = null) {
        private val ledger = mutableMapOf<String, Pair<Int, String>>()
        val starts = mutableListOf<String>()
        val stops = mutableListOf<String>()
        fun answer(control: FakeControl): Pair<Int, String> {
            val request = JSONObject(control.bytes.toString())
            val key = request.optJSONObject("idempotency_context")?.getString("idempotency_key") ?: return 200 to "{}"
            return when {
                control.url.path.endsWith("/bootstrap") -> {
                    starts += key
                    ledger.getOrPut(key) { firstStart.takeIf { starts.size == 1 } ?: (200 to accepted(request).toString()) }
                }
                control.url.path.endsWith("/stop") -> { stops += key; ledger.getOrPut(key) { 409 to "{\"error\":\"REALTIME_SESSION_NOT_ACTIVE\"}" } }
                else -> 200 to "{}"
            }
        }
    }

    private fun connect(disk: PreferenceDisk, gateway: Gateway) = runBlocking {
        GatewayClient(Enrollment(disk.preferences, PlainTestCipher), openConnection = { url -> FakeControl(url) { gateway.answer(it) } },
            openKey = { _, _, _ -> ByteArray(32) }).connect(pairing)
    }

    private fun journal(disk: PreferenceDisk) = Enrollment(disk.restart().preferences, PlainTestCipher).controlJournal()

    @Test fun answeredStartIsNotReplayedAndTheNextStartIsFresh() {
        val disk = PreferenceDisk(); Enrollment(disk.preferences, PlainTestCipher).seed(pairing)
        val gateway = Gateway(503 to "{\"error\":\"ACCEPTED_ACTIVITY_FUTURE\"}")
        assertThrows(IOException::class.java) { connect(disk, gateway) }
        assertNull("an answered Start leaves nothing to replay", journal(disk))

        connect(disk.restart(), gateway)
        assertEquals(2, gateway.starts.size)
        assertNotEquals("the retry is a new request, not the answered one", gateway.starts[0], gateway.starts[1])
        assertTrue(gateway.stops.isEmpty())
    }

    @Test fun startStillRunningOnTheGatewayStaysJournaledForReplay() {
        val disk = PreferenceDisk(); Enrollment(disk.preferences, PlainTestCipher).seed(pairing)
        val gateway = Gateway(409 to "{\"error\":\"PUBLIC_OPERATION_RECEIPT_IN_FLIGHT\"}")
        assertThrows(Exception::class.java) { connect(disk, gateway) }
        val pending = journal(disk)!!.getJSONObject("pending")
        assertEquals("bootstrap", pending.getString("slug"))
        assertEquals(gateway.starts.single(), pending.getJSONObject("body").getJSONObject("idempotency_context").getString("idempotency_key"))
    }

    @Test fun refusedStopForgetsTheOldSessionSoTheNextStartGoesAhead() {
        val disk = PreferenceDisk(); Enrollment(disk.preferences, PlainTestCipher).seed(pairing)
        connect(disk, Gateway())
        assertNotNull("a connected Start is journaled for the stop before the next Start", journal(disk)!!.optJSONObject("bootstrap"))

        // That session is already gone on the gateway: its stop is refused, and Start must not loop on it.
        val gateway = Gateway()
        assertThrows(IOException::class.java) { connect(disk.restart(), gateway) }
        assertNull(journal(disk))
        connect(disk.restart(), gateway)
        assertEquals("one refused stop, never repeated", 1, gateway.stops.size)
        assertEquals(1, gateway.starts.size)
    }
}
