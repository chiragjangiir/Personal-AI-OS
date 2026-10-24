package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow

class UnlockLeaseTest {
    private fun lock(locked: Boolean = true, reason: String? = null, cycle: Long? = null) = JSONObject()
        .put("lock_enabled", true).put("locked", locked).put("wear_poll_ms", 2000).put("reason", reason)
        .apply { cycle?.let { put("lock_cycle", it) } }
    private fun approval(lease: UnlockLease) = lock(false, cycle = lease.lockCycle)

    @Test fun matchingCycleSnapshotUnmasksLocallyAndReceiptAloneDoesNot() {
        val lease = UnlockLease { "unlock-1" }
        lease.connection(true)
        assertTrue(lease.state.locked); assertNull(lease.accept(lock(), 0))
        val request = lease.wear(true)!!
        assertEquals(setOf("operation", "control_id", "lock_cycle"), request.keys().asSequence().toSet())
        assertEquals("glasses_unlock_request", request.getString("operation"))
        assertEquals(lease.lockCycle, request.getLong("lock_cycle"))
        lease.receipt(JSONObject().put("control_id", "unlock-1").put("ok", true))
        assertTrue(lease.state.locked)
        assertNull(lease.accept(lock(reason = "awaiting_phone").put("approval_expires_in_ms", 4200), 100))
        assertEquals(4300L, lease.state.approvalUntil)
        assertNull(lease.wear(true))
        val previous = approval(lease)
        lease.accept(previous, 500)
        assertFalse(lease.state.locked)
        assertEquals("已解锁 · 戴着有效，摘下会重新上锁", lease.state.line(3499))
        assertNull(lease.state.line(3500))
        assertNull(lease.wear(false)); assertTrue(lease.state.locked)
        lease.accept(previous, 501); assertTrue(lease.state.locked)
        assertNotNull(lease.wear(true)); assertTrue(lease.state.locked)
        lease.accept(previous, 502); assertTrue(lease.state.locked)
        lease.accept(approval(lease), 503); assertFalse(lease.state.locked)
    }

    @Test fun wearScreenReconnectRestartAndUserRelocksRejectOldCycleUntilMatchingSnapshot() {
        for (event in listOf("screen", "wear", "reconnect", "restart", "user")) {
            val lease = UnlockLease()
            lease.connection(true); lease.wear(true); lease.accept(lock(), 0)
            val previous = approval(lease); lease.accept(previous, 1)
            assertFalse(lease.state.locked)
            val oldCycle = lease.lockCycle
            when (event) {
                "screen" -> { assertEquals("screen_off", lease.screen(false)!!.getString("reason")); assertNotNull(lease.screen(true)) }
                "wear" -> { lease.wear(false); assertNotNull(lease.wear(true)) }
                "reconnect" -> { lease.connection(false); lease.accept(lock(), 2); lease.ready() }
                "restart" -> { lease.restart(); lease.wear(true); lease.accept(lock(), 2); lease.ready() }
                "user" -> { assertEquals("user", lease.lock().getString("reason")); assertNotNull(lease.retry()) }
            }
            assertTrue("$event must advance cycle", lease.lockCycle > oldCycle)
            lease.accept(previous, 3)
            assertTrue("$event rejected stale unlock", lease.state.locked)
            val retained = HudState(paired = true, listening = true, callId = "call", paymentLock = lease.state,
                cards = listOf(HudCard("private", "chat", listOf("private"), 1, Long.MAX_VALUE)))
            assertTrue(visibleHud(retained, 10000).cards.isEmpty())
            assertEquals(HudScreen.Locked, reconcileHud(HudScreen.Card("private"), visibleHud(retained, 10000)))
            lease.accept(approval(lease), 4)
            assertFalse("$event accepts fresh cycle", lease.state.locked)
            assertEquals(1, visibleHud(retained.copy(paymentLock = lease.state), 10000).cards.size)
        }
    }

