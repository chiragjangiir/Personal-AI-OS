package com.personalaios.glasses

import org.json.JSONObject
import java.time.Instant

/** WGS84 exists only at the wire/sensor boundary. Render coordinates are converted once per hop. */
data class RouteAlternative(val totalMeters: Double, val totalSeconds: Double, val points: List<NavCoordinate>)
data class RouteOverview(val selected: Int, val alternatives: List<RouteAlternative>, val show: Boolean)
data class NavigationRoute(val id: String, val revision: Int, val points: List<NavCoordinate>,
    val totalMeters: Double = 0.0, val totalSeconds: Double = 0.0, val overview: RouteOverview? = null,
    val destination: String = "", val mode: String = "walking") {
    fun overviewMap() = MiniMapState(points.first(), 0.0, 0.0, points, style = MiniMapStyle.ROUTE_ONLY,
        overview = overview, overviewVisible = true)
    companion object {
        fun fromWire(message: JSONObject): NavigationRoute {
            require(message.getString("coordinate_system") == "wgs84")
            val steps = message.getJSONArray("steps")
            val points = (0 until steps.length()).flatMap { index ->
                val line = steps.getJSONObject(index).getJSONArray("polyline")
                (0 until line.length()).map { line.getJSONObject(it).renderCoordinate() }
            }
            val overview = message.optJSONObject("overview")?.let { value ->
                require(value.getInt("version") == 1)
                val selected = value.getInt("selected"); require(selected in 0..1)
                val alternatives = value.getJSONArray("alternatives"); require(alternatives.length() <= 1)
                RouteOverview(selected, (0 until alternatives.length()).map { i ->
                    val route = alternatives.getJSONObject(i); val line = route.getJSONArray("polyline")
                    RouteAlternative(route.getDouble("total_m"), route.getDouble("total_s"),
                        (0 until line.length()).map { line.getJSONObject(it).renderCoordinate() })
                }, value.getBoolean("show"))
            }
            return NavigationRoute(message.getString("nav_id"), message.getInt("revision"), points,
                message.optDouble("total_m", 0.0), message.optDouble("total_s", 0.0), overview,
                message.optJSONObject("destination")?.getString("name").orEmpty(), message.optString("mode", "walking"))
        }
    }
}

data class NavigationFix(val routeId: String, val revision: Int, val latitude: Double, val longitude: Double,
    val altitude: Double, val sampleTime: Long, val sequence: Long, val course: Double?,
    val position: NavCoordinate, val accuracy: Double, val maneuver: NavManeuver,
    val segmentIndex: Int, val segmentFraction: Double) {
    companion object {
        fun fromWire(message: JSONObject): NavigationFix {
            require(message.getString("coordinate_system") == "wgs84")
            val position = message.getJSONObject("position")
            val nav = message.getJSONObject("nav")
            val turn = when (nav.getString("maneuver")) {
                "left", "slight_left", "sharp_left" -> NavTurn.LEFT
                "right", "slight_right", "sharp_right" -> NavTurn.RIGHT
                "uturn" -> NavTurn.UTURN
                "arrive" -> NavTurn.ARRIVE
                "straight", "depart" -> NavTurn.STRAIGHT
                else -> error("Unknown navigation maneuver")
            }
            return NavigationFix(nav.getString("nav_id"), nav.getInt("revision"),
                position.getDouble("lat"), position.getDouble("lng"), position.optDouble("altitude_m", 0.0),
                Instant.parse(position.getString("at")).toEpochMilli(), message.getLong("seq"),
                if (position.has("course_deg")) position.getDouble("course_deg") else null,
                position.renderCoordinate(), position.getDouble("accuracy_m"),
                NavManeuver(nav.getJSONObject("maneuver_location").renderCoordinate(),
                    nav.getDouble("distance_to_maneuver_m"), turn),
                nav.getInt("route_segment_index"), nav.getDouble("segment_fraction"))
        }
    }
    fun mapState(route: NavigationRoute, heading: HeadingSample, style: MiniMapStyle): MiniMapState? {
        // A reroute and a 1 Hz fix arrive independently; display only the matching authority revision.
        if (route.id != routeId || route.revision != revision) return null
        return MiniMapState(position, accuracy, heading.degreesTrueNorth.toDouble(), route.points, maneuver,
            style, TurnHudGeometry.progressAt(route.points, segmentIndex, segmentFraction), heading.shouldCalibrate)
    }
}

private fun JSONObject.renderCoordinate() = NavCoordinate.fromWgs84(getDouble("lat"), getDouble("lng"))
