package com.personalaios.glasses

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.*
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.sqrt
import org.json.JSONObject

/** Debug measurements only. Service controls foreground permissions and screen-off test conditions. */
class DeviceProbe(private val context: Context, private val senses: DeviceSenses) {
    private val directory: File
        get() {
            return File(context.filesDir, "device-probes").apply {
                check(isDirectory || mkdirs()) { "Cannot create private probe directory" }
            }
        }

    fun facts() { Log.i("YimiProbe", "wear_state=${senses.wearState()} via=Mercury_getWearingState") }

    @SuppressLint("MissingPermission")
    suspend fun microphones(seconds: Int = 5, continuous: Boolean = false, observe: (JSONObject) -> Unit = {}) = withContext(Dispatchers.IO) {
        val output = directory
        val power = context.getSystemService(PowerManager::class.java)
        delay(2000) // Allow the operator to background the app and turn off the display before measurement.
        val inputs = context.getSystemService(AudioManager::class.java).getDevices(AudioManager.GET_DEVICES_INPUTS).toList().filter { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
        inputs.forEach { Log.i("YimiProbe", "mic_available id=${it.id} type=${it.type} address=${it.address}") }
        val routes: List<AudioDeviceInfo?> = if (continuous || inputs.isEmpty()) listOf(null) else inputs
        val sources = if (continuous) listOf(MediaRecorder.AudioSource.MIC) else
            listOf(MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        for (source in sources) {
            for (preferred in routes) {
                val rate = 16000
                val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                check(minimum > 0) { "AudioRecord unsupported minimum=$minimum" }
                val record = AudioRecord.Builder().setAudioSource(source)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(maxOf(minimum, rate)).build()
                val silenced = AtomicInteger(0)
                val callback = object : AudioManager.AudioRecordingCallback() {
                    override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
                        if (configs.any { it.clientAudioSessionId == record.audioSessionId && it.isClientSilenced }) silenced.incrementAndGet()
                    }
                }
                val wake = if (continuous) power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yimi:debug-microphone") else null
                var registered = false
                var started = false
                try {
                    check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
                    if (preferred != null) check(record.setPreferredDevice(preferred)) { "Preferred microphone rejected id=${preferred.id}" }
                    record.registerAudioRecordingCallback(context.mainExecutor, callback)
                    registered = true
                    val file = File(output, "mic-${System.currentTimeMillis()}-$source-${preferred?.id ?: "default"}.wav")
                    var samples = 0L
                    var nonzero = 0L
                    var sumSquares = 0.0
                    var reads = 0
                    var previousRead = 0L
                    var maxReadGap = 0L
                    var gapsOver250 = 0L
                    var nextObservation = 10000L
                    val start = SystemClock.elapsedRealtime()
                    val interactive = power.isInteractive
                    var route = "unknown"
                    RandomAccessFile(file, "rw").use { wav ->
                        wav.write(ByteArray(44))
                        wake?.acquire()
                        record.startRecording()
                        started = true
                        check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone did not start" }
                        val buffer = ShortArray(1600)
                        while (SystemClock.elapsedRealtime() - start < seconds * 1000L) {
                            ensureActive()
                            val count = record.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                            val readAt = SystemClock.elapsedRealtime()
                            if (previousRead != 0L) {
                                val gap = readAt - previousRead
                                maxReadGap = maxOf(maxReadGap, gap)
                                if (gap > 250) gapsOver250++
                            }
                            previousRead = readAt
                            check(count > 0) { "AudioRecord read failed=$count" }
                            val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                            for (i in 0 until count) {
                                bytes.putShort(buffer[i])
                                if (buffer[i].toInt() != 0) nonzero++
                                sumSquares += buffer[i].toDouble() * buffer[i]
                            }
                            wav.write(bytes.array())
                            samples += count
                            reads++
                            record.activeRecordingConfiguration?.let { if (it.isClientSilenced) silenced.incrementAndGet() }
                            record.routedDevice?.let { route = "${it.id}:${it.type}:${it.address}" }
                            val elapsed = SystemClock.elapsedRealtime() - start
                            if (elapsed >= nextObservation) {
                                observe(JSONObject().put("event", "microphone").put("duration_ms", elapsed)
                                    .put("sample_rate", rate).put("samples", samples).put("pcm_bytes", samples * 2).put("reads", reads)
                                    .put("max_read_gap_ms", maxReadGap).put("read_gaps_over_250ms", gapsOver250)
                                    .put("nonzero", nonzero).put("silenced_observations", silenced.get()).put("route", route))
                                nextObservation = elapsed + 10000
                            }
                        }
                        val size = (samples * 2).toInt()
                        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
                            .put("RIFF".toByteArray()).putInt(size + 36).put("WAVEfmt ".toByteArray())
                            .putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2)
                            .putShort(2).putShort(16).put("data".toByteArray()).putInt(size)
                        wav.seek(0)
                        wav.write(header.array())
                    }
                    val duration = SystemClock.elapsedRealtime() - start
                    observe(JSONObject().put("event", "microphone_complete").put("duration_ms", duration)
                        .put("sample_rate", rate).put("samples", samples).put("pcm_bytes", samples * 2).put("reads", reads)
                        .put("max_read_gap_ms", maxReadGap).put("read_gaps_over_250ms", gapsOver250).put("nonzero", nonzero)
                        .put("silenced_observations", silenced.get()).put("rms", sqrt(sumSquares / samples)).put("route", route))
                    Log.i("YimiProbe", "mic source=$source preferred=${preferred?.id} routed=$route duration_ms=$duration sample_rate=$rate samples=$samples reads=$reads rms=${sqrt(sumSquares / samples)} nonzero=$nonzero silenced_observations=${silenced.get()} interactive_before=$interactive interactive_after=${power.isInteractive} private_file=${file.name}")
                } finally {
                    try {
                        if (started) record.stop()
                    } finally {
                        try {
                            if (registered) record.unregisterAudioRecordingCallback(callback)
                        } finally {
                            try { record.release() } finally { if (wake?.isHeld == true) wake.release() }
                        }
                    }
                }
            }
        }
    }

