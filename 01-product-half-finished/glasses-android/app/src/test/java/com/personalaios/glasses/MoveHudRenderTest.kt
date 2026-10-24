package com.personalaios.glasses

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE, qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class MoveHudRenderTest {
    private val ride = JSONObject("""{"speed_kmh":28.6,"hr_bpm":128}""")
    private val nav = JSONObject("""{"maneuver":"right","distance_to_maneuver_m":30,"road":"水印巷","remaining_m":9800,"remaining_s":1800}""")
    private val origin = NavCoordinate(30.0, 120.0)
    private val junction = NavCoordinate(30.00027, 120.0)
    private val frame = MiniMapState(origin, 4.0, 0.0, listOf(origin, junction, NavCoordinate(30.00027, 120.001)),
        NavManeuver(junction, 30.0, NavTurn.RIGHT), style = MiniMapStyle.STREETS)
    private val ink = Color.rgb(236, 239, 246)
    private val secondary = Color.rgb(166, 174, 192)
    private val hint = Color.rgb(135, 144, 164)
    private val accent = Color.rgb(91, 134, 255)

    @Test fun binocularCombinedScenesUseProductionTextAndMapViewsWithoutClipping() {
        val context = RuntimeEnvironment.getApplication()
        val eyes = listOf(FrameLayout(context), FrameLayout(context))
        val mirror = NavigationMirror(context, eyes[0], eyes[1], false, false) { fail(it) }
        val streets = streetFixture()
        mirror.resume()
        try {
            for (large in listOf(false, true)) for (scene in listOf("caption", "thinking", "mode_error", "behind", "stale")) {
                val thinking = scene == "thinking" || scene == "mode_error"
                val state = HudState(paired = true, ride = ride, nav = nav, callId = "call", listening = true,
                    callPlayback = !thinking, foregroundCalls = if (thinking) setOf("call") else emptySet(),
                    conversation = CallConversation(if (thinking) "thinking" else "chat",
                        if (scene == "thinking") "正在核对沿途信息，稍后告诉你。" else null),
                    conversationError = if (scene == "mode_error") "请求未送达" else null,
                    say = "前方三十米右转，我在呢。")
                val layout = moveHudLayout(state, largeText = large)
                val map = if (scene == "behind") frame.copy(headingDegrees = 180.0, compassUnreliable = true) else frame
                mirror.update(map, layout)
                mirror.hosts.forEach { it.present(map, streets, "离线街道夹具", metersPerPixel = 1.0) }
                val bitmaps = eyes.map { lens ->
                    val texts = layout.texts.map { item ->
                        val color = when {
                            item.role == "call_status" -> accent
                            scene == "stale" && item.role in setOf("speed", "heart") -> hint
                            item.role in setOf("speed", "heart", "navigation", "say", "thinking_status") -> ink
                            else -> secondary
                        }
                        val view = moveHudTextView(context, item, large, color, if (scene == "stale") hint else secondary)
                        if (item.role == "say") view.alpha = captionAlpha(4500)
                        lens.addView(view, FrameLayout.LayoutParams(item.rect.width, item.rect.height).apply {
                            leftMargin = item.rect.x; topMargin = item.rect.y
                        })
                        item to (if (view is ScrollView) view.getChildAt(0) as TextView else view as TextView)
                    }
                    lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
                    lens.layout(0, 0, 640, 480)
                    texts.forEach { (item, view) ->
                        assertNotNull("${item.role} must be laid out", view.layout)
                        if (item.role != "thinking_status") {
                            assertTrue("${item.role} clipped vertically large=$large", view.layout.height <= view.height)
                            assertTrue("${item.role} unexpectedly ellipsized large=$large",
                                (0 until view.layout.lineCount).all { view.layout.getEllipsisCount(it) == 0 })
                        }
                    }
                    Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).also { lens.draw(Canvas(it)) }
                }
                assertTrue("both eyes must present the same generation", bitmaps[0].sameAs(bitmaps[1]))
                assertEquals(mirror.hosts[0].contentDescription, mirror.hosts[1].contentDescription)
                System.getenv("MOVE_SCREENSHOT_DIR")?.let { dir ->
                    File(dir).mkdirs()
                    File(dir, "ride_nav_${scene}_${if (large) "large" else "standard"}.png").outputStream().use {
                        bitmaps[0].compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                }
                bitmaps.forEach(Bitmap::recycle)
                eyes.forEach { lens -> (lens.childCount - 1 downTo 0).forEach { i ->
                    if (lens.getChildAt(i).tag != NavigationMirror.TAG) lens.removeViewAt(i)
                } }
            }
            mirror.update(null)
            assertTrue(mirror.hosts.all { it.visibility == View.GONE })
            mirror.pause(); mirror.resume(); mirror.update(frame, moveHudLayout(HudState(ride = ride, nav = nav)))
            assertTrue(mirror.hosts.all { it.visibility == View.VISIBLE })
        } finally { mirror.destroy(); streets.recycle() }
    }

    @Test fun routeOverviewsRenderIdenticallyInBothEyesWithAndWithoutAlternate() {
        val context = RuntimeEnvironment.getApplication()
        for (selected in listOf(0, 1)) for (alternate in listOf(false, true)) for (large in listOf(false, true)) {
            val alternatives = if (alternate) listOf(RouteAlternative(12000.0, 3840.0,
                listOf(origin, NavCoordinate(30.0001, 120.001), frame.route.last()))) else emptyList()
            val route = NavigationRoute("overview", 1, frame.route, 10700.0, 3420.0,
                RouteOverview(selected, alternatives, true), destination = "西湖", mode = "bicycling")
            val state = HudState(paired = true, nav = JSONObject(), navigationRoute = route, routeOverviewUntil = 2000)
            val layout = moveHudLayout(state, largeText = large)
            val bitmaps = (0..1).map {
                val lens = FrameLayout(context)
                lens.addView(MiniMapView(context).apply { setHudLayout(layout); present(route.overviewMap()) }, FrameLayout.LayoutParams(640, 480))
                val texts = layout.texts.map { item ->
                    val view = moveHudTextView(context, item, large, ink, secondary) as TextView
                    lens.addView(view, FrameLayout.LayoutParams(item.rect.width, item.rect.height).apply {
                        leftMargin = item.rect.x; topMargin = item.rect.y
                    }); item to view
                }
                lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
                lens.layout(0, 0, 640, 480)
                texts.forEach { (item, view) ->
                    assertTrue("${item.role} clipped large=$large", view.layout.height <= view.height)
                    assertTrue("${item.role} ellipsized large=$large", (0 until view.layout.lineCount).all { view.layout.getEllipsisCount(it) == 0 })
                }
                Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).also { lens.draw(Canvas(it)) }
            }
            assertTrue(bitmaps[0].sameAs(bitmaps[1]))
            System.getenv("MOVE_SCREENSHOT_DIR")?.let { dir ->
                File(dir).mkdirs()
                File(dir, "overview_selected${selected}_alternate${alternate}_${if (large) "large" else "standard"}.png").outputStream().use {
                    bitmaps[0].compress(Bitmap.CompressFormat.PNG, 100, it)
                }
            }
            bitmaps.forEach(Bitmap::recycle)
        }
    }

    @Test fun routeReceiptTimeoutWalkingAndSwitchUseProductionTransitions() {
        val start = 1792324800000L
        fun wire(selected: Int = 0, alternative: Boolean = true) = JSONObject("""{"operation":"nav_route","coordinate_system":"wgs84","nav_id":"transition","revision":1,"mode":"walking","destination":{"name":"西湖"},"total_m":10700,"total_s":3420,"steps":[{"polyline":[{"lat":30,"lng":120},{"lat":30.00027,"lng":120},{"lat":30.00027,"lng":120.001}]}],"overview":{"version":1,"selected":$selected,"show":true,"alternatives":[]}}""").apply {
            if (alternative) getJSONObject("overview").getJSONArray("alternatives").put(JSONObject("""{"total_m":12000,"total_s":3840,"polyline":[{"lat":30,"lng":120},{"lat":30.0001,"lng":120.001},{"lat":30.00027,"lng":120.001}]}"""))
            if (selected == 1) {
                val primary = getJSONArray("steps").getJSONObject(0)
                val alternate = getJSONObject("overview").getJSONArray("alternatives").getJSONObject(0)
                val original = primary.getJSONArray("polyline")
                primary.put("polyline", alternate.getJSONArray("polyline"))
                alternate.put("polyline", original).put("total_m", 10700).put("total_s", 3420)
                put("revision", 2).put("total_m", 12000).put("total_s", 3840)
            }
        }
        fun fix(latitude: Double, second: Int) = JSONObject("""{"operation":"move_hud","kind":"walk_nav","coordinate_system":"wgs84","seq":$second,"position":{"lat":$latitude,"lng":120,"accuracy_m":3,"at":"2026-10-18T12:00:0${second}Z"},"nav":{"nav_id":"transition","revision":1,"maneuver":"right","maneuver_location":{"lat":30.00027,"lng":120},"distance_to_maneuver_m":30,"route_segment_index":0,"segment_fraction":0,"remaining_m":10700,"remaining_s":3420}}""")
        val received = HudState(paired = true).move(wire(), start)
        val fixed = received.move(fix(30.0, 0), start)
        val walking = fixed.move(fix(30.000014, 1), start+1000)
        val scenes = listOf("route_start" to visibleHud(received, start), "timeout_collapsed" to visibleHud(fixed, start+2000),
            "walking_collapsed" to visibleHud(walking, start+1000),
            "switch_returned_overview" to visibleHud(fixed.move(wire(selected = 1), start+1100), start+1100),
            "no_alternative" to visibleHud(HudState(paired = true).move(wire(alternative = false), start), start))
        val context = RuntimeEnvironment.getApplication()
        scenes.forEach { (name, state) ->
            val layout = moveHudLayout(state)
            val route = state.navigationRoute!!
            val map = if (state.routeOverviewUntil > 0) route.overviewMap() else
                state.navigationFix!!.mapState(route, HeadingSample(0f, HeadingAccuracy.HIGH, 1), MiniMapStyle.ROUTE_ONLY)!!
            assertEquals(name, name.endsWith("overview") || name in setOf("route_start", "no_alternative"), map.overviewVisible)
            val lens = FrameLayout(context)
            lens.addView(MiniMapView(context).apply { setHudLayout(layout); present(map) }, FrameLayout.LayoutParams(640, 480))
            layout.texts.forEach { item -> lens.addView(moveHudTextView(context, item, false, ink, secondary),
                FrameLayout.LayoutParams(item.rect.width, item.rect.height).apply { leftMargin = item.rect.x; topMargin = item.rect.y }) }
            lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
            lens.layout(0, 0, 640, 480)
            val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).also { lens.draw(Canvas(it)) }
            System.getenv("MOVE_SCREENSHOT_DIR")?.let { dir ->
                File(dir).mkdirs(); File(dir, "transition_$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            bitmap.recycle()
        }
    }

    /** Synthetic dark streets for offline composition only; no map-service acceptance is implied. */
    private fun streetFixture() = Bitmap.createBitmap(172, 172, Bitmap.Config.ARGB_8888).also { bitmap ->
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(11, 18, 32))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(65, 79, 98); strokeWidth = 8f }
        canvas.drawLine(25f, 0f, 25f, 172f, paint); canvas.drawLine(0f, 45f, 172f, 45f, paint)
        paint.color = Color.rgb(63, 203, 132); paint.strokeWidth = 5f
        canvas.drawLine(86f, 155f, 86f, 65f, paint); canvas.drawLine(86f, 65f, 172f, 65f, paint)
        paint.color = Color.LTGRAY; paint.textSize = 12f
        canvas.drawText("离线街道示意", 35f, 30f, paint)
    }
}
