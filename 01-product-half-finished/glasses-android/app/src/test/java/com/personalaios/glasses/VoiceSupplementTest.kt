package com.personalaios.glasses

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VoiceSupplementTest {
    private var next = 0
    private fun supplement() = VoiceSupplement { "id-${++next}" }
    private fun lock(granted: Boolean) = JSONObject().put("operation", "payment_lock_state")
        .put("voice_enrollment", JSONObject().put("granted", granted))
    private fun draft(phase: String, call: String?, clean: Int = 0, issue: String? = null) = JSONObject()
        .put("operation", "voice_enrollment_state").put("enrollment", JSONObject().put("session_id", "draft-1")
            .put("call_id", call ?: JSONObject.NULL).put("phase", phase).put("clean_speech_ms", clean)
            .put("target_speech_ms", 30000).put("issue", issue ?: JSONObject.NULL))

    @Test fun phoneApprovedConversationRunsOnTheServerDraftAndSaves() {
        val voice = supplement()
        assertTrue(voice.request(false, false).isEmpty()); assertEquals(VoiceSupplementPhase.Failed, voice.state.phase)
        val request = voice.request(true, false).single()
        val example = JSONObject(javaClass.getResource("/payment-wire-examples.json")!!.readText())
            .getJSONObject("examples").getJSONArray("voiceprint_enrol_request").getJSONObject(1)
        assertEquals(canonicalJson(example.put("control_id", request.getString("control_id"))), canonicalJson(request))
        assertEquals(VoiceSupplementPhase.AwaitingPhone, voice.state.phase)
        assertTrue(voice.grant(lock(false)).isEmpty())
        assertTrue("the payment grant does not start it", voice.grant(JSONObject().put("enrolment", JSONObject().put("granted", true))).isEmpty())
        val start = voice.grant(lock(true)).single()
        assertEquals("start", start.getString("action")); assertEquals("voice_enrollment_control", start.getString("operation"))
        val call = start.getString("call_id"); assertFalse(start.has("enrollment_session_id"))
        voice.accept(draft("collecting", "other-call"))
        assertNull(voice.callToOpen())
        voice.accept(draft("collecting", call))
        assertEquals(call to "draft-1", voice.callToOpen()); assertNull(voice.callToOpen())
        voice.accept(draft("collecting", call, 12000))
        assertEquals(12000, voice.state.cleanMs)
        val check = voice.tap().single()
        assertEquals("check", check.getString("action")); assertEquals("draft-1", check.getString("enrollment_session_id")); assertEquals(call, check.getString("call_id"))
        voice.accept(draft("checked", call, 31000))
        assertEquals(VoiceSupplementPhase.Checked, voice.state.phase)
        assertEquals("commit", voice.tap().single().getString("action")); assertEquals(VoiceSupplementPhase.Saving, voice.state.phase)
        voice.accept(draft("committed", null, 31000))
        assertEquals(VoiceSupplementPhase.Saved, voice.state.phase)
        assertTrue(voice.grant(lock(false)).isEmpty()); assertEquals(VoiceSupplementPhase.Saved, voice.state.phase)
        assertTrue(voice.cancel().isEmpty())
    }

    @Test fun shortPauseResumesOnANewCallAndLostApprovalOrRejectionFails() {
        val voice = supplement(); voice.request(true, false)
        val first = voice.grant(lock(true)).single().getString("call_id")
        voice.accept(draft("collecting", first)); voice.callToOpen()
        voice.accept(draft("paused", first, 8000, "VOICE_ENROLLMENT_MORE_SPEECH_REQUIRED"))
        assertEquals(VoiceSupplementPhase.Paused, voice.state.phase); assertEquals("清晰语音还不够，继续聊一会儿", voice.state.message)
        val resume = voice.tap().single()
        assertEquals("resume", resume.getString("action")); val second = resume.getString("call_id"); assertNotEquals(first, second)
        voice.accept(draft("paused", first, 8000))
        assertEquals(VoiceSupplementPhase.Starting, voice.state.phase)
        voice.accept(draft("collecting", second, 8000)); assertEquals(second to "draft-1", voice.callToOpen())
        voice.grant(lock(false))
        assertEquals(VoiceSupplementPhase.Failed, voice.state.phase)
        val again = voice.request(true, false).single()
        assertTrue(voice.rejected(JSONObject().put("operation", "rejected").put("control_id", "unrelated")).not())
        assertTrue(voice.rejected(JSONObject().put("operation", "rejected").put("control_id", again.getString("control_id"))))
        assertEquals(VoiceSupplementPhase.Failed, voice.state.phase)
    }

    @Test fun leavingDiscardsTheUnsavedDraftAndSettingsOpensTheScreen() {
        val voice = supplement(); voice.request(true, false)
        val call = voice.grant(lock(true)).single().getString("call_id"); voice.accept(draft("collecting", call))
        val discard = voice.cancel().single()
        assertEquals("discard", discard.getString("action")); assertEquals("draft-1", discard.getString("enrollment_session_id"))
        assertEquals(VoiceSupplementPhase.Idle, voice.state.phase)
        val state = HudState(paired = true)
        val entry = reduceHud(HudScreen.Settings(HudScreen.Idle, 9), HudGesture.Click, state, 0)
        assertEquals("SUPPLEMENT_REQUEST", entry.action); assertEquals(HudScreen.VoiceSupplement(HudScreen.Settings(HudScreen.Idle, 9)), entry.screen)
        val talking = state.copy(voiceSupplement = VoiceSupplementState(VoiceSupplementPhase.Talking))
        assertEquals("SUPPLEMENT_TAP", reduceHud(entry.screen, HudGesture.Click, talking, 0).action)
        assertEquals("SUPPLEMENT_CANCEL", reduceHud(entry.screen, HudGesture.DoubleClick, talking, 0).action)
        assertEquals(entry.screen, reconcileHud(entry.screen, talking.copy(callId = call)))
    }

    @Test fun enrollmentCallOpenCarriesTheDraft() {
        val owner = SupervisorJob()
        try {
            fun calls() = CallLifecycle(CoroutineScope(owner + Dispatchers.Unconfined), MutableStateFlow(HudState(paired = true)), {}, {})
            val enrollment = calls()
            runBlocking { enrollment.open("call-1", "draft-1") }
            val open = enrollment.openToSend()!!
            assertEquals("draft-1", open.getString("enrollment_session_id")); assertEquals("call-1", open.getString("call_id"))
            val ordinary = calls()
            runBlocking { ordinary.open("call-2") }
            assertFalse(ordinary.openToSend()!!.has("enrollment_session_id"))
        } finally { owner.cancel() }
    }
}
