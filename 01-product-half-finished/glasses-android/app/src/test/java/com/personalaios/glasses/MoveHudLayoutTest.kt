package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class MoveHudLayoutTest {
    private val ride = JSONObject("""{"speed_kmh":7.6,"avg_kmh":6.0,"max_kmh":9.8,"distance_m":1200,"elapsed_s":720,"hr_bpm":91,"hr_zone":1,"kcal":4}""")
    private val nav = JSONObject("""{"maneuver":"left","distance_to_maneuver_m":414,"road":"水印巷","remaining_m":9800,"remaining_s":3240}""")

    private val navigationFix = NavigationFix.fromWire(JSONObject().put("coordinate_system", "wgs84").put("seq", 1)
        .put("position", JSONObject("""{"lat":31.23,"lng":121.47,"accuracy_m":4,"at":"2026-10-18T12:00:00Z"}"""))
        .put("nav", JSONObject(nav.toString()).put("nav_id", "n").put("revision", 1)
            .put("maneuver_location", JSONObject("""{"lat":31.24,"lng":121.48}"""))
            .put("route_segment_index", 0).put("segment_fraction", 0.4)))

    @Test fun allMovementCallCaptionAndTextSizeCombinationsOwnDisjointHudRectangles() {
        for (kind in listOf("ride", "walk_nav", "ride_nav")) for (call in listOf(false, true))
            for (caption in listOf(false, true)) for (large in listOf(false, true)) for (page in 0..1) {
                val state = visibleHud(HudState(paired = true, ride = ride.takeIf { kind != "walk_nav" },
                    nav = nav.takeIf { kind != "ride" }, navigationFix = navigationFix.takeIf { kind != "ride" }, moveAt = 1000, callId = if (call) "call" else null,
                    captions = if (caption) listOf(HudCaption("her", "assistant", 1, "前面左转，我在呢", 1000)) else emptyList()), 1000)
                val layout = moveHudLayout(state, page, large)
                assertEquals(caption, layout.texts.any { it.role == "say" })
                assertFalse(layout.texts.any { it.role in setOf("call_status", "camera", "caption") })
                val rectangles = layout.texts.map { it.role to it.rect } + listOfNotNull(
                    layout.portrait?.let { "portrait" to it }, layout.turnIcon?.let { "turn" to it }, layout.heartIcon?.let { "heart_icon" to it })
                val context = "$kind call=$call caption=$caption large=$large page=$page"
                rectangles.forEachIndexed { i, (name, rect) ->
                    assertTrue("$context $name outside display", rect.x >= 0 && rect.x + rect.width <= 640 && rect.y >= 0 && rect.y + rect.height <= 480)
                    rectangles.drop(i + 1).forEach { (otherName, other) ->
                        assertFalse("$context: $name overlaps $otherName", rect.overlaps(other))
                    }
                }
                if (kind == "ride") {
                    assertNull(layout.miniMap); assertNull(layout.turnCard)
                    rectangles.forEach { (name, rect) -> assertTrue("$context $name outside ride band", rect.y+rect.height <= 162) }
                } else {
                    assertNotNull(layout.portrait)
                    assertEquals(setOf("assistant") + (if (kind == "ride_nav") setOf("speed", "heart") else emptySet()) +
                            if (caption) setOf("say") else emptySet<String>(),
                        layout.texts.filter { it.rect.y < 162 }.map { it.role }.toSet())
                    val card = layout.turnCard!!; val map = layout.miniMap!!
                    assertFalse(card.overlaps(map))
                    // A card contains its own text and icon; only independent regions must be disjoint.
                    val independent = listOf("turn_card" to card, "map" to map,
                        "ribbon" to layout.turnRibbon!!, "distance" to layout.turnDistance!!,
                        "left_hint" to layout.directionHintLeft!!, "right_hint" to layout.directionHintRight!!) +
                        rectangles.filter { (name, _) -> name in setOf("assistant", "say", "portrait", "speed", "heart", "heart_icon") }
                    independent.forEachIndexed { i, (name, rect) ->
                        independent.drop(i+1).forEach { (otherName, other) ->
                            assertFalse("$context: $name overlaps $otherName", rect.overlaps(other))
                        }
                    }
                    rectangles.filter { (name, _) -> name.startsWith("navigation") || name == "turn" }.forEach { (name, rect) ->
                        assertTrue("$context $name outside card", rect.x >= card.x && rect.y >= card.y &&
                            rect.x+rect.width <= card.x+card.width && rect.y+rect.height <= card.y+card.height)
                    }
                }
            }
    }


    @Test fun ridingNavigationRetainsNumbersAndOneStatusOwnerAcrossModesAndPayment() {
        val activity = ActivityCard("work", 1, "event", ActivityPhase.running, "查路线", "读取地图", 1, 0, 0, 0, null)
        for (large in listOf(false, true)) for (mode in listOf("chat", "thinking")) for (navigating in listOf(false, true)) {
            val source = HudState(paired = true, ride = ride, nav = nav.takeIf { navigating }, navigationFix = navigationFix.takeIf { navigating },
                moveAt = 1000, callId = "call", conversation = CallConversation(mode,
                    if (mode == "thinking") "正在核对沿途信息" else null),
                captions = listOf(HudCaption("reply", "assistant", 1, "前面左转，我在呢", 1000)), activities = listOf(activity),
                cards = listOf(HudCard("legacy", "查路线", emptyList(), 1, Long.MAX_VALUE, progress = "1/2",
                    ack = JSONObject().put("processed_event_id", "event"))))
            val visible = visibleHud(source, 1000)
            val screen = reconcileHud(HudScreen.Talking, visible)
            assertTrue(screen is HudScreen.Move)
            assertNull(activityLine(visible, screen, 1000, 1000))
            assertNull(legacyProgressCard(visible, false))
            val layout = moveHudLayout(visible, largeText = large)
            assertEquals("7.6", layout.texts.single { it.role == "speed" }.text)
            assertEquals("91", layout.texts.single { it.role == "heart" }.text)
            assertEquals(1, layout.texts.count { it.role == "call_status" })
            assertEquals(mode == "chat", layout.texts.any { it.role == "say" })
            assertEquals(mode == "thinking", layout.texts.any { it.role == "thinking_status" })
            if (mode == "thinking") assertNull(layout.portrait)
            val regions = layout.texts.map { it.rect } + listOfNotNull(layout.portrait, layout.heartIcon,
                layout.turnIcon, layout.miniMap, layout.turnRibbon, layout.turnDistance,
                layout.directionHintLeft, layout.directionHintRight)
            regions.forEachIndexed { i, rect -> regions.drop(i + 1).forEach { assertFalse(rect.overlaps(it)) } }
            val failedMode = moveHudLayout(visible.copy(conversation = CallConversation(mode),
                conversationError = "请求未送达"), largeText = large)
            assertFalse(failedMode.texts.any { it.role == "say" })
            assertEquals("切换失败：请求未送达", failedMode.texts.single { it.role == "thinking_status" }.text)
            val menu = moveHudLayout(visible, largeText = large, menuOpen = true)
            assertFalse(menu.texts.any { it.role == "thinking_status" })
            assertEquals(navigating, menu.texts.any { it.role == "call_status" })
            assertEquals(mode == "chat", menu.texts.any { it.role == "say" })
            val paying = visibleHud(source.copy(payment = PaymentNotice("pay", "awaiting_owner", 100,
                "商店", null, false, null, Long.MAX_VALUE)), 1000)
            assertEquals(HudScreen.Payment, reconcileHud(screen, paying))
            assertNull(activityLine(paying, HudScreen.Payment, 1000, 1000))
            val locked = visibleHud(source.copy(paymentLock = GlassesLockState(locked = true)), 1000)
            assertEquals(HudScreen.Move(), reconcileHud(screen, locked))
            val lockedLayout = moveHudLayout(locked, largeText = large)
            assertEquals("7.6", lockedLayout.texts.single { it.role == "speed" }.text)
            assertEquals("91", lockedLayout.texts.single { it.role == "heart" }.text)
            assertFalse(lockedLayout.texts.any { it.role in setOf("say", "call_status", "thinking_status") })
            assertNull(activityLine(locked, HudScreen.Move(), 1000, 1000))
        }
    }

    @Test fun worldLockedArrowAndDistanceClearBothBottomCornersAtEveryVisibleHeading() {
        val position = NavCoordinate(30.0, 120.0)
        val target = NavCoordinate(30.001, 120.0)
        for (rideState in listOf(null, ride)) for (large in listOf(false, true)) for (page in 0..1) {
            val layout = moveHudLayout(HudState(nav = nav, ride = rideState), page, large)
            for (heading in -180..180) for (distance in listOf(30.0, 101.0)) {
                val geometry = TurnHudGeometry.calculate(position, heading.toDouble(), listOf(position, target),
                    distance, 0.0, target)!!
                if (!geometry.ribbonVisible) continue
                val x = geometry.ribbonX.toInt()
                val arrow = layout.turnRibbon!!.copy(x = x-34, width = 68)
                val meters = layout.turnDistance!!.copy(x = x-70, width = 140)
                val map = layout.miniMap!!
                // Ring dot radius and stroke extend five pixels beyond its capture rectangle.
                val mapInk = HudTextRect(map.x-5, map.y-5, map.width+10, map.height+10)
                for (bottom in listOf(mapInk, layout.turnCard!!)) {
                    assertFalse("heading=$heading distance=$distance arrow", arrow.overlaps(bottom))
                    if (geometry.nearManeuver) assertFalse("heading=$heading meters", meters.overlaps(bottom))
                }
                assertTrue(arrow.x >= 0 && arrow.x+arrow.width <= 640)
                assertTrue(meters.x >= 0 && meters.x+meters.width <= 640)
            }
        }
    }

    @Test fun walkingUsesLatestHerCaptionWithOriginalFadeAndDefersOrdinaryCards() {
        val captions = listOf(HudCaption("old", "assistant", 1, "旧回复", 0), HudCaption("new", "assistant", 2, "新回复", 2000))
        val card = HudCard("message", "消息", listOf("稍后看"), 1, 100000)
        val state = HudState(paired = true, nav = nav, moveAt = 2000, captions = captions,
            say = "旧播报", sayAt = 1000, cards = listOf(card))
        val visible = visibleHud(state, 6500)
        assertEquals("新回复", visible.say); assertEquals(2000, visible.sayAt)
        assertEquals(.5f, captionAlpha(6500 - visible.sayAt), .001f)
        assertTrue(visible.cards.isEmpty())
        assertNull(visibleHud(state, 7000).say)
        assertNull(visibleHud(state.copy(captions = captions + HudCaption("you", "user", 3, "嗯", 7000)), 7000).say)
        assertTrue(visibleHud(state, 12000).cards.isEmpty())
    }

    @Test fun pendingMeasurementAndStaleNavigationShowWaitingWithoutFalseValuesOrArrows() {
        val ridePending = moveHudLayout(HudState(ride = JSONObject()))
        assertEquals("—", ridePending.texts.single { it.role == "speed" }.text)
        assertEquals("—", ridePending.texts.single { it.role == "middle" }.text)
        assertEquals("等待骑行数据", ridePending.texts.single { it.role == "middle_detail" }.text)
        for (rideState in listOf(null, JSONObject())) {
            val waiting = moveHudLayout(HudState(ride = rideState, nav = JSONObject()))
            assertEquals("等待定位", waiting.texts.single { it.role == "navigation" }.text)
            assertNull(waiting.turnIcon); assertNull(waiting.turnRibbon); assertNull(waiting.miniMap)
            assertFalse(waiting.texts.any { it.role in setOf("navigation_road", "navigation_detail") })
        }
    }

    @Test fun navigationOnlyUpdatesRetainNumbersWithoutRenewingRideFreshnessAndReconnectRestoresThem() {
        val start = navigationFix.sampleTime
        fun update(at: Long) = JSONObject().put("operation", "move_hud").put("kind", "ride_nav")
            .put("coordinate_system", "wgs84").put("seq", at - start)
            .put("position", JSONObject().put("lat", 31.23).put("lng", 121.47).put("accuracy_m", 4)
                .put("at", Instant.ofEpochMilli(at).toString()))
            .put("nav", JSONObject(nav.toString()).put("nav_id", "n").put("revision", 1)
                .put("maneuver_location", JSONObject().put("lat", 31.24).put("lng", 121.48))
                .put("route_segment_index", 0).put("segment_fraction", 0.4))
        val initial = HudState(paired = true).move(update(start).put("ride", ride), start)
        for (age in listOf(9999L, 10000L, 59999L, 60000L)) {
            val source = initial.move(update(start + age), start + age)
            assertSame(initial.ride, source.ride)
            assertEquals(start, source.rideAt)
            val visible = visibleHud(source, start + age)
            assertNotNull(visible.navigationFix)
            val layout = moveHudLayout(visible)
            assertEquals(if (age < 60000) "7.6" else "—", layout.texts.single { it.role == "speed" }.text)
            assertEquals(if (age < 60000) "91" else "—", layout.texts.single { it.role == "heart" }.text)
        }
        val disconnected = visibleHud(initial, start + 10000)
        assertNull(disconnected.navigationFix)
        val waiting = moveHudLayout(disconnected)
        assertEquals("等待定位", waiting.texts.single { it.role == "navigation" }.text)
        assertEquals("7.6", waiting.texts.single { it.role == "speed" }.text)
        assertNull(waiting.miniMap); assertNull(waiting.turnRibbon)
        val reconnected = initial.move(update(start + 61000).put("ride", ride), start + 61000)
        assertEquals(start + 61000, reconnected.rideAt)
        val layout = moveHudLayout(visibleHud(reconnected, start + 61000))
        assertEquals("7.6", layout.texts.single { it.role == "speed" }.text)
        assertEquals("91", layout.texts.single { it.role == "heart" }.text)
        assertNotNull(layout.miniMap); assertNotNull(layout.turnRibbon)
    }

    @Test fun phoneUnavailableHintIsSpecificAndInterruptsMovementWithoutAGenericError() {
        for (operation in listOf("ride_control", "nav_control")) {
            val packet = JSONObject().put("request_operation", operation).put("error_code", "PHONE_NOT_CONNECTED")
            val hint = movementRejectionHint(packet)!!
            assertEquals("打开手机上的依米，导航会自动开始", hint)
            val cards = HudCards("glasses").notice(1000, text = hint, priority = 2)
            val state = visibleHud(HudState(paired = true, ride = ride, nav = nav, moveAt = 1000, cards = cards), 1000)
            assertEquals(listOf(hint), state.cards.single().lines)
            assertEquals(HudScreen.Card("request-notice"), reconcileHud(HudScreen.Move(), state, true))
        }
        assertNull(movementRejectionHint(JSONObject().put("request_operation", "call_open").put("error_code", "PHONE_NOT_CONNECTED")))
        assertNull(movementRejectionHint(JSONObject().put("request_operation", "ride_control").put("error_code", "FORBIDDEN")))
    }
}
