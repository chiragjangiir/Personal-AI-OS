package com.personalaios.glasses

import kotlin.math.abs

/** Motion candidates, not identity or consent. Axes must be checked on the worn device. */
class HeadGestures {
    private var start = 0L
    private var last = 0L
    private var cooldown = 0L
    private var axis = -1
    private var sign = 0
    private var reversed = false
    private var excursion = 0.0
    private var stillSince = 0L
    private var dwellSent = false

    fun reset() {
        start = 0; last = 0; cooldown = 0; axis = -1; sign = 0
        reversed = false; excursion = 0.0; stillSince = 0; dwellSent = false
    }

    fun sample(timeNs: Long, x: Float, y: Float, z: Float): String? {
        val dt = if (last == 0L) 0.0 else (timeNs - last) / 1e9
        last = timeNs
        if (dt !in 0.0..0.2) { axis = -1; stillSince = 0; return null }
        val rates = floatArrayOf(x, y, z)
        val peak = rates.indices.maxBy { abs(rates[it]) }
        if (rates.all { abs(it) < 0.08f }) {
            if (stillSince == 0L) stillSince = timeNs
            if (!dwellSent && timeNs - stillSince >= 2_000_000_000L) {
                dwellSent = true
                return "head_dwell"
            }
        } else { stillSince = 0; dwellSent = false }
        if (timeNs < cooldown) return null
        if (axis < 0 && peak < 2 && abs(rates[peak]) > 0.5f) {
            axis = peak; sign = if (rates[peak] > 0) 1 else -1
            start = timeNs; excursion = 0.0; reversed = false
        }
        if (axis < 0) return null
        if (timeNs - start > 1_500_000_000L || (peak != axis && abs(rates[peak]) > 0.5f)) {
            axis = -1
            return null
        }
        val rate = rates[axis]
        excursion += rate * dt
        if (rate * sign < -0.5f && abs(excursion) > 0.12) reversed = true
        if (reversed && abs(excursion) < 0.08 && timeNs - start > 250_000_000L) {
            val candidate = if (axis == 0) "nod" else "shake"
            axis = -1; cooldown = timeNs + 2_000_000_000L
            return candidate
        }
        return null
    }
}