    @Test fun denialExpiryAndFailedReceiptsStayLocallyMaskedWithoutApprovalLoops() {
        val lease = UnlockLease { "request" }
        lease.connection(true); lease.wear(true); lease.accept(lock(), 0)
        val pending = lock(reason = "awaiting_phone").put("approval_expires_in_ms", 1234)
        lease.accept(pending, 10)
        assertTrue(lease.state.line(1244)!!.contains("重新确认"))
        assertNull(lease.accept(lock(reason = "denied"), 1250)); assertNull(lease.wear(true))
        assertNotNull(lease.retry())
        lease.receipt(JSONObject().put("control_id", "different").put("ok", false))
        assertNull(lease.state.reason)
        lease.receipt(JSONObject().put("control_id", "request").put("ok", false))
        assertEquals("denied", lease.state.reason); assertTrue(lease.state.locked)
        lease.accept(lock(false).put("lock_enabled", false).put("reason", "disabled"), 1251)
        assertFalse(lease.state.enabled); assertFalse(lease.state.locked)
    }

    @Test fun disabledLockScreenOnRecomputesVisibilityWithOrWithoutAnOffScreenSnapshot() {
        for (snapshotWhileOff in listOf(false, true)) {
            val lease = UnlockLease(); lease.connection(true); lease.wear(true)
            val disabled = lock(false).put("lock_enabled", false).put("reason", "disabled")
            lease.accept(disabled, 0); assertFalse(lease.state.locked)
            lease.screen(false); assertTrue(lease.state.locked)
            if (snapshotWhileOff) { lease.accept(disabled, 1); assertTrue(lease.state.locked) }
            assertNull(lease.screen(true)); assertFalse(lease.state.locked)
            lease.wear(false); lease.screen(true); assertTrue(lease.state.locked)
            lease.wear(true); assertFalse(lease.state.locked)
            lease.connection(false); lease.screen(true); assertTrue(lease.state.locked)
            lease.ready(); assertTrue(lease.state.locked) // cached disabled setting is not current after reconnect
            lease.accept(disabled, 2); assertFalse(lease.state.locked)
        }
    }

    @Test fun enabledUnlockRequiresAnExactCycleAndLockedSnapshotsAlwaysMask() {
        val lease = UnlockLease(); lease.connection(true); lease.wear(true); lease.accept(lock(), 0)
        for (cycle in listOf(null, lease.lockCycle - 1, lease.lockCycle + 1)) {
            lease.accept(lock(false, cycle = cycle), 1); assertTrue(lease.state.locked)
        }
        for (value in listOf(-1, 1.5, "1"))
            assertThrows(IllegalArgumentException::class.java) { lease.accept(lock(false).put("lock_cycle", value), 2) }
        lease.accept(approval(lease), 3); assertFalse(lease.state.locked)
        val previous = approval(lease)
        lease.accept(lock(cycle = lease.lockCycle - 1, reason = "expired"), 4)
        assertTrue(lease.state.locked)
        lease.retry(); lease.accept(previous, 5); assertTrue(lease.state.locked)
        lease.accept(approval(lease), 6); assertFalse(lease.state.locked)
    }

    @Test fun modelCycleStartsAtZeroAndTracksRestartWearScreenAndConnection() {
        val lease = UnlockLease { "ctl-1" }; assertEquals(0L, lease.lockCycle)
        lease.restart(); assertEquals(1L, lease.lockCycle)
        lease.connection(true); assertEquals(2L, lease.lockCycle)
        lease.wear(true); assertEquals(2L, lease.wearMessage(true).getLong("lock_cycle"))
        lease.wear(false); assertEquals(3L, lease.wearMessage(false).getLong("lock_cycle"))
        lease.screen(false); assertEquals(4L, lease.lockCycle)
        lease.connection(false); assertEquals(5L, lease.lockCycle)
        lease.restart(); assertEquals(6L, lease.wearMessage(false).getLong("lock_cycle"))
    }

