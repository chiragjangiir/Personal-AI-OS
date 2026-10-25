package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.URL
import java.time.Instant

class ServerClockTest {
    private val date = "Sat, 24 Oct 2026 14:00:00 GMT"
    private val epoch = Instant.parse("2026-10-24T14:00:00Z").toEpochMilli()

    @Test fun dateCorrectsFastAndSlowWallClocks() {
        for (skew in listOf(-52, 52)) {
            var elapsed = 1000L
            val clock = ServerClock({ epoch + skew * 60_000 }, { elapsed })
            assertNull(clock.knownTime())
            assertEquals(epoch + skew * 60_000, clock.nowMillis())
            assertTrue(clock.learn(date))
            assertEquals(epoch, clock.nowMillis())
            elapsed += 250
            assertEquals(epoch + 250, clock.nowMillis())
        }
    }

    @Test fun correctedTimeIgnoresWallClockChangesAndAdvancesThroughElapsedTime() {
        var wall = epoch; var elapsed = 0L
        val clock = ServerClock({ wall }, { elapsed })
        clock.learn(date)
        wall += 86_400_000; elapsed += 3_600_000
        assertEquals(epoch + 3_600_000, clock.nowMillis())
        wall -= 172_800_000; elapsed += 100
        assertEquals(epoch + 3_600_100, clock.knownTime())
    }

    @Test fun missingOrMalformedDateKeepsLastSampleAndDoesNotEnableColdClock() {
        val clock = ServerClock({ epoch + 999_999 }, { 0 })
        assertFalse(clock.learn(null as String?)); assertFalse(clock.learn("invalid"))
        assertNull(clock.knownTime())
        clock.learn(date)
        assertFalse(clock.learn("invalid")); assertEquals(epoch, clock.nowMillis())
    }

    @Test fun dateSecondPrecisionDoesNotReverseProgressWithinSameSecond() {
        var elapsed = 0L
        val clock = ServerClock({ 0 }, { elapsed })
        clock.learn(date); elapsed += 700
        clock.learn(date)
        assertEquals(epoch + 700, clock.nowMillis())
        assertTrue(clock.learn("Sat, 24 Oct 2026 14:00:02 GMT"))
        assertEquals(epoch + 2000, clock.nowMillis())
    }

    @Test fun insecureResponseCannotSetClock() {
        val clock = ServerClock({ 0 }, { 0 })
        val connection = FakeControl(URL("http://example.test")) { 200 to "{}" }.apply { date = this@ServerClockTest.date }
        assertFalse(clock.learn(connection)); assertNull(clock.knownTime())
    }

    @Test fun serverCorrectionsDoNotChangeLocalCardOrUnlockTimers() {
        var elapsed = 1000L
        val clock = ServerClock({ 0 }, { elapsed })
        val cards = HudCards("glasses", monotonic = { elapsed }, wireNow = clock::nowMillis)
        val lease = UnlockLease({ elapsed })
        val waitUntil = lease.state.connectionWaitUntil
        cards.notice(elapsed)
        clock.learn(date)
        assertEquals(waitUntil, lease.state.connectionWaitUntil)
        assertEquals(1, cards.snapshot(elapsed).size)
        elapsed += 4999; clock.learn("Sat, 24 Oct 2026 15:00:00 GMT")
        assertEquals(1, cards.snapshot(elapsed).size)
        elapsed++; assertTrue(cards.snapshot(elapsed).isEmpty())
    }

    @Test fun unsyncedEnrollmentDefersOnlyExpiryToServer() {
        val payload = JSONObject().put("schema", "paios.glasses-enrollment.v1").put("origin", DEFAULT_GATEWAY)
            .put("token", "a".repeat(43)).put("expires_at", "2026-10-24T14:00:00Z")
        assertNotNull(parseEnrollmentPayload(payload.toString(), DEFAULT_GATEWAY, now = null))
        assertThrows(IllegalArgumentException::class.java) { parseEnrollmentPayload(payload.toString(), DEFAULT_GATEWAY, now = epoch) }
        payload.put("expires_at", "invalid")
        assertThrows(java.time.format.DateTimeParseException::class.java) { parseEnrollmentPayload(payload.toString(), DEFAULT_GATEWAY, now = null) }
    }
}