    suspend fun imu(seconds: Int = 180) = coroutineScope {
        require(seconds in 1..300)
        val file = File(directory, "imu-${System.currentTimeMillis()}.csv")
        val manager = context.getSystemService(SensorManager::class.java)
        val sensors = listOf(Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GYROSCOPE, Sensor.TYPE_ACCELEROMETER)
            .mapNotNull { type -> manager.getDefaultSensor(type).also {
                Log.i("YimiProbe", "imu_available type=$type present=${it != null}")
            } }
        check(sensors.isNotEmpty()) { "No requested IMU sensors available" }
        val lines = Channel<String>(256)
        val dropped = AtomicInteger(0)
        val frames = sensors.associate { it.type to AtomicInteger(0) }
        val start = SystemClock.elapsedRealtime()
        val gestures = HeadGestures()
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                frames.getValue(event.sensor.type).incrementAndGet()
                if (event.sensor.type == Sensor.TYPE_GYROSCOPE) gestures.sample(event.timestamp, event.values[0], event.values[1], event.values[2])?.let {
                    Log.i("YimiProbe", "gesture_candidate=$it labels=none debug_only=true")
                }
                val line = "${event.timestamp},${event.sensor.type},${event.accuracy},${event.values.take(4).joinToString(",")}\n"
                if (!lines.trySend(line).isSuccess) dropped.incrementAndGet()
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        val writer = launch(Dispatchers.IO) {
            file.bufferedWriter().use { output ->
                output.write("timestamp_ns,sensor_type,accuracy,x,y,z,w_optional\n")
                for (line in lines) output.write(line)
            }
        }
        try {
            sensors.forEach { check(manager.registerListener(listener, it, 40_000, Handler(Looper.getMainLooper()))) {
                "IMU registration failed type=${it.type}"
            } }
            delay(seconds * 1000L)
        } finally {
            manager.unregisterListener(listener)
            lines.close()
            withContext(NonCancellable) { writer.join() }
        }
        val elapsed = SystemClock.elapsedRealtime() - start
        frames.forEach { (type, count) -> Log.i("YimiProbe", "imu type=$type frames=${count.get()} average_hz=${count.get() * 1000.0 / elapsed}") }
        Log.i("YimiProbe", "imu duration_ms=$elapsed dropped=${dropped.get()} private_file=${file.name} labels=none")
    }
}
