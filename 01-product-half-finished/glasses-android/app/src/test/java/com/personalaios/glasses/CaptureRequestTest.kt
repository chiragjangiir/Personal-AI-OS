package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureRequestTest {
    private fun policy(interval: Long = 30000) = CapturePolicy(JSONObject()
        .put("enabled", true).put("private_paused", false).put("interval_ms", interval)
        .put("triggers", org.json.JSONArray(listOf("interval", "scene_change", "head_dwell", "user_request"))))
    private fun captureRequestAvailable(pending: String?, uploading: Boolean, retryAt: Long, lastFrame: Long, now: Long) =
        policy().requestAvailable(pending, uploading, retryAt, lastFrame, now, "user_request")

    @Test fun mixedAutomaticTriggersWaitForTheServerPolicySinceThePreviousUpload() {
        for (interval in listOf(5000L, 30000L, 60000L)) {
            val policy = policy(interval)
            val completedUpload = 100000L
            for (reason in listOf("interval", "scene_change", "head_dwell")) {
                assertFalse("$reason must not capture before policy interval $interval",
                    policy.requestAvailable(null, false, 0, completedUpload, completedUpload + interval - 1, reason))
                assertTrue(policy.requestAvailable(null, false, 0, completedUpload, completedUpload + interval, reason))
            }
        }
    }

    @Test fun motionAtTwentySecondsCannotConsumeTheNextIntervalSlot() {
        val policy = policy()
        assertFalse(policy.requestAvailable(null, false, 0, 100000, 120000, "scene_change"))
        assertTrue(policy.requestAvailable(null, false, 0, 100000, 130000, "interval"))
        assertFalse(policy.requestAvailable(null, false, 0, 130000, 150000, "head_dwell"))
    }

    @Test fun uploadLatencyDoesNotShortenTheAutomaticSpacingButExplicitPhotosKeepTheirCooldown() {
        val policy = policy()
        val started = 100000L
        val completed = started + 8000
        assertFalse(policy.requestAvailable(null, false, 0, completed, started + 30000, "interval"))
        assertTrue(policy.requestAvailable(null, false, 0, completed, completed + 30000, "interval"))
        assertFalse(policy.requestAvailable(null, true, 0, started, completed + 30000, "interval"))
        assertFalse(policy.requestAvailable(null, false, 0, completed, completed + 1999, "user_request"))
        assertTrue(policy.requestAvailable(null, false, 0, completed, completed + 2000, "user_request"))
    }

    @Test fun timerWaitsForTheReceiptDeadlineInsteadOfSkippingToTheNextGridSlot() {
        val policy = policy()
        val acknowledged = 31000L
        val due = captureIntervalDue(60000, acknowledged, policy.intervalMs)
        assertFalse(policy.requestAvailable(null, false, 0, acknowledged, 60000, "interval"))
        org.junit.Assert.assertEquals(61000L, due)
        assertTrue(policy.requestAvailable(null, false, 0, acknowledged, due, "interval"))
        val nextAck = 62000L
        val nextDue = captureIntervalDue(due + policy.intervalMs, nextAck, policy.intervalMs)
        org.junit.Assert.assertEquals(92000L, nextDue)
        assertTrue(policy.requestAvailable(null, false, 0, nextAck, nextDue, "interval"))
    }

    @Test fun explicitPhotoMovesTheExistingAutomaticTimerDeadline() {
        val policy = policy()
        assertTrue(policy.requestAvailable(null, false, 0, 31000, 35000, "user_request"))
        val photoAcknowledged = 38000L
        val due = captureIntervalDue(60000, photoAcknowledged, policy.intervalMs)
        org.junit.Assert.assertEquals(68000L, due)
        assertFalse(policy.requestAvailable(null, false, 0, photoAcknowledged, 60000, "interval"))
        assertTrue(policy.requestAvailable(null, false, 0, photoAcknowledged, due, "interval"))
    }
    @Test fun expiredToolCannotReplaceAnUploadingCallPhoto() {
        // The tool's 20-second wait can end before the stream's 30-second deadline.
        assertFalse("old upload still owns its frame after the tool expires",
            captureRequestAvailable(null, true, 0, 1000, 21000))
        assertTrue(captureRequestAvailable(null, false, 0, 1000, 21000))
        assertFalse(captureRequestAvailable("user_request", false, 0, 1000, 21000))
        assertFalse(captureRequestAvailable(null, false, 22000, 1000, 21000))
        assertFalse(captureRequestAvailable(null, false, 0, 20000, 21000))
    }
}
