package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OriginMigrationTest {
    private fun pairing() = JSONObject().put("origin", OriginMigration.LEGACY).put("token", "original-token")
        .put("device_id", "glasses-1").put("user_id", "owner-1").put("paired_at", "original-time")
        .put("governance", JSONObject().put("purpose", "realtime"))
    private fun bootstrap() = JSONObject().put("status", "bootstrap_accepted").put("canonical_api_origin", DEFAULT_GATEWAY)
        .put("realtime_session_ref", JSONObject().put("ref_id", "session-1"))
        .put("device_lease_ref", JSONObject().put("ref_id", "lease-1"))
        .put("continuity_id", "continuity-1").put("connection_epoch", "epoch-1")
    private fun proof() = bootstrap().put("status", "committed").also { it.remove("canonical_api_origin") }

    @Test fun successfulAuthenticatedMigrationChangesOnlyOriginAndMigrationMetadata() {
        val before = pairing(); var probes = 0
        val migrated = OriginMigration.announced(before, bootstrap()) { probes++; proof() }!!
        assertEquals(1, probes)
        assertEquals(OriginMigration.LEGACY, before.getString("origin"))
        assertEquals(DEFAULT_GATEWAY, migrated.getString("origin"))
        before.keys().forEach { key ->
            if (key != "origin") assertEquals(canonicalJson(before.get(key)), canonicalJson(migrated.get(key)))
        }
        assertNull(OriginMigration.fallback(migrated))
    }

    @Test fun failedProofLeavesStoredPairingUntouchedAndCanRetryLater() {
        val stored = pairing(); val original = stored.toString()
        assertNull(OriginMigration.announced(stored, bootstrap()) { null })
        assertEquals(original, stored.toString())
        assertNotNull(OriginMigration.announced(stored, bootstrap()) { proof() })
    }

    @Test fun unacceptedOrUnsafeAnnouncementsNeverSendTokenToTarget() {
        val uri = java.net.URI(DEFAULT_GATEWAY)
        val otherPort = if (uri.port == 9443) 9444 else 9443
        val invalid = listOf(DEFAULT_GATEWAY.replace("https://", "http://"),
            "https://${uri.host}:$otherPort", "$DEFAULT_GATEWAY/", "$DEFAULT_GATEWAY/path",
            "https://${uri.host}.evil.test", "https://user@${uri.rawAuthority}",
            "$DEFAULT_GATEWAY?next=evil", DEFAULT_GATEWAY.replace("https://", "wss://"))
        invalid.forEach { origin ->
            assertNull(OriginMigration.announced(pairing(), bootstrap().put("canonical_api_origin", origin)) {
                fail("Invalid origin must not receive a credential"); null
            })
        }
        assertNull(OriginMigration.announced(pairing(), bootstrap().put("status", "rejected")) {
            fail("Unauthenticated announcement must not be used"); null
        })
        assertNull(OriginMigration.announced(pairing().put("origin", "https://other.example"), bootstrap()) {
            fail("Only the owner rollout can migrate"); null
        })
    }

    @Test fun proofMustConfirmExactAuthenticatedBindingWithoutOriginEcho() {
        val invalid = listOf(proof().put("status", "uncommitted"),
            proof().put("continuity_id", "other"), proof().put("connection_epoch", "other"),
            proof().put("realtime_session_ref", JSONObject().put("ref_id", "other")),
            proof().put("device_lease_ref", JSONObject().put("ref_id", "other")), proof().also { it.remove("device_lease_ref") })
        invalid.forEach { response -> assertNull(OriginMigration.announced(pairing(), bootstrap()) { response }) }
    }

    @Test fun reloadRetainsLegacyIdentityWithoutReverseFallbackAfterSecondSuccess() {
        val migrated = JSONObject(OriginMigration.announced(pairing(), bootstrap()) { proof() }!!.toString())
        assertNull(OriginMigration.fallback(migrated))
        val confirmed = JSONObject(OriginMigration.confirmed(migrated)!!.toString())
        assertNull(OriginMigration.confirmed(confirmed))
        assertNull(OriginMigration.fallback(confirmed))
        val rolledBack = JSONObject(OriginMigration.switched(confirmed, OriginMigration.LEGACY).toString())
        assertEquals(OriginMigration.LEGACY, rolledBack.getString("origin"))
        assertEquals("original-token", rolledBack.getString("token"))
        assertEquals("glasses-1", rolledBack.getString("device_id"))
        assertEquals(DEFAULT_GATEWAY, OriginMigration.fallback(rolledBack))
        assertNotNull(OriginMigration.announced(rolledBack, bootstrap()) { proof() })
    }

    @Test fun freshInstallOriginIsDirectAndHasNoFallbackWithoutMigration() {
        assertEquals(BuildConfig.PAIOS_GATEWAY_ORIGIN, DEFAULT_GATEWAY)
        assertNull(OriginMigration.fallback(pairing().put("origin", DEFAULT_GATEWAY)))
    }
}
