package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class NavCoordinateTest {
    @Test fun beijingMatchesGatewayGcjTransform() {
        val gcj = NavCoordinate.fromWgs84(39.908823, 116.397470)
        assertEquals(39.91022649807321, gcj.latitude, 0.000000001)
        assertEquals(116.4037135824225, gcj.longitude, 0.000000001)
    }

    @Test fun outsideChinaIsUnchanged() {
        assertEquals(NavCoordinate(37.7749, -122.4194), NavCoordinate.fromWgs84(37.7749, -122.4194))
    }

    @Test(expected = IllegalArgumentException::class)
    fun invalidExternalCoordinateIsRejected() { NavCoordinate.fromWgs84(Double.NaN, 0.0) }
}
