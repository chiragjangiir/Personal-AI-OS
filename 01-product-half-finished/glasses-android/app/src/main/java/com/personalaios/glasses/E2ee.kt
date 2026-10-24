package com.personalaios.glasses

import com.google.crypto.tink.subtle.X25519
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.time.Instant
import java.util.UUID
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The existing iPhone HPKE framing contract, using raw X25519 recipient keys. */
object E2ee {
    private const val suite = "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM"
    private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8)
    private fun u16(n: Int) = byteArrayOf((n ushr 8).toByte(), n.toByte())
    private fun lp(s: String): ByteArray = bytes(s).let { require(it.size <= 65535); u16(it.size) + it }
    private fun uuid(s: String): ByteArray {
        val u = UUID.fromString(s)
        return ByteBuffer.allocate(16).putLong(u.mostSignificantBits).putLong(u.leastSignificantBits).array()
    }
    private fun hex(s: String): ByteArray {
        require(Regex("^[a-f0-9]{64}$").matches(s))
        return s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
    private fun decode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
    private fun ref(v: JSONObject) = lp(v.getString("ref_type")) + uuid(v.getString("ref_id")) +
        lp(v.getString("object_version")) + hex(v.getString("canonical_payload_sha256"))
    private fun alias(v: JSONObject) = lp(v.getString("alias_type")) + lp(v.getString("issuer")) +
        lp(v.getString("value")) + if (v.has("provider_id")) byteArrayOf(1) + uuid(v.getString("provider_id")) else byteArrayOf(0)
    private fun aliases(v: JSONArray) = u16(v.length()) + (0 until v.length()).fold(byteArrayOf()) { a, i -> a + alias(v.getJSONObject(i)) }
    private fun strings(v: JSONArray, ids: Boolean) = u16(v.length()) +
        (0 until v.length()).fold(byteArrayOf()) { a, i -> a + if (ids) uuid(v.getString(i)) else lp(v.getString(i)) }
    private fun governance(v: JSONObject) = strings(v.getJSONArray("purpose_scopes"), false) +
        listOf("consent_record_refs", "policy_decision_refs", "purpose_token_refs", "capability_grant_refs")
            .fold(byteArrayOf()) { a, k -> a + strings(v.getJSONArray(k), true) }
    private fun idempotency(v: JSONObject): ByteArray {
        val s = v.getJSONObject("idempotency_scope")
        val presence = listOf("user_id", "tenant_id", "target_object_id").fold(byteArrayOf()) { a, k ->
            a + if (s.has(k)) byteArrayOf(1) + uuid(s.getString(k)) else byteArrayOf(0)
        }
        return lp(s.getString("owner_module")) + lp(s.getString("operation_kind")) + lp(s.getString("target_object_type")) +
            presence + lp(v.getString("idempotency_key")) + lp(v.getString("idempotency_profile_id")) +
            lp(v.getString("idempotency_profile_version")) + hex(v.getString("idempotency_profile_sha256")) + hex(v.getString("idempotency_request_sha256"))
    }
    private fun prefix(kind: String) = bytes("PAIOS-RT-HPKE-$kind") + lp("paios-realtime-e2ee-hpke-framing") +
        lp("realtime/e2ee") + lp("1.0.0") + u16(0x20) + u16(1) + u16(2) + byteArrayOf(0)
    private fun binding(r: JSONObject) = ref(r.getJSONObject("realtime_session_ref")) + ref(r.getJSONObject("device_lease_ref")) +
        uuid(r.getString("continuity_id")) + lp(r.getString("connection_epoch"))
    private fun keyBinding(r: JSONObject) = alias(r.getJSONObject("key_envelope_ref")) + lp(r.getInt("key_index").toString()) +
        lp(r.getString("key_generation")) + uuid(r.getString("device_id")) + ref(r.getJSONObject("recipient_device_credential_ref")) +
        alias(r.getJSONObject("participant_audience"))
    private fun extract(salt: ByteArray, input: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256")); doFinal(input)
    }
    private fun labeledExtract(id: ByteArray, salt: ByteArray, label: String, input: ByteArray) =
        extract(salt, bytes("HPKE-v1") + id + bytes(label) + input)
    private fun labeledExpand(id: ByteArray, prk: ByteArray, label: String, info: ByteArray, n: Int): ByteArray {
        val data = u16(n) + bytes("HPKE-v1") + id + bytes(label) + info
        val out = ByteArrayOutputStream(); var previous = byteArrayOf(); var i = 1
        while (out.size() < n) { previous = extract(prk, previous + data + byteArrayOf(i++.toByte())); out.write(previous) }
        return out.toByteArray().copyOf(n)
    }
    fun open(request: JSONObject, response: JSONObject, recipientPrivateKey: ByteArray, now: Instant = Instant.now()): ByteArray {
        val echoed = listOf("request_id", "idempotency_context", "realtime_session_ref", "device_lease_ref", "continuity_id",
            "connection_epoch", "transport_aliases", "key_envelope_ref", "key_index", "key_generation", "device_id",
            "recipient_device_credential_ref", "participant_audience", "governance")
        require(response.getString("operation") == "realtime_e2ee_key_resolve" && response.getString("status") == "key_resolved")
        require(response.getString("cipher_suite") == suite && Instant.parse(response.getString("expires_at")).isAfter(now))
        echoed.forEach { require(canonicalJson(response.get(it)) == canonicalJson(request.get(it))) { "Stale E2EE binding" } }
        val info = prefix("INFO") + lp("realtime_e2ee_key_resolve") + binding(request) + keyBinding(request)
        val aad = prefix("AAD") + lp(suite) + lp("realtime_e2ee_key_resolve") + lp("key_resolved") + lp(request.getString("request_id")) +
            idempotency(request.getJSONObject("idempotency_context")) + binding(request) + aliases(request.getJSONArray("transport_aliases")) +
            keyBinding(request) + lp(response.getString("expires_at")) + governance(request.getJSONObject("governance"))
        require(response.getString("aad_sha256") == sha256(aad)) { "E2EE AAD digest mismatch" }
        val enc = decode(response.getString("encapsulated_key")); require(enc.size == 32)
        val kem = bytes("KEM") + u16(0x20)
        val dh = X25519.computeSharedSecret(recipientPrivateKey, enc)
        val shared = try { labeledExpand(kem, labeledExtract(kem, byteArrayOf(), "eae_prk", dh), "shared_secret", enc + X25519.publicFromPrivate(recipientPrivateKey), 32) } finally { dh.fill(0) }
        val id = bytes("HPKE") + u16(0x20) + u16(1) + u16(2)
        val context = byteArrayOf(0) + labeledExtract(id, byteArrayOf(), "psk_id_hash", byteArrayOf()) + labeledExtract(id, byteArrayOf(), "info_hash", info)
        val secret = labeledExtract(id, shared, "secret", byteArrayOf()); shared.fill(0)
        val key = labeledExpand(id, secret, "key", context, 32)
        val nonce = labeledExpand(id, secret, "base_nonce", context, 12); secret.fill(0)
        val plain = try { Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); updateAAD(aad)
            doFinal(decode(response.getString("ciphertext")))
        } } finally { key.fill(0) }
        try {
            require(plain.size >= 10 && plain.copyOfRange(0, 8).contentEquals(bytes("PAIOSKEY")) && plain[8] == 0.toByte() && plain[9] == 1.toByte())
            var offset = 10
            fun read(): String { require(offset + 2 <= plain.size); val size = ((plain[offset].toInt() and 255) shl 8) or (plain[offset + 1].toInt() and 255)
                offset += 2; require(offset + size <= plain.size); val text = String(plain, offset, size, Charsets.UTF_8); offset += size; return text }
            require(read() == request.getInt("key_index").toString() && read() == request.getString("key_generation") && offset + 32 == plain.size)
            return plain.copyOfRange(offset, plain.size)
        } finally { plain.fill(0) }
    }
}
