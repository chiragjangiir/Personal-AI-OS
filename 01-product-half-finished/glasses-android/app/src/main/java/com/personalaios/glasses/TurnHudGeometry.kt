package com.personalaios.glasses

import kotlin.math.*

enum class NavTurnHint { LEFT, RIGHT }

data class TurnHudState(
    val routeBearingDegrees: Double,
    val relativeBearingDegrees: Double,
    val ribbonX: Double,
    val ribbonVisible: Boolean,
    val nearManeuver: Boolean,
    val directionDotX: Double,
    val directionDotY: Double,
    /** Clockwise signed sweep from the top of the ring. Zero means no orange arc. */
    val arcSweepDegrees: Double,
    val turnHint: NavTurnHint?,
    val routeProgressMeters: Double
)

object TurnHudGeometry {
    // RayNeo calls X3 Pro's 30° FOV diagonal; its panel is 640×480 (4:3):
    // https://www.rayneo.com/blogs/news/smart-glasses-teleprompter-trade-show-talking-points
    // Derived horizontal = 2 atan(tan(diagonal/2) * 4/5), not a vendor horizontal measurement.
    const val HORIZONTAL_FOV_DEGREES = 24.197582045640598
    const val RIBBON_HALF_WIDTH = 70.0
    const val RING_CENTER_X = 528.0
    const val RING_CENTER_Y = 362.0
    const val RING_RADIUS = 84.0

    /** The movement producer chooses the segment; this only converts its fraction to render-space distance. */
    fun progressAt(route: List<NavCoordinate>, segmentIndex: Int, segmentFraction: Double): Double {
        return (0 until segmentIndex).sumOf { NavMetric.distance(route[it], route[it+1]) } +
            NavMetric.distance(route[segmentIndex], route[segmentIndex+1])*segmentFraction
    }

    /** null means no directional route. Supplied progress resolves crossings and hairpins. */
    fun calculate(
        position: NavCoordinate,
        headingDegrees: Double,
        route: List<NavCoordinate>,
        maneuverDistanceMeters: Double?,
        routeProgressMeters: Double? = null,
        maneuverLocation: NavCoordinate? = null
    ): TurnHudState? {
        if (route.size < 2) return null
        val lengths = route.zipWithNext { a, b -> NavMetric.distance(a, b) }
        val total = lengths.sum()
        if (total == 0.0) return null
        var progress = routeProgressMeters?.coerceAtMost(total)
        if (progress == null) {
            var nearest = Double.POSITIVE_INFINITY; var traversed = 0.0
            var projected = 0.0
            for (i in lengths.indices) {
                val (t, distance) = NavMetric.projection(position, route[i], route[i+1])
                if (distance < nearest) { nearest = distance; projected = traversed + t*lengths[i] }
                traversed += lengths[i]
            }
            progress = projected
        }
        fun at(distance: Double): NavCoordinate {
            var left = distance
            for (i in lengths.indices) {
                if (lengths[i] > 0 && left <= lengths[i])
                    return NavMetric.interpolate(route[i], route[i+1], left/lengths[i])
                left -= lengths[i]
            }
            return route.last()
        }
        val start = at(progress)
        val target = if (maneuverLocation != null && maneuverDistanceMeters != null && maneuverDistanceMeters <= 100)
            maneuverLocation else at((progress+25).coerceAtMost(total))
        // At the destination retain the last nonzero route direction rather than bearing to self.
        val from = if (progress >= total) at((total-25).coerceAtLeast(0.0)) else start
        var (east, north) = NavMetric.xy(target, from)
        // A short out-and-back can put the lookahead on its start. Use the active segment, not false north.
        if (hypot(east, north) < 0.01) {
            var traversed = 0.0
            var active = lengths.indexOfLast { it > 0 }
            for (i in lengths.indices) {
                traversed += lengths[i]
                if (lengths[i] > 0 && traversed > progress) { active = i; break }
            }
            val tangent = NavMetric.xy(route[active+1], route[active])
            east = tangent.first; north = tangent.second
        }
        val bearing = (Math.toDegrees(atan2(east, north)) + 360) % 360
        val delta = wrapDegrees(bearing-headingDegrees)
        val x = 320 + delta*640/HORIZONTAL_FOV_DEGREES
        val visible = x >= RIBBON_HALF_WIDTH && x <= 640-RIBBON_HALF_WIDTH
        val misaligned = abs(delta) > 45
        val hint = if (misaligned || !visible) {
            if (delta < 0) NavTurnHint.LEFT else NavTurnHint.RIGHT
        } else null
        val angle = Math.toRadians(delta)
        return TurnHudState(bearing, delta, x, visible,
            maneuverDistanceMeters != null && maneuverDistanceMeters <= 100,
            RING_CENTER_X + sin(angle)*RING_RADIUS, RING_CENTER_Y - cos(angle)*RING_RADIUS,
            if (misaligned) delta else 0.0, hint, progress)
    }

    fun wrapDegrees(degrees: Double): Double = ((degrees+180)%360+360)%360-180
}
