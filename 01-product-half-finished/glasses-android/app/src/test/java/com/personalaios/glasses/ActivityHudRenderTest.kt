package com.personalaios.glasses

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], application = Application::class, manifest = Config.NONE, qualifiers = "xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ActivityHudRenderTest {
    @Test fun sixStatesRenderTheProductionViewOnATransparent640By480Lens() {
        val fixtures = JSONObject(javaClass.getResource("/activity-update.fixtures.json")!!.readText()).getJSONObject("fixtures")
        for (name in fixtures.keys()) {
            val card = ActivityCard.from(fixtures.getJSONObject(name), 0)
            val state = HudState(paired = true, activities = listOf(card))
            val line = activityLine(state, HudScreen.Idle, 0, 0)!!
            render(name, line)
            if (name == "succeeded") render("succeeded_fading_3250ms", line.copy(alpha = card.alpha(3250)))
        }
        val parallel = listOf("single_running", "parallel_six").map { ActivityCard.from(fixtures.getJSONObject(it), 0) }
        render("parallel_cards", activityLine(HudState(paired = true, activities = parallel), HudScreen.Idle, 0, 0)!!)
    }

    @Test fun realProgressAndAbsentProgressRenderWithoutUsingCounts() {
        val fixtures = JSONObject(javaClass.getResource("/activity-update.fixtures.json")!!.readText()).getJSONObject("fixtures")
        val message = JSONObject(fixtures.getJSONObject("single_running").toString())
        val card = message.getJSONObject("card")
        val baseline = ActivityCard.from(message, 0)
        render("progress_absent", activityLine(HudState(paired = true, activities = listOf(baseline)), HudScreen.Idle, 0, 0)!!)
        card.put("progress", JSONObject().put("version", 1).put("value", 2.5).put("total", 10))
        val reported = ActivityCard.from(message, 0)
        render("progress_real_2_5_of_10", activityLine(HudState(paired = true, activities = listOf(reported)), HudScreen.Idle, 0, 0)!!)
    }

    @Test fun twoLineTitleKeepsPartialReasonAndHourDurationInsideTheSafeBand() {
        render("long_title_partial_hour", ActivityLine("部分完成 · 报表已完成，文件已保存；发送停在收件人确认之前，尚未发送任何附件，请确认后继续", "用时 1小时01分01秒",
            null, 1f, 3000, title = "整理表格".repeat(10)))
    }

    private fun render(name: String, line: ActivityLine) {
        val context = RuntimeEnvironment.getApplication()
        val lens = FrameLayout(context)
        val view = activityLineView(context, line)
        lens.addView(view)
        fun descendants(group: ViewGroup): List<View> = (0 until group.childCount).flatMap {
            val child = group.getChildAt(it)
            listOf(child) + if (child is ViewGroup) descendants(child) else emptyList()
        }
        val children = descendants(view)
        val bars = children.filterIsInstance<ProgressBar>()
        val labels = children.filterIsInstance<TextView>().map { it.text.toString() }
        val reported = line.progress
        if (reported == null) {
            assertTrue("No fabricated count-based bar", bars.isEmpty())
            assertFalse(labels.any { it.contains("4 件在办") || it.contains("2/6") || it.contains("0/1") })
        } else {
            val bar = bars.single()
            assertFalse(bar.isIndeterminate)
            assertEquals(10000, bar.max)
            assertEquals(2500, bar.progress)
            assertEquals(reported.label, bar.contentDescription)
            assertTrue(labels.contains(reported.label))
            assertTrue(labels.contains(line.elapsed))
        }
        lens.measure(View.MeasureSpec.makeMeasureSpec(640, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY))
        lens.layout(0, 0, 640, 480)
        assertEquals(30, view.left); assertEquals(20, view.top); assertEquals(610, view.right)
        assertNull(view.background)
        assertTrue("Activity remains above the menu", view.bottom < 140)
        val title = children.filterIsInstance<TextView>().first()
        assertEquals(2, title.maxLines)
        assertTrue("Explicit duration remains visible", labels.contains(line.elapsed))
        line.title?.let { assertTrue(labels.contains(it)); assertTrue(labels.contains(line.text)) }
        for (child in children.filterIsInstance<TextView>()) {
            val rect = android.graphics.Rect()
            child.getDrawingRect(rect)
            view.offsetDescendantRectToMyCoords(child, rect)
            assertTrue("Text must fit the optical band", rect.bottom <= 108)
            assertTrue("Text lines must be fully visible", child.layout.getLineBottom(child.lineCount - 1) <= child.height)
        }
        val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
        lens.draw(Canvas(bitmap))
        var painted = 0
        for (y in 0 until 480) for (x in 0 until 640) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) {
                assertTrue("Pixel outside top safe band: $x,$y", x in 30 until 610 && y in 20 until 128)
                painted++
            }
        }
        assertTrue("Native renderer must paint text", painted > 20)
        System.getenv("ACTIVITY_SCREENSHOT_DIR")?.let { directory ->
            File(directory).mkdirs()
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        bitmap.recycle()
    }
}
