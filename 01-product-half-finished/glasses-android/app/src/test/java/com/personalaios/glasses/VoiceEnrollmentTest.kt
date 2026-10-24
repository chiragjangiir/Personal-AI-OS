package com.personalaios.glasses

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VoiceEnrollmentTest {
    private fun grant(ms: Long = 600000) = JSONObject().put("enrolment", JSONObject().put("granted", true)
        .put("expires_in_ms", ms).put("sentences", JSONArray((1..8).map { "服务器的第 $it 句" })))
    private fun sample(op: String, status: String, quality: String? = null, index: Int = 1) = JSONObject()
        .put("operation", "voiceprint_sample").put("operation_id", op).put("status", status).put("quality", quality)
        .apply { if (quality == "ok") put("sample_id", "vps-00000000-0000-4000-8000-${index.toString().padStart(12, '0')}") }
    private fun measured(voice: VoiceEnrollment, now: Long, quality: String = "ok", index: Int = 1): String {
        val open = voice.tap(now).single(); assertEquals("voiceprint_open", open.getString("operation"))
        val op = open.getString("operation_id")
        assertTrue(voice.tap(now).isEmpty()) // wait for recording acknowledgement before allowing stop
        voice.accept(sample(op, "recording"), now)
        val stop = voice.tap(now).single()
        assertEquals("voiceprint_commit", stop.getString("operation")); assertEquals(op, stop.getString("operation_id"))
        voice.accept(sample("unrelated", "measured", quality, index), now)
        assertEquals(VoiceEnrollmentPhase.Measuring, voice.state.phase)
        voice.accept(sample(op, "measured", quality, index), now)
        assertEquals(VoiceEnrollmentPhase.Result, voice.state.phase)
        return op
    }
    private fun begin(voice: VoiceEnrollment, until: Long = 600000) {
        assertEquals("voiceprint_enrol_request", voice.request(true, false).single().getString("operation"))
        assertEquals(VoiceEnrollmentPhase.AwaitingPhone, voice.state.phase)
        assertTrue(voice.tap(0).isEmpty()); assertTrue(voice.finish(0).isEmpty())
        assertEquals("voiceprint_read", voice.grant(grant(until), 0).single().getString("operation"))
        assertEquals((1..8).map { "服务器的第 $it 句" }, voice.state.sentences)
    }
    private fun owner(control: String, status: String, samples: JSONArray? = null) = JSONObject().put("operation", "voiceprint_owner")
        .put("control_id", control).put("owner", JSONObject().put("enrolled", status == "enrolled").put("samples", 8).put("reenrollment_required", false))
        .put("enrollment", JSONObject().put("status", status).put("samples", samples))

    @Test fun localGrantGatesEightSentenceFlowAndLocalSuccessConsumption() {
        val voice = VoiceEnrollment()
        assertTrue(voice.request(false, false).isEmpty()); assertTrue(voice.request(true, true).isEmpty())
        assertTrue(voice.tap(0).isEmpty()); assertTrue(voice.grant(grant(), 0).isEmpty())
        begin(voice)
        for (i in 1..8) {
            measured(voice, i.toLong(), index = i)
            assertEquals(i - 1, voice.state.index)
            assertEquals(i, voice.state.good)
            if (i < 5) assertTrue(voice.finish(i.toLong()).isEmpty())
            if (i < 8) assertEquals(i - 1, voice.state.index)
        }
        assertTrue(voice.state.canFinish)
        val enroll = voice.tap(9).single()
        assertEquals("voiceprint_enroll", enroll.getString("operation")); assertEquals(8, enroll.getJSONArray("sample_ids").length())
        assertEquals(setOf("operation", "control_id", "sample_ids"), enroll.keys().asSequence().toSet())
        // The server may push grant consumption before it sends the correlated enrollment result.
        voice.grant(JSONObject().put("enrolment", JSONObject().put("granted", false)), 10)
        voice.accept(owner("wrong-control", "enrolled"), 10); assertEquals(VoiceEnrollmentPhase.Enrolling, voice.state.phase)
        voice.accept(owner(enroll.getString("control_id"), "enrolled"), 10)
        assertEquals(VoiceEnrollmentPhase.Enrolled, voice.state.phase); assertNull(voice.state.until)
        assertEquals("已记住你在眼镜上的声音", voice.state.message)
        assertTrue(voice.tap(11).isEmpty()); assertTrue(voice.finish(11).isEmpty()); assertTrue(voice.grant(grant(), 11).isEmpty())
        assertFalse(enroll.toString().contains("embedding")); assertFalse(voice.state.toString().contains("consistency"))
    }

    @Test fun sampleQualityRetryFiveGoodThresholdAndConsistencyConclusions() {
        val voice = VoiceEnrollment(); begin(voice)
        for (q in listOf("too_short", "no_speech")) {
            measured(voice, 1, q); assertEquals(0, voice.state.good); assertEquals(0, voice.state.index)
            assertTrue(voice.state.message.contains(if (q == "too_short") "太短" else "没听到"))
        }
        for (i in 1..5) measured(voice, 2, index = i)
        val enroll = voice.finish(3).single(); assertEquals(5, enroll.getJSONArray("sample_ids").length())
        assertTrue(voice.finish(4).isEmpty())
        val refused = JSONArray().put(JSONObject().put("sample_id", enroll.getJSONArray("sample_ids").getString(2)).put("ok", false).put("consistency", 0.1))
        voice.accept(owner(enroll.getString("control_id"), "inconsistent", refused), 4)
        assertEquals(VoiceEnrollmentPhase.Ready, voice.state.phase); assertEquals(2, voice.state.index)
        assertEquals(4, voice.state.good); assertFalse(voice.state.canFinish)
        assertFalse(voice.state.toString().contains("0.1"))
        measured(voice, 5, index = 9)
        assertEquals(5, voice.finish(6).single().getJSONArray("sample_ids").length())
    }

    @Test fun localGrantExpiryRevocationAndCancellationDropLateReplies() {
        val voice = VoiceEnrollment(); begin(voice, until = 313)
        val open = voice.tap(1).single(); val op = open.getString("operation_id")
        assertTrue(voice.expire(312).isEmpty())
        val cancel = voice.expire(313).single()
        assertEquals("voiceprint_cancel", cancel.getString("operation")); assertEquals(op, cancel.getString("operation_id"))
        assertEquals(VoiceEnrollmentPhase.Expired, voice.state.phase)
        voice.accept(sample(op, "measured", "ok"), 314); assertEquals(0, voice.state.good)
        assertTrue(voice.tap(314).isEmpty()); assertTrue(voice.finish(314).isEmpty())
        begin(voice); voice.tap(0)
        assertEquals("voiceprint_cancel", voice.grant(JSONObject().put("enrolment", JSONObject().put("granted", false)), 1).single().getString("operation"))
        assertEquals(VoiceEnrollmentPhase.Expired, voice.state.phase)
        begin(voice); voice.tap(0)
        assertEquals("voiceprint_cancel", voice.cancel().single().getString("operation"))
        assertEquals(VoiceEnrollmentPhase.Idle, voice.state.phase)
    }

    @Test fun suppliedApprovalDeadlineDenialAndErrorsUpdateLocalState() {
        val voice = VoiceEnrollment { "enrol-1" }
        voice.request(true, false)
        voice.grant(JSONObject().put("approval_expires_in_ms", 721), 10)
        assertEquals(731L, voice.state.until)
        voice.expire(731); assertEquals(VoiceEnrollmentPhase.Expired, voice.state.phase)
        voice.request(true, false); voice.accept(JSONObject().put("operation", "payment_receipt").put("control_id", "enrol-1").put("ok", false), 1)
        assertEquals(VoiceEnrollmentPhase.Failed, voice.state.phase)
        voice.request(true, false); voice.grant(JSONObject().put("reason", "denied"), 2)
        assertEquals(VoiceEnrollmentPhase.Failed, voice.state.phase)
        begin(voice); voice.tap(3)
        voice.accept(JSONObject().put("operation", "rejected").put("request_operation", "voiceprint_open"), 4)
        assertEquals(VoiceEnrollmentPhase.Failed, voice.state.phase)
    }

    @Test fun ownerReadAndSampleRetryExposeOnlyConclusionFields() {
        val voice = VoiceEnrollment(); voice.request(true, false)
        val read = voice.grant(grant(), 0).single()
        voice.accept(owner(read.getString("control_id"), "enrolled").apply { remove("enrollment") }, 1)
        assertTrue(voice.state.ownerEnrolled); assertEquals(VoiceEnrollmentPhase.Ready, voice.state.phase)
        val first = voice.tap(2).single()
        voice.accept(sample(first.getString("operation_id"), "failed").put("error_code", "VOICEPRINT_SAMPLE_FAILED"), 3)
        assertEquals(VoiceEnrollmentPhase.Result, voice.state.phase); assertEquals(0, voice.state.good)
        measured(voice, 4)
        assertEquals(1, voice.state.good)
        assertEquals("好 · 这句好了", voice.state.message)
        assertFalse(voice.state.toString().contains("score"))
    }

    @Test fun settingsEntryAndLocalEnrolmentControlsEmitExpectedActions() {
        val state = HudState(paired = true)
        val settings = HudScreen.Settings(HudScreen.Idle, 6)
        val entry = reduceHud(settings, HudGesture.Click, state, 0)
        assertEquals("VOICE_ENROL", entry.action); assertTrue(entry.screen is HudScreen.VoiceEnrolment)
        val voice = VoiceEnrollment(); begin(voice)
        val hud = state.copy(voiceEnrollment = voice.state.copy(good = 5, canFinish = true))
        val finish = reduceHud(entry.screen, HudGesture.Forward, hud, 1).screen
        assertEquals("VOICE_FINISH", reduceHud(finish, HudGesture.Click, hud, 1).action)
        assertEquals("VOICE_CANCEL", reduceHud(finish, HudGesture.DoubleClick, hud, 1).action)
        for (gesture in listOf(HudGesture.Nod, HudGesture.Shake, HudGesture.LongClick))
            assertNull(reduceHud(entry.screen, gesture, hud, 1).action)
    }
}
