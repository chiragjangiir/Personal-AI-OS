package com.personalaios.glasses

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.FrameLayout

/** Persistent binocular hosts. The caller retains TAG in MainActivity's HUD redraw filter.
 * One 172px renderer + one shared bitmap guarantees the same map/camera generation in both eyes.
 */
class NavigationMirror(context: Context, left: FrameLayout, right: FrameLayout,
    privacyShown: Boolean, privacyAgreed: Boolean, private val onError: (String) -> Unit) {
    companion object { const val TAG = "navigation_mirror"; const val FRAME_INTERVAL_MS = 100L }
    val hosts = listOf(left, right).map { lens -> MiniMapView(context).apply {
        tag = TAG; visibility = View.GONE
        lens.addView(this, FrameLayout.LayoutParams(-1, -1))
    } }
    private val source = if (BuildConfig.AMAP_CONFIGURED && privacyShown && privacyAgreed)
        AMapStreetSource(context, privacyShown, privacyAgreed) else null
    private val handler = Handler(Looper.getMainLooper())
    private var latest: MiniMapState? = null
    private var latestLayout: MoveHudLayout? = null
    private var alignSource: () -> Unit = {}
    private var running = false
    private var sourceActive = false
    private var busy = false
    private var reportedError: String? = null
    private var alignListener: View.OnLayoutChangeListener? = null
    private var generation = 0
    private var lastFrameAt = -FRAME_INTERVAL_MS
    private val draw = Runnable { render() }
    init {
        source?.view?.apply {
            tag = TAG
            // The left overlay paints this whole rectangle black, then displays the shared circular capture.
            left.addView(this, left.indexOfChild(hosts[0]), FrameLayout.LayoutParams(0, 0))
            visibility = View.GONE
            fun align() {
                val rect = latestLayout?.miniMap ?: return
                pivotX = 0f; pivotY = 0f; scaleX = left.width/640f; scaleY = left.height/480f
                layoutParams = (layoutParams as FrameLayout.LayoutParams).apply {
                    width = rect.width; height = rect.height
                    leftMargin = (rect.x*scaleX).toInt(); topMargin = (rect.y*scaleY).toInt()
                }
            }
            alignSource = ::align
            alignListener = View.OnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
                if (r-l != oldR-oldL || b-t != oldB-oldT) align()
            }.also(left::addOnLayoutChangeListener)
            align()
        }
    }
    fun update(state: MiniMapState?, layout: MoveHudLayout? = latestLayout) {
        latestLayout = layout
        hosts.forEach { it.setHudLayout(layout) }
        alignSource()
        if (latest?.route != state?.route || latest?.style != state?.style ||
            latest?.nextManeuver?.location != state?.nextManeuver?.location || latest?.overviewVisible != state?.overviewVisible ||
            latest?.overview != state?.overview || hosts[0].visibility != View.VISIBLE) {
            generation++
            hosts.forEach { it.present(state) }
        }
        latest = state
        val active = running && state?.style == MiniMapStyle.STREETS
        if (sourceActive != active) {
            sourceActive = active; busy = false
            if (active) source?.resume() else source?.pause()
        }
        if (state == null) {
            hosts.forEach { it.present(null) }
        }
        hosts.forEach { it.visibility = if (state == null || !running) View.GONE else View.VISIBLE }
        source?.view?.visibility = if (state == null || !running || state.overviewVisible) View.GONE else View.VISIBLE
        schedule()
    }
    fun resume() { running = true; update(latest) }
    fun pause() {
        running = false; generation++; busy = false
        handler.removeCallbacks(draw)
        if (sourceActive) source?.pause()
        sourceActive = false
        hosts.forEach { it.visibility = View.GONE }; source?.view?.visibility = View.GONE
    }
    fun destroy() {
        pause(); source?.destroy()
        alignListener?.let { (hosts[0].parent as FrameLayout).removeOnLayoutChangeListener(it) }
        hosts.forEach { (it.parent as FrameLayout).removeView(it) }
        source?.view?.let { (it.parent as FrameLayout).removeView(it) }
    }
    private fun schedule() {
        handler.removeCallbacks(draw)
        if (running && latest != null && !busy)
            handler.postDelayed(draw, (lastFrameAt + FRAME_INTERVAL_MS - SystemClock.uptimeMillis()).coerceAtLeast(0))
    }
    private fun render() {
        val state = latest ?: return
        lastFrameAt = SystemClock.uptimeMillis()
        val current = generation
        busy = true
        if (state.style == MiniMapStyle.STREETS && source?.capture(state) { bitmap, approval, error, scale ->
            if (running) {
                busy = false
                if (current == generation) {
                    hosts.forEach { it.present(state, bitmap, approval, error, scale) }
                    if (error != null && error != reportedError) onError(error)
                    reportedError = error
                }
                schedule()
            }
        } == true) return
        busy = false
        hosts.forEach { it.present(state) }
        schedule()
    }
}
