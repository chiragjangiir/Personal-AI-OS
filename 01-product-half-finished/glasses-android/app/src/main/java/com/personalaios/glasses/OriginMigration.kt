package com.personalaios.glasses

import org.json.JSONObject

/** Bounded owner rollout. Exact origins also reject credentials, paths, suffix tricks and redirects. */
internal object OriginMigration {
    val LEGACY = BuildConfig.PAIOS_LEGACY_GATEWAY_ORIGIN
    private const val STATE = "api_origin_migration"

    fun announced(pairing: JSONObject, bootstrap: JSONObject, proof: () -> JSONObject?): JSONObject? {
        if (pairing.optString("origin") != LEGACY || bootstrap.optString("status") != "bootstrap_accepted" ||
            bootstrap.optString("canonical_api_origin") != DEFAULT_GATEWAY) return null
        val verified = proof() ?: return null
        if (verified.optString("status") != "committed" ||
            listOf("realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch").any {
                !bootstrap.has(it) || !verified.has(it) || canonicalJson(bootstrap.get(it)) != canonicalJson(verified.get(it))
            }) return null
        return JSONObject(pairing.toString()).put("origin", DEFAULT_GATEWAY)
            .put(STATE, JSONObject().put("fallback_origin", LEGACY).put("confirmed", false))
    }

    fun confirmed(pairing: JSONObject): JSONObject? {
        if (pairing.optString("origin") != DEFAULT_GATEWAY ||
            pairing.optJSONObject(STATE)?.optString("fallback_origin") != LEGACY ||
            pairing.getJSONObject(STATE).optBoolean("confirmed")) return null
        return JSONObject(pairing.toString()).also { it.getJSONObject(STATE).put("confirmed", true) }
    }

    fun fallback(pairing: JSONObject): String? {
        if (pairing.optJSONObject(STATE)?.optString("fallback_origin") != LEGACY) return null
        return if (pairing.optString("origin") == LEGACY) DEFAULT_GATEWAY else null
    }

    fun switched(pairing: JSONObject, origin: String): JSONObject = JSONObject(pairing.toString()).put("origin", origin)
}
