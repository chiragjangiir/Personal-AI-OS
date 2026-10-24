package com.personalaios.glasses

import kotlin.math.abs

/** IMU memory triggers and foreground choice gestures share the same detector. */
class HeadMotion {
    private val gestures = HeadGestures()
    private var last = 0L
    private var stillSince = 0L
    private var dwellSent = false
    private var excursion = 0.0
    private var sceneSent = 0L
    fun reset() { last = 0; stillSince = 0; dwellSent = false; excursion = 0.0; sceneSent = 0; gestures.reset() }
    fun sample(timeNs: Long, x: Float, y: Float, z: Float, choice: Boolean = false): String? {
        if (choice) return gestures.sample(timeNs, x, y, z)
        val dt = if (last == 0L) 0.0 else (timeNs - last) / 1e9
        last = timeNs
        if (dt !in 0.0..0.2) { stillSince = 0; excursion = 0.0; return null }
        val peak = maxOf(abs(x), abs(y), abs(z))
        if (peak < 0.08f) {
            excursion = 0.0
            if (stillSince == 0L) stillSince = timeNs
            if (!dwellSent && timeNs - stillSince >= 2_000_000_000L) { dwellSent = true; return "head_dwell" }
        } else {
            stillSince = 0; dwellSent = false; excursion += peak * dt
            if (excursion > 0.5 && timeNs - sceneSent > 2_000_000_000L) {
                excursion = 0.0; sceneSent = timeNs; return "scene_change"
            }
        }
        return null
    }
}
