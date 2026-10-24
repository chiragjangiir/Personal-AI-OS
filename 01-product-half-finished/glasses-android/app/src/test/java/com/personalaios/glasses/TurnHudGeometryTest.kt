package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class TurnHudGeometryTest {
    private val origin = NavCoordinate(0.0, 0.0)
    private val north = listOf(origin, NavCoordinate(0.01, 0.0))
    private fun state(heading: Double, distance: Double? = 100.0) =
        TurnHudGeometry.calculate(origin, heading, north, distance)!!

    @Test fun worldLockedRibbonUsesOpticalFovAndWrapsNorth() {
        assertEquals(320.0, state(0.0).ribbonX, 0.00001)
        val turned = state(355.0)
        assertEquals(5.0, turned.relativeBearingDegrees, 0.00001)
        assertEquals(320 + 5*640/TurnHudGeometry.HORIZONTAL_FOV_DEGREES, turned.ribbonX, 0.00001)
        assertTrue(turned.ribbonVisible)
        assertTrue(TurnHudGeometry.HORIZONTAL_FOV_DEGREES in 24.0..24.3)
    }

    @Test fun arrowFootprintHidesBeforeCenterExitsViewAndStillGivesHint() {
        val edge = state(350.0)
        assertEquals(10.0, edge.relativeBearingDegrees, 0.00001)
        assertFalse(edge.ribbonVisible)
        assertEquals(NavTurnHint.RIGHT, edge.turnHint)
        assertEquals(0.0, edge.arcSweepDegrees, 0.0)
    }

    @Test fun largeMismatchUsesSignedOrangeArcAndRingDirectionDot() {
        val right = state(270.0)
        assertEquals(90.0, right.arcSweepDegrees, 0.00001)
        assertEquals(612.0, right.directionDotX, 0.00001)
        assertEquals(362.0, right.directionDotY, 0.00001)
        assertEquals(NavTurnHint.RIGHT, right.turnHint)
        val left = state(90.0)
        assertEquals(-90.0, left.arcSweepDegrees, 0.00001)
        assertEquals(444.0, left.directionDotX, 0.00001)
        assertEquals(NavTurnHint.LEFT, left.turnHint)
    }

    @Test fun nearManeuverIncludes100MetersOnly() {
        assertTrue(state(0.0, 100.0).nearManeuver)
        assertFalse(state(0.0, 100.01).nearManeuver)
        assertFalse(state(0.0, null).nearManeuver)
    }

    @Test fun bearingStartsFromNearestProjectedProgressNotOldRouteStart() {
        val route = listOf(origin, NavCoordinate(0.001, 0.0), NavCoordinate(0.001, 0.001))
        val result = TurnHudGeometry.calculate(NavCoordinate(0.001, 0.0005), 90.0, route, 20.0)!!
        assertEquals(90.0, result.routeBearingDegrees, 0.00001)
        assertEquals(320.0, result.ribbonX, 0.00001)
        assertTrue(result.routeProgressMeters > 160)
    }

    @Test fun lookaheadWalks25MetersAlongSegments() {
        val tenMeters = 10 / NavMetric.METERS_PER_DEGREE
        val route = listOf(origin, NavCoordinate(tenMeters, 0.0), NavCoordinate(tenMeters, 0.001))
        val result = TurnHudGeometry.calculate(origin, 0.0, route, 20.0)!!
        assertEquals(Math.toDegrees(kotlin.math.atan2(15.0, 10.0)), result.routeBearingDegrees, 0.00001)
    }

    @Test fun suppliedProgressResolvesHairpinAtSamePhysicalPosition() {
        val tip = NavCoordinate(0.001, 0.0)
        val route = listOf(origin, tip, origin)
        val result = TurnHudGeometry.calculate(tip, 180.0, route, 10.0,
            NavMetric.distance(origin, tip) + 10)!!
        assertEquals(180.0, result.routeBearingDegrees, 0.00001)
        assertEquals(320.0, result.ribbonX, 0.00001)
    }

    @Test fun authoritativeSegmentFractionResolvesCrossingsInRenderCoordinates() {
        val tip = NavCoordinate(0.001, 0.0)
        val route = listOf(origin, tip, origin)
        val progress = TurnHudGeometry.progressAt(route, 1, 0.1)
        val result = TurnHudGeometry.calculate(tip, 180.0, route, 10.0, progress)!!
        assertEquals(180.0, result.routeBearingDegrees, 0.00001)
        assertTrue(result.routeProgressMeters > NavMetric.distance(origin, tip))
    }

    @Test fun routeWithoutDirectionHasNoHudGeometry() {
        assertNull(TurnHudGeometry.calculate(origin, 0.0, emptyList(), null))
        assertNull(TurnHudGeometry.calculate(origin, 0.0, listOf(origin, origin), null))
    }

    @Test fun shortOutAndBackUsesCurrentSegmentInsteadOfFalseNorth() {
        val east = NavCoordinate(0.0, 12.5/NavMetric.METERS_PER_DEGREE)
        val route = listOf(origin, east, origin)
        val start = TurnHudGeometry.calculate(origin, 90.0, route, 12.5, 0.0)!!
        assertEquals(90.0, start.routeBearingDegrees, 0.00001)
        val end = TurnHudGeometry.calculate(origin, 270.0, route, 0.0, 25.0)!!
        assertEquals(270.0, end.routeBearingDegrees, 0.00001)
    }
}
