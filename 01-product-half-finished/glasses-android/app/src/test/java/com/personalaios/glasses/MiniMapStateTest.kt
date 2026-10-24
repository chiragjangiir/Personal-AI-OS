package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class MiniMapStateTest {
    private val origin = NavCoordinate(30.0, 120.0)
    private fun state(heading: Double) = MiniMapState(origin, 4.0, heading, listOf(origin, NavCoordinate(30.001, 120.0)))
    @Test fun userStaysBelowCenterAndPointsAhead() {
        for (heading in listOf(0.0, 90.0, 180.0, 359.0)) {
            assertEquals(Pair(528f, 382f), miniMapPoint(origin, state(heading), 1.0))
        }
    }
    @Test fun turningEastMovesNorthRouteToLeft() {
        val north = NavCoordinate(30.0002, 120.0)
        val forward = miniMapPoint(north, state(0.0), 1.0)
        val east = miniMapPoint(north, state(90.0), 1.0)
        assertEquals(528f, forward.first, 0.001f); assertTrue(forward.second < 382f)
        assertTrue(east.first < 528f); assertEquals(382f, east.second, 0.001f)
    }
    @Test fun maneuverThresholdAndHeadingDriveOneRenderState() {
        val next = NavManeuver(NavCoordinate(30.001, 120.0), 100.0, NavTurn.RIGHT)
        val frame = state(90.0).copy(nextManeuver = next)
        val g = frame.geometry()!!
        assertTrue(g.nearManeuver); assertFalse(g.ribbonVisible)
        assertEquals(NavTurnHint.LEFT, g.turnHint)
    }
    @Test fun nearTurnTargetsJunctionInsteadOfTheRoadBeyondIt() {
        val junction = NavCoordinate(30.00009, 120.0)
        val exit = NavCoordinate(30.00009, 120.001)
        val frame = MiniMapState(origin, 4.0, 0.0, listOf(origin, junction, exit),
            NavManeuver(junction, 10.0, NavTurn.RIGHT))
        val g = frame.geometry()!!
        assertTrue(g.nearManeuver); assertTrue(g.ribbonVisible)
        assertEquals(320.0, g.ribbonX, 0.001)
    }
}
