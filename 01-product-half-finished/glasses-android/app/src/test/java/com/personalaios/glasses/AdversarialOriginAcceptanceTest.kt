package com.personalaios.glasses

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class AdversarialOriginAcceptanceTest {
    private fun enrolled(disk: PreferenceDisk) = Enrollment(disk.preferences, PlainTestCipher).also {
        it.seed(OriginMigration.confirmed(provenPair())!!.put("media", JSONArray(listOf("audio", "data"))))
    }
    private fun keyReply(request: JSONObject) = JSONObject(request.toString()).put("status", "key_resolved")
        .put("cipher_suite", "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM")
        .put("expires_at", "2099-01-01T00:00:00Z").put("encapsulated_key", "AQ").put("ciphertext", "AQ").put("aad_sha256", "0".repeat(64))
    private fun healthy(enrollment: Enrollment, calls: MutableList<FakeControl>, expiredReplayId: String? = null,
        decorateBootstrap: (JSONObject) -> Unit = {}) = GatewayClient(enrollment,
        openConnection = { url -> FakeControl(url) {
            val request = JSONObject(it.bytes.toString())
            200 to when (request.getString("operation")) {
                "bootstrap" -> accepted(request).also { response ->
                    decorateBootstrap(response)
                    if (request.getString("request_id") == expiredReplayId) {
                        response.getJSONObject("livekit").put("credential_expires_at", "2000-01-01T00:00:00Z")
                        response.getJSONObject("e2ee_key_envelope").put("expires_at", "2000-01-01T00:00:00Z")
                        for (media in listOf("audio", "data")) response.getJSONObject("media_grants").getJSONObject(media).put("expires_at", "2000-01-01T00:00:00Z")
                    }
                }
                "media_stop" -> stopped(request)
                else -> keyReply(request)
            }.toString()
        }.also { calls += it } },
        // Healthy key success is stubbed; bootstrap/stop qualification, journal, ordering and route persistence are real.
        openKey = { _, _, _ -> ByteArray(32) { 7 } })

    @Test fun incompleteBootstrapKeepsPendingAndExpiredReplayCanStopThenConnectAfterRestart() = runBlocking {
        val disk = PreferenceDisk(); val enrollment = enrolled(disk); val before = canonicalJson(enrollment.pairing())
        val requests = mutableListOf<FakeControl>()
        val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
            200 to "{\"status\":\"bootstrap_accepted\"}"
        }.also { requests += it } })
        assertThrows(Exception::class.java) { runBlocking { client.connect(enrollment.pairing()!!) } }
        assertEquals(before, canonicalJson(enrollment.pairing()))
        val journal = enrollment.controlJournal()!!
        assertNull(journal.optJSONObject("bootstrap"))
        val pending = journal.getJSONObject("pending").getJSONObject("body")
        assertEquals(1, requests.size)
        assertEquals(canonicalJson(pending), requests[0].bytes.toString())
        val restarted = Enrollment(disk.restart().preferences, PlainTestCipher); val healthyCalls = mutableListOf<FakeControl>()
        val recovered = healthy(restarted, healthyCalls, pending.getString("request_id"))
        val connection = recovered.connect(restarted.pairing()!!)
        assertEquals("glasses-1", connection.deviceId); assertArrayEquals(ByteArray(32) { 7 }, connection.contentKey)
        assertEquals(DEFAULT_GATEWAY + "/v1/realtime/bootstrap", healthyCalls.first().url.toString())
        assertArrayEquals(requests[0].bytes.toByteArray(), healthyCalls.first().bytes.toByteArray())
        assertEquals("media_stop", JSONObject(healthyCalls[1].bytes.toString()).getString("operation"))
        assertEquals("bootstrap", JSONObject(healthyCalls[2].bytes.toString()).getString("operation"))
        assertNull(restarted.controlJournal()!!.optJSONObject("pending"))
        assertEquals(DEFAULT_GATEWAY, restarted.pairing()!!.getString("origin")); recovered.clear()
    }

    private fun rewriteRef(value: JSONObject, name: String, field: String, replacement: Any) {
        val changed = value.getJSONObject(name).put(field, replacement)
        if (name == "realtime_session_ref") value.getJSONObject("e2ee_key_envelope").put(name, JSONObject(changed.toString()))
        if (name == "device_lease_ref") for (media in listOf("audio", "video", "data")) {
            val grant = value.getJSONObject("media_grants").getJSONObject(media)
            if (grant.getBoolean("enabled")) grant.put(name, JSONObject(changed.toString()))
        }
    }

    @Test fun malformedCanonicalRefsKeepPendingAcrossConfiguredAndLegacyRoutes() = runBlocking {
        // The four reviewer captures contain these exact corrupt fields in the following key request.
        for (initial in listOf(OriginMigration.LEGACY, DEFAULT_GATEWAY)) {
            for ((field, bad) in listOf("object_version" to "not-a-version", "ref_id" to "1-1-1-1-1")) {
                val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
                enrollment.seed(provenPair(initial).put("media", JSONArray(listOf("audio", "data"))))
                val before = canonicalJson(enrollment.pairing()); val requests = mutableListOf<FakeControl>()
                val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) { call ->
                    if (initial == OriginMigration.LEGACY && url.toString().startsWith(initial + "/")) throw IOException("selected route unavailable")
                    200 to accepted(JSONObject(call.bytes.toString())).also { rewriteRef(it, "realtime_session_ref", field, bad) }.toString()
                }.also { requests += it } })
                assertThrows(IllegalArgumentException::class.java) { runBlocking { client.connect(enrollment.pairing()!!) } }
                assertEquals(before, canonicalJson(enrollment.pairing()))
                assertEquals(if (initial == OriginMigration.LEGACY) 2 else 1, requests.size)
                assertEquals(initial + "/v1/realtime/bootstrap", requests[0].url.toString())
                assertEquals(DEFAULT_GATEWAY + "/v1/realtime/bootstrap", requests.last().url.toString())
                assertArrayEquals(requests[0].bytes.toByteArray(), requests.last().bytes.toByteArray())
                val journal = enrollment.controlJournal()!!; assertNull(journal.optJSONObject("bootstrap"))
                assertEquals(requests[0].bytes.toString(), canonicalJson(journal.getJSONObject("pending").getJSONObject("body")))
                assertTrue(requests.all { JSONObject(it.bytes.toString()).getString("operation") == "bootstrap" })
                val restarted = Enrollment(disk.restart().preferences, PlainTestCipher); val calls = mutableListOf<FakeControl>()
                val recovered = healthy(restarted, calls)
                assertArrayEquals(ByteArray(32) { 7 }, recovered.connect(restarted.pairing()!!).contentKey)
                assertEquals(initial + "/v1/realtime/bootstrap", calls.first().url.toString())
                assertArrayEquals(requests[0].bytes.toByteArray(), calls.first().bytes.toByteArray())
                assertEquals(listOf("bootstrap", "media_stop", "bootstrap", "realtime_e2ee_key_resolve"),
                    calls.map { JSONObject(it.bytes.toString()).getString("operation") })
                assertEquals(initial, restarted.pairing()!!.getString("origin"))
                assertNull(restarted.controlJournal()!!.optJSONObject("pending")); recovered.clear()
            }
        }
    }

    @Test fun everyRetainedRefRejectsNonstringOrNonpositiveVersionsAndNoncanonicalUuidV7() = runBlocking {
        val badFields: List<Pair<String, Any>> = listOf("object_version" to 1, "object_version" to "0",
            "object_version" to "01", "object_version" to "-1", "ref_id" to "1-1-1-1-1",
            "ref_id" to "018F0000-0000-7000-8000-000000000004", "ref_id" to "018f0000-0000-4000-8000-000000000004",
            "ref_id" to "018f0000-0000-7000-7000-000000000004")
        for (name in listOf("realtime_session_ref", "device_lease_ref", "recipient_device_credential_ref")) for ((field, bad) in badFields) {
            val disk = PreferenceDisk(); val enrollment = enrolled(disk); val before = canonicalJson(enrollment.pairing())
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) { call ->
                200 to accepted(JSONObject(call.bytes.toString())).also { rewriteRef(it, name, field, bad) }.toString()
            } })
            assertThrows(IllegalArgumentException::class.java) { runBlocking { client.connect(enrollment.pairing()!!) } }
            assertEquals(before, canonicalJson(enrollment.pairing()))
            assertNull(enrollment.controlJournal()!!.optJSONObject("bootstrap"))
            assertEquals("bootstrap", enrollment.controlJournal()!!.getJSONObject("pending").getString("slug"))
        }
    }

    @Test fun unboundedPositiveObjectVersionsRemainUsableThroughPublicConnectAndRestart() = runBlocking {
        val disk = PreferenceDisk(); val enrollment = enrolled(disk); val version = "1" + "0".repeat(128)
        val decorate: (JSONObject) -> Unit = { response ->
            for (name in listOf("realtime_session_ref", "device_lease_ref", "recipient_device_credential_ref"))
                rewriteRef(response, name, "object_version", version)
        }
        val first = healthy(enrollment, mutableListOf(), decorateBootstrap = decorate)
        first.connect(enrollment.pairing()!!); first.clear()
        val restarted = Enrollment(disk.restart().preferences, PlainTestCipher); val calls = mutableListOf<FakeControl>()
        val recovered = healthy(restarted, calls, decorateBootstrap = decorate)
        assertArrayEquals(ByteArray(32) { 7 }, recovered.connect(restarted.pairing()!!).contentKey)
        val stop = JSONObject(calls.first().bytes.toString())
        assertEquals("media_stop", stop.getString("operation"))
        assertEquals(version, stop.getJSONObject("realtime_session_ref").getString("object_version"))
        assertEquals(version, stop.getJSONObject("device_lease_ref").getString("object_version"))
        assertEquals(version, restarted.controlJournal()!!.getJSONObject("bootstrap").getJSONObject("recipient_device_credential_ref").getString("object_version"))
        assertNull(restarted.controlJournal()!!.optJSONObject("pending")); recovered.clear()
    }

    @Test fun bootstrapRequiredFieldsAndPairingBindingsQualifyBeforeAnyJournalOrRouteReplacement() = runBlocking {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.remove("livekit") }, { it.getJSONObject("livekit").remove("participant_token") },
            { it.remove("central_text_transport") }, { it.getJSONObject("central_text_transport").remove("expected_gateway_identity") },
            { it.remove("recipient_device_credential_ref") }, { it.remove("e2ee_key_envelope") },
            { it.put("request_id", "foreign-request") }, { it.put("bootstrap_mode", "fully_disconnected") },
            { it.put("governance", JSONObject()) }, { it.put("transport_aliases", JSONArray()) },
            { it.getJSONObject("e2ee_key_envelope").put("continuity_id", "other") },
            { it.getJSONObject("e2ee_key_envelope").getJSONObject("scope").put("device_id", "other") },
            { it.getJSONObject("media_grants").getJSONObject("audio").put("device_id", "other") },
            { it.getJSONObject("device_lease_ref").remove("canonical_payload_sha256") })
        for (mutate in mutations) {
            val disk = PreferenceDisk(); val enrollment = enrolled(disk); val before = canonicalJson(enrollment.pairing())
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                200 to accepted(JSONObject(it.bytes.toString())).also(mutate).toString()
            } })
            assertThrows(Exception::class.java) { runBlocking { client.connect(enrollment.pairing()!!) } }
            assertEquals(before, canonicalJson(enrollment.pairing()))
            assertNull(enrollment.controlJournal()!!.optJSONObject("bootstrap"))
            assertEquals("bootstrap", enrollment.controlJournal()!!.getJSONObject("pending").getString("slug"))
        }
    }

    @Test fun stopMismatchesPreserveOriginalPendingAndRestartUsesProvenRoute() = runBlocking {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("request_id", "foreign") }, { it.put("continuity_id", "foreign") },
            { it.put("connection_epoch", "9") }, { it.put("device_lease_ref", JSONObject()) },
            { it.put("governance", JSONObject()) }, { it.getJSONObject("operation_outcome").put("outcome_class", "indeterminate") },
            { it.getJSONObject("execution_facts").put("closure_status", "indeterminate") },
            { it.getJSONObject("operation_outcome").getJSONObject("recorded_result_ref").put("idempotency_context", JSONObject()) })
        for (mutate in mutations) {
            val disk = PreferenceDisk(); val enrollment = enrolled(disk)
            healthy(enrollment, mutableListOf()).connect(enrollment.pairing()!!)
            val before = canonicalJson(enrollment.pairing()); val calls = mutableListOf<FakeControl>()
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                200 to stopped(JSONObject(it.bytes.toString())).also(mutate).toString()
            }.also { calls += it } })
            assertThrows(Exception::class.java) { runBlocking { client.stop() } }
            assertEquals(before, canonicalJson(enrollment.pairing()))
            val pending = enrollment.controlJournal()!!.getJSONObject("pending").getJSONObject("body")
            assertEquals(canonicalJson(pending), calls[0].bytes.toString())
            assertEquals(1, calls.size)
            val restarted = Enrollment(disk.restart().preferences, PlainTestCipher); val recovered = mutableListOf<FakeControl>()
            healthy(restarted, recovered).stop()
            assertArrayEquals(calls[0].bytes.toByteArray(), recovered.first().bytes.toByteArray())
            assertEquals(DEFAULT_GATEWAY + "/v1/realtime/media/stop", recovered.first().url.toString())
            assertNull(restarted.controlJournal())
        }
    }

    @Test fun keyMismatchesUseRealE2eeOwnerBeforeRouteOrJournalChangesAndRestartRecovers() = runBlocking {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("request_id", "foreign") }, { it.put("operation", "bootstrap") },
            { it.put("status", "success") }, { it.put("connection_epoch", "9") },
            { it.put("device_id", "foreign") }, { it.put("recipient_device_credential_ref", JSONObject()) },
            { it.put("participant_audience", JSONObject()) }, { it.put("idempotency_context", JSONObject()) })
        for ((index, mutate) in mutations.withIndex()) {
            val disk = PreferenceDisk(); val enrollment = enrolled(disk); val before = canonicalJson(enrollment.pairing())
            val calls = mutableListOf<FakeControl>(); var binding: JSONObject? = null
            // Default key opener is real E2ee.open. The valid suite reaches its exact echo checks before decryption.
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                val request = JSONObject(it.bytes.toString())
                if (url.path.endsWith("bootstrap")) 200 to accepted(request).also { binding = it }.toString()
                else 200 to keyReply(request).put("cipher_suite", "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM").also(mutate).toString()
            }.also { calls += it } })
            val rejection = assertThrows(IllegalArgumentException::class.java) { runBlocking { client.connect(enrollment.pairing()!!) } }
            if (index !in 1..2) assertEquals("Stale E2EE binding", rejection.message)
            assertEquals(before, canonicalJson(enrollment.pairing()))
            val journal = enrollment.controlJournal()!!
            assertNull(journal.optJSONObject("pending"))
            assertEquals(canonicalJson(binding), canonicalJson(journal.getJSONObject("bootstrap")))
            val restarted = Enrollment(disk.restart().preferences, PlainTestCipher); val recoveredCalls = mutableListOf<FakeControl>()
            val recovered = healthy(restarted, recoveredCalls)
            assertEquals("glasses-1", recovered.connect(restarted.pairing()!!).deviceId)
            assertEquals(DEFAULT_GATEWAY + "/v1/realtime/media/stop", recoveredCalls.first().url.toString())
            assertNull(restarted.controlJournal()!!.optJSONObject("pending"))
            recovered.clear()
        }
    }
}
