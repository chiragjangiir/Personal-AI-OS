package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class NavPolylineTest {
    @Test fun denseRouteKeepsEndpointsAndSharpTurnUnderBudget() {
        val route = (0..1000).map { i ->
            NavCoordinate(if (i == 501) 0.002 else 0.0, i*0.00001)
        }
        val reduced = NavPolyline.simplify(route)
        assertTrue(reduced.size <= 300)
        assertEquals(route.first(), reduced.first())
        assertEquals(route.last(), reduced.last())
        assertTrue(reduced.contains(route[501]))
    }

    @Test fun budgetUsesGeometricImportanceRatherThanEveryNthPoint() {
        val route = (0..1000).map { i -> NavCoordinate(if (i == 501) 0.002 else 0.0, i*0.00001) }
        val reduced = NavPolyline.simplify(route, 3)
        assertEquals(listOf(route.first(), route[501], route.last()), reduced)
    }

    @Test fun smallAndEmptyRoutesArePreserved() {
        assertEquals(emptyList<NavCoordinate>(), NavPolyline.simplify(emptyList()))
        val route = listOf(NavCoordinate(0.0, 0.0), NavCoordinate(0.0, 0.01))
        assertEquals(route, NavPolyline.simplify(route))
    }
}
