package com.personalaios.glasses

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import kotlin.math.roundToInt

internal data class AvatarFrame(val left: Int, val top: Int, val width: Int, val height: Int)

/** Coordinates belong to each 640×480 optical viewport, independent of Android density. */
internal fun avatarFrame(lensWidth: Int, lensHeight: Int) = AvatarFrame(
    (30 * lensWidth / 640f).roundToInt(), (20 * lensHeight / 480f).roundToInt(),
    (144 * lensWidth / 640f).roundToInt(), (144 * lensHeight / 480f).roundToInt()
)

/** Temporary optical preview. Stable containers survive the HUD's text redraws. */
internal class AvatarPlaceholder(context: Context, left: FrameLayout, right: FrameLayout) {
    companion object { const val TAG = "avatar_placeholder" }
    val hosts = listOf(left, right).map { lens ->
        FrameLayout(context).apply {
            tag = TAG; visibility = View.GONE
            fun position() {
                val frame = avatarFrame(lens.width, lens.height)
                layoutParams = FrameLayout.LayoutParams(frame.width, frame.height, Gravity.TOP or Gravity.LEFT).apply {
                    leftMargin = frame.left; topMargin = frame.top
                }
            }
            lens.addView(this, FrameLayout.LayoutParams(0, 0))
            lens.addOnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
                if (r - l != oldR - oldL || b - t != oldB - oldT) position()
            }
            position()
        }
    }
}
