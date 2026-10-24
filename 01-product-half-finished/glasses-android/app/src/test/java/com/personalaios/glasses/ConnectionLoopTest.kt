package com.personalaios.glasses

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.CoroutineStart
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConnectionLoopTest {
    @Test fun formalPacketsAndTapWaitForReadyAndReleaseOnce() = runBlocking<Unit> {
        val ready = ConnectionLoop(); val sent = mutableListOf<String>()
        val requests = listOf("wear_state", "camera_status", "call_open").map { operation ->
            launch(start = CoroutineStart.UNDISPATCHED) { ready.awaitConnected(); sent += operation }
        }
        assertTrue(sent.isEmpty())
        ready.connected(); ready.connected()
        requests.forEach { it.join() }
        assertEquals(listOf("wear_state", "camera_status", "call_open"), sent)
    }

    @Test fun readinessTimeoutFailsRequestWithoutPublishing() = runBlocking<Unit> {
        val ready = ConnectionLoop(); var sent = false
        try {
            ready.awaitConnected(1); sent = true
            fail("Missing ready must fail")
        } catch (error: GatewayReadinessTimeout) {
            assertEquals("连接超时，请重试", error.message)
        }
        assertFalse(sent)
    }

    @Test fun disconnectFailsHeldPacketAndNewGenerationStillWaits() = runBlocking<Unit> {
        val ready = ConnectionLoop(); val error = IOException("gateway disconnected")
        var failure: Throwable? = null; var sent = false
        val pending = launch(start = CoroutineStart.UNDISPATCHED) {
            try { ready.awaitConnected(); sent = true } catch (caught: IOException) { failure = caught }
        }
        ready.failed(error); pending.join()
        assertTrue(failure is IOException); assertEquals(error.message, failure?.message); assertFalse(sent)
        ready.disconnected()
        val next = launch(start = CoroutineStart.UNDISPATCHED) { ready.awaitConnected(); sent = true }
        assertFalse(sent)
        ready.connected(); next.join(); assertTrue(sent)
    }

    @Test fun readyRequiresExactEnvelopeAndCurrentSession() {
        val ready = JSONObject().put("schema_version", "paios.central.text-envelope.v1")
            .put("session_id", "continuity-current").put("operation", "ready")
        assertEquals("ready", formalPacket(ready.toString().toByteArray(), "continuity-current").getString("operation"))
        assertEquals("accepted", formalPacket(JSONObject(ready.toString()).put("operation", "accepted")
            .toString().toByteArray(), "continuity-current").getString("operation"))
        val rejected = listOf(JSONObject(ready.toString()).put("extra", true),
            JSONObject(ready.toString()).put("session_id", "previous"),
            JSONObject(ready.toString()).put("schema_version", "other"))
        rejected.forEach { value ->
            try { formalPacket(value.toString().toByteArray(), "continuity-current"); fail("Invalid ready must be rejected") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun connectionTimeoutRetriesInsteadOfStoppingCompanion() = runBlocking<Unit> {
        var attempts = 0; var retries = 0
        try {
            ConnectionLoop { }.run({
                if (++attempts == 2) throw CancellationException("owner stopped")
                kotlinx.coroutines.withTimeout(1) { awaitCancellation() }
            }, { _, _ -> retries++ })
        } catch (_: CancellationException) { }
        assertEquals(2, attempts); assertEquals(1, retries)
    }

    @Test fun tapDuringBackoffWaitsAndCompletesOnceAfterReconnect() = runBlocking<Unit> {
        val backoff = CompletableDeferred<Unit>(); val resume = CompletableDeferred<Unit>()
        val done = CompletableDeferred<Unit>(); var attempts = 0; var calls = 0
        val loop = ConnectionLoop { backoff.complete(Unit); resume.await() }
        val driver = launch { loop.run({ connected ->
            attempts++; connected()
            if (attempts == 1) throw IOException("network lost")
            awaitCancellation()
        }, { _, _ -> }) }
        backoff.await()
        val tap = launch { loop.awaitConnected(); calls++; done.complete(Unit) }
        kotlinx.coroutines.yield()
        assertEquals(0, calls)
        resume.complete(Unit); done.await()
        assertEquals(2, attempts); assertEquals(1, calls)
        driver.cancelAndJoin(); tap.join()
    }

    @Test fun transientFailuresBackOffOneTwoFourSeconds() = runBlocking<Unit> {
        val waits = mutableListOf<Long>(); val retries = mutableListOf<Long>()
        val stop = CancellationException("test finished")
        var attempts = 0
        try {
            ConnectionLoop { waits += it }.run({
                if (++attempts == 4) throw stop
                throw IOException("socket disconnected")
            }, { _, delay -> retries += delay })
            fail("Cancellation must propagate")
        } catch (error: CancellationException) { assertSame(stop, error) }
        assertEquals(listOf(1000L, 2000L, 4000L), waits)
        assertEquals(waits, retries); assertEquals(4, attempts)
    }
    @Test fun connectedSessionResetsTheNextRetryDelay() = runBlocking<Unit> {
        val waits = mutableListOf<Long>(); var attempts = 0
        try {
            ConnectionLoop { waits += it }.run({ connected ->
                attempts++
                if (attempts == 4) throw CancellationException("test finished")
                if (attempts == 3) connected()
                throw IOException("socket disconnected")
            }, { _, _ -> })
            fail("Cancellation must propagate")
        } catch (_: CancellationException) { }
        assertEquals(listOf(1000L, 2000L, 1000L), waits)
        assertEquals(4, attempts)
    }
    @Test fun cancellationDuringWaitStopsWithoutAnotherAttempt() = runBlocking<Unit> {
        val stop = CancellationException("owner stopped")
        var attempts = 0; var retries = 0
        try {
            ConnectionLoop { throw stop }.run({ attempts++; throw IOException("disconnected") }, { _, _ -> retries++ })
            fail("Cancellation must propagate")
        } catch (error: CancellationException) { assertSame(stop, error) }
        assertEquals(1, attempts); assertEquals(1, retries)
    }
    @Test fun pairingAuthenticationLossStopsWithoutRetryOrWait() = runBlocking<Unit> {
        val lost = PairingAuthenticationLost("pairing revoked")
        var attempts = 0; var retries = 0; var waits = 0
        try {
            ConnectionLoop { waits++ }.run({ attempts++; throw lost }, { _, _ -> retries++ })
            fail("Pairing loss must propagate")
        } catch (error: PairingAuthenticationLost) { assertSame(lost, error) }
        assertEquals(1, attempts); assertEquals(0, retries); assertEquals(0, waits)
    }
}
