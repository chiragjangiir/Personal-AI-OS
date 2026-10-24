package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HudUiTest {
    @Test fun ownerGestureFailuresAndBackOrderCannotRegress() {
        val unpaired = HudState()
        val scan = reduceHud(HudScreen.Pairing(), HudGesture.Click, unpaired, 0)
        assertEquals("SCAN", scan.action); assertEquals(HudScreen.Scanning, scan.screen)
        val pairingSlide = reduceHud(HudScreen.Pairing(), HudGesture.Down, unpaired, 0).screen
        assertTrue(reduceHud(reconcileHud(pairingSlide, unpaired), HudGesture.Click, unpaired, 0).screen is HudScreen.Settings)
        assertEquals(HudTransition(HudScreen.Pairing(), "CANCEL_SCAN"),
            reduceHud(scan.screen, HudGesture.DoubleClick, unpaired, 0))
        val errand = HudCard("errand", "点奶茶", emptyList(), 1, Long.MAX_VALUE, progress = "1/3")
        val idle = HudState(paired = true, cards = listOf(errand))
        val menu = HudScreen.Menu(HudScreen.Idle, touched = 0)
        for (slide in listOf(HudGesture.Forward, HudGesture.Down, HudGesture.Backward, HudGesture.Up)) {
            val moved = reduceHud(menu, slide, idle, 0).screen
            val click = reduceHud(moved, HudGesture.Click, idle, 0)
            if (slide == HudGesture.Forward || slide == HudGesture.Down) assertEquals("PRIVATE", click.action)
            else assertEquals("STOP", click.action)
        }
        val card = HudCard("choice", "午饭", emptyList(), 1, Long.MAX_VALUE, actions = listOf(
            HudAction("shop-a", "甲店", JSONObject()), HudAction("shop-b", "乙店", JSONObject()), HudAction("shop-c", "丙店", JSONObject())))
        val call = idle.copy(callId = "call", cards = listOf(errand, card))
        val choice = HudScreen.Card(card.id)
        val next = reduceHud(choice, HudGesture.Forward, call, 0).screen
        val approve = reduceHud(next, HudGesture.Click, call, 0)
        assertEquals("APPROVE", approve.action); assertEquals(card.id, approve.cardId); assertEquals("shop-b", approve.actionId)
        assertEquals(approve, reduceHud(next, HudGesture.Nod, call, 0))
        assertEquals("DISMISS", reduceHud(next, HudGesture.Shake, call, 0).action)
        val fromSettings = reduceHud(HudScreen.Settings(choice), HudGesture.DoubleClick, call, 0)
        assertEquals(HudTransition(choice), fromSettings)
        val fromMenu = reduceHud(HudScreen.Menu(fromSettings.screen, touched = 0), HudGesture.DoubleClick, call, 0)
        assertEquals(HudTransition(choice), fromMenu)
        val dismissed = reduceHud(fromMenu.screen, HudGesture.DoubleClick, call, 0)
        assertEquals(HudTransition(HudScreen.Talking, "DISMISS", card.id), dismissed)
        assertEquals("STOP", reduceHud(dismissed.screen, HudGesture.DoubleClick, call, 0).action)
        assertEquals("FINISH", reduceHud(HudScreen.Idle, HudGesture.DoubleClick, idle, 0).action)
        for (screen in listOf(HudScreen.Pairing(), scan.screen, menu, choice, HudScreen.Settings(choice), HudScreen.Talking))
            assertEquals(HudTransition(screen), reduceHud(screen, HudGesture.LongClick, call, 0))
    }

    private val ride = JSONObject("""{"speed_kmh":27.4,"avg_kmh":24.1,"max_kmh":41.2,"distance_m":12600,"moving_s":2400,"elapsed_s":2535,"hr_alert":false}""")
    private val nav = JSONObject("""{"nav_id":"n","revision":1,"step_index":0,"maneuver":"right","distance_to_maneuver_m":200,"remaining_m":3200,"remaining_s":540,"maneuver_location":{"lat":31.24,"lng":121.48},"route_segment_index":0,"segment_fraction":0.4}""")
    private fun frame(kind: String) = JSONObject().put("operation", "move_hud").put("kind", kind).put("at", "t").put("ride", ride).put("nav", nav)
        .put("coordinate_system", "wgs84").put("seq", 2).put("position", JSONObject("""{"lat":31.23,"lng":121.47,"accuracy_m":4,"at":"2026-10-18T12:00:00Z"}"""))
    private val paired = HudState(paired = true)
    private val offer = HudCard("offer", "依米来电", listOf("聊聊这次骑行？"), 2, Long.MAX_VALUE,
        actions = listOf(HudAction("accept", "接听", JSONObject()), HudAction("decline", "拒绝", JSONObject())))

    @Test fun unwornLockKeepsMovementVisibleWithoutExposingOtherContent() {
        val now = java.time.Instant.parse("2026-10-18T12:00:00Z").toEpochMilli()
        val locked = paired.copy(capture = CaptureState(worn = false),
            paymentLock = GlassesLockState(enabled = true, locked = true, reason = "not_worn"),
            cards = listOf(offer), captions = listOf(HudCaption("private", "assistant", 1, "私人消息", now)))
        for (kind in listOf("ride", "ride_nav", "walk_nav")) {
            val received = locked.move(frame(kind), now)
                .move(JSONObject().put("operation", "move_say").put("text", "前方右转"), now)
            val visible = visibleHud(received, now)
            assertEquals("前方右转", visible.say)
            assertTrue(visible.cards.isEmpty()); assertTrue(visible.captions.isEmpty()); assertNull(visible.payment)
            assertEquals(kind != "walk_nav", visible.ride != null)
            assertEquals(kind != "ride", visible.nav != null)
            assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Locked, visible, newCard = true))
            assertTrue(moveHudLayout(visible).texts.isNotEmpty())
            // Displaying movement does not grant call, menu, payment or choice authorization.
            assertEquals(HudTransition(HudScreen.Locked, "UNLOCK"), reduceHud(HudScreen.Move(), HudGesture.Click, visible, now))
            assertEquals(HudTransition(HudScreen.Locked), reduceHud(HudScreen.Move(), HudGesture.Nod, visible, now))
        }
        val ended = locked.move(frame("ride"), now)
            .move(JSONObject().put("operation", "ride_summary").put("distance_m", 1000), now)
            .move(JSONObject().put("operation", "move_say").put("text", "骑行结束"), now)
        val visible = visibleHud(ended, now)
        assertNotNull(visible.summary); assertEquals("骑行结束", visible.say)
        assertEquals(HudScreen.Summary(now), reconcileHud(HudScreen.Summary(now), visible))
        assertEquals(HudScreen.Locked, reconcileHud(HudScreen.Idle, visibleHud(locked, now)))
    }

    @Test fun lockedMovementDoesNotExposeConversationTextOrErrors() {
        val state = paired.copy(callId = "call", listening = true,
            paymentLock = GlassesLockState(enabled = true, locked = true),
            conversation = CallConversation("thinking", "私人问题"), conversationError = "私人错误")
            .move(frame("ride_nav"), 0)
        val visible = visibleHud(state, 0)
        assertNull(visible.conversation); assertNull(visible.conversationError)
        assertEquals("call", visible.callId); assertTrue(visible.listening)
        assertFalse(moveHudLayout(visible).texts.any { it.text.contains("私人问题") || it.text.contains("私人错误") })
    }

    @Test fun movementDisplayDoesNotDependOnWearOrLockLease() {
        val now = java.time.Instant.parse("2026-10-18T12:00:00Z").toEpochMilli()
        for (worn in listOf(null, false, true)) for (lock in listOf(
            GlassesLockState(enabled = true, locked = true, reason = "not_worn"),
            GlassesLockState(enabled = false, locked = true, reason = "disabled"),
            GlassesLockState(enabled = true, locked = true, reason = "awaiting_phone"))) {
            val state = paired.copy(capture = CaptureState(worn = worn), paymentLock = lock,
                cards = listOf(offer), captions = listOf(HudCaption("private", "assistant", 1, "私人消息", now)))
                .move(frame("ride_nav"), now)
            val visible = visibleHud(state, now)
            assertNotNull(visible.ride); assertNotNull(visible.nav); assertNotNull(visible.navigationFix)
            assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Locked, visible))
            assertTrue(visible.cards.isEmpty()); assertTrue(visible.captions.isEmpty()); assertNull(visible.payment)
            val stale = visibleHud(state, now + 60000)
            assertEquals(0, stale.ride!!.length()); assertEquals(0, stale.nav!!.length()); assertNull(stale.navigationFix)
            assertEquals(HudScreen.Locked, reconcileHud(HudScreen.Notice("私人通知", now + 1000), visibleHud(state.copy(ride = null, nav = null), now)))
        }
    }

    @Test fun moveKindsPageTheDataAndDoubleClickNeverEndsTheRide() {
        val riding = visibleHud(paired.move(frame("ride"), 0), 0)
        val both = visibleHud(paired.move(frame("ride_nav"), 0), 0)
        val walking = visibleHud(paired.move(frame("walk_nav"), 0), 0)
        assertNull(riding.nav); assertNotNull(both.ride); assertNotNull(both.nav); assertNull(walking.ride)
        val move = reconcileHud(HudScreen.Idle, riding)
        assertEquals(HudScreen.Move(), move)
        for (slide in listOf(HudGesture.Forward, HudGesture.Backward, HudGesture.Up, HudGesture.Down)) {
            val paged = reduceHud(move, slide, riding, 0).screen
            assertEquals(HudScreen.Move(1), paged); assertEquals(paged, reconcileHud(paged, riding))
            assertEquals(move, reduceHud(paged, slide, riding, 0).screen)
            assertTrue(reduceHud(move, slide, walking, 0).screen is HudScreen.Menu)
        }
        assertEquals("TAP", reduceHud(move, HudGesture.Click, both, 0).action)
        assertEquals(listOf("AMBIENT", "PRIVATE", "RECORD", "TAP", "RIDE_STOP", "NAV_STOP", "SETTINGS"), hudMenu(both).map { it.action })
        assertEquals(listOf("AMBIENT", "PRIVATE", "RECORD", "TAP", "RIDE_START", "NAV", "SETTINGS"), hudMenu(paired).map { it.action })
        // Double click only asks (the menu holds 结束骑行); ending takes an explicit choice there. In a call it hangs up.
        var screen: HudScreen = HudScreen.Move(1)
        repeat(4) { reduceHud(screen, HudGesture.DoubleClick, both, 0).let { assertNull(it.action); screen = it.screen } }
        assertEquals(HudScreen.Move(1), screen)
        val asked = reduceHud(screen, HudGesture.DoubleClick, both, 0).screen
        assertEquals(HudTransition(HudScreen.Move(1), "RIDE_STOP"), reduceHud((asked as HudScreen.Menu).copy(focus = hudMenu(both).indexOfFirst { it.action == "RIDE_STOP" }), HudGesture.Click, both, 0))
        assertEquals(HudTransition(move, "STOP"), reduceHud(move, HudGesture.DoubleClick, both.copy(callId = "call"), 0))
    }

    @Test fun rideWithoutGpsSpeedKeepsHeartRateAndElapsedMetrics() {
        val metrics = JSONObject(ride.toString()).apply { remove("speed_kmh"); put("hr_bpm", 126) }
        val state = visibleHud(paired.move(frame("ride").put("ride", metrics), 1000), 2000)
        val liveRide = state.ride!!
        assertFalse(liveRide.has("speed_kmh"))
        assertEquals(126, liveRide.getInt("hr_bpm")); assertEquals(2535, liveRide.getInt("elapsed_s"))
        assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Idle, state))
    }

    @Test fun cardsWaitWhileMovementRemainsPendingAndExplicitStopClearsIt() {
        val message = HudCard("message", "微信 · 小周", listOf("明天几点见"), 1, Long.MAX_VALUE, actions = listOf(HudAction("reply", "让依米回复", JSONObject())))
        val care = HudCard("care", "安全确认", listOf("你还好吗"), 2, Long.MAX_VALUE, actions = listOf(HudAction("safe", "我安全", JSONObject())))
        val state = paired.copy(cards = listOf(message)).move(frame("ride_nav"), 1000)
        assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Idle, visibleHud(state, 1000), newCard = true))
        assertEquals(HudScreen.Card("care"), reconcileHud(HudScreen.Move(), visibleHud(state.copy(cards = listOf(message, care)), 1000), newCard = true))
        // Receipt expiry removes directional cues, while mode intent persists until a stop.
        assertNotNull(visibleHud(state, 10999).navigationFix)
        val stale = visibleHud(state, 11000)
        assertEquals(0, stale.nav!!.length()); assertNull(stale.navigationFix)
        val pending = visibleHud(state, 61000)
        assertEquals(0, pending.ride!!.length())
        assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Move(), pending))
        val stopped = state.move(JSONObject().put("operation", "move_hud").put("kind", "walk_nav"), 62000)
        assertNull(stopped.ride); assertNull(stopped.nav)
        assertEquals(HudScreen.Card("message"), reconcileHud(HudScreen.Move(), stopped))
    }

    @Test fun pendingRideAndOldSensorTimestampNeverInventMetricsOrDirections() {
        val pending = paired.move(JSONObject().put("operation", "move_hud").put("kind", "ride"), 1000)
        assertNotNull(pending.ride); assertNull(pending.nav)
        assertEquals(0, visibleHud(pending, 90000).ride!!.length())
        val packet = frame("ride_nav").apply { remove("ride") }
        val sampleTime = java.time.Instant.parse("2026-10-18T12:00:00Z").toEpochMilli()
        val waiting = visibleHud(paired.move(packet, sampleTime + 60000), sampleTime + 60000)
        assertEquals(0, waiting.ride!!.length()); assertEquals(0, waiting.nav!!.length())
        assertNull(waiting.navigationFix)
        assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Idle, waiting))
        val resumed = visibleHud(paired.move(packet, sampleTime + 1000), sampleTime + 1000)
        assertNotNull(resumed.navigationFix); assertEquals("right", resumed.nav!!.getString("maneuver"))
    }

    @Test fun navigationWithoutPositionKeepsModeAndWaitsWithoutDirectionalCues() {
        val packet = frame("ride_nav").apply { remove("position") }
        val state = paired.move(packet, 1000)
        assertNull(state.navigationFix)
        val visible = visibleHud(state, 1000)
        assertEquals(0, visible.nav!!.length())
        assertEquals(HudScreen.Move(), reconcileHud(HudScreen.Idle, visible))
        val layout = moveHudLayout(visible)
        assertEquals("等待定位", layout.texts.single { it.role == "navigation" }.text)
        assertNull(layout.turnIcon); assertNull(layout.miniMap); assertNull(layout.turnRibbon)
    }

    @Test fun summaryReturnsAfterAMinuteUnlessAnUrgentCardTakesOver() {
        val summary = JSONObject().put("operation", "ride_summary").put("distance_m", 32600).put("moving_s", 5320).put("elapsed_s", 5600)
        val ended = paired.move(frame("ride"), 0).move(summary, 5000)
        assertNull(ended.ride)
        val shown = HudScreen.Summary(ended.summaryAt)
        assertEquals(shown, settleHud(shown, 64999)); assertEquals(HudScreen.Idle, reconcileHud(settleHud(shown, 65000), ended))
        val touched = reduceHud(shown, HudGesture.Forward, ended, 30000).screen
        assertEquals(touched, settleHud(touched, 89999)); assertEquals(HudScreen.Idle, settleHud(touched, 90000))
        assertEquals(HudTransition(HudScreen.Idle), reduceHud(shown, HudGesture.DoubleClick, ended, 0))
        val remark = HudCard("remark", "依米", listOf("比上周快了"), 1, Long.MAX_VALUE)
        assertEquals(shown, reconcileHud(shown, ended.copy(cards = listOf(remark)), newCard = true))
        assertEquals(HudScreen.Card("offer"), reconcileHud(shown, ended.copy(cards = listOf(offer, remark)), newCard = true))
    }

    @Test fun payOpensAlipayAndTheReturnSendsPayClosed() {
        val riding = visibleHud(paired.move(frame("ride"), 0), 0)
        assertEquals(HudTransition(HudScreen.Paying, "PAY"), reduceHud(HudScreen.Move(), HudGesture.Pay, riding, 0))
        assertEquals(HudScreen.Paying, reconcileHud(HudScreen.Paying, riding.copy(cards = listOf(offer)), newCard = true))
        assertEquals(HudTransition(HudScreen.Move(), "PAY_CLOSED"), reduceHud(HudScreen.Paying, HudGesture.Resume, riding, 0))
        assertEquals(HudTransition(HudScreen.Idle), reduceHud(HudScreen.Idle, HudGesture.Resume, paired, 0))
    }

    private fun transcript(id: String, role: String, text: String, turn: Int = 1) = JSONObject().put("operation", "display_card").put("card_id", id)
        .put("title", "任意标题").put("lines", org.json.JSONArray().put(text)).put("priority", "normal").put("lifetime_ms", 8000)
        .put("caption", JSONObject().put("role", role).put("turn", turn))

    @Test fun captionsReplacePerTurnKeepTwoLinesAndFade() {
        val cards = HudCards("glasses")
        cards.accept(transcript("t1-you", "user", "帮我点"), 0)
        cards.accept(transcript("t1-her", "assistant", "好的"), 100)
        cards.accept(transcript("t1-her", "assistant", "好的，点哪家？"), 200)
        assertTrue(cards.snapshot(200).isEmpty())
        assertEquals(listOf("帮我点", "好的，点哪家？"), cards.captions().map { it.text })
        assertEquals(listOf(true, false), cards.captions().map { it.mine })
        cards.accept(transcript("t2-you", "user", "奶茶", 2), 300)
        assertEquals(listOf("好的，点哪家？", "奶茶"), captionWindow(cards.captions(), 300).map { it.text })
        assertEquals(1f, captionAlpha(3999), 0f)
        assertEquals(0.5f, captionAlpha(4500), 0.001f)
        assertTrue(captionWindow(cards.captions(), 5299).isNotEmpty()); assertTrue(captionWindow(cards.captions(), 5300).isEmpty())
        val riding = HudState(captions = cards.captions(), ride = JSONObject(), moveAt = 300)
        assertEquals("好的，点哪家？", visibleHud(riding.copy(captions = cards.captions().take(2)), 400).say)
        cards.accept(transcript("r", "assistant", "回复").put("lifetime_ms", 30000).apply { remove("caption") }, 400)
        assertEquals(1, cards.snapshot(400).size)
    }
    @Test fun ambientAndAvatarRequireAnExplicitConfirmationAndBackCancels() {
        val menu = HudScreen.Menu(HudScreen.Idle, touched = 0)
        val ask = reduceHud(menu, HudGesture.Click, paired, 0)
        assertEquals("AMBIENT_ON", ask.action)
        assertEquals(HudScreen.Consent(HudScreen.Idle), ask.screen)
        assertEquals("AMBIENT_CANCEL", reduceHud(ask.screen, HudGesture.Click, paired, 0).action)
        assertEquals("AMBIENT_CANCEL", reduceHud(ask.screen, HudGesture.DoubleClick, paired, 0).action)
        val yes = reduceHud(ask.screen, HudGesture.Forward, paired, 0).screen
        assertEquals("AMBIENT_CONFIRM", reduceHud(yes, HudGesture.Click, paired, 0).action)
        val call = paired.copy(callId = "call")
        val avatar = reduceHud(HudScreen.Menu(HudScreen.Talking, touched = 0), HudGesture.Click, call, 0)
        assertNull(avatar.action)
        assertEquals(HudScreen.Consent(HudScreen.Talking, avatar = true, callId = "call"), avatar.screen)
        assertNull(reduceHud(avatar.screen, HudGesture.Click, call, 0).action)
        val costAccepted = reduceHud(avatar.screen, HudGesture.Forward, call, 0).screen
        assertEquals("AVATAR_ON", reduceHud(costAccepted, HudGesture.Click, call, 0).action)
        assertEquals(HudScreen.Idle, reconcileHud(costAccepted, paired))
        assertEquals(HudScreen.Talking, reconcileHud(costAccepted, call.copy(callId = "next")))
        assertEquals(HudTransition(costAccepted), reduceHud(costAccepted, HudGesture.LongClick, call, 0))
    }

    @Test fun cameraAndAvatarControlsUseTheirOwnReceipts() {
        val call = paired.copy(callId = "call", avatarPhase = "Waiting")
        assertEquals("等待画面", avatarLabel(call))
        assertEquals("开", avatarLabel(call.copy(avatarPhase = "Playing")))
        assertEquals("等待画面", cameraLabel(call))
        assertEquals("开", cameraLabel(call.copy(capture = call.capture.copy(callCameraPublished = true))))
        val off = call.copy(capture = call.capture.copy(callCameraRequested = false))
        assertEquals("关", cameraLabel(off))
        assertEquals("等待关闭", cameraLabel(off.copy(capture = off.capture.copy(callCameraPublished = true))))
        val menu = HudScreen.Menu(HudScreen.Talking, touched = 0)
        assertEquals("AVATAR_OFF", reduceHud(menu, HudGesture.Click, call, 0).action)
        assertEquals("CAMERA", reduceHud(menu.copy(focus = 1), HudGesture.Click, call, 0).action)
        assertEquals(listOf("AVATAR", "CAMERA", "MUTE", "STOP"), hudMenu(call).map { it.action })
    }

}
