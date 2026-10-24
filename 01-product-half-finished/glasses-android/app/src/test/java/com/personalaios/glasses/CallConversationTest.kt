package com.personalaios.glasses

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CallConversationTest {
    private class Fixture : AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val hud = MutableStateFlow(HudState(paired = true))
        val calls = CallLifecycle(scope, hud, {}, {})
        fun live(mode: String? = "chat", id: String = "call", actions: List<String> = emptyList()): JSONObject =
            JSONObject().put("operation", "call_state").put("call_id", id).put("state", "live").apply {
                if (mode != null) put("conversation_mode", mode)
                if (actions.isNotEmpty()) {
                    put("processed_event_id", "processed:one")
                    put("thinking_status", JSONObject().put("state", "failed").put("text", "请重试")
                        .put("actions", JSONArray(actions)))
                }
            }
        fun accept(mode: String? = "chat", actions: List<String> = emptyList()) {
            assertTrue(calls.receive(live(mode, actions = actions)))
        }
        fun receipt(command: JSONObject, mode: String = command.getString("conversation_mode")) = JSONObject()
            .put("schema_version", "paios.central.text-envelope.v1").put("operation", "control_receipt")
            .put("session_id", "session").put("call_id", command.getString("call_id"))
            .put("control_id", command.getString("control_id"))
            .put("requested_operation", "call_set_conversation_mode")
            .put("receipt", JSONObject().put("conversation_mode", mode))
        override fun close() { scope.cancel() }
    }

    private fun strings(array: JSONArray) = (0 until array.length()).map(array::getString)
    private fun keys(message: JSONObject) = message.keys().asSequence().toSet()
    private val schema by lazy {
        JSONObject(checkNotNull(javaClass.getResource("/formal-message.v1.json")).readText())
    }

    // Check the exact flat command contract without adding another JSON Schema implementation.
    private fun assertCommand(command: JSONObject) {
        val definition = schema.getJSONObject("inputs").getJSONObject(command.getString("operation")).getJSONObject("definition")
        val properties = definition.getJSONObject("properties")
        assertFalse(definition.getBoolean("additionalProperties"))
        assertEquals(strings(definition.getJSONArray("required")).toSet(), keys(command))
        keys(command).forEach { key ->
            val rule = properties.getJSONObject(key)
            val value = command.getString(key)
            if (rule.has("const")) assertEquals(rule.getString("const"), value)
            if (rule.has("enum")) assertTrue(strings(rule.getJSONArray("enum")).contains(value))
            if (rule.has("pattern")) assertTrue(Regex(rule.getString("pattern")).matches(value))
        }
        assertEquals(command.getString("control_id"), UUID.fromString(command.getString("control_id")).toString())
    }

    @Test fun wireCommandsAndServerSnapshotUseTheMirroredFormalContract() = Fixture().use {
        it.accept()
        val command = it.calls.setConversationMode("thinking")!!
        assertCommand(JSONObject(command.toString()))
        val receipt = it.receipt(command)
        val receiptSchema = schema.getJSONObject("outputs").getJSONObject("control_receipt")
        assertTrue(keys(receipt).containsAll(strings(receiptSchema.getJSONArray("required"))))
        val modeBranch = receiptSchema.getJSONArray("anyOf").getJSONObject(0)
        assertTrue(keys(receipt).containsAll(strings(modeBranch.getJSONArray("required"))))
        assertEquals(command.getString("operation"), modeBranch.getJSONObject("properties")
            .getJSONObject("requested_operation").getString("const"))
        it.calls.conversationReceipt(JSONObject(receipt.toString()))
        val snapshot = it.live("thinking", actions = listOf("retry", "switch_to_chat"))
            .put("schema_version", "paios.central.text-envelope.v1").put("session_id", "session")
        val statusSchema = schema.getJSONObject("outputs").getJSONObject("call_state")
            .getJSONObject("properties").getJSONObject("thinking_status")
        assertTrue(keys(snapshot.getJSONObject("thinking_status")).containsAll(strings(statusSchema.getJSONArray("required"))))
        assertEquals(listOf("retry", "switch_to_chat"), strings(statusSchema.getJSONObject("properties")
            .getJSONObject("actions").getJSONObject("items").getJSONArray("enum")))
        assertTrue(it.calls.receive(formalPacket(snapshot.toString().toByteArray(), "session")))
        assertEquals(CallConversation("thinking", "请重试", listOf("retry", "switch_to_chat"), "processed:one"), it.hud.value.conversation)
        val retry = it.calls.retryThinking()!!
        assertCommand(retry)
        assertEquals("processed:one", retry.getString("processed_event_id"))
        assertNotEquals(command.getString("control_id"), retry.getString("control_id"))
    }

    @Test fun aSwitchWaitsForItsReceiptAndIgnoresStaleOrUnrelatedControls() = Fixture().use {
        it.accept()
        assertNull(it.calls.setConversationMode("chat"))
        val first = it.calls.setConversationMode("thinking")!!
        val pending = it.hud.value.conversationPending
        assertEquals("chat", it.hud.value.conversation!!.mode)
        assertEquals("聊天模式 · 等待确认", conversationLabel(it.hud.value))
        assertNull(it.calls.setConversationMode("thinking"))
        listOf(it.receipt(first).put("call_id", "other"), it.receipt(first).put("control_id", UUID.randomUUID().toString()),
            it.receipt(first).put("requested_operation", "call_retry")).forEach { stale ->
            it.calls.conversationReceipt(stale)
            assertEquals(pending, it.hud.value.conversationPending)
        }
        assertFalse(it.calls.receive(it.live("thinking", "other")))
        assertEquals(pending, it.hud.value.conversationPending)
        it.accept("chat")
        assertEquals(pending, it.hud.value.conversationPending)
        it.calls.conversationReceipt(it.receipt(first))
        assertEquals("thinking", it.hud.value.conversation!!.mode)
        assertNull(it.hud.value.conversationPending)
        assertNull(it.hud.value.conversationError)
        val second = it.calls.setConversationMode("chat")!!
        assertNotEquals(first.getString("control_id"), second.getString("control_id"))
        it.calls.conversationReceipt(it.receipt(first))
        assertEquals(second.getString("control_id"), it.hud.value.conversationPending!!.controlId)
        it.accept("chat")
        assertNull(it.hud.value.conversationPending)
        assertEquals("chat", it.hud.value.conversation!!.mode)
    }

    @Test fun rejectionAndTransportFailureKeepTheConfirmedModeAndAllowANewSwitch() = Fixture().use {
        it.accept()
        val command = it.calls.setConversationMode("thinking")!!
        val rejected = JSONObject().put("request_operation", "call_set_conversation_mode")
            .put("control_id", command.getString("control_id")).put("error_code", "CALL_BUSY")
        assertFalse(it.calls.conversationRejected(JSONObject(rejected.toString()).put("control_id", "stale")))
        assertFalse(it.calls.conversationRejected(JSONObject(rejected.toString()).put("request_operation", "call_retry")))
        it.calls.conversationFailed(null, "unrelated")
        it.calls.conversationFailed("stale", "unrelated")
        assertNotNull(it.hud.value.conversationPending)
        assertTrue(it.calls.conversationRejected(rejected))
        assertEquals("chat", it.hud.value.conversation!!.mode)
        assertEquals("CALL_BUSY", it.hud.value.conversationError)
        assertEquals("聊天模式 · 切换失败", conversationLabel(it.hud.value))
        val next = it.calls.setConversationMode("thinking")!!
        assertNotEquals(command.getString("control_id"), next.getString("control_id"))
        assertNull(it.hud.value.conversationError)
        it.calls.conversationFailed(next.getString("control_id"), "offline")
        assertNull(it.hud.value.conversationPending)
        assertEquals("offline", it.hud.value.conversationError)
        assertEquals("chat", it.hud.value.conversation!!.mode)
    }

    @Test fun oldServersAndCallBoundariesCannotRetainConversationIntent() = Fixture().use {
        assertNull(it.calls.setConversationMode("thinking"))
        it.accept(null)
        assertNull(it.hud.value.conversation)
        assertNull(it.calls.setConversationMode("thinking"))
        assertEquals(listOf("AVATAR", "CAMERA", "MUTE", "STOP"), hudMenu(it.hud.value).map { item -> item.action })
        it.accept()
        it.calls.setConversationMode("thinking")
        it.accept(null)
        assertNull(it.hud.value.conversationPending)
        it.accept()
        it.calls.setConversationMode("thinking")
        it.calls.hangup()
        assertNull(it.calls.setConversationMode("thinking"))
        it.calls.receive(JSONObject().put("call_id", "call").put("state", "closed"))
        assertNull(it.hud.value.conversation)
        assertNull(it.hud.value.conversationPending)
        assertNull(it.hud.value.conversationError)
        it.hud.value = it.hud.value.copy(conversation = CallConversation("thinking"), conversationError = "old")
        runBlocking { it.calls.open("next") }
        assertFalse(it.calls.openToSend()!!.has("conversation_mode"))
        assertNull(it.hud.value.conversation)
        assertNull(it.hud.value.conversationPending)
        assertNull(it.hud.value.conversationError)
    }

    @Test fun serverActionsControlRetryAndSwitchBackAndKeepCameraAndMuteAvailable() = Fixture().use {
        it.accept("thinking")
        assertNull(it.calls.retryThinking())
        assertEquals(listOf("CAMERA", "MUTE", "STOP", "MODE"), hudMenu(it.hud.value).map { item -> item.action })
        it.accept("thinking", listOf("retry", "switch_to_chat"))
        val state = it.hud.value
        val menu = hudMenu(state)
        assertEquals(listOf("CAMERA", "MUTE", "STOP", "MODE", "THINK_RETRY", "THINK_CHAT"), menu.map { item -> item.action })
        for (action in listOf("THINK_RETRY", "THINK_CHAT")) {
            val screen = HudScreen.Menu(HudScreen.Talking, menu.indexOfFirst { item -> item.action == action }, 0)
            assertEquals(HudTransition(HudScreen.Talking, action), reduceHud(screen, HudGesture.Click, state, 1))
        }
        val retry = it.calls.retryThinking()!!
        assertNotEquals(retry.getString("control_id"), it.calls.retryThinking()!!.getString("control_id"))
        val switchBack = it.calls.setConversationMode("chat")!!
        assertEquals("thinking", it.hud.value.conversation!!.mode)
        it.calls.conversationReceipt(it.receipt(switchBack))
        assertNull(it.calls.retryThinking())
        assertFalse(hudMenu(it.hud.value).any { item -> item.action.startsWith("THINK_") })
        assertTrue(hudMenu(it.hud.value).any { item -> item.action == "AVATAR" })
    }

    @Test fun remoteModeChangesPreserveServerStatusTextVerbatimAndReplaceOldActions() = Fixture().use {
        it.accept("thinking", listOf("retry", "switch_to_chat"))
        val text = "主脑正在处理。\n稍后由通话原声朗读。"
        val waiting = it.live("thinking").put("thinking_status", JSONObject().put("state", "waiting").put("text", text))
        assertTrue(it.calls.receive(waiting))
        assertEquals(text, it.hud.value.conversation!!.text)
        assertNull(it.calls.retryThinking())
        assertFalse(hudMenu(it.hud.value).any { item -> item.action.startsWith("THINK_") })
        it.accept("chat")
        assertEquals(CallConversation("chat"), it.hud.value.conversation)
        assertNull(it.hud.value.conversationPending)
    }

    @Test fun modeMenuNavigatesAndPendingChoicesCannotSubmitAnotherControl() {
        val state = HudState(paired = true, callId = "call", conversation = CallConversation("chat"))
        val menu = HudScreen.Menu(HudScreen.Talking, hudMenu(state).indexOfFirst { it.action == "MODE" }, 0)
        val submenu = reduceHud(menu, HudGesture.Click, state, 5).screen as HudScreen.Menu
        assertEquals(menu.copy(focus = 0, touched = 5, modeChoices = true), submenu)
        assertEquals(listOf("MODE_CHAT", "MODE_THINKING"), hudMenu(state, true).map { it.action })
        assertTrue(hudMenu(state, true)[0].label.contains("已选"))
        val thinking = reduceHud(submenu, HudGesture.Forward, state, 6).screen
        assertEquals(HudTransition(HudScreen.Talking, "MODE_THINKING"), reduceHud(thinking, HudGesture.Click, state, 7))
        assertEquals(HudTransition(submenu.copy(modeChoices = false, touched = 8)), reduceHud(submenu, HudGesture.DoubleClick, state, 8))
        val pending = state.copy(conversationPending = CallModeRequest("control", "thinking"))
        assertTrue(hudMenu(pending, true).all { !it.enabled })
        assertEquals(HudTransition(thinking), reduceHud(thinking, HudGesture.Click, pending, 7))
    }

    @Test fun thinkingModeInvalidatesAnAlreadyAcceptedAvatarConsent() {
        val thinking = HudState(paired = true, callId = "call", conversation = CallConversation("thinking"))
        val consent = HudScreen.Consent(HudScreen.Talking, avatar = true, focus = 1, callId = "call")
        val reconciled = reconcileHud(consent, thinking)
        assertEquals(HudScreen.Talking, reconciled)
        assertNotEquals("AVATAR_ON", reduceHud(reconciled, HudGesture.Click, thinking, 0).action)
        assertFalse(hudMenu(thinking).any { it.action == "AVATAR" })
    }
}
