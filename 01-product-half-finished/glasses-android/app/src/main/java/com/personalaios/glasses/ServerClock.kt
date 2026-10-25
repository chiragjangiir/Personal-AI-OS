package com.personalaios.glasses

import android.os.SystemClock
import java.net.HttpURLConnection
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** HTTPS Date supplies epoch time; elapsed realtime advances it independently of the device's wall clock. */
internal class ServerClock(private val wallMs: () -> Long = System::currentTimeMillis,
    private val elapsedMs: () -> Long = SystemClock::elapsedRealtime) {
    private var epochOffset: Long? = null

    @Synchronized fun nowMillis(): Long = epochOffset?.let { it + elapsedMs() } ?: wallMs()
    @Synchronized fun knownTime(): Long? = epochOffset?.let { it + elapsedMs() }

    @Synchronized fun learn(date: String?): Boolean {
        if (date == null) return false
        val serverMs = try { ZonedDateTime.parse(date, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }
            catch (_: DateTimeParseException) { return false }
        val elapsed = elapsedMs()
        // Date has second precision. Preserve progress within that second across successive responses.
        val current = epochOffset?.let { it + elapsed }
        val estimate = if (current != null && current in serverMs until serverMs + 1000) current else serverMs
        epochOffset = estimate - elapsed
        return true
    }

    fun learn(connection: HttpURLConnection): Boolean =
        connection.url.protocol == "https" && learn(connection.getHeaderField("Date"))

    companion object { val shared = ServerClock() }
}

/** Process-local durations never depend on epoch time or a server correction. */
internal fun monotonicMillis(): Long = System.nanoTime() / 1_000_000
