package com.personalaios.glasses

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.widget.ScrollView
import android.widget.TextView

/** Movement text uses the same optical layout and typography in both eyes. */
fun moveHudTextView(context: Context, item: MoveHudText, largeText: Boolean, color: Int, unitColor: Int): View {
    val metric = item.role in setOf("speed", "heart", "navigation", "middle")
    val text = TextView(context).apply {
        text = item.text; textSize = item.size * if (largeText) 1.2f else 1f
        setTextColor(color); includeFontPadding = false
        typeface = when {
            metric -> Typeface.create(Typeface.DEFAULT, 800, false)
            item.role in setOf("say", "call_status", "overview_totals") -> Typeface.DEFAULT_BOLD
            else -> Typeface.DEFAULT
        }
        maxLines = when (item.role) { "thinking_status" -> Int.MAX_VALUE; "say", "call_status" -> 2; else -> 1 }
        ellipsize = TextUtils.TruncateAt.END
        gravity = Gravity.CENTER_VERTICAL or when {
            item.role.startsWith("heart") || item.role == "overview_selected" -> Gravity.END
            item.role.startsWith("middle") || item.role in setOf("overview_hint", "overview_alternative") -> Gravity.CENTER_HORIZONTAL
            else -> Gravity.START
        }
        if (metric) {
            fontFeatureSettings = "tnum"
            item.unit?.let { unit ->
                text = SpannableStringBuilder(item.text).apply {
                    val start = length; append("\u2009$unit")
                    for (span in listOf(RelativeSizeSpan(16f / item.size), ForegroundColorSpan(unitColor),
                        TypefaceSpan(Typeface.create(Typeface.DEFAULT, 600, false))))
                        setSpan(span, start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        if (item.role == "call_status") id = R.id.call_conversation_status
        if (item.role == "thinking_status") id = R.id.call_thinking_status
        contentDescription = item.text
    }
    return if (item.role == "thinking_status") ScrollView(context).apply { addView(text) } else text
}
