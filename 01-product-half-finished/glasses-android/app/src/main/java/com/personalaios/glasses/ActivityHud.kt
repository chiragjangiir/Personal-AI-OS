package com.personalaios.glasses

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONObject
import java.math.BigDecimal
import java.time.Duration
import java.time.Instant
import java.util.Locale

enum class ActivityPhase { running, succeeded, failed, partial, cancelled, unknown, waiting }

/** Tool-reported work units. Activity counts never supply a progress denominator. */
data class ActivityProgress(val version: Int, val value: Double, val total: Double) {
    val label: String get() = listOf(value, total).joinToString("/") {
        BigDecimal.valueOf(it).stripTrailingZeros().toPlainString()
    }
    companion object {
        fun from(wire: JSONObject): ActivityProgress {
            require(wire.get("version") is Number && wire.getDouble("version") == 1.0)
            require(wire.get("value") is Number && wire.get("total") is Number)
            val value = wire.getDouble("value"); val total = wire.getDouble("total")
            require(value.isFinite() && value >= 0 && total.isFinite() && total > 0)
            return ActivityProgress(1, value, total)
        }
    }
}

/** A wire snapshot, anchored to monotonic receipt time rather than the device's wall clock. */
data class ActivityCard(val id: String, val revision: Long, val processedEventId: String,
    val phase: ActivityPhase, val summary: String, val step: String?, val running: Int,
    val elapsedMs: Long, val progressAgeMs: Long, val receivedAt: Long, val failure: String?, val progress: ActivityProgress? = null) {
    val ongoing get() = phase == ActivityPhase.running || phase == ActivityPhase.waiting
    fun elapsed(now: Long) = elapsedMs + if (ongoing) now - receivedAt else 0
    fun alpha(now: Long): Float = if (ongoing) 1f
        else ((3500 - (now - receivedAt)) / 500f).coerceIn(0f, 1f)

    companion object {
        fun from(message: JSONObject, receivedAt: Long): ActivityCard {
            val c = message.getJSONObject("card")
            val phase = ActivityPhase.valueOf(c.getString("state"))
            val revision = c.getLong("revision"); require(revision >= 0)
            val elapsed = c.getLong("elapsed_ms"); require(elapsed >= 0)
            val age = Duration.between(Instant.parse(c.getString("last_progress_at")),
                Instant.parse(c.getString("observed_at"))).toMillis()
            val running = c.getJSONObject("counts").getInt("running"); require(running >= 0)
            if (phase != ActivityPhase.running && phase != ActivityPhase.waiting) Instant.parse(c.getString("completed_at"))
            val failure = if (phase == ActivityPhase.failed || phase == ActivityPhase.partial)
                c.getString("failure_reason") else null
            return ActivityCard(c.getString("id"), revision, message.getString("processed_event_id"),
                phase, c.getString("summary"), if (c.has("step_summary")) c.getString("step_summary") else null,
                running, elapsed, age, receivedAt, failure,
                if (c.has("progress")) ActivityProgress.from(c.getJSONObject("progress")) else null)
        }
    }
}

data class ActivityLine(val text: String, val elapsed: String?, val others: String?, val alpha: Float, val nextUpdateMs: Long,
    val progress: ActivityProgress? = null, val title: String? = null)

