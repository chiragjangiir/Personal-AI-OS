package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class VoiceStatusTest {
    private val standby = HudState(paired = true, localWakeEnabled = true,
        capture = CaptureState(worn = true), localWake = LocalWakeState.LocalReady)

    @Test fun localStandbyRequiresOwnerOptInAndLiveCapture() {
        val standby = this.standby.copy(ambient = true)
        assertEquals("唤醒词待命 · 仅本机", voiceStatus(standby))
        assertEquals("唤醒已关", voiceStatus(standby.copy(localWakeEnabled = false)))
        assertFalse(wakeTaps(standby.copy(localWakeEnabled = false)))
        assertFalse(localCaptureArmed(standby.copy(localWakeEnabled = false)))
        for (unavailable in listOf(LocalWakeState.WaitingForAudio, LocalWakeState.Unavailable))
            assertEquals("唤醒不可用", voiceStatus(standby.copy(localWake = unavailable)))
        assertEquals("没戴", voiceStatus(standby.copy(capture = CaptureState(worn = false))))
        assertEquals("随身关", voiceStatus(standby.copy(ambient = false)))
        assertEquals("手机通话中", voiceStatus(standby.copy(phoneAudio = true)))
    }

    @Test fun liveCallMovesThroughActualMediaAndServerWorkFacts() {
        val connected = standby.copy(callId = "current")
        assertEquals("正在连接通话", voiceStatus(connected))
        assertEquals("正在听你说", voiceStatus(connected.copy(callPcmPublished = true)))
        val closing = connected.copy(callClosing = true, microphoneApplied = Microphone.On)
        assertEquals("正在结束通话", voiceStatus(closing))
        assertEquals(Microphone.Off, microphone(closing))
        assertEquals(Microphone.On, microphone(closing.copy(ambient = true, listening = true,
            capture = CaptureState(worn = true, policyCurrent = true, privatePaused = false))))
        val listening = connected.copy(microphoneApplied = Microphone.On)
        assertEquals("正在听你说", voiceStatus(listening))
        assertEquals("正在静音", voiceStatus(listening.copy(micMuted = true)))
        assertEquals("正在静音", voiceStatus(listening.copy(micMuted = true, microphoneApplied = null)))
        assertEquals("麦克风已静音", voiceStatus(listening.copy(micMuted = true, microphoneApplied = Microphone.Muted)))
        assertEquals("正在取消静音", voiceStatus(listening.copy(microphoneApplied = Microphone.Muted)))
        val thinking = listening.copy(foregroundCalls = setOf("current"))
        assertEquals("正在想", voiceStatus(thinking))
        assertEquals("依米正在说话", voiceStatus(thinking.copy(callPlayback = true)))
        assertEquals("正在想", voiceStatus(thinking.copy(callPlayback = false)))
        val handedOff = listening.copy(backgroundWorkCount = 2)
        assertEquals("已交给依米处理", voiceStatus(handedOff))
        assertEquals("正在听你说", voiceStatus(handedOff.copy(backgroundWorkCount = 0)))
    }

    @Test fun endedCallKeepsBackgroundWorkAndNeverBecomesAnActiveCall() {
        val ended = standby.copy(callEnded = true, backgroundWorkCount = 2,
            foregroundCalls = setOf("ended"))
        assertEquals("通话已结束 · 还有 2 件在办", voiceStatus(ended))
        assertEquals("通话已结束", voiceStatus(ended.copy(backgroundWorkCount = 0)))
        assertEquals("后台事项 2 件在办", voiceStatus(ended.copy(callEnded = false)))
        assertEquals("正在结束通话", voiceStatus(ended.copy(callPlayback = true)))
        assertEquals("正在结束通话", voiceStatus(ended.copy(listening = true, microphoneApplied = Microphone.On)))
        assertEquals("正在结束通话", voiceStatus(ended.copy(listening = true, microphoneApplied = null)))
        assertEquals("通话已结束 · 还有 2 件在办", voiceStatus(ended.copy(listening = true, microphoneApplied = Microphone.Off)))
        assertEquals("通话已结束 · 还有 2 件在办", voiceStatus(ended.copy(listening = true, ambient = true, microphoneApplied = Microphone.On)))
        assertEquals("通话已结束 · 还有 2 件在办", voiceStatus(ended.copy(listening = true, recording = true, microphoneApplied = Microphone.On)))
        assertEquals("正在结束通话", voiceStatus(ended.copy(listening = true, recording = false, microphoneApplied = Microphone.On)))
        val otherCall = ended.copy(callId = "new", callEnded = false,
            backgroundWorkCount = 0, microphoneApplied = Microphone.On)
        assertEquals("正在听你说", voiceStatus(otherCall))
        assertEquals("正在听你说", voiceStatus(otherCall.copy(foregroundCalls = emptySet())))
    }

    @Test fun wakeSettingKeepsExistingSettingsAndAmbientRows() {
        val settings = HudScreen.Settings(HudScreen.Idle, 8)
        assertEquals("WAKE", reduceHud(settings, HudGesture.Click, standby, 0).action)
        val appearance = settings.copy(focus = 7)
        assertEquals(HudScreen.Appearance(appearance), reduceHud(appearance, HudGesture.Click, standby, 0).screen)
        assertEquals(HudScreen.Settings(HudScreen.Idle, 9), reduceHud(settings, HudGesture.Down, standby, 0).screen)
        assertEquals(HudScreen.Settings(HudScreen.Idle, 0),
            reduceHud(settings.copy(focus = 9), HudGesture.Down, standby, 0).screen)
        assertEquals(ambientStatus(standby), ambientStatus(standby.copy(localWakeEnabled = false)))
    }
}
