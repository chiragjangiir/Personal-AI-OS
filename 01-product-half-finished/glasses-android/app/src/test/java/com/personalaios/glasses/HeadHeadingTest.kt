package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class HeadHeadingTest {
    // Build an orthonormal device-to-world rotation from viewing bearing/pitch and head roll.
    private fun matrix(bearing: Double, pitch: Double = 0.0, roll: Double = 0.0): FloatArray {
        val b = Math.toRadians(bearing); val p = Math.toRadians(pitch); val r = Math.toRadians(roll)
        val forward = doubleArrayOf(sin(b) * cos(p), cos(b) * cos(p), sin(p))
        val right = doubleArrayOf(cos(b), -sin(b), 0.0)
        val up = doubleArrayOf(-sin(b) * sin(p), -cos(b) * sin(p), cos(p))
        return FloatArray(9) { i ->
            val row = i / 3
            when (i % 3) {
                0 -> (right[row] * cos(r) + up[row] * sin(r)).toFloat()
                1 -> (-right[row] * sin(r) + up[row] * cos(r)).toFloat()
                else -> -forward[row].toFloat()
            }
        }
    }

    @Test fun viewingDirectionUsesMinusZForAllCardinalBearings() {
        listOf(0.0, 90.0, 180.0, 270.0).forEach {
            assertEquals(it, HeadingMath.magneticBearing(matrix(it))!!, 0.0001)
        }
    }

    @Test fun pitchAndRollDoNotCreateFalseTurns() {
        listOf(-70.0, -25.0, 0.0, 50.0, 75.0).forEach { pitch ->
            listOf(-120.0, -45.0, 0.0, 65.0, 180.0).forEach { roll ->
                assertEquals(133.0, HeadingMath.magneticBearing(matrix(133.0, pitch, roll))!!, 0.0001)
            }
        }
        assertNull(HeadingMath.magneticBearing(matrix(30.0, 90.0)))
    }

    @Test fun smoothingCrossesNorthByShortestArc() {
        val forward = HeadingSmoother()
        forward.sample(359.0, 1_000_000_000)
        val next = forward.sample(1.0, 1_100_000_000)!!
        assertTrue(next > 359f || next < 1f)
        val reverse = HeadingSmoother()
        reverse.sample(1.0, 1_000_000_000)
        val back = reverse.sample(359.0, 1_100_000_000)!!
        assertTrue(back > 359f || back < 1f)
    }

    @Test fun smoothingDependsOnElapsedTimeRatherThanSamplingRate() {
        val slow = HeadingSmoother(); val fast = HeadingSmoother()
        slow.sample(0.0, 1_000_000_000); fast.sample(0.0, 1_000_000_000)
        val expected = slow.sample(90.0, 1_200_000_000)!!
        fast.sample(90.0, 1_100_000_000)
        assertEquals(expected, fast.sample(90.0, 1_200_000_000)!!, 0.0001f)
    }

    @Test fun staleSamplesCannotChangeFilterStateAndResetStartsFresh() {
        val filter = HeadingSmoother()
        assertEquals(20f, filter.sample(20.0, 2_000_000_000)!!, 0f)
        assertNull(filter.sample(200.0, 1_000_000_000))
        assertNull(filter.sample(200.0, 2_000_000_000))
        assertEquals(20f, filter.sample(20.0, 3_000_000_000)!!, 0f)
        filter.reset()
        assertEquals(270f, filter.sample(-90.0, 1_000_000_000)!!, 0f)
    }

    @Test fun unknownAccuracyNeverRequestsCalibration() {
        assertEquals(HeadingAccuracy.UNKNOWN, HeadingMath.accuracy(-1))
        assertEquals(HeadingAccuracy.UNRELIABLE, HeadingMath.accuracy(0))
        HeadingAccuracy.values().forEach {
            assertEquals(it == HeadingAccuracy.UNRELIABLE, HeadingSample(0f, it, 1).shouldCalibrate)
        }
    }

    @Test fun fusedAccuracyPreservesExplicitMagnetometerWarnings() {
        val high = HeadingAccuracy.HIGH; val unknown = HeadingAccuracy.UNKNOWN
        val unreliable = HeadingAccuracy.UNRELIABLE
        assertEquals(high, HeadingMath.fusedAccuracy(high, unknown))
        assertEquals(high, HeadingMath.fusedAccuracy(unknown, high))
        assertEquals(unknown, HeadingMath.fusedAccuracy(unknown, unknown))
        assertEquals(unreliable, HeadingMath.fusedAccuracy(high, unreliable))
        assertEquals(unreliable, HeadingMath.fusedAccuracy(unreliable, high))
        assertEquals(HeadingAccuracy.LOW, HeadingMath.fusedAccuracy(high, HeadingAccuracy.LOW))
        assertEquals(HeadingAccuracy.MEDIUM, HeadingMath.fusedAccuracy(HeadingAccuracy.MEDIUM, high))
    }
}
