package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NavigationWireTest {
    @Test fun navigationFreshnessUsesServerEpochWhileDisplayDeadlinesUseMonotonicTime() {
        val epoch = java.time.Instant.parse("2026-10-18T12:00:00Z").toEpochMilli()
        val state = HudState().move(fix(), now = 1000, serverNow = epoch)
        assertNotNull(visibleHud(state, now = 1001, serverNow = epoch + 1).navigationFix)
        assertNull(visibleHud(state, now = 1002, serverNow = epoch + 10000).navigationFix)
        assertNull(visibleHud(state, now = 11000, serverNow = epoch + 1).navigationFix)
    }
    private fun route(revision: Int = 1) = JSONObject("""{"operation":"nav_route","coordinate_system":"wgs84","nav_id":"n","revision":$revision,"steps":[{"polyline":[{"lat":31.23,"lng":121.47},{"lat":31.231,"lng":121.47}]},{"polyline":[{"lat":31.231,"lng":121.47},{"lat":31.232,"lng":121.47}]}]}""")
    private fun fix(distance: Int = 101) = JSONObject("""{"operation":"move_hud","kind":"walk_nav","coordinate_system":"wgs84","seq":9,"position":{"lat":31.23,"lng":121.47,"accuracy_m":3,"course_deg":90,"at":"2026-10-18T12:00:00Z"},"nav":{"nav_id":"n","revision":1,"maneuver":"right","maneuver_location":{"lat":31.231,"lng":121.47},"distance_to_maneuver_m":$distance,"route_segment_index":0,"segment_fraction":0.5}}""")
    private val heading = HeadingSample(0f, HeadingAccuracy.HIGH, 1)

    @Test fun routeAndFixReachMapWithOneConversionAndAuthoritativeProgress() {
        val hud = HudState().move(route(), 0).move(fix(), 10)
        val line = hud.navigationRoute!!
        assertEquals(4, line.points.size)
        assertEquals(line.points[1], line.points[2]) // Never simplify the authority's segment numbering.
        assertEquals(NavCoordinate.fromWgs84(31.23, 121.47), line.points[0])
        val gps = hud.navigationFix!!
        assertEquals(31.23, gps.latitude, 0.0)
        assertEquals(1792324800000L, gps.sampleTime)
        assertEquals(9L, gps.sequence)
        assertEquals(90.0, gps.course!!, 0.0)
        val map = gps.mapState(line, heading, MiniMapStyle.ROUTE_ONLY)!!
        assertEquals(line.points[0], map.position)
        assertEquals(MiniMapStyle.ROUTE_ONLY, map.style)
        assertEquals(TurnHudGeometry.progressAt(line.points, 0, .5), map.routeProgressMeters!!, .001)
        assertEquals(NavTurn.RIGHT, map.nextManeuver!!.turn)
        assertNull(gps.mapState(NavigationRoute.fromWire(route(2)), heading, MiniMapStyle.STREETS))
    }

    @Test fun exactHundredMeterSwitchAndCompassHintFollowInput() {
        val line = NavigationRoute.fromWire(route())
        fun state(meters: Int) = NavigationFix.fromWire(fix(meters)).mapState(line, heading, MiniMapStyle.STREETS)!!
        assertFalse(state(101).geometry()!!.nearManeuver)
        assertTrue(state(100).geometry()!!.nearManeuver)
        val unreliable = NavigationFix.fromWire(fix()).mapState(line,
            heading.copy(accuracy = HeadingAccuracy.UNRELIABLE), MiniMapStyle.STREETS)!!
        assertTrue(unreliable.compassUnreliable)
        val stale = visibleHud(HudState().move(route(), 0).move(fix(), 0), 10000)
        assertEquals(0, stale.nav!!.length()); assertNull(stale.navigationFix)
        assertNull(moveHudLayout(stale).turnIcon)
    }

    @Test fun navigationOnlyUpdatesKeepRidingValuesWithoutRenewingTheirFreshness() {
        val start = 1792324800000L
        val metrics = JSONObject("""{"speed_kmh":18.4,"hr_bpm":121}""")
        val original = HudState(paired = true).move(fix().put("kind", "ride_nav").put("ride", metrics), start)
        val update = fix().put("kind", "ride_nav")
        val after = original.move(update, start + 9000)
        assertSame(metrics, visibleHud(after, start + 9999).ride)
        assertEquals(start, after.rideAt)
        assertEquals(start + 9000, after.moveAt)
        val waitingForFix = visibleHud(after, start + 10000)
        assertSame(metrics, waitingForFix.ride)
        assertEquals(0, waitingForFix.nav!!.length())
        assertNull(waitingForFix.navigationFix)
        val waitingLayout = moveHudLayout(waitingForFix)
        assertEquals("18.4", waitingLayout.texts.single { it.role == "speed" }.text)
        assertEquals("121", waitingLayout.texts.single { it.role == "heart" }.text)
        assertNull(waitingLayout.miniMap); assertNull(waitingLayout.turnRibbon)
        val expired = after.move(update, start + 60000)
        assertEquals(0, visibleHud(expired, start + 60000).ride!!.length())
        val resumed = expired.move(fix().put("kind", "ride_nav").put("ride", metrics), start + 61000)
        assertSame(metrics, visibleHud(resumed, start + 61000).ride)
        assertEquals(start + 61000, resumed.rideAt)
        assertNull(resumed.move(fix(), start + 62000).ride) // Explicit walking mode ends the riding display.
    }

    private fun overview(show: Boolean = true, alternate: Boolean = true, selected: Int = 0) = route()
        .put("destination", JSONObject().put("name", "西湖")).put("mode", "bicycling")
        .put("total_m", 10700).put("total_s", 3420).put("overview", JSONObject()
            .put("version", 1).put("selected", selected).put("show", show).put("alternatives", org.json.JSONArray().apply {
                if (alternate) put(JSONObject().put("total_m", 12000).put("total_s", 3840)
                    .put("polyline", org.json.JSONArray("""[{"lat":31.23,"lng":121.47},{"lat":31.231,"lng":121.472},{"lat":31.232,"lng":121.47}]""")))
            }))

    @Test fun overviewStartsOnReceiptWithoutFixExpiresAndSwitchRestartsIt() {
        val state = HudState(paired = true).move(overview(), 100)
        assertTrue(reconcileHud(HudScreen.Idle, visibleHud(state, 100)) is HudScreen.Move)
        assertEquals(HudTextRect(110, 214, 420, 230), moveHudLayout(visibleHud(state, 2099)).miniMap)
        assertEquals("去西湖 · 骑行 57 分钟 · 10.7 公里", moveHudLayout(state).texts.first().text)
        assertEquals(NavCoordinate.fromWgs84(31.231, 121.472), state.navigationRoute!!.overview!!.alternatives.single().points[1])
        assertEquals("等待定位", moveHudLayout(visibleHud(state, 2100)).texts.single { it.role == "navigation" }.text)
        assertEquals(2100L, state.move(overview(show = false), 500).routeOverviewUntil)
        val switched = state.move(overview(selected = 1), 1000)
        assertEquals(3000L, switched.routeOverviewUntil)
        assertEquals("路线二（已选）", moveHudLayout(switched).texts.single { it.role == "overview_selected" }.text)
    }

    @Test fun movementCollapsesOverviewAndOnlyAvailableAlternateCanSwitch() {
        val start = 1792324800000L
        val state = HudState(paired = true).move(overview(), start).move(fix(), start)
        val jitter = fix().apply { getJSONObject("position").put("lat", 31.230001).put("at", "2026-10-18T12:00:01Z") }
        assertTrue(state.move(jitter, start+1000).routeOverviewUntil > 0)
        val moving = fix().apply { getJSONObject("position").put("lat", 31.230014).put("at", "2026-10-18T12:00:01Z") }
        val walking = state.move(moving, start+1000)
        assertEquals(0L, walking.routeOverviewUntil)
        assertEquals(0L, walking.move(overview(selected = 1), start+1100).routeOverviewUntil)
        val stopped = fix().apply { getJSONObject("position").put("lat", 31.230014).put("at", "2026-10-18T12:00:02Z") }
        assertEquals(start+4200, walking.move(stopped, start+2000).move(overview(selected = 1), start+2200).routeOverviewUntil)
        val ride = fix().put("kind", "ride_nav").put("ride", JSONObject().put("speed_kmh", 2.0))
        assertEquals(0L, state.move(ride, start+500).routeOverviewUntil)
        val riding = state.move(ride, start+500)
        assertEquals(0L, riding.move(overview(selected = 1), start+600).routeOverviewUntil)
        assertEquals(start+12000, riding.move(overview(selected = 1), start+10000).routeOverviewUntil)
        assertTrue(state.move(moving.apply { getJSONObject("position").put("at", "2026-10-18T11:59:59Z") }, start+1000).routeOverviewUntil > 0)
        for (gesture in listOf(HudGesture.Forward, HudGesture.Backward)) {
            assertEquals("NAV_SWITCH", reduceHud(HudScreen.Move(), gesture, state, start).action)
            assertNull(reduceHud(HudScreen.Move(), gesture, state.move(overview(alternate = false), start), start).action)
        }
        val solo = moveHudLayout(state.move(overview(alternate = false), start))
        assertFalse(solo.texts.any { it.role == "overview_alternative" || it.text.contains("换一条") })
    }

    @Test fun mapConsentRequiresExplicitChoiceAndCancelKeepsRoute() {
        val screen = HudScreen.Consent(HudScreen.Move(), navigation = true)
        assertEquals("MAP_DECLINE", reduceHud(screen, HudGesture.Click, HudState(), 0).action)
        assertEquals("MAP_DECLINE", reduceHud(screen, HudGesture.DoubleClick, HudState(), 0).action)
        assertEquals("MAP_AGREE", reduceHud(screen.copy(focus = 1), HudGesture.Click, HudState(), 0).action)
    }
}
