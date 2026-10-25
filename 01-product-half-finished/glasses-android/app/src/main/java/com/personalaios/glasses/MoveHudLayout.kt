package com.personalaios.glasses

import org.json.JSONObject
import kotlin.math.roundToInt

data class HudTextRect(val x: Int, val y: Int, val width: Int, val height: Int) {
    fun overlaps(other: HudTextRect) = x < other.x + other.width && other.x < x + width &&
        y < other.y + other.height && other.y < y + height
}

data class MoveHudText(val role: String, val text: String, val rect: HudTextRect,
    val size: Int, val unit: String? = null)
data class MoveHudLayout(val texts: List<MoveHudText>, val portrait: HudTextRect?, val turnIcon: HudTextRect?,
    val heartIcon: HudTextRect? = null,
    val turnCard: HudTextRect? = null, val miniMap: HudTextRect? = null,
    val turnRibbon: HudTextRect? = null, val turnDistance: HudTextRect? = null,
    val directionHintLeft: HudTextRect? = null, val directionHintRight: HudTextRect? = null)

/** Optical-pixel layout shared by the Android text and map renderers. */
fun moveHudLayout(state: HudState, page: Int = 0, largeText: Boolean = false, menuOpen: Boolean = false): MoveHudLayout {
    val ride = state.ride; val nav = state.nav
    if (nav != null && state.routeOverviewUntil > 0 && state.navigationRoute?.overview != null) {
        val route = state.navigationRoute; val overview = route.overview!!
        fun totals(meters: Double, seconds: Double) = "${(seconds / 60).roundToInt().coerceAtLeast(1)} 分钟 · ${"%.1f".format(meters / 1000)} 公里"
        val destinationLimit = if (largeText) 2 else 3
        val destination = if (route.destination.length > destinationLimit) route.destination.take(destinationLimit - 1) + "…" else route.destination
        val title = "去$destination · ${if (route.mode == "bicycling") "骑行" else "步行"} "
        val texts = mutableListOf(
            MoveHudText("overview_totals", title + totals(route.totalMeters, route.totalSeconds), HudTextRect(64, 38, 374, 38), 20),
            MoveHudText("overview_selected", if (overview.selected == 0) "路线一（推荐）" else "路线二（已选）", HudTextRect(446, 44, 142, 30), 15),
            MoveHudText("overview_hint", if (overview.alternatives.isNotEmpty()) "说「换一条」或滑镜腿切换 · 2 秒后自动出发" else "2 秒后自动出发", HudTextRect(60, 108, 520, 32), 16))
        overview.alternatives.firstOrNull()?.let { alternate -> texts += MoveHudText("overview_alternative",
            (if (overview.selected == 0) "路线二：" else "路线一（推荐）：") + totals(alternate.totalMeters, alternate.totalSeconds), HudTextRect(100, 140, 440, 30), 15) }
        return MoveHudLayout(texts, null, null, miniMap = HudTextRect(110, 214, 420, 230))
    }
    if (ride == null && nav == null) return MoveHudLayout(emptyList(), null, null)
    val texts = mutableListOf<MoveHudText>()
    fun line(role: String, text: String, x: Int, y: Int, width: Int, height: Int, size: Int, unit: String? = null) {
        texts += MoveHudText(role, text, HudTextRect(x, y, width, height), size, unit)
    }
    fun one(n: Double) = "%.1f".format(n)
    fun number(json: JSONObject, key: String) = if (json.has(key)) json.getDouble(key) else null
    fun distance(n: Double) = if (n < 1000) "${n.roundToInt()}米" else "${one(n / 1000)}km"
    val detailsY = if (largeText) 78 else 70
    val sayY = if (largeText) 120 else 108
    val valueHeight = if (largeText) 64 else 54
    if (ride != null) {
        line("speed", number(ride, "speed_kmh")?.let(::one) ?: "—", 30, 14, 185, valueHeight, 40, "km/h")
        if (nav == null) line("speed_detail", "均速 ${number(ride, "avg_kmh")?.let(::one) ?: "—"} · 最高 ${number(ride, "max_kmh")?.let(::one) ?: "—"}",
            30, detailsY, 185, 26, 14)
        line("heart", number(ride, "hr_bpm")?.roundToInt()?.toString() ?: "—", 500, 14, 110, valueHeight, 40)
        val zone = listOfNotNull(number(ride, "hr_zone")?.let { "${it.toInt()} 区" },
            number(ride, "kcal")?.let { "${it.roundToInt()} 千卡" }).joinToString(" · ")
        if (nav == null) line("heart_detail", zone, 470, detailsY, 140, 26, 14)
    }
    val mode = conversationLabel(state)
    val thinking = if (mode != null) state.conversation?.text ?: state.conversationError?.let { "切换失败：$it" } else null
    if (nav != null) {
        val verbs = mapOf("left" to "左转", "right" to "右转", "slight_left" to "向左前方", "slight_right" to "向右前方",
            "sharp_left" to "向左后方", "sharp_right" to "向右后方", "straight" to "直行", "uturn" to "掉头", "arrive" to "到达", "depart" to "出发")
        val combined = ride != null
        val statusX = if (combined) 230 else 82
        line(if (mode == null) "assistant" else "call_status",
            if (mode == null) "依米" else if (combined) "$mode\n${voiceStatus(state)}" else "$mode · ${voiceStatus(state)}",
            statusX, if (combined) 14 else 20, if (combined) 220 else 528, if (combined) 64 else 30, 18)
        val subtitleY = if (combined) 82 else 56
        val subtitleHeight = if (combined) 54 else 76
        if (thinking != null) {
            if (!menuOpen) line("thinking_status", thinking, 82, subtitleY, 528, subtitleHeight, 16)
        } else state.say?.let { line("say", it, 82, subtitleY, 528, subtitleHeight, 18) }
        val portrait = if (state.conversation?.mode == "thinking") null
            else if (combined) HudTextRect(26, 86, 42, 42) else HudTextRect(26, 20, 42, 42)
        val heart = ride?.let { HudTextRect(470, 30, 24, 24) }
        if (nav.length() == 0) {
            line("navigation", "等待定位", 94, 304, 326, 64, 30)
            return MoveHudLayout(texts, portrait, null, heart,
                turnCard = HudTextRect(24, 298, 402, 150))
        }
        line("navigation", distance(nav.getDouble("distance_to_maneuver_m")), 94, 304, 326, 64, 44)
        val road = nav.optString("road").takeIf { it.isNotEmpty() }?.let { " · $it" }.orEmpty()
        line("navigation_road", verbs.getValue(nav.getString("maneuver")) + road, 30, 376, 390, 32, 20)
        line("navigation_detail", "剩${distance(nav.getDouble("remaining_m"))} · 约${(nav.getDouble("remaining_s") / 60).roundToInt().coerceAtLeast(1)}分",
            30, 414, 390, 30, 16)
        // The whole horizontal ribbon lane clears the map, including large distance text at its right edge.
        return MoveHudLayout(texts, portrait, HudTextRect(30, 314, 48, 48), heart,
            turnCard = HudTextRect(24, 298, 402, 150), miniMap = HudTextRect(442, 276, 172, 172),
            turnRibbon = HudTextRect(0, 168, 640, 74), turnDistance = HudTextRect(0, 242, 640, 26),
            directionHintLeft = HudTextRect(30, 138, 130, 28), directionHintRight = HudTextRect(480, 138, 130, 28))
    }
    when {
        ride != null && page == 1 -> {
            line("middle", "爬升 ${number(ride, "elev_gain_m")?.let { "${it.roundToInt()} m" } ?: "—"}", 230, 22, 220, 48, 24)
            val cadence = number(ride, "cadence_rpm")?.let { "${it.roundToInt()} rpm" } ?: "—"
            line("middle_detail", "踏频 $cadence" + if (ride.optString("cadence_source") == "pocket_estimate") " · 估算" else "",
                230, detailsY, 220, 26, 14)
        }
        ride != null -> {
            line("middle", number(ride, "distance_m")?.let { one(it / 1000) } ?: "—", 230, 22, 220, 48, 26, "km")
            val seconds = number(ride, "elapsed_s")?.toLong()
            line("middle_detail", seconds?.let { "%d:%02d:%02d".format(it / 3600, it / 60 % 60, it % 60) } ?: "等待骑行数据", 230, detailsY, 220, 26, 16)
        }
    }
    val say = state.say?.takeIf { thinking == null }
    say?.let { line("say", it, 70, sayY, 540, 36, 18) }
    if (mode != null && !menuOpen) {
        line("call_status", "$mode · ${voiceStatus(state)}", 30, 336, 580, 36, 18)
        thinking?.let { line("thinking_status", it, 30, 374, 580, 80, 16) }
    }
    return MoveHudLayout(texts, say?.let { HudTextRect(24, sayY - 6, 42, 42) }, null,
        ride?.let { HudTextRect(470, 30, 24, 24) })
}

fun movementRejectionHint(message: JSONObject): String? =
    if (message.getString("error_code") == "PHONE_NOT_CONNECTED" &&
        message.getString("request_operation") in setOf("ride_control", "nav_control"))
        "打开手机上的依米，导航会自动开始" else null
