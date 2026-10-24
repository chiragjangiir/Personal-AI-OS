package com.personalaios.glasses

import android.content.Context
import android.graphics.*
import android.view.View
import kotlin.math.*

/** Optical pixels match the approved 640×480 mockup, independent of Android density.
 * Draws only navigation geometry; the surrounding HUD owns the turn card and top band.
 */
class MiniMapView(context: Context) : View(context) {
    private var state: MiniMapState? = null
    private var layout: MoveHudLayout? = null
    private var streets: Bitmap? = null
    private var approval: String? = null
    private var mapError: String? = null
    private var streetMetersPerPixel: Double? = null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val path = Path()
    private val crop = Path()
    private var route = emptyList<NavCoordinate>()
    private var reducedRoute = emptyList<NavCoordinate>()
    private val green = Color.rgb(63, 203, 132)
    private val orange = Color.rgb(255, 181, 71)

    fun setHudLayout(value: MoveHudLayout?) { layout = value; invalidate() }

    /** Supply the identical immutable state and screenshot to both eyes on the main thread. */
    fun present(value: MiniMapState?, bitmap: Bitmap? = null, approvalNumber: String? = null, error: String? = null,
        metersPerPixel: Double? = null) {
        state = value; streets = bitmap; approval = approvalNumber; mapError = error
        streetMetersPerPixel = if (bitmap != null) metersPerPixel?.times(bitmap.width.toDouble()/layout!!.miniMap!!.width) else null
        if (value != null && route != value.route) {
            route = value.route; reducedRoute = NavPolyline.simplify(route)
        }
        contentDescription = when {
            value == null -> null
            error != null -> error
            bitmap == null -> "导航路线图，无街道底图"
            else -> "高德街道导航图"
        }
        invalidate()
    }
    override fun onDraw(canvas: Canvas) {
        val s = state ?: return
        val hud = layout ?: return
        val map = hud.miniMap ?: return
        if (s.overviewVisible) { drawOverview(canvas, s, map); return }
        val cx = map.x + map.width/2f; val cy = map.y + map.height/2f
        val radius = map.width/2f; val userY = cy + 20f
        val mapRect = RectF(map.x.toFloat(), map.y.toFloat(), (map.x+map.width).toFloat(), (map.y+map.height).toFloat())
        crop.reset(); crop.addCircle(cx, cy, radius-8f, Path.Direction.CW)
        canvas.save(); canvas.scale(width/640f, height/480f)
        // Also covers the live source renderer beneath the left eye, including its rectangular corners.
        fill(Color.BLACK); canvas.drawRect(mapRect, paint)
        canvas.save(); canvas.clipPath(crop)
        fill(Color.rgb(11, 18, 32)); canvas.drawCircle(cx, cy, radius-8f, paint)
        val bitmap = streets
        val metersPerPixel = streetMetersPerPixel ?: 156543.03392*cos(Math.toRadians(s.position.latitude))/131072
        if (bitmap != null) canvas.drawBitmap(bitmap, null, mapRect, paint)
        else {
            path.reset()
            reducedRoute.forEachIndexed { i, coordinate ->
                val projected = miniMapPoint(coordinate, s, metersPerPixel)
                val x = projected.first - TurnHudGeometry.RING_CENTER_X.toFloat() + cx
                val y = projected.second - TurnHudGeometry.RING_CENTER_Y.toFloat() + cy
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            stroke(green, 5f); canvas.drawPath(path, paint)
        }
        stroke(Color.argb(100, 147, 168, 205), 1f)
        canvas.drawCircle(cx, userY, (s.accuracyMeters/metersPerPixel).toFloat(), paint)
        canvas.restore()
        for (i in 0 until 72) {
            val a = Math.toRadians(i*5.0); val major = i%9 == 0
            val r = if (major) radius-9 else radius-5
            stroke(if (major) Color.rgb(147, 168, 205) else Color.rgb(70, 87, 117), if (major) 2f else 1.4f)
            canvas.drawLine((cx+sin(a)*r).toFloat(), (cy-cos(a)*r).toFloat(),
                (cx+sin(a)*radius).toFloat(), (cy-cos(a)*radius).toFloat(), paint)
        }
        val north = Math.toRadians(-s.headingDegrees)
        text(canvas, "北", (cx+sin(north)*(radius-20)).toFloat(), (cy+5-cos(north)*(radius-20)).toFloat(), 13f, Color.LTGRAY)
        fill(Color.rgb(27, 34, 50)); canvas.drawCircle(cx, userY, 15f, paint)
        path.reset(); path.moveTo(cx, userY-12); path.lineTo(cx+9, userY+9)
        path.lineTo(cx, userY+4); path.lineTo(cx-9, userY+9); path.close()
        fill(Color.WHITE); canvas.drawPath(path, paint)
        s.geometry()?.let { g ->
            if (g.arcSweepDegrees != 0.0) {
                stroke(orange, 4f)
                canvas.drawArc(RectF(mapRect).apply { inset(2f, 2f) }, -90f, g.arcSweepDegrees.toFloat(), false, paint)
            }
            val angle = Math.toRadians(g.relativeBearingDegrees)
            val dotX = (cx+sin(angle)*(radius-2)).toFloat()
            val dotY = (cy-cos(angle)*(radius-2)).toFloat()
            fill(if (g.arcSweepDegrees != 0.0) orange else green)
            canvas.drawCircle(dotX, dotY, 6f, paint)
            stroke(Color.BLACK, 2f)
            canvas.drawCircle(dotX, dotY, 6f, paint)
            if (g.ribbonVisible) drawTurn(canvas, s, g, hud)
            if (g.turnHint != null) {
                val left = g.turnHint == NavTurnHint.LEFT
                val rect = if (left) hud.directionHintLeft!! else hud.directionHintRight!!
                val x = (if (left) rect.x else rect.x+rect.width).toFloat()
                val y = rect.y+rect.height/2f; val sign = if (left) 1 else -1
                path.reset(); path.moveTo(x, y); path.lineTo(x+sign*12, y-8)
                path.lineTo(x+sign*12, y+8); path.close(); fill(orange); canvas.drawPath(path, paint)
                text(canvas, if (left) "往左看" else "往右看", x+sign*20, y+7, 20f, orange,
                    if (left) Paint.Align.LEFT else Paint.Align.RIGHT)
            }
        }
        if (bitmap == null) text(canvas, mapError ?: "仅路线 · 无街道底图", cx, mapRect.bottom-10f, 12f, Color.LTGRAY)
        approval?.takeIf { bitmap != null && it.isNotBlank() }?.let { text(canvas, it, cx, mapRect.bottom+15f, 9f, Color.LTGRAY) }
        if (s.compassUnreliable) text(canvas, "画 8 字校准指南针", 320f, 470f, 16f, orange)
        canvas.restore()
    }
    private fun drawOverview(canvas: Canvas, s: MiniMapState, map: HudTextRect) {
        canvas.save(); canvas.scale(width/640f, height/480f)
        val top = RectF(40f, 30f, 600f, 86f)
        fill(Color.rgb(16, 23, 38)); canvas.drawRoundRect(top, 14f, 14f, paint)
        stroke(Color.rgb(38, 49, 74), 1f); canvas.drawRoundRect(top, 14f, 14f, paint)
        val rect = RectF(map.x.toFloat(), map.y.toFloat(), (map.x+map.width).toFloat(), (map.y+map.height).toFloat())
        fill(Color.rgb(11, 18, 32)); canvas.drawRoundRect(rect, 18f, 18f, paint)
        stroke(Color.rgb(38, 49, 74), 1f); canvas.drawRoundRect(rect, 18f, 18f, paint)
        val alternate = s.overview?.alternatives?.firstOrNull()?.points.orEmpty()
        val origin = s.route.first()
        val all = (s.route + alternate).map { NavMetric.xy(it, origin) }
        val minX = all.minOf { it.first }; val maxX = all.maxOf { it.first }
        val minY = all.minOf { it.second }; val maxY = all.maxOf { it.second }
        val scale = minOf((map.width-56) / (maxX-minX).coerceAtLeast(1.0),
            (map.height-48) / (maxY-minY).coerceAtLeast(1.0))
        fun point(coordinate: NavCoordinate): Pair<Float, Float> {
            val (x, y) = NavMetric.xy(coordinate, origin)
            return Pair((rect.centerX()+(x-(minX+maxX)/2)*scale).toFloat(),
                (rect.centerY()-(y-(minY+maxY)/2)*scale).toFloat())
        }
        fun line(points: List<NavCoordinate>, color: Int, width: Float, dashed: Boolean) {
            path.reset()
            NavPolyline.simplify(points).forEachIndexed { index, coordinate ->
                val (x, y) = point(coordinate)
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            stroke(color, width); paint.pathEffect = if (dashed) DashPathEffect(floatArrayOf(2f, 8f), 0f) else null
            canvas.drawPath(path, paint); paint.pathEffect = null
        }
        line(alternate, Color.rgb(135, 144, 164), 4f, true)
        line(s.route, green, 6f, false)
        val (startX, startY) = point(s.route.first()); fill(Color.WHITE); canvas.drawCircle(startX, startY, 8f, paint)
        val (endX, endY) = point(s.route.last()); fill(Color.rgb(255, 100, 124)); canvas.drawCircle(endX, endY, 9f, paint)
        stroke(Color.WHITE, 2f); canvas.drawCircle(endX, endY, 9f, paint)
        canvas.restore()
    }
    private fun drawTurn(canvas: Canvas, s: MiniMapState, g: TurnHudState, hud: MoveHudLayout) {
        val ribbon = hud.turnRibbon!!
        val originY = if (g.nearManeuver) ribbon.y+24f else ribbon.y+ribbon.height/2f
        canvas.save(); canvas.translate(g.ribbonX.toFloat(), originY)
        path.reset()
        if (!g.nearManeuver) {
            path.moveTo(-13f, 4f); path.lineTo(0f, -6f); path.lineTo(13f, 4f)
            path.moveTo(-13f, 13f); path.lineTo(0f, 3f); path.lineTo(13f, 13f)
            stroke(green, 3f)
        } else {
            when (s.nextManeuver!!.turn) {
                NavTurn.LEFT, NavTurn.RIGHT -> {
                    val sign = if (s.nextManeuver.turn == NavTurn.LEFT) -1 else 1
                    path.moveTo(-6f*sign, 44f); path.lineTo(-6f*sign, 8f)
                    path.quadTo(-6f*sign, -6f, 8f*sign, -6f); path.lineTo(30f*sign, -6f)
                    path.moveTo(14f*sign, -20f); path.lineTo(30f*sign, -6f); path.lineTo(14f*sign, 8f)
                }
                NavTurn.UTURN -> {
                    path.moveTo(-14f, 44f); path.lineTo(-14f, 0f); path.cubicTo(-14f, -25f, 16f, -25f, 16f, 0f)
                    path.lineTo(16f, 20f); path.moveTo(5f, 9f); path.lineTo(16f, 20f); path.lineTo(27f, 9f)
                }
                NavTurn.ARRIVE -> {
                    path.moveTo(0f, 44f); path.lineTo(0f, -20f); path.lineTo(28f, -10f); path.lineTo(0f, 0f)
                }
                NavTurn.STRAIGHT -> {
                    path.moveTo(0f, 44f); path.lineTo(0f, -20f)
                    path.moveTo(-16f, -4f); path.lineTo(0f, -20f); path.lineTo(16f, -4f)
                }
            }
            stroke(green, 8f)
        }
        canvas.drawPath(path, paint)
        if (g.nearManeuver) text(canvas, "${s.nextManeuver!!.distanceMeters.roundToInt()} 米", 0f, (hud.turnDistance!!.y+hud.turnDistance.height-5)-originY, 22f, Color.WHITE)
        canvas.restore()
    }
    private fun fill(color: Int) { paint.color = color; paint.style = Paint.Style.FILL }
    private fun stroke(color: Int, width: Float) { paint.color = color; paint.style = Paint.Style.STROKE; paint.strokeWidth = width }
    private fun text(c: Canvas, value: String, x: Float, y: Float, size: Float, color: Int, align: Paint.Align = Paint.Align.CENTER) {
        fill(color); paint.textSize = size; paint.textAlign = align
        c.drawText(value, x, y, paint)
    }
}
