package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WakeWordTest {
    @Test fun hudDoesNotEquateGatewayConnectionWithLocalWakeReadiness() {
        val worn = HudState(localWakeEnabled = true, paired = true, listening = true, ambient = true, capture = CaptureState(worn = true))
        assertEquals("唤醒已停", localWakeStatus(worn))
        assertEquals("唤醒加载中", localWakeStatus(worn.copy(localWake = LocalWakeState.Loading)))
        assertEquals("等待麦克风", localWakeStatus(worn.copy(localWake = LocalWakeState.WaitingForAudio)))
        assertEquals("唤醒不可用", localWakeStatus(worn.copy(localWake = LocalWakeState.Unavailable)))
        val ready = worn.copy(listening = false, localWake = LocalWakeState.LocalReady)
        assertEquals("可唤醒", localWakeStatus(ready))
        assertEquals("没戴", localWakeStatus(ready.copy(capture = CaptureState(worn = false))))
        assertEquals("已停止", localWakeStatus(ready.copy(status = "已停止")))
    }

    @Test fun callAndBusyPauseKeywordsWithoutReleasingTheLocalRecorderIntent() {
        val standby = HudState(localWakeEnabled = true, paired = true, ambient = true, capture = CaptureState(worn = true))
        for (paused in listOf(standby.copy(busy = true), standby.copy(callId = "call"))) {
            assertTrue(localCaptureArmed(paused))
            assertFalse(wakeTaps(paused))
            val resumed = paused.copy(callId = null, busy = false)
            assertTrue(localCaptureArmed(resumed))
            assertTrue(wakeTaps(resumed))
        }
        for (phase in VoiceEnrollmentPhase.values()) {
            val enrollment = standby.copy(voiceEnrollment = VoiceEnrollmentState(phase = phase))
            assertTrue(localCaptureArmed(enrollment))
            assertEquals(phase.name, phase !in enrolmentWindow, wakeTaps(enrollment))
        }
        assertTrue(localCaptureArmed(standby))
        assertFalse(wakeTaps(standby, paying = true))
        assertFalse(localCaptureArmed(standby.copy(capture = CaptureState(worn = false))))
        assertFalse(localCaptureArmed(standby.copy(paired = false)))
    }

    @Test fun wakeRequiresAmbientAndIsIndependentOfTransport() {
        val idle = HudState(localWakeEnabled = true, paired = true, listening = true, capture = CaptureState(worn = true), ambient = true)
        assertTrue(wakeTaps(idle))
        assertFalse(wakeTaps(idle.copy(ambient = false)))
        assertEquals("随身关", localWakeStatus(idle.copy(ambient = false)))
        // Riding or navigating, voice comes first; the private pause pauses only the camera.
        assertTrue(wakeTaps(idle.copy(ride = JSONObject(), nav = JSONObject())))
        assertTrue(wakeTaps(idle.copy(capture = CaptureState(worn = true, privatePaused = true))))
        // Live/pending calls, payment, unknown wear, removal and unpaired state cannot wake.
        assertFalse(wakeTaps(idle.copy(callId = "call")))
        assertFalse(wakeTaps(idle.copy(busy = true)))
        assertFalse(wakeTaps(idle, paying = true))
        assertFalse(wakeTaps(idle.copy(capture = CaptureState(worn = false))))
        assertFalse(wakeTaps(idle.copy(capture = CaptureState())))
        assertTrue(wakeTaps(idle.copy(listening = false)))
        assertFalse(wakeTaps(HudState(capture = CaptureState(worn = true))))
    }

    @Test fun phoneAudioReleasesStandbyAndOwnCallCanStillCapture() {
        val phone = HudState(localWakeEnabled = true, paired = true, ambient = true,
            capture = CaptureState(worn = true), phoneAudio = true)
        assertFalse(localCaptureArmed(phone))
        assertFalse(wakeTaps(phone))
        assertEquals("手机通话中", localWakeStatus(phone))
        assertTrue(localCaptureArmed(phone.copy(callId = "own-call")))
        assertFalse(localCaptureArmed(phone.copy(callId = "own-call", callClosing = true)))
        assertTrue(wakeTaps(phone.copy(phoneAudio = false)))
    }
}
