package com.personalaios.glasses

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant
import java.util.Base64

/** Frozen RFC-009 cross-end vector from gateway/tests/realtime-e2ee-ciphertext-resolver.test.ts. */
class E2eeContractTest {
    @Test fun enrollmentQrRejectsForeignGatewayExpiredAndNonEnrollmentCodes() {
        val origin = "https://api.example"
        val qr = JSONObject().put("schema", "paios.glasses-enrollment.v1").put("origin", origin)
            .put("token", "a".repeat(43)).put("expires_at", "2026-10-12T10:05:00.000Z")
        val now = Instant.parse("2026-10-12T10:00:00Z").toEpochMilli()
        org.junit.Assert.assertEquals(origin, parseEnrollmentPayload(qr.toString(), origin, now).getString("origin"))
        assertThrows(IllegalArgumentException::class.java) { parseEnrollmentPayload(qr.toString(), "https://foreign.example", now) }
        assertThrows(IllegalArgumentException::class.java) { parseEnrollmentPayload(qr.toString(), origin, now + 300_000) }
        qr.put("schema", "paios.device-pairing.v1")
        assertThrows(IllegalArgumentException::class.java) { parseEnrollmentPayload(qr.toString(), origin, now) }
    }
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun encoded(value: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(hex(value))
    private val at = Instant.parse("2026-08-23T11:59:00Z")
    private val secret = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
    private fun ref(type: String, id: String, version: String, hash: String) = JSONObject()
        .put("ref_type", type).put("ref_id", "018f0e0e-0000-7000-8000-00000000000$id")
        .put("object_version", version).put("canonical_payload_sha256", hash.repeat(64))
    private fun alias(type: String, issuer: String, value: String) = JSONObject().put("alias_type", type).put("issuer", issuer).put("value", value)
    private fun request(): JSONObject {
        val governance = JSONObject().put("purpose_scopes", JSONArray(listOf("realtime_audio")))
        listOf("consent_record_refs", "policy_decision_refs", "purpose_token_refs", "capability_grant_refs").forEachIndexed { i, key ->
            governance.put(key, JSONArray(listOf("018f0e0e-0000-7000-8000-00000000000" + (7 + i).toString(16))))
        }
        return JSONObject().put("operation", "realtime_e2ee_key_resolve").put("request_id", "req-test-00000001")
            .put("idempotency_context", JSONObject().put("idempotency_scope", JSONObject().put("owner_module", "T11B")
                .put("operation_kind", "realtime_e2ee_key_resolve").put("target_object_type", "RealtimeSession"))
                .put("idempotency_key", "idem-test-00000001").put("idempotency_profile_id", "https://personal-ai-os.local/contracts/realtime/realtime-e2ee-key-resolve-request.v1.schema.json")
                .put("idempotency_profile_version", "1.0.0").put("idempotency_profile_sha256", "4".repeat(64)).put("idempotency_request_sha256", "5".repeat(64)))
            .put("realtime_session_ref", ref("RealtimeSession", "1", "1", "1")).put("device_lease_ref", ref("DeviceLease", "2", "2", "2"))
            .put("continuity_id", "018f0e0e-0000-7000-8000-000000000003").put("connection_epoch", "7")
            .put("transport_aliases", JSONArray().put(alias("room", "test_provider", "room-001")))
            .put("key_envelope_ref", alias("key_envelope", "paios", "env-001")).put("key_index", 0).put("key_generation", "1")
            .put("device_id", "018f0e0e-0000-7000-8000-000000000004").put("recipient_device_credential_ref", ref("DeviceCredential", "6", "3", "3"))
            .put("participant_audience", alias("participant", "paios", "aud-001")).put("governance", governance)
    }
    private fun response(request: JSONObject) = JSONObject(request.toString()).put("status", "key_resolved")
        .put("expires_at", "2026-08-23T12:00:00.000Z").put("cipher_suite", "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM")
        .put("encapsulated_key", encoded("358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254"))
        .put("ciphertext", encoded("f34a71ee2caa4b25bd686e079bea8fd3b9fd24855f73c91fcdb96ba5121da387b7fe6d7790478ff3ac54396fc8eaf0d4171e7500e3f06b8cacf2330b7fd535d2"))
        .put("aad_sha256", "5dcb52c670cc00be562f9ab41fb2ae14c2e89253a435d2a0569f64635a23fc9b")

    @Test fun frozenServerVectorReturnsRawContentKey() {
        val request = request()
        assertArrayEquals(hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"), E2ee.open(request, response(request).apply { put("server_extension", true) }, secret, at))
    }
    @Test fun expiredAndForeignBindingsCannotOpen() {
        val request = request(); val response = response(request)
        assertThrows(IllegalArgumentException::class.java) { E2ee.open(request, response, secret, at.plusSeconds(61)) }
        val ciphertext = Base64.getUrlDecoder().decode(response.getString("ciphertext"))
        ciphertext[0] = (ciphertext[0].toInt() xor 1).toByte()
        response.put("ciphertext", Base64.getUrlEncoder().withoutPadding().encodeToString(ciphertext))
        assertThrows(java.security.GeneralSecurityException::class.java) { E2ee.open(request, response, secret, at) }
        response.put("connection_epoch", "8")
        assertThrows(IllegalArgumentException::class.java) { E2ee.open(request, response, secret, at) }
    }
}