/** The existing top band has one owner. Movement, payments and live captions keep precedence. */
fun activityLine(state: HudState, screen: HudScreen, wallNow: Long, now: Long): ActivityLine? {
    val base = (screen as? HudScreen.Menu)?.under ?: screen
    if (!state.paired || state.ride != null || state.nav != null || state.paymentLock.locked ||
        wallNow < state.paymentLock.bannerUntil || state.payment?.let { it.until > wallNow } == true ||
        captionWindow(state.captions, wallNow).isNotEmpty() || state.avatarPhase == "Playing" ||
        (base != HudScreen.Idle && base != HudScreen.Talking)) return null
    val active = state.activities.filter { it.ongoing }
    val card = state.activities.lastOrNull { it.alpha(now) > 0 } ?: return null
    val text = when (card.phase) {
        ActivityPhase.succeeded -> "已完成"
        ActivityPhase.failed -> "未办成 · ${card.failure}"
        ActivityPhase.partial -> "部分完成 · ${card.failure}"
        ActivityPhase.cancelled -> "已取消"
        ActivityPhase.unknown -> "结果待核对"
        ActivityPhase.waiting -> "正在等待"
        ActivityPhase.running -> {
            val detail = card.step ?: card.summary
            val prefix = if (card.step != null) "${card.summary} · " else ""
            val idleSeconds = (card.progressAgeMs + now - card.receivedAt) / 1000
            if (idleSeconds >= 30) "这一步较慢 · $idleSeconds 秒没有新进度 · $prefix$detail"
            else "$prefix$detail"
        }
    }
    val age = now - card.receivedAt
    val nextUpdate = if (card.ongoing) 1000L else if (age < 3000) 3000 - age else 50L
    val others = active.size - if (card.ongoing) 1 else 0
    return ActivityLine(text, activityDuration(card.elapsed(now)),
        if (others > 0) "另 $others 件" else null, card.alpha(now), nextUpdate,
        card.progress.takeIf { card.phase == ActivityPhase.running },
        card.summary.takeIf { card.phase != ActivityPhase.running })
}

/** Suppress the legacy chip while activity owns the band, and retain coverage by formal request identity. */
fun legacyProgressCard(state: HudState, activityVisible: Boolean): HudCard? =
    state.cards.lastOrNull { it.progress != null }?.takeUnless { errand ->
        activityVisible || state.legacyProgressCovered ||
            state.activities.any { it.processedEventId == errand.ack?.getString("processed_event_id") }
    }

/** Explicit units distinguish elapsed work from the device clock. */
fun activityDuration(milliseconds: Long): String {
    val seconds = milliseconds / 1000
    val duration = when {
        seconds < 60 -> "${seconds}秒"
        seconds < 3600 -> String.format(Locale.ROOT, "%d分%02d秒", seconds / 60, seconds % 60)
        else -> String.format(Locale.ROOT, "%d小时%02d分%02d秒", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }
    return "用时 $duration"
}

/** Transparent optical band, above the menu at y=140; titles never compete with the timer. */
fun activityLineView(context: Context, line: ActivityLine): LinearLayout = LinearLayout(context).apply {
    id = R.id.activity_status
    layoutParams = FrameLayout.LayoutParams(580, 108).apply { leftMargin = 30; topMargin = 20 }
    orientation = LinearLayout.VERTICAL
    alpha = line.alpha
    fun text(value: String, size: Float = 20f, lines: Int = 1) = TextView(context).apply {
        text = value; setTextColor(Color.rgb(242, 245, 255)); typeface = Typeface.DEFAULT_BOLD
        setTextSize(TypedValue.COMPLEX_UNIT_PX, size); includeFontPadding = false
        maxLines = lines; ellipsize = TextUtils.TruncateAt.END
        importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    contentDescription = listOfNotNull(line.title, line.text, line.progress?.label, line.elapsed, line.others).joinToString(" ")
    addView(text(line.title ?: line.text, lines = 2), LinearLayout.LayoutParams(-1, -2))
    line.title?.let { addView(text(line.text, size = 16f, lines = 2), LinearLayout.LayoutParams(-1, -2)) }
    val footer = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    line.elapsed?.let { footer.addView(text(it, size = 16f), LinearLayout.LayoutParams(-2, -2)) }
    line.progress?.let { reported ->
        footer.addView(ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = false; max = 10000
            progress = ((reported.value / reported.total).coerceAtMost(1.0) * max).toInt()
            progressTintList = ColorStateList.valueOf(Color.rgb(242, 245, 255))
            progressBackgroundTintList = ColorStateList.valueOf(Color.rgb(93, 100, 120))
            contentDescription = reported.label
            stateDescription = reported.label
        }, LinearLayout.LayoutParams(64, 8).apply { leftMargin = 8; rightMargin = 8 })
        footer.addView(text(reported.label, size = 16f), LinearLayout.LayoutParams(-2, -2))
    }
    line.others?.let { footer.addView(text(" · $it", size = 16f), LinearLayout.LayoutParams(-2, -2)) }
    addView(footer, LinearLayout.LayoutParams(-1, -2))
}
