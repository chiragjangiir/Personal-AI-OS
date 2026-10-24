package com.personalaios.glasses

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.atan2
import kotlin.math.exp
import kotlin.math.hypot

enum class HeadingAccuracy { UNKNOWN, UNRELIABLE, LOW, MEDIUM, HIGH, UNAVAILABLE }

data class HeadingSample(
    val degreesTrueNorth: Float,
    val accuracy: HeadingAccuracy,
    val timestampNanos: Long,
    /** Null means the rotation-vector sensor did not provide a heading error estimate. */
    val headingAccuracyRadians: Float? = null,
) {
    val shouldCalibrate: Boolean get() = accuracy == HeadingAccuracy.UNRELIABLE
}

/** Pure orientation math. Android's matrix maps device axes to east/north/up.
 * Assumes the glasses' display-local frame looks along -Z with +Y up; verify the worn sensor frame.
 * The world forward vector is then -matrix column 2.
 * Projecting forward, rather than reading phone azimuth, avoids turns caused by roll.
 */
internal object HeadingMath {
    fun normalize(degrees: Double): Double = ((degrees % 360.0) + 360.0) % 360.0
    fun magneticBearing(matrix: FloatArray): Double? {
        val east = -matrix[2].toDouble()
        val north = -matrix[5].toDouble()
        // Looking almost vertically has no stable horizontal heading.
        if (!east.isFinite() || !north.isFinite() || hypot(east, north) < 0.05) return null
        return normalize(Math.toDegrees(atan2(east, north)))
    }
    fun accuracy(status: Int): HeadingAccuracy = when (status) {
        0 -> HeadingAccuracy.UNRELIABLE
        1 -> HeadingAccuracy.LOW
        2 -> HeadingAccuracy.MEDIUM
        3 -> HeadingAccuracy.HIGH
        else -> HeadingAccuracy.UNKNOWN
    }
    /** Ignore absent estimates; any explicit unreliable magnetic source requires calibration. */
    fun fusedAccuracy(rotation: HeadingAccuracy, magnetic: HeadingAccuracy): HeadingAccuracy {
        val ranked = listOf(HeadingAccuracy.UNRELIABLE, HeadingAccuracy.LOW, HeadingAccuracy.MEDIUM, HeadingAccuracy.HIGH)
        return ranked.firstOrNull { it == rotation || it == magnetic } ?: HeadingAccuracy.UNKNOWN
    }
}

/** A time-based circular low-pass filter. Duplicate/out-of-order samples do not advance state. */
internal class HeadingSmoother(private val timeConstantSeconds: Double = 0.18) {
    private var timestamp = 0L
    private var heading: Double? = null
    fun reset() { timestamp = 0; heading = null }
    fun sample(degrees: Double, timestampNanos: Long): Float? {
        if (!degrees.isFinite() || timestampNanos <= timestamp) return null
        val previous = heading
        val next = if (previous == null) HeadingMath.normalize(degrees) else {
            val alpha = 1.0 - exp(-(timestampNanos - timestamp) / 1e9 / timeConstantSeconds)
            val delta = HeadingMath.normalize(degrees - previous + 180.0) - 180.0
            HeadingMath.normalize(previous + alpha * delta)
        }
        timestamp = timestampNanos; heading = next
        return next.toFloat() % 360f
    }
}

/** Main-thread sensor owner. Requires an explicit WGS84 fix before emitting true-north samples.
 * Uses magnetic rotation vector, never game rotation vector (which has no north reference).
 */
