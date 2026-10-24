package com.personalaios.glasses

import kotlin.math.*

/** A map coordinate in GCJ-02. Server navigation and phone GPS use WGS84. */
data class NavCoordinate(val latitude: Double, val longitude: Double) {
    companion object {
        /** Matches the gateway's AMap conversion; call once at the WGS84 boundary. */
        fun fromWgs84(latitude: Double, longitude: Double): NavCoordinate {
            require(latitude.isFinite() && latitude in -90.0..90.0)
            require(longitude.isFinite() && longitude in -180.0..180.0)
            val original = NavCoordinate(latitude, longitude)
            if (longitude !in 72.004..137.8347 || latitude !in 0.8293..55.8271) return original
            val x = longitude - 105; val y = latitude - 35
            val wave = (20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2 / 3
            var dLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*sqrt(abs(x)) + wave
            dLat += (20*sin(y*PI) + 40*sin(y*PI/3)) * 2/3
            dLat += (160*sin(y*PI/12) + 320*sin(y*PI/30)) * 2/3
            var dLng = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*sqrt(abs(x)) + wave
            dLng += (20*sin(x*PI) + 40*sin(x*PI/3)) * 2/3
            dLng += (150*sin(x*PI/12) + 300*sin(x*PI/30)) * 2/3
            val rad = Math.toRadians(latitude)
            val eccentricity = 0.00669342162296594323
            val magic = 1 - eccentricity * sin(rad).pow(2)
            dLat = dLat*180 / (6378245*(1-eccentricity)/(magic*sqrt(magic))*PI)
            dLng = dLng*180 / (6378245/sqrt(magic)*cos(rad)*PI)
            return NavCoordinate(latitude + dLat, longitude + dLng)
        }
    }
}

/** Local metric geometry shared by route reduction and HUD projection. */
internal object NavMetric {
    const val METERS_PER_DEGREE = PI / 180 * 6371000
    fun xy(point: NavCoordinate, origin: NavCoordinate): Pair<Double, Double> =
        Pair((point.longitude-origin.longitude)*METERS_PER_DEGREE*cos(Math.toRadians(origin.latitude)),
            (point.latitude-origin.latitude)*METERS_PER_DEGREE)

    fun distance(a: NavCoordinate, b: NavCoordinate): Double {
        val (x, y) = xy(b, a)
        return hypot(x, y)
    }

    fun interpolate(a: NavCoordinate, b: NavCoordinate, t: Double) = NavCoordinate(
        a.latitude + (b.latitude-a.latitude)*t, a.longitude + (b.longitude-a.longitude)*t)

    fun projection(point: NavCoordinate, a: NavCoordinate, b: NavCoordinate): Pair<Double, Double> {
        val (x, y) = xy(point, a); val (dx, dy) = xy(b, a)
        val lengthSquared = dx*dx + dy*dy
        val t = if (lengthSquared == 0.0) 0.0 else ((x*dx+y*dy)/lengthSquared).coerceIn(0.0, 1.0)
        return Pair(t, (x-t*dx).pow(2) + (y-t*dy).pow(2))
    }
}