    @Test fun serverPollCadenceReplacesTheDefaultAndMalformedStateCannotReplaceIt() {
        val lease = UnlockLease(); assertEquals(2000L, lease.state.wearPollMs)
        lease.accept(lock().put("wear_poll_ms", 617), 0); assertEquals(617L, lease.state.wearPollMs)
        val before = lease.state
        for (value in listOf(0, -1, 1.5, "2000"))
            assertThrows(IllegalArgumentException::class.java) { lease.accept(lock().put("wear_poll_ms", value), 0) }
        assertEquals(before, lease.state)
    }

    @Test fun pollChangeCancelsTheOldWaitAndImmediatelyReadsTheWearProvider() = runBlocking {
        val interval = MutableStateFlow(2000L)
        val waits = kotlinx.coroutines.channels.Channel<Long>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        var reads = 0
        val job = launch { pollWear(interval, { reads++ }, { ms -> waits.send(ms); awaitCancellation() }) }
        assertTrue(withTimeout(5000) { waits.receive() } in 1..2000)
        interval.value = 713
        assertTrue(withTimeout(5000) { waits.receive() } in 1..713)
        assertEquals(2, reads); job.cancelAndJoin()
    }

    @Test fun maskBeforeTheGatewayAnswersSaysConnectingAndNeverAsksTheIphone() {
        val lease = UnlockLease()
        assertEquals("正在连接依米…", lease.state.line(0)); assertFalse(lease.state.awaitingPhone)
        lease.connection(true); assertEquals("正在连接依米…", lease.state.line(0))
        lease.wear(true); lease.screen(false); lease.screen(true); assertEquals("正在连接依米…", lease.state.line(0))
        lease.retry(); assertEquals("正在连接依米…", lease.state.line(0))
        lease.accept(lock(false).put("lock_enabled", false).put("reason", "disabled"), 0)
        assertFalse(lease.state.locked); assertNull(lease.state.line(0))
        lease.wear(false); assertTrue(lease.state.locked)
        assertNull("a disabled lock never asks the iPhone", lease.state.line(0))
        lease.connection(false); assertEquals("正在连接依米…", lease.state.line(0))
        val enabled = UnlockLease(); enabled.connection(true); enabled.wear(true); enabled.accept(lock(reason = "awaiting_phone"), 0)
        assertEquals("依米已锁定 · 请在 iPhone 上确认", enabled.state.line(0)); assertTrue(enabled.state.awaitingPhone)
    }

    @Test fun modelDefersUnlockRequestUntilReady() {
        val lease = UnlockLease(); lease.connection(false); lease.wear(true)
        assertNull(lease.accept(lock(reason = "awaiting_phone"), 0))
        assertTrue(lease.state.locked)
        assertEquals("glasses_unlock_request", lease.ready()!!.getString("operation"))
    }

    @Test fun reconnectDisplayUsesOneReadinessBudgetAcrossRetriesAndClearsOnServerState() {
        var now = 1000L
        val lease = UnlockLease(now = { now })
        assertEquals("正在连接依米…", lease.state.line(15999))
        now = 7000; lease.connection(false)
        now = 12000; lease.connection(false); lease.ready()
        assertEquals(16000L, lease.state.connectionWaitUntil)
        assertEquals("正在连接依米…", lease.state.line(15999))
        assertEquals("连接超时 · 正在重试", lease.state.line(16000))
        lease.wear(true)
        lease.accept(lock(false).put("lock_enabled", false).put("reason", "disabled"), 17000)
        assertNull(lease.state.connectionWaitUntil); assertNull(lease.state.line(17000))
        now = 20000; lease.connection(false)
        assertEquals(35000L, lease.state.connectionWaitUntil)
        assertEquals("正在连接依米…", lease.state.line(34999))
    }
}
