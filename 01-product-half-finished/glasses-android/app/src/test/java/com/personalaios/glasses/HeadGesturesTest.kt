package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test

class HeadGesturesTest {
    @Test fun stillnessIsDwellOnly() {
        val detector = HeadGestures()
        val events = (1..250).mapNotNull { detector.sample(it * 20_000_000L, 0f, 0f, 0f) }
        assertEquals(listOf("head_dwell"), events)
    }
    @Test fun oneWayTurnAndRollNeverAnswer() {
        for (rates in listOf(floatArrayOf(1f, 0f, 0f), floatArrayOf(0f, 0f, 1f))) {
            val detector = HeadGestures()
            val events = (1..100).mapNotNull { detector.sample(it * 20_000_000L, rates[0], rates[1], rates[2]) }
            assertTrue(events.isEmpty())
        }
    }
    @Test fun nodAndShakeRequireReturnAndCooldown() {
        for (axis in 0..1) {
            val detector = HeadMotion()
            val events = (1..80).mapNotNull {
                val rate = if (it % 30 in 1..15) 1f else -1f
                detector.sample(it * 20_000_000L, if (axis == 0) rate else 0f, if (axis == 1) rate else 0f, 0f, choice = true)
            }
            assertEquals(listOf(if (axis == 0) "nod" else "shake"), events)
        }
    }
    @Test fun mixedAxisMotionCancelsCandidate() {
        val detector = HeadGestures()
        val events = (1..40).mapNotNull {
            detector.sample(it * 20_000_000L, if (it < 20) 1f else -1f, if (it in 11..15) 2f else 0f, 0f)
        }
        assertTrue(events.isEmpty())
    }
}
