package com.personalaios.glasses

import org.json.JSONObject

/** The current call snapshot. No remembered client preference is stored. */
data class CallConversation(val mode: String, val text: String? = null,
    val actions: List<String> = emptyList(), val processedEventId: String? = null) {
    companion object {
        fun fromWire(message: JSONObject): CallConversation? {
            if (!message.has("conversation_mode")) return null
            val mode = message.getString("conversation_mode")
            require(mode in setOf("chat", "thinking"))
            val status = message.optJSONObject("thinking_status")
            val actions = status?.optJSONArray("actions")
            return CallConversation(mode, status?.getString("text"),
                actions?.let { (0 until it.length()).map(it::getString) }.orEmpty(),
                if (message.has("processed_event_id")) message.getString("processed_event_id") else null)
        }
    }
}

data class CallModeRequest(val controlId: String, val mode: String)

fun conversationLabel(state: HudState): String? = state.conversation?.let {
    (if (it.mode == "thinking") "思考模式" else "聊天模式") + when {
        state.conversationPending != null -> " · 等待确认"
        state.conversationError != null -> " · 切换失败"
        else -> ""
    }
}
