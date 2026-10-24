package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CapturePolicyTest {
    private fun policy() = JSONObject("""{"enabled":true,"private_paused":false,"interval_ms":30000,"triggers":["interval","user_request"]}""")
    @Test fun automaticMemoryRequiresWearAndHonorsAvailabilityAndPrivacy() {
        val applied = CapturePolicy(policy())
        assertTrue(applied.allows(true, true, false, true))
        assertFalse(applied.allows(true, true, false, null))
        assertFalse("automatic memory must honor the server wear gate", applied.allows(true, true, false, false))
        assertFalse(applied.allows(true, false, false, true))
        assertFalse(applied.allows(true, true, true, true))
    }
    @Test fun serverPauseAndDisableAreHonoredWithoutPolicyWearField() {
        assertFalse(CapturePolicy(policy().put("private_paused", true)).allows(true, true, false, true))
        assertFalse(CapturePolicy(policy().put("enabled", false)).allows(true, true, false, true))
    }
    @Test fun memoryDisabledDoesNotDisableCallButPrivacyAndRemovalDo() {
        val disabled = CapturePolicy(policy().put("enabled", false))
        assertFalse(disabled.allows(true, true, false, true))
        assertTrue(disabled.allowsCall(true, false, true))
        assertFalse(disabled.allowsCall(true, true, true))
        assertFalse(disabled.allowsCall(true, false, false))
        assertFalse(disabled.allowsCall(true, false, null))
        assertFalse(disabled.allowsCall(false, false, true))
        assertFalse(CapturePolicy(policy().put("private_paused", true)).allowsCall(true, false, true))
    }
    @Test fun ambientModeOffStopsMemoryButNotTheCallsOwnVideo() {
        val applied = CapturePolicy(policy())
        for (available in listOf(false, true)) for (pending in listOf(false, true))
            for (worn in listOf(null, false, true)) assertFalse(applied.allows(false, available, pending, worn))
        assertTrue(applied.allows(true, true, false, true))
        assertTrue(applied.allowsCall(true, false, true))
    }
    @Test fun malformedPolicyReplacementCannotPoisonCurrentPolicy() {
        val input = policy()
        var applied = CapturePolicy(input)
        val original = applied
        assertThrows(ClassCastException::class.java) { applied = CapturePolicy(policy().put("enabled", "true")) }
        assertThrows(IllegalArgumentException::class.java) { applied = CapturePolicy(policy().put("interval_ms", 1.5)) }
        input.put("interval_ms", "invalid").getJSONArray("triggers").put("head_dwell")
        assertSame(original, applied)
        assertEquals(30000L, applied.intervalMs)
        assertEquals(setOf("interval", "user_request"), applied.triggers)
    }

}
