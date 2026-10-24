package com.personalaios.glasses

import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class GatewayMigrationTest {
    private fun body() = bootstrapRequest()
    private fun verifySame(calls: List<FakeControl>) {
        assertEquals(2, calls.size)
        assertArrayEquals(calls[0].bytes.toByteArray(), calls[1].bytes.toByteArray())
        calls.forEach { assertEquals("Bearer original-token", it.getRequestProperty("Authorization")); assertFalse(it.instanceFollowRedirects) }
    }

    @Test fun configuredOriginFailsThenRestartReplaysOriginalJournalThroughProvenCurrent() = runBlocking {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
        enrollment.seed(provenPair()); val calls = mutableListOf<FakeControl>()
        val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) { throw IOException("down") }.also { calls += it } })
        assertThrows(IOException::class.java) { client.post("bootstrap", "/v1/realtime/bootstrap", body()) }
        assertEquals(1, calls.size)
        assertEquals(DEFAULT_GATEWAY + "/v1/realtime/bootstrap", calls.single().url.toString())
        assertEquals(DEFAULT_GATEWAY, enrollment.pairing()!!.getString("origin"))
        val restarted = Enrollment(disk.restart().preferences, PlainTestCipher)
        val replay = mutableListOf<FakeControl>()
        val recovered = GatewayClient(restarted, openConnection = { url -> FakeControl(url) {
            if (url.path.endsWith("bootstrap")) 200 to accepted(JSONObject(it.bytes.toString())).toString()
            else 200 to stopped(JSONObject(it.bytes.toString())).toString()
        }.also { replay += it } })
        recovered.stop()
        assertArrayEquals(calls[0].bytes.toByteArray(), replay[0].bytes.toByteArray())
        assertEquals(DEFAULT_GATEWAY, replay[0].url.toString().removeSuffix("/v1/realtime/bootstrap"))
        assertEquals("Bearer original-token", replay[0].getRequestProperty("Authorization"))
        assertNull(restarted.controlJournal())
    }

    @Test fun beijingOutageAcrossRestartNeverRequestsRetiredEdge() {
        var disk = PreferenceDisk(); var enrollment = Enrollment(disk.preferences, PlainTestCipher)
        enrollment.seed(provenPair())
        repeat(2) {
            val before = canonicalJson(enrollment.pairing()); val calls = mutableListOf<FakeControl>()
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                if (url.toString().startsWith(DEFAULT_GATEWAY + "/")) throw IOException("down")
                200 to accepted(JSONObject(it.bytes.toString())).toString()
            }.also { calls += it } })
            assertThrows(IOException::class.java) { client.post("bootstrap", "/v1/realtime/bootstrap", body()) }
            assertEquals(listOf(DEFAULT_GATEWAY + "/v1/realtime/bootstrap"), calls.map { it.url.toString() })
            assertEquals(before, canonicalJson(enrollment.pairing()))
            disk = disk.restart(); enrollment = Enrollment(disk.preferences, PlainTestCipher)
            assertNull(OriginMigration.fallback(enrollment.pairing()!!))
        }
    }

    @Test fun alternateRejectedSemanticallyOrByHttpNeverChangesEnrollmentOrRecurses() {
        for ((code, result) in listOf(200 to "{\"status\":\"wrong\"}", 400 to "{}", 302 to "{}")) {
            val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
            enrollment.seed(provenPair().put("origin", OriginMigration.LEGACY)); val before = canonicalJson(enrollment.pairing()); val calls = mutableListOf<FakeControl>()
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                if (url.toString().startsWith(OriginMigration.LEGACY + "/")) throw IOException("down") else code to result
            }.also { calls += it } })
            assertThrows(Exception::class.java) { client.post("bootstrap", "/v1/realtime/bootstrap", body()) }
            verifySame(calls); assertEquals(before, canonicalJson(enrollment.pairing()))
            assertEquals(before, canonicalJson(Enrollment(disk.restart().preferences, PlainTestCipher).pairing()))
        }
    }

    @Test fun discoveryReturnsAcceptedSessionBeforeProofAndStaleImportWinsCas() = runBlocking {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher); enrollment.seed(pair())
        val started = CountDownLatch(1); val release = CountDownLatch(1); val owner = SupervisorJob()
        val scope = CoroutineScope(owner + Dispatchers.Default); val calls = java.util.Collections.synchronizedList(mutableListOf<FakeControl>())
        val client = GatewayClient(enrollment, scope, { url -> FakeControl(url) {
            if (url.path.endsWith("reconcile")) { started.countDown(); check(release.await(3, TimeUnit.SECONDS)); 200 to accepted(JSONObject(it.bytes.toString())).put("status", "committed").toString() }
            else 200 to accepted(JSONObject(it.bytes.toString())).toString()
        }.also { calls += it } })
        try {
            assertEquals("bootstrap_accepted", client.post("bootstrap", "/v1/realtime/bootstrap", body()).getString("status"))
            assertTrue(started.await(3, TimeUnit.SECONDS))
            assertEquals(OriginMigration.LEGACY, enrollment.pairing()!!.getString("origin"))
            val second = Enrollment(disk.preferences, PlainTestCipher); second.clearPairing(); second.seed(pair(device = "replacement"))
            release.countDown(); owner.children.toList().joinAll()
            assertEquals("replacement", enrollment.pairing()!!.getString("device_id"))
            verifySame(calls)
        } finally { release.countDown(); owner.cancel() }
    }

    @Test fun legacyRecoveryOnlyMovesToConfiguredDirectOrigin() {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
        enrollment.seed(provenPair().put("origin", OriginMigration.LEGACY))
        val calls = mutableListOf<FakeControl>()
        val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
            if (url.toString().startsWith(OriginMigration.LEGACY + "/")) throw IOException("down")
            200 to accepted(JSONObject(it.bytes.toString())).toString()
        }.also { calls += it } })
        client.post("bootstrap", "/v1/realtime/bootstrap", body())
        verifySame(calls)
        assertEquals(DEFAULT_GATEWAY + "/v1/realtime/bootstrap", calls.last().url.toString())
        assertEquals(DEFAULT_GATEWAY, Enrollment(disk.restart().preferences, PlainTestCipher).pairing()!!.getString("origin"))
        assertNull(OriginMigration.fallback(enrollment.pairing()!!))
    }

    @Test fun discoveryFailureIsPacedThenSuccessMigratesWithOriginalBytes() = runBlocking {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher); enrollment.seed(pair())
        val owner = SupervisorJob(); val scope = CoroutineScope(owner + Dispatchers.Default)
        var clock = 0L; var probes = 0; var succeed = false
        val calls = java.util.Collections.synchronizedList(mutableListOf<FakeControl>())
        val client = GatewayClient(enrollment, scope, { url -> FakeControl(url) {
            if (url.path.endsWith("reconcile")) { probes++; if (!succeed) throw IOException("down"); 200 to accepted(JSONObject(it.bytes.toString())).put("status", "committed").toString() }
            else 200 to accepted(JSONObject(it.bytes.toString())).toString()
        }.also { calls += it } }, { clock })
        try {
            client.post("bootstrap", "/v1/realtime/bootstrap", body()); owner.children.toList().joinAll()
            client.post("bootstrap", "/v1/realtime/bootstrap", body()); owner.children.toList().joinAll()
            assertEquals(1, probes)
            clock = 1000L; succeed = true
            client.post("bootstrap", "/v1/realtime/bootstrap", body()); owner.children.toList().joinAll()
            assertEquals(2, probes); assertEquals(DEFAULT_GATEWAY, enrollment.pairing()!!.getString("origin"))
            assertArrayEquals(calls[0].bytes.toByteArray(), calls[1].bytes.toByteArray())
            assertEquals(DEFAULT_GATEWAY, Enrollment(disk.restart().preferences, PlainTestCipher).pairing()!!.getString("origin"))
        } finally { owner.cancel() }
    }
}
