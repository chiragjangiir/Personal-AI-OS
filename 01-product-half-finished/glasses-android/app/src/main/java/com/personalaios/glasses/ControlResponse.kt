package com.personalaios.glasses

import org.json.JSONObject
import java.net.URI
import java.time.Instant

/** Runtime bootstrap/stop producers and their realtime response schemas own these wire contracts. */
internal object ControlResponse {
    private fun same(a: JSONObject, b: JSONObject, vararg fields: String) = fields.forEach {
        require(canonicalJson(a.get(it)) == canonicalJson(b.get(it))) { "Control response binding mismatch: $it" }
    }
    private fun text(value: JSONObject, field: String): String {
        val text = value.get(field); require(text is String && text.isNotBlank()); return text
    }
    private fun uuid(value: String) { require(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(value)) }
    private fun decimal(value: JSONObject, field: String) { require(Regex("^[1-9][0-9]{0,37}$").matches(text(value, field))) }
    private fun hash(value: JSONObject, field: String) { require(Regex("^[a-f0-9]{64}$").matches(text(value, field))) }
    private fun ref(value: JSONObject, type: String) {
        require(value.getString("ref_type") == type); uuid(text(value, "ref_id"))
        require(Regex("^[1-9][0-9]*$").matches(text(value, "object_version"))); hash(value, "canonical_payload_sha256")
    }
    private fun alias(value: JSONObject) {
        listOf("alias_type", "issuer", "value").forEach { text(value, it) }
        if (value.has("provider_id")) uuid(text(value, "provider_id"))
    }
    private fun expiry(value: JSONObject, field: String = "expires_at"): Instant =
        Instant.parse(text(value, field))

    fun bootstrap(value: JSONObject, request: JSONObject, pairing: JSONObject) {
        require(value.getString("operation") == "bootstrap" && value.getString("status") == "bootstrap_accepted")
        same(value, request, "request_id", "bootstrap_mode", "governance")
        require(request.getString("device_id") == pairing.getString("device_id")); same(request, pairing, "governance")
        val governance = value.getJSONObject("governance")
        for (field in listOf("purpose_scopes", "consent_record_refs", "policy_decision_refs", "purpose_token_refs", "capability_grant_refs")) {
            val items = governance.getJSONArray(field); require(items.length() > 0)
            for (i in 0 until items.length()) {
                val item = items.getString(i); require(item.isNotBlank())
                if (field != "purpose_scopes") uuid(item)
            }
        }
        ref(value.getJSONObject("realtime_session_ref"), "RealtimeSession")
        ref(value.getJSONObject("device_lease_ref"), "DeviceLease")
        ref(value.getJSONObject("recipient_device_credential_ref"), "DeviceCredential")
        uuid(text(value, "continuity_id")); decimal(value, "connection_epoch")
        val aliases = value.getJSONArray("transport_aliases")
        val participants = (0 until aliases.length()).map { aliases.getJSONObject(it).also(::alias) }
            .count { it.getString("alias_type") == "participant" }
        require(participants == 1)
        val livekit = value.getJSONObject("livekit"); val url = URI(text(livekit, "server_url"))
        require(url.scheme == "wss" && !url.host.isNullOrBlank() && url.userInfo == null && url.query == null && url.fragment == null)
        require(url.port == -1 || url.port in 1..65535)
        text(livekit, "participant_token"); val credentialExpiry = expiry(livekit, "credential_expires_at")
        val transport = value.getJSONObject("central_text_transport")
        require(transport.getString("schema") == "paios.central.text-transport.v1" && transport.getString("execution_owner") == "hermes_text")
        require(transport.getString("input_topic") == "paios.central.text.v1" && transport.getString("output_topic") == "paios.central.sealed-text.v1")
        text(transport, "expected_gateway_identity"); require(transport.getInt("max_packet_bytes") in 1..12288)
        if (transport.has("call_rejoin_window_s")) {
            val window = transport.get("call_rejoin_window_s")
            require(window is Number && window.toDouble() % 1.0 == 0.0 && window.toLong() in 1L..2147483L)
        }
        val envelope = value.getJSONObject("e2ee_key_envelope")
        same(envelope, value, "realtime_session_ref", "continuity_id", "governance")
        alias(envelope.getJSONObject("key_envelope_ref")); require(envelope.getInt("key_index") >= 0)
        decimal(envelope, "key_generation"); require(!expiry(envelope).isAfter(credentialExpiry))
        val scope = envelope.getJSONObject("scope")
        require(scope.getString("device_id") == pairing.getString("device_id") && scope.getString("distribution_mode") == "application_controlled_envelope")
        val enabled = mutableSetOf<String>()
        for (media in listOf("audio", "video", "data")) {
            val grant = value.getJSONObject("media_grants").getJSONObject(media)
            if (!grant.getBoolean("enabled")) continue
            require(request.getJSONObject("requested_media").getBoolean(media))
            require(grant.getString("device_id") == pairing.getString("device_id")); same(grant, value, "device_lease_ref")
            val start = grant.getJSONObject("start_binding")
            require(start.getString("kind") == "explicit_user_start")
            same(start, request.getJSONObject("start"), "kind", "device_id")
            val requested = request.getJSONObject("start").getJSONArray("modalities")
            val allowed = (0 until requested.length()).map { requested.getString(it) }.toSet()
            val modalities = start.getJSONArray("modalities").let { array -> (0 until array.length()).map { array.getString(it) } }
            require(media in modalities && modalities.size == modalities.toSet().size && allowed.containsAll(modalities))
            require(!expiry(grant).isAfter(credentialExpiry)); enabled += media
        }
        val channels = scope.getJSONArray("channels").let { array -> (0 until array.length()).map { array.getString(it) } }
        require(enabled.isNotEmpty() && channels.size == channels.toSet().size && channels.toSet() == enabled)
    }

    fun stop(value: JSONObject, request: JSONObject) {
        require(value.getString("operation") == "media_stop" && value.getString("status") == "success")
        same(value, request, "request_id", "realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch", "governance")
        val outcome = value.getJSONObject("operation_outcome")
        require(outcome.getString("outcome_class") == "committed_success")
        require(outcome.getString("resolution_mode") in setOf("direct", "reconciled_no_effect", "reconciled_effect_confirmed"))
        val recorded = outcome.getJSONObject("recorded_result_ref")
        same(recorded, request, "idempotency_context")
        decimal(recorded, "fencing_epoch"); require(recorded.getString("outcome_class") == "committed_success")
        listOf("result_schema_id", "result_schema_version").forEach { text(recorded, it) }
        listOf("result_schema_sha256", "result_payload_sha256").forEach { hash(recorded, it) }
        val facts = value.getJSONObject("execution_facts")
        require(facts.getString("closure_status") == "verified_closed" && facts.getString("device_lease_release") in setOf("released", "already_released"))
        listOf("participant_cleanup", "track_cleanup", "room_cleanup").forEach { require(facts.getString(it) == "verified_absent") }
    }
}
