package com.personalaios.glasses

import kotlin.math.*

enum class MiniMapStyle { STREETS, ROUTE_ONLY }
enum class NavTurn { STRAIGHT, LEFT, RIGHT, UTURN, ARRIVE }
data class NavManeuver(val location: NavCoordinate, val distanceMeters: Double, val turn: NavTurn)

/** Every coordinate here is GCJ-02. Convert WGS84 once before constructing this render input. */
data class MiniMapState(
    val position: NavCoordinate,
    val accuracyMeters: Double,
    val headingDegrees: Double,
    /** Original immutable route. Only the displayed polyline is reduced to 300 points. */
    val route: List<NavCoordinate>,
    val nextManeuver: NavManeuver? = null,
    val style: MiniMapStyle = MiniMapStyle.STREETS,
    /** Distance along this exact GCJ-02 route, normally from TurnHudGeometry.progressAt. */
    val routeProgressMeters: Double? = null,
    val compassUnreliable: Boolean = false,
    val overview: RouteOverview? = null, val overviewVisible: Boolean = false
) {
    fun geometry() = TurnHudGeometry.calculate(position, headingDegrees, route,
        nextManeuver?.distanceMeters, routeProgressMeters, nextManeuver?.location)
}

/** Heading-up projection, shared by the route-only path and its accuracy circle. */
internal fun miniMapPoint(point: NavCoordinate, state: MiniMapState, metersPerPixel: Double): Pair<Float, Float> {
    val (east, north) = NavMetric.xy(point, state.position)
    val h = Math.toRadians(state.headingDegrees)
    return Pair((528 + (east*cos(h)-north*sin(h))/metersPerPixel).toFloat(),
        (382 - (east*sin(h)+north*cos(h))/metersPerPixel).toFloat())
}
