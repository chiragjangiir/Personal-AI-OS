package com.personalaios.glasses

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CallLifecycleTest {
    private class Fixture : AutoCloseable {
        val owner = SupervisorJob()
        val hud = MutableStateFlow(HudState(paired = true, status = "随身开", ambient = true))
        var now = 100_000L
        var serverOffset = 0L
        var capturing = false
        var ends = 0
        private val cards = HudCards("glasses")
        val diagnostics = mutableListOf<String>()
        private val timers = mutableMapOf<CompletableDeferred<Unit>, Long>()
        val calls = CallLifecycle(CoroutineScope(owner + Dispatchers.Unconfined), hud, { capturing = it }, { ends++ }, { now }, { ms ->
            val ready = CompletableDeferred<Unit>()
            timers[ready] = now + ms
            try { ready.await() } finally { timers.remove(ready) }
        }, diagnose = { code -> diagnostics += code }, onFailure = { message ->
            hud.value = hud.value.copy(cards = cards.callFailure(message, now))
        }, serverNow = { now + serverOffset }).apply { windowS = 7 }
        fun advance(ms: Long) {
            now += ms
            timers.filterValues { it <= now }.keys.toList().forEach { it.complete(Unit) }
        }
        fun frame(phase: String, id: String = "call", deadline: Long? = null) = JSONObject()
            .put("call_id", id).put("state", phase).also { if (deadline != null) it.put("rejoin_deadline", GatewayClient.timestamp(deadline)) }
        fun live(deadline: Long? = null) { assertTrue(calls.receive(frame("live", deadline = deadline))) }
        fun open(id: String = "call") = runBlocking { calls.open(id) }
        fun ended() {
            assertNull(hud.value.callId); assertFalse(hud.value.busy)
            assertEquals("随身开", hud.value.status); assertFalse(capturing); assertEquals(1, ends)
        }
        override fun close() { owner.cancel() }
    }

    @Test fun serverDeadlineBecomesALocalDurationUnaffectedByLaterClockCorrections() = Fixture().use {
        it.serverOffset = 52 * 60_000L
        it.live(deadline = it.now + it.serverOffset + 7000)
        it.calls.linkLost()
        it.serverOffset = -52 * 60_000L
        it.advance(6999); assertNotNull(it.hud.value.callId)
        it.advance(1); it.ended()
    }

    @Test fun linkLossRetainsTheCurrentCallAndItsCaptureIntentInTheSingleWaitState() {
        for (phase in listOf("opening", "connecting", "live")) Fixture().use {
            it.calls.receive(it.frame(phase)); it.calls.linkLost()
            assertEquals("call", it.hud.value.callId); assertTrue(it.capturing)
            assertTrue(it.hud.value.busy); assertEquals("请稍候", it.hud.value.status); assertEquals(0, it.ends)
        }
    }

    @Test fun disconnectedDeadlineExpiresWithoutAnotherPacketOrConnection() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(6999)
        assertEquals("call", it.hud.value.callId)
        it.advance(1); it.ended()
        assertFalse(it.calls.receive(it.frame("live"))); it.ended()
    }

    @Test fun repeatedLossAndNewBootstrapPolicyDoNotExtendTheFrozenBudget() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(6000)
        it.calls.windowS = 99; it.calls.linkLost(); it.advance(1000); it.ended()
    }

    @Test fun theFirstServerDeadlineReplacesTheEstimateInFull() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        assertTrue(it.calls.receive(it.frame("connecting", deadline = 109000)))
        it.advance(6000); assertEquals("call", it.hud.value.callId) // The old 107000 estimate has passed.
        it.advance(1999); assertNotNull(it.hud.value.callId)
        it.advance(1); it.ended()
        assertTrue(it.diagnostics.isEmpty())
    }

    @Test fun aLaterQualifiedExtensionIsRejectedAndDiagnosed() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        it.calls.receive(it.frame("connecting", deadline = 109000))
        it.calls.receive(it.frame("connecting", deadline = 111000))
        assertEquals(listOf("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED"), it.diagnostics)
        it.advance(7999); assertNotNull(it.hud.value.callId)
        it.advance(1); it.ended()
    }

    @Test fun anEarlierQualifiedDeadlineShortensTheAcceptedBudget() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        it.calls.receive(it.frame("connecting", deadline = 109000))
        it.calls.receive(it.frame("connecting", deadline = 105000))
        it.advance(3999); assertNotNull(it.hud.value.callId)
        it.advance(1); it.ended(); assertTrue(it.diagnostics.isEmpty())
    }

    @Test fun qualificationSurvivesRetriesAndResetsOnlyAfterLiveRecovery() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        it.calls.receive(it.frame("connecting", deadline = 109000))
        it.calls.linkLost(); it.calls.retryClose()
        it.calls.receive(it.frame("opening", deadline = 111000))
        assertEquals(1, it.diagnostics.size)
        it.live(); it.calls.linkLost()
        it.calls.receive(it.frame("connecting", deadline = 110000))
        it.advance(7000); assertNotNull(it.hud.value.callId)
        it.advance(2000); it.ended(); assertEquals(1, it.diagnostics.size)
    }

    @Test fun rejectingAnExtensionStillAcceptsConfirmedLiveRecovery() = Fixture().use {
        it.live(); it.calls.linkLost()
        it.calls.receive(it.frame("connecting", deadline = 109000))
        assertTrue(it.calls.receive(it.frame("live", deadline = 111000)))
        assertEquals(listOf("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED"), it.diagnostics)
        it.advance(20000); assertEquals("通话中", it.hud.value.status); assertEquals(0, it.ends)
    }

    @Test fun lastAnnouncedAbsoluteDeadlineOverridesTheWindowAndSurvivesPacketsWithoutIt() = Fixture().use {
        it.live(it.now + 5000); it.live(it.now + 2000)
        assertTrue(it.calls.receive(it.frame("connecting")))
        it.calls.linkLost(); it.advance(1999); assertNotNull(it.hud.value.callId)
        it.calls.receive(it.frame("connecting", deadline = it.now + 10000))
        assertEquals(listOf("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED"), it.diagnostics)
        it.advance(1); it.ended()
    }

    @Test fun anAlreadyElapsedAnnouncedDeadlineEndsAtLinkLoss() = Fixture().use {
        it.live(it.now + 1000); it.advance(1000); it.calls.linkLost(); it.ended()
    }

    @Test fun sameCallResumesBeforeExpiryAndTheNextLossGetsANewBudget() = Fixture().use {
        it.live(it.now + 3000); it.calls.linkLost(); it.advance(2999); it.live()
        assertFalse(it.hud.value.busy); assertEquals("通话中", it.hud.value.status); assertTrue(it.capturing)
        it.advance(10000); assertEquals(0, it.ends)
        it.calls.linkLost(); it.advance(6999); assertNotNull(it.hud.value.callId)
        it.advance(1); it.ended()
    }

    @Test fun aLivePacketAtTheDeadlineCannotBeatADelayedExpiryJob() = Fixture().use {
        it.live(); it.calls.linkLost(); it.now += 7000
        assertFalse(it.calls.receive(it.frame("live"))); it.ended()
    }

    @Test fun terminalStatesUseTheSameEndPathAndCancelOfflineExpiry() {
        for (phase in listOf("closed", "failed")) for (lost in listOf(false, true)) Fixture().use {
            it.live(); if (lost) it.calls.linkLost()
            assertTrue(it.calls.receive(it.frame(phase))); it.ended()
            it.advance(20000); it.ended(); assertFalse(it.calls.receive(it.frame("live")))
        }
    }

    @Test fun aNewAuthoritativeDeadlineDuringRecoveryReplacesTheLocalEstimate() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        assertTrue(it.calls.receive(it.frame("connecting", deadline = it.now + 500)))
        assertEquals("请稍候", it.hud.value.status)
        it.advance(500); it.ended()
    }

    @Test fun anElapsedDeadlineReceivedDuringRecoveryCannotReenableCapture() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(1000)
        assertFalse(it.calls.receive(it.frame("connecting", deadline = it.now)))
        it.ended()
    }

    @Test fun anUnacknowledgedHangupCannotBeReopenedByActivePackets() = Fixture().use {
        it.live(); it.calls.hangup()
        for (phase in listOf("opening", "connecting", "live")) assertFalse(it.calls.receive(it.frame(phase)))
        assertTrue(it.calls.hasPendingClose); assertFalse(it.capturing)
        assertEquals("call", it.calls.closeToSend()!!.getString("call_id"))
        assertNull(it.calls.closeToSend())
        assertTrue(it.calls.receive(it.frame("closed"))); assertFalse(it.calls.hasPendingClose); it.ended()
    }

    @Test fun ownerHangupStaysEndedAcrossLossAndLateLiveBothBeforeAndDuringRecovery() {
        for (alreadyLost in listOf(false, true)) Fixture().use {
            it.live()
            if (alreadyLost) it.calls.linkLost()
            assertEquals("call", it.calls.hangup()); assertFalse(it.capturing)
            assertFalse(it.calls.receive(it.frame("live")))
            it.calls.linkLost(); it.ended(); it.advance(20000); it.ended()
            assertFalse(it.calls.receive(it.frame("live")))
        }
    }

    @Test fun serverClosingReleasesCaptureAndCannotResumeOnReconnect() = Fixture().use {
        it.live(); assertTrue(it.calls.receive(it.frame("closing"))); assertFalse(it.capturing)
        it.calls.linkLost(); assertFalse(it.calls.receive(it.frame("live"))); it.ended()
        assertFalse(it.calls.hasPendingClose); assertNull(it.calls.closeToSend())
    }

    @Test fun differentCallCannotReplaceOrEndTheCurrentCallButCanStartAfterItEnds() = Fixture().use {
        it.live(); it.calls.linkLost()
        for (phase in listOf("opening", "connecting", "live", "closing", "closed", "failed"))
            assertFalse(it.calls.receive(it.frame(phase, "other")))
        assertEquals("call", it.hud.value.callId); assertTrue(it.capturing)
        it.calls.receive(it.frame("closed"))
        assertTrue(it.calls.receive(it.frame("live", "other")))
        assertEquals("other", it.hud.value.callId); it.advance(20000); assertTrue(it.capturing)
    }

    @Test fun ambientLinkLossDoesNotStartACallOrATimer() = Fixture().use {
        val ambient = it.hud.value
        it.calls.windowS = null; it.calls.linkLost(); it.advance(20000)
        assertEquals(ambient, it.hud.value); assertFalse(it.capturing); assertEquals(0, it.ends)
    }

    @Test fun acceptedLiveCallsHaveNoOpeningTimeout() = Fixture().use {
        it.open(); it.advance(1000)
        assertEquals("call", it.hud.value.callId); assertEquals("请稍候", it.hud.value.status)
        for (phase in listOf("opening", "connecting")) {
            assertTrue(it.calls.receive(it.frame(phase))); assertEquals("请稍候", it.hud.value.status)
        }
        it.live(); it.advance(20000); assertEquals("通话中", it.hud.value.status); assertEquals(0, it.ends)
    }

    @Test fun readyReplaysOnlyAnUnacceptedOpenWithTheSameIdAndPreservesMute() = Fixture().use {
        it.open()
        assertEquals("call", it.calls.openToSend()!!.getString("call_id")); assertNull(it.calls.openToSend())
        it.calls.toggleMute()
        it.calls.linkLost(); it.calls.toggleMute(); assertFalse(it.hud.value.micMuted)
        it.calls.toggleMute(); it.advance(1000); it.calls.ready()
        assertTrue(it.hud.value.micMuted); assertEquals(Microphone.Muted, microphone(it.hud.value))
        assertEquals("call", it.calls.openToSend()!!.getString("call_id"))
        it.live(); it.calls.linkLost(); it.calls.ready(); it.live(); assertNull(it.calls.openToSend())
        assertTrue(it.hud.value.micMuted); assertEquals(Microphone.Muted, microphone(it.hud.value))
        it.calls.receive(it.frame("closed")); assertFalse(it.hud.value.micMuted)
    }

    @Test fun anUnacceptedOrConnectingOpenFailsVisiblyWithinReadyBoundEvenAcrossReconnects() {
        for (accepted in listOf(false, true)) Fixture().use {
            it.calls.windowS = 120
            it.open(); it.calls.openToSend()
            if (accepted) it.calls.receive(it.frame("connecting"))
            it.advance(5000); it.calls.linkLost(); it.calls.ready()
            it.advance(GATEWAY_READY_TIMEOUT_MS - 5001); assertNotNull(it.hud.value.callId)
            it.advance(1)
            assertNull(it.hud.value.callId); assertFalse(it.hud.value.busy); assertFalse(it.capturing)
            assertEquals("通话连接超时，请重试", it.hud.value.status)
            assertEquals(listOf("通话连接超时，请重试"), visibleHud(it.hud.value, it.now).cards.single().lines)
            assertTrue(it.calls.hasPendingClose); assertNull(it.calls.openToSend())
            val close = it.calls.closeToSend()!!
            assertEquals("call", close.getString("call_id")); assertEquals("error", close.getString("reason"))
            assertFalse(it.calls.receive(it.frame("live")))
            assertTrue(it.calls.receive(it.frame("closed"))); assertFalse(it.calls.hasPendingClose)
            it.open("next"); assertEquals("next", it.calls.openToSend()!!.getString("call_id"))
        }
    }

    @Test fun lateStartupPacketsCannotBeatADelayedOpeningTimer() = Fixture().use {
        it.calls.windowS = 120; it.open()
        it.now += GATEWAY_READY_TIMEOUT_MS
        assertFalse(it.calls.receive(it.frame("live")))
        assertNull(it.hud.value.callId); assertTrue(it.calls.hasPendingClose)
        assertEquals("通话连接超时，请重试", it.hud.value.status)
    }

    @Test fun serverStartupFailureIsVisibleAndCancelsTheLocalOpeningTimer() {
        for (terminal in listOf("failed", "closed")) Fixture().use {
            it.open()
            if (terminal == "closed") assertTrue(it.calls.receive(it.frame("closing")))
            assertTrue(it.calls.receive(it.frame(terminal).put("error_code", "VOICE_CALL_OPEN_FAILED")))
            assertNull(it.hud.value.callId); assertFalse(it.hud.value.busy)
            assertEquals("通话连接失败，请重试", it.hud.value.status)
            assertEquals(listOf("通话连接失败，请重试"), visibleHud(it.hud.value, it.now).cards.single().lines)
            assertEquals(listOf("通话连接失败，请重试"), visibleHud(it.hud.value.copy(ride = JSONObject(), moveAt = it.now), it.now).cards.single().lines)
            assertFalse(it.calls.receive(it.frame("failed")))
            it.advance(GATEWAY_READY_TIMEOUT_MS)
            assertEquals("通话连接失败，请重试", it.hud.value.status); assertEquals(1, it.ends)
            assertFalse(it.calls.hasPendingClose)
        }
    }

    @Test fun ownerHangupDuringStartupDoesNotProduceAFailureNotice() = Fixture().use {
        it.open(); it.calls.hangup(); assertTrue(it.calls.receive(it.frame("closed")))
        it.advance(GATEWAY_READY_TIMEOUT_MS); it.ended(); assertTrue(it.hud.value.cards.isEmpty())
    }

    @Test fun theFormalParserKeepsUnknownFieldsAndTheConsumerAcceptsThem() = Fixture().use {
        val packet = it.frame("live", deadline = it.now + 1000).put("schema_version", "paios.central.text-envelope.v1")
            .put("session_id", "session").put("operation", "call_state").put("future_field", JSONObject().put("video", true))
        val parsed = formalPacket(packet.toString().toByteArray(), "session")
        assertTrue(parsed.has("future_field")); assertTrue(it.calls.receive(parsed))
        it.calls.linkLost(); it.advance(1000); it.ended()
    }

    @Test fun missingWindowAllowsCallsButEndsThemAtLinkLoss() = Fixture().use {
        it.calls.windowS = null
        it.open(); it.live(it.now + 30000); it.advance(20000)
        assertEquals("call", it.hud.value.callId)
        it.calls.linkLost(); it.ended()
    }

    @Test fun hangupSurvivesATimedOutSendAndReconnectAfterMoreThan15Seconds() = runBlocking {
        Fixture().use {
            it.calls.windowS = 120
            it.live(); it.calls.linkLost(); it.calls.hangup(); it.ended()
            val link = ConnectionLoop(); val sent = mutableListOf<JSONObject>()
            try { link.awaitConnected(1); fail("The disconnected send must time out") }
            catch (_: GatewayReadinessTimeout) { it.calls.retryClose() }
            it.advance(16000); assertTrue(it.calls.hasPendingClose)
            link.connected(); link.awaitConnected()
            it.calls.closeToSend()?.let(sent::add) // Ready drains the retained owner command.
            assertFalse(it.calls.receive(it.frame("live")))
            it.calls.closeToSend()?.let(sent::add) // The replay cannot send it twice on the same link.
            assertEquals(1, sent.size); assertEquals("call_close", sent.single().getString("operation"))
            assertEquals("call", sent.single().getString("call_id")); assertEquals("button", sent.single().getString("reason"))
            assertTrue(it.calls.receive(it.frame("closed"))); assertFalse(it.calls.hasPendingClose)
            assertNull(it.calls.closeToSend()); it.ended()
        }
    }

    @Test fun expiredRecoveryStillDrainsOwnerCloseOnReadyAndWaitsForMatchingTerminalState() = Fixture().use {
        it.calls.windowS = 20; it.live(); it.calls.linkLost(); it.calls.hangup()
        it.advance(20000); assertTrue(it.calls.hasPendingClose)
        assertEquals("call", it.calls.closeToSend()!!.getString("call_id")); assertNull(it.calls.closeToSend())
        assertFalse(it.calls.receive(it.frame("closed", "other"))); assertTrue(it.calls.hasPendingClose)
        assertTrue(it.calls.receive(it.frame("closed"))); assertFalse(it.calls.hasPendingClose); it.ended()
    }

    @Test fun rejoinPublishedBeforeDeadlineButReceivedAfterItCannotAcknowledgeOwnerClose() {
        for (timerFired in listOf(false, true)) for (terminal in listOf("closed", "failed")) Fixture().use {
            it.live(); it.calls.linkLost(); it.calls.receive(it.frame("connecting", deadline = 105000))
            it.calls.hangup()
            // Gateway rejoins at 104999; its live replay is processed two milliseconds later.
            if (timerFired) it.advance(5001) else it.now = 105001
            assertFalse(it.calls.receive(it.frame("live"))); assertTrue(it.calls.hasPendingClose)
            assertEquals("call_close", it.calls.closeToSend()!!.getString("operation"))
            assertNull(it.calls.closeToSend()); it.calls.closePublished("call")
            assertFalse(it.calls.receive(it.frame("live")))
            assertNotNull(it.calls.closeToSend()); assertTrue(it.calls.hasPendingClose); it.ended()
            assertTrue(it.calls.receive(it.frame(terminal))); assertFalse(it.calls.hasPendingClose); it.ended()
        }
    }

    @Test fun localTeardownIsNotACloseAcknowledgement() = Fixture().use {
        it.live(); it.calls.hangup(); it.calls.end()
        assertTrue(it.calls.hasPendingClose); assertNotNull(it.calls.closeToSend())
        assertTrue(it.calls.receive(it.frame("failed"))); assertFalse(it.calls.hasPendingClose); it.ended()
    }

    @Test fun aCallThatOnlyExpiredLocallyNeverCreatesAnOwnerClose() = Fixture().use {
        it.live(); it.calls.linkLost(); it.advance(7000); it.ended()
        assertFalse(it.calls.hasPendingClose); assertNull(it.calls.closeToSend())
    }

    @Test fun lostCloseAcknowledgementIsReplayedOnTheNextLink() = Fixture().use {
        it.live(); it.calls.hangup(); assertNotNull(it.calls.closeToSend())
        it.calls.linkLost(); it.advance(1000)
        assertNotNull(it.calls.closeToSend()); assertNull(it.calls.closeToSend())
        assertFalse(it.calls.receive(it.frame("closed", "other"))); assertTrue(it.calls.hasPendingClose)
        assertTrue(it.calls.receive(it.frame("failed"))); assertFalse(it.calls.hasPendingClose)
    }

    @Test fun activePacketsAfterUnacknowledgedPublicationRequestAnIdempotentCloseAgain() = Fixture().use {
        it.live(); it.calls.hangup(); assertNotNull(it.calls.closeToSend()); it.calls.closePublished("call")
        assertNull(it.calls.closeToSend())
        for (phase in listOf("opening", "connecting", "live")) {
            assertFalse(it.calls.receive(it.frame(phase)))
            assertEquals("call", it.calls.closeToSend()!!.getString("call_id"))
            assertNull(it.calls.closeToSend()); it.calls.closePublished("call")
        }
        assertFalse(it.capturing); assertTrue(it.calls.hasPendingClose)
    }

    @Test fun theNextCallWaitsForCloseAcknowledgementEvenAfterRecoveryExpires() {
        for (terminal in listOf("closed", "failed")) Fixture().use {
            it.live(); it.calls.linkLost(); it.calls.hangup()
            val next = CoroutineScope(it.owner + Dispatchers.Unconfined).launch { it.calls.open("next") }
            assertFalse(next.isCompleted); assertNull(it.hud.value.callId)
            it.advance(7000); assertFalse(next.isCompleted); assertTrue(it.calls.hasPendingClose)
            assertFalse(it.calls.receive(it.frame("live"))); assertFalse(next.isCompleted)
            it.calls.receive(it.frame(terminal))
            assertTrue(next.isCompleted); assertEquals("next", it.hud.value.callId)
        }
    }

    @Test fun pendingOwnerCloseRetainsTheQualifiedBudgetWithoutTreatingExpiryAsAcknowledgement() = Fixture().use {
        it.live(); it.calls.linkLost(); it.calls.hangup(); it.advance(1000)
        assertFalse(it.calls.receive(it.frame("connecting", deadline = 109000)))
        it.advance(6000); assertTrue(it.calls.hasPendingClose)
        assertEquals("call", it.calls.closeToSend()!!.getString("call_id"))
        it.calls.closePublished("call")
        assertFalse(it.calls.receive(it.frame("live", deadline = 111000)))
        assertEquals(listOf("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED"), it.diagnostics)
        it.advance(1999); assertTrue(it.calls.hasPendingClose)
        it.advance(1); assertTrue(it.calls.hasPendingClose); assertNotNull(it.calls.closeToSend()); it.ended()
        it.calls.linkLost(); assertFalse(it.calls.receive(it.frame("connecting", deadline = 112000)))
        assertEquals(2, it.diagnostics.size) // Expiry and retry cannot reset deadline qualification.
        assertTrue(it.calls.receive(it.frame("closed"))); assertFalse(it.calls.hasPendingClose); it.ended()
    }
}