class HeadHeading(context: Context, private val onSample: (HeadingSample) -> Unit) : SensorEventListener {
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotation = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val magnetometer = manager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    private val matrix = FloatArray(9)
    private val gravity = FloatArray(3)
    private val magnetic = FloatArray(3)
    private val smoother = HeadingSmoother()
    private var gravityTime = 0L
    private var magneticTime = 0L
    private var rotationTime = 0L
    private var lastEmission = 0L
    private var declination: Float? = null
    private var rotationAccuracy = HeadingAccuracy.UNKNOWN
    private var magneticAccuracy = HeadingAccuracy.UNKNOWN
    private var running = false
    var available: Boolean = rotation != null || (accelerometer != null && magnetometer != null)
        private set
    val accuracy: HeadingAccuracy get() = if (!available) HeadingAccuracy.UNAVAILABLE
        else if (rotation != null) HeadingMath.fusedAccuracy(rotationAccuracy, magneticAccuracy) else magneticAccuracy

    fun updateTrueNorthLocation(wgs84Lat: Double, wgs84Lon: Double, altitudeMeters: Double, timeMillis: Long) {
        declination = GeomagneticField(wgs84Lat.toFloat(), wgs84Lon.toFloat(), altitudeMeters.toFloat(), timeMillis).declination
    }

    fun start(): Boolean {
        if (running) return true
        smoother.reset(); gravityTime = 0; magneticTime = 0; rotationTime = 0; lastEmission = 0
        rotationAccuracy = HeadingAccuracy.UNKNOWN; magneticAccuracy = HeadingAccuracy.UNKNOWN
        running = if (rotation != null) {
            manager.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME)
        } else if (accelerometer != null && magnetometer != null) {
            val accelerationStarted = manager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME)
            val magneticStarted = manager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_GAME)
            accelerationStarted && magneticStarted
        } else false
        // Rotation fusion and its underlying magnetometer expose independent accuracy statuses.
        if (running && rotation != null && magnetometer != null) {
            manager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_NORMAL)
        }
        if (!running) manager.unregisterListener(this)
        available = running
        return running
    }

    fun stop() {
        manager.unregisterListener(this)
        running = false
        smoother.reset()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        when (sensor?.type) {
            Sensor.TYPE_MAGNETIC_FIELD -> magneticAccuracy = HeadingMath.accuracy(accuracy)
            Sensor.TYPE_ROTATION_VECTOR -> rotationAccuracy = HeadingMath.accuracy(accuracy)
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!running || event.timestamp <= 0) return
        val age = SystemClock.elapsedRealtimeNanos() - event.timestamp
        if (age !in 0L..1_000_000_000L) return
        var headingError: Float? = null
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> {
                if (rotation == null || event.timestamp <= rotationTime) return
                rotationTime = event.timestamp
                rotationAccuracy = HeadingMath.accuracy(event.accuracy)
                headingError = event.values.getOrNull(4)?.takeIf { it.isFinite() && it >= 0f }
                SensorManager.getRotationMatrixFromVector(matrix, event.values)
            }
            Sensor.TYPE_ACCELEROMETER -> {
                if (rotation != null || event.timestamp <= gravityTime) return
                event.values.copyInto(gravity, endIndex = 3); gravityTime = event.timestamp
            }
            Sensor.TYPE_MAGNETIC_FIELD -> {
                if (event.timestamp <= magneticTime) return
                magneticTime = event.timestamp
                magneticAccuracy = HeadingMath.accuracy(event.accuracy)
                if (rotation != null) return // Monitor accuracy only; fusion remains the orientation authority.
                event.values.copyInto(magnetic, endIndex = 3)
            }
            else -> return
        }
        if (rotation == null) {
            if (gravityTime == 0L || magneticTime == 0L ||
                event.timestamp - minOf(gravityTime, magneticTime) > 500_000_000L) return
            if (!SensorManager.getRotationMatrix(matrix, null, gravity, magnetic)) return
        }
        val correction = declination ?: return
        val bearing = HeadingMath.magneticBearing(matrix) ?: return
        val smoothed = smoother.sample(bearing + correction, event.timestamp) ?: return
        if (lastEmission != 0L && event.timestamp - lastEmission < 100_000_000L) return
        lastEmission = event.timestamp
        onSample(HeadingSample(smoothed, accuracy, event.timestamp, headingError))
    }
}
