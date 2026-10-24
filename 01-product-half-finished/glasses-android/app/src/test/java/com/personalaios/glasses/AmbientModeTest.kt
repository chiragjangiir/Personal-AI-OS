package com.personalaios.glasses

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AmbientModeTest {
    private val idle = HudState(paired = true, listening = true,
        capture = CaptureState(worn = true, privatePaused = false, policyCurrent = true))
    private fun payment(state: String = "awaiting_owner", voice: Boolean = true, until: Long = 2_000) =
        PaymentNotice("pay", state, 100, null, null, voice, null, until)

    @Test fun phoneAudioOwnsMicrophoneUntilOurOwnCallStartsAndReclaimsItOnClose() {
        val phone = idle.copy(phoneAudio = true, ambient = true)
        for (state in listOf(phone, phone.copy(recording = true), phone.copy(payment = payment()),
            phone.copy(voiceEnrollment = VoiceEnrollmentState(phase = VoiceEnrollmentPhase.Recording)))) {
            assertEquals(Microphone.Off, microphone(state, 0))
            assertEquals(Microphone.On, microphone(state.copy(callId = "own-call"), 0))
            assertEquals(Microphone.Off, microphone(state.copy(callId = "own-call", callClosing = true), 0))
        }
        assertEquals(Microphone.On, microphone(phone.copy(phoneAudio = false), 0))
        assertEquals(Microphone.Muted, microphone(phone.copy(callId = "own-call", micMuted = true), 0))
    }

    /** The call presentation the companion drives; CallLifecycle owns the in-call mute intent. */
    private class Calls(ambient: Boolean) : AutoCloseable {
        val owner = SupervisorJob()
        val hud = MutableStateFlow(HudState(paired = true, listening = true, ambient = ambient,
            capture = CaptureState(worn = true, privatePaused = false, policyCurrent = true)).let { it.copy(status = idleStatus(it)) })
        val calls = CallLifecycle(CoroutineScope(owner + Dispatchers.Unconfined), hud, {}, {})
        fun state(phase: String, id: String = "call") = calls.receive(JSONObject().put("call_id", id).put("state", phase))
        val mic get() = microphone(hud.value, 0)
        override fun close() { owner.cancel() }
    }

    @Test fun offByDefaultAndNothingIsHeardOnItsOwn() {
        assertFalse(HudState().ambient)
        assertEquals(Microphone.Off, microphone(idle, 0))
        assertEquals(Microphone.On, microphone(idle.copy(ambient = true), 0))
        assertEquals(AMBIENT_OFF_STATUS, idleStatus(idle)); assertEquals(AMBIENT_ON_STATUS, idleStatus(idle.copy(ambient = true)))
    }

    @Test fun onlyConfirmationPersistsOnAndOffSurvivesRestartWithoutAffectingCalls() {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
        val hud = MutableStateFlow(idle.copy(ambient = enrollment.ambientMode))
        val applied = mutableListOf<Boolean>()
        val switch = AmbientSwitch(enrollment, hud, applied::add)
        assertFalse(enrollment.ambientMode)
        switch.request(true)
        assertEquals(AmbientStatus.Confirmation, ambientStatus(hud.value))
        assertEquals(Microphone.Off, microphone(hud.value)); assertFalse(enrollment.ambientMode)
        switch.cancel(); switch.confirm(); assertTrue(applied.isEmpty())
        switch.request(true); switch.confirm()
        assertTrue(Enrollment(disk.restart().preferences, PlainTestCipher).ambientMode)
        assertNull(hud.value.microphoneApplied)
        assertEquals("等待确认", ambientDisplay(hud.value).text)
        assertEquals(Microphone.On, microphone(hud.value))
        hud.value = hud.value.copy(callId = "call", micMuted = true)
        switch.request(false)
        assertEquals(Microphone.Muted, microphone(hud.value))
        assertEquals(listOf(true, false), applied)
        assertFalse(Enrollment(disk.restart().preferences, PlainTestCipher).ambientMode)
        hud.value = hud.value.copy(callId = null)
        assertEquals(Microphone.Off, microphone(hud.value))
        switch.request(true); switch.request(false); switch.confirm()
        assertFalse(enrollment.ambientMode)
    }

    @Test fun displayUsesPolicyAndMicrophoneReceiptsWithoutChangingAcquisition() {
        val off = idle.copy(microphoneApplied = Microphone.Off, ambientRequestedAt = 1)
        val on = off.copy(ambient = true, microphoneApplied = Microphone.On,
            capture = off.capture.copy(paused = false, status = "ready"))
        assertEquals("随身关", ambientDisplay(off, 2).text)
        assertEquals("随身开", ambientDisplay(on, 2).text)
        assertEquals("开启随身？请确认", ambientDisplay(off.copy(ambientConfirmation = true), 2).text)
        for (state in listOf(on.copy(microphoneApplied = null), on.copy(microphoneApplied = Microphone.Off),
            off.copy(microphoneApplied = Microphone.On), on.copy(capture = on.capture.copy(policyCurrent = false)),
            on.copy(capture = on.capture.copy(paused = true)), on.copy(capture = on.capture.copy(status = "unavailable")),
            off.copy(capture = off.capture.copy(privacyPending = true)), off.copy(capture = off.capture.copy(paused = false)), off.copy(capture = off.capture.copy(closing = true)))) {
            assertEquals("等待确认", ambientDisplay(state, 2).text)
            assertEquals(AmbientDisplay("确认超时 · 重试", true), ambientDisplay(state, 1 + AMBIENT_APPLY_TIMEOUT_MS))
        }
        assertEquals(Microphone.On, microphone(on.copy(microphoneApplied = null), 2))
        assertEquals("随身关", ambientDisplay(off.copy(callId = "call", microphoneApplied = Microphone.On), 2).text)
        assertEquals("随身开", ambientDisplay(on.copy(callId = "call", capture = on.capture.copy(
            callCameraRequested = false, paused = true, status = "paused")), 2).text)
        assertEquals("隐私暂停", ambientDisplay(on.copy(microphoneApplied = Microphone.Off,
            capture = on.capture.copy(privatePaused = true)), 2).text)
        assertTrue(on.copy(capture = on.capture.copy(privatePaused = true)).ambient)
        val pausedOff = off.copy(capture = off.capture.copy(privatePaused = true))
        assertEquals("隐私暂停", ambientDisplay(pausedOff, 2).text)
        assertEquals("随身　关", hudMenu(pausedOff).first().label)
        assertFalse(pausedOff.ambient)
        assertEquals("没戴 · 随身仍在记录", ambientDisplay(on.copy(capture = on.capture.copy(worn = false)), 2).text)
        assertEquals("没戴 · 随身关", ambientDisplay(off.copy(capture = off.capture.copy(worn = false)), 2).text)
        for (state in listOf(off, on)) assertEquals("未连接 · 上次随身${if (state.ambient) "开" else "关"}",
            ambientDisplay(state.copy(listening = false), 2).text)
        assertEquals("未连接 · 上次随身关 · 到手机处理", ambientDisplay(off.copy(paired = false), 2).text)
        assertEquals(AmbientDisplay("错误 · 麦克风权限未开启 · 到手机处理"),
            ambientDisplay(on.copy(ambientError = "麦克风权限未开启"), 2))
        assertEquals(AmbientDisplay("错误 · Camera error 4 · 重试", true), ambientDisplay(on.copy(ambientError = "Camera error 4"), 2))
        assertEquals(AmbientDisplay("错误 · microphone permission denied · 到手机处理"),
            ambientDisplay(on.copy(listening = false, ambientError = "microphone permission denied"), 2))
        assertEquals(AmbientDisplay("错误 · microphone permission denied · 到手机处理"),
            ambientDisplay(on.copy(capture = on.capture.copy(error = "microphone permission denied")), 2))
    }

    @Test fun retryReappliesPersistedIntentAndInvalidatesAnOldReceipt() {
        val disk = PreferenceDisk(); val enrollment = Enrollment(disk.preferences, PlainTestCipher)
        val hud = MutableStateFlow(idle.copy(microphoneApplied = Microphone.Off, ambientError = "failed"))
        val applied = mutableListOf<Boolean>(); val switch = AmbientSwitch(enrollment, hud, applied::add)
        switch.retry()
        assertEquals(listOf(false), applied); assertFalse(enrollment.ambientMode)
        assertNull(hud.value.microphoneApplied); assertNull(hud.value.ambientError)
        assertTrue(hud.value.ambientRequestedAt > 0)
        assertEquals("等待确认", ambientDisplay(hud.value).text)
        assertEquals(Microphone.On, microphone(idle.copy(recording = true), 0))
        assertEquals(Microphone.Muted, microphone(idle.copy(recording = true, callId = "call", micMuted = true), 0))
    }

    @Test fun automaticAudioFollowsPrivacyWearPolicyAndConnectionButExplicitCallsStillWork() {
        val on = idle.copy(ambient = true)
        val cases = listOf(
            on.copy(listening = false) to AmbientStatus.Disconnected,
            on.copy(capture = on.capture.copy(error = "camera denied")) to AmbientStatus.Error,
            on.copy(capture = on.capture.copy(privacyPending = true)) to AmbientStatus.Waiting,
            on.copy(capture = on.capture.copy(policyCurrent = false)) to AmbientStatus.Waiting,
            on.copy(capture = on.capture.copy(privatePaused = true)) to AmbientStatus.Private,
            on.copy(capture = on.capture.copy(worn = false)) to AmbientStatus.NotWorn,
            on.copy(capture = on.capture.copy(worn = null)) to AmbientStatus.Waiting)
        for ((state, status) in cases) {
            assertEquals(status, ambientStatus(state))
            assertEquals(if (status == AmbientStatus.NotWorn) Microphone.On else Microphone.Off, microphone(state))
            assertEquals(Microphone.On, microphone(state.copy(callId = "explicit-call")))
            assertEquals(AmbientStatus.Off, ambientStatus(state.copy(ambient = false)))
        }
    }

    @Test fun modeOffPublishesOnlyForTheOwnersOwnNeeds() {
        assertEquals(Microphone.On, microphone(idle.copy(callId = "call"), 0))
        assertEquals(Microphone.Muted, microphone(idle.copy(callId = "call", micMuted = true), 0))
        for (phase in VoiceEnrollmentPhase.values()) assertEquals(phase.name,
            if (phase in setOf(VoiceEnrollmentPhase.Opening, VoiceEnrollmentPhase.Recording, VoiceEnrollmentPhase.Measuring)) Microphone.On else Microphone.Off,
            microphone(idle.copy(voiceEnrollment = VoiceEnrollmentState(phase = phase)), 0))
        assertEquals(Microphone.On, microphone(idle.copy(payment = payment()), 0))
        assertEquals(Microphone.Off, microphone(idle.copy(payment = payment()), 2_000))
        assertEquals(Microphone.Off, microphone(idle.copy(payment = payment(voice = false)), 0))
        assertEquals(Microphone.Off, microphone(idle.copy(payment = payment(state = "verifying")), 0))
    }

    @Test fun modeOnIsTodaysAlwaysPublishedMicrophoneWithTheInCallMute() {
        val on = idle.copy(ambient = true)
        assertEquals(Microphone.On, microphone(on.copy(callId = "call"), 0))
        assertEquals(Microphone.Muted, microphone(on.copy(callId = "call", micMuted = true), 0))
        assertEquals(Microphone.On, microphone(on.copy(payment = payment(voice = false)), 0))
    }

    @Test fun wakePublicationWaitsForServerAcknowledgementBeforeFrontSetupFinishes() {
        val opening = idle.copy(callId = "wake", busy = true)
        assertEquals(Microphone.Off, microphone(opening, 0, wakeCallId = "wake"))
        // Matching inbound acknowledgement clears the marker while front setup is still busy.
        assertEquals(Microphone.On, microphone(opening, 0, wakeCallId = null))
        assertEquals(Microphone.On, microphone(opening.copy(ambient = true), 0, wakeCallId = "wake"))
        assertEquals(Microphone.On, microphone(opening.copy(recording = true), 0, wakeCallId = "wake"))
        assertEquals(Microphone.On, microphone(opening, 0))
    }

    @Test fun removalPreservesAmbientRecordingAndTheGlassesOwnSwitch() {
        val on = idle.copy(ambient = true)
        val unworn = on.copy(capture = on.capture.copy(worn = false))
        assertEquals(Microphone.On, microphone(unworn, 0))
        assertTrue(unworn.ambient)
        assertEquals(Microphone.On, microphone(unworn.copy(capture = unworn.capture.copy(worn = true)), 0))
        assertEquals(Microphone.Off, microphone(unworn.copy(ambient = false), 0))
    }

    @Test fun aTapSessionPublishesAtOnceAndUnpublishesWhenItEnds() = Calls(ambient = false).use {
        assertEquals(Microphone.Off, it.mic)
        runBlocking { it.calls.open("call") }
        assertEquals(Microphone.On, it.mic)
        assertTrue(it.state("live")); assertEquals(Microphone.On, it.mic)
        it.calls.hangup(); assertEquals(Microphone.Off, it.mic)
        assertTrue(it.state("closed")); assertEquals(Microphone.Off, it.mic)
        assertEquals(AMBIENT_OFF_STATUS, it.hud.value.status)
    }

    @Test fun aMutedCallEndingWithTheModeOffUnpublishes() = Calls(ambient = false).use {
        assertTrue(it.state("live")); it.hud.value = it.hud.value.copy(micMuted = true)
        assertEquals(Microphone.Muted, it.mic)
        assertTrue(it.state("closed"))
        assertEquals(Microphone.Off, it.mic); assertFalse(it.hud.value.micMuted)
    }

    @Test fun aCallEndingWithTheModeOnKeepsTodaysPublishedMicrophone() = Calls(ambient = true).use {
        assertTrue(it.state("live")); it.hud.value = it.hud.value.copy(micMuted = true)
        assertTrue(it.state("failed"))
        assertEquals(Microphone.On, it.mic); assertEquals(AMBIENT_ON_STATUS, it.hud.value.status)
    }
}
