package com.personalaios.glasses

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.CancellationException

class HudCardsContractTest {
    private fun packet(operation: String) = JSONObject().put("schema_version", "paios.central.text-envelope.v1")
        .put("operation", operation).put("session_id", "session")
    private fun header() = packet("result_header").apply {
        put("event_id", "event"); put("processed_event_id", "processed"); put("run_id", "run")
        put("consumed_revision", 1); put("result_revision", 1); put("reply_id", "reply"); put("reply_epoch", 1)
        put("reply_phase", "sealed"); put("reply_mode", "text"); put("run_status", "completed")
        put("reply_status", "complete"); put("result_status", "completed"); put("delivery_status", "pending")
        put("output_plan", JSONArray().put(JSONObject().put("target_device_id", "glasses")
            .put("device_type", "glasses").put("output_modes", JSONArray().put("text")).put("route_version", "route")))
        put("text_replay", "sealed"); put("text_chunk_count", 2); put("rendered_text_through_seq", 0)
        put("pending_text_chunk_count", 2); put("pending_voice_chunk_count", 0); put("voice_transport", "not_supported")
        put("voice_status", "not_requested"); put("receipt_status", "pending"); put("voice_error", JSONObject.NULL)
        put("receipt_error", JSONObject.NULL); put("receipt_sources", JSONArray()); put("receipt_refs", JSONArray())
    }
    private fun chunk(seq: Int, target: String = "glasses") = packet("display_card").put("card_id", "server-page-$seq")
        .put("title", "依米").put("lines", JSONArray().put(if (seq == 1) "第一段" else "第二段"))
        .put("priority", "normal").put("lifetime_ms", 120000).put("delivery", JSONObject()
            .put("processed_event_id", "processed").put("output_id", "output:one").put("reply_id", "reply")
            .put("target_device_id", target).put("route_version", "route").put("reply_epoch", 1).put("seq", seq).put("final", seq == 2))

    @Test fun serverReplyCardsKeepIdentityAndCannotAcknowledgeUnseenEarlierPages() {
        val hud = HudCards("glasses"); hud.accept(header(), 1000)
        assertThrows(IllegalArgumentException::class.java) { hud.accept(chunk(1, "phone"), 1001) }
        val two = hud.accept(chunk(2), 1002).single()
        assertEquals("server-page-2", two.id); assertEquals("第二段", two.lines.single()); assertNull(hud.accepted)
        assertNull(hud.replies.rendered(two.ack!!, 1003))
        val one = hud.accept(chunk(1), 1004).last()
        assertEquals("第一段", one.lines.single()); assertEquals(2, hud.accepted!!.getJSONObject("ack").getInt("highest_contiguous_seq"))
        val rendered = hud.replies.rendered(one.ack!!, 1005)!!
        assertEquals(2, rendered.getJSONObject("ack").getInt("highest_contiguous_seq"))
        assertEquals("rendered", rendered.getJSONObject("ack").getString("status"))
        val conflict = chunk(1).put("lines", JSONArray().put("冲突"))
        assertThrows(IllegalArgumentException::class.java) { hud.accept(conflict, 1006) }
        assertEquals(2, hud.accept(chunk(1), 1007).size)
        confirm(hud, rendered, 1008); assertNull(hud.accepted)
        assertTrue(hud.replies.recoveryRequests().isEmpty())
        assertTrue(hud.accept(header().put("reply_phase", "interrupted"), 1009).isEmpty())
        assertTrue(hud.accept(chunk(2), 1010).isEmpty())
        val pending = header().put("text_replay", "pending").put("rendered_text_through_seq", 1).put("pending_text_chunk_count", 1)
        val fresh = HudCards("glasses"); fresh.accept(pending, 1011)
        val replay = fresh.accept(chunk(2), 1012).single()
        assertEquals("第二段", replay.lines.single()); assertNotNull(fresh.replies.rendered(replay.ack!!, 1013))
    }
    @Test fun explicitCaptionRolesIgnoreTitlesAndMalformedUpdatesCannotReplaceText() {
        val hud = HudCards("glasses")
        fun caption(role: String, turn: Any = 7) = packet("display_card").put("card_id", "caption-$role")
            .put("title", "任意标题").put("lines", JSONArray().put(role)).put("priority", "normal").put("lifetime_ms", 30000)
            .put("caption", JSONObject().put("role", role).put("turn", turn))
        listOf("user", "assistant", "main_agent").forEach { hud.accept(caption(it), 1000) }
        assertTrue(hud.snapshot(1000).isEmpty()); assertNull(hud.accepted)
        assertEquals(listOf("user", "assistant", "main_agent"), hud.captions().map { it.role })
        assertEquals(listOf(true, false, false), hud.captions().map { it.mine })
        assertEquals(listOf(7L, 7L, 7L), hud.captions().map { it.turn })
        listOf("7", 7.5, -1, 9007199254740992L).forEach { turn ->
            assertThrows(IllegalArgumentException::class.java) { hud.accept(caption("user", turn), 1001) }
        }
        assertThrows(IllegalArgumentException::class.java) { hud.accept(caption("unknown"), 1001) }
        assertThrows(IllegalArgumentException::class.java) {
            hud.accept(caption("user").apply { getJSONObject("caption").put("extra", true) }, 1001)
        }
        assertEquals("user", hud.captions().first().text)
    }
    @Test fun transcriptLikeCardsAndDeliveredCaptionsKeepVisibleRenderingReceipts() {
        val hud = HudCards("glasses"); hud.accept(header(), 1000)
        val one = hud.accept(chunk(1).put("lifetime_ms", 8000), 1001).single()
        assertEquals("依米", one.title); assertTrue(hud.captions().isEmpty())
        assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
        val rendered = hud.replies.rendered(one.ack!!, 1002)!!
        assertEquals("rendered", rendered.getJSONObject("ack").getString("status"))
        val two = hud.accept(chunk(2).put("caption", JSONObject().put("role", "assistant").put("turn", 1)), 1003).last()
        assertTrue(hud.captions().isEmpty()); assertNotNull(two.ack)
        assertEquals(2, hud.replies.rendered(two.ack!!, 1004)!!.getJSONObject("ack").getInt("highest_contiguous_seq"))
        val generic = packet("display_card").put("card_id", "generic").put("title", "你")
            .put("lines", JSONArray().put("普通提醒")).put("priority", "normal").put("lifetime_ms", 8000)
        assertEquals("普通提醒", hud.accept(generic, 1005).last().lines.single())
        assertTrue(hud.captions().isEmpty())
    }
    private fun card(id: String = "prompt") = packet("display_card").put("card_id", id).put("title", "请选择")
        .put("lines", JSONArray().put("是否需要帮助？")).put("priority", "high").put("lifetime_ms", 30000)
        .put("actions", JSONArray().put(JSONObject().put("id", "yes").put("label", "需要")
            .put("command", JSONObject().put("operation", "card_answer").put("card_id", id).put("kind", "tap").put("answer", "yes")))
            .put(JSONObject().put("id", "no").put("label", "不用")
                .put("command", JSONObject().put("operation", "card_answer").put("card_id", id).put("kind", "tap").put("answer", "no"))))
    @Test fun genericCardsPreserveServerPresentationCommandsAndLifetime() {
        val hud = HudCards("glasses")
        val input = card().put("progress", JSONObject().put("current", 1).put("total", 3))
        val visible = hud.accept(input, 1000).single()
        assertEquals("请选择", visible.title); assertEquals(listOf("是否需要帮助？"), visible.lines)
        assertEquals("1/3", visible.progress)
        val expected = canonicalJson(input.getJSONArray("actions").getJSONObject(1).getJSONObject("command"))
        assertEquals(expected, canonicalJson(hud.action("prompt", "no", 1001)!!))
        assertTrue(hud.snapshot(31000).isEmpty()); assertNull(hud.action("prompt", "no", 31000))
        hud.accept(card(), 32000)
        assertTrue(hud.accept(card().put("lifetime_ms", 0), 32001).isEmpty())
    }
    @Test fun removalOrReconnectInvalidatesActionsAndFutureServerCommandsRemainUsable() {
        val hud = HudCards("glasses"); hud.accept(card(), 1000)
        hud.clearInteractions()
        assertNull(hud.action("prompt", "yes", 1001)); assertTrue(hud.snapshot(1001).isEmpty())
        val future = card().apply { getJSONArray("actions").getJSONObject(0).getJSONObject("command").put("operation", "future_server_action") }
        hud.accept(future, 1002)
        assertEquals("future_server_action", hud.action("prompt", "yes", 1003)!!.getString("operation"))
        assertNull(hud.action("prompt", "unknown", 1003))
    }
    @Test fun replacementUsesServerActionIdentity() {
        val hud = HudCards("glasses"); hud.accept(card(), 1)
        val replacement = card().apply { getJSONArray("actions").getJSONObject(0).put("id", "replacement") }
        hud.accept(replacement, 2)
        assertNull(hud.action("prompt", "yes", 3))
        assertEquals("yes", hud.action("prompt", "replacement", 3)!!.getString("answer"))
    }
    @Test fun shopChoicesKeepRecommendedOrderDetailsAndExactAnswerIdentity() {
        val input = card().put("actions", JSONArray())
        listOf("shop-b", "shop-a", "shop-c").forEach { id ->
            input.getJSONArray("actions").put(JSONObject().put("id", id).put("label", if (id == "shop-b") "推荐 · 乙店" else id)
                .put("lines", JSONArray().put("实付 ¥18").put("堂食店").put("20分钟送达"))
                .put("command", JSONObject().put("operation", "card_answer").put("card_id", "prompt").put("kind", "tap").put("answer", id)))
        }
        val hud = HudCards("glasses"); val shown = hud.accept(input, 1).single()
        assertEquals(listOf("shop-b", "shop-a", "shop-c"), shown.actions.map { it.id })
        assertEquals(listOf("实付 ¥18", "堂食店", "20分钟送达"), shown.actions.first().lines)
        assertEquals("shop-c", hud.action(shown.id, shown.actions.last().id, 2)!!.getString("answer"))
    }
    @Test fun failureNoticeSurvivesIncomingCardsUntilItsExpiry() {
        val hud = HudCards("glasses")
        hud.notice(1000)
        val visible = hud.accept(card(), 1001)
        assertTrue(visible.any { it.lines == listOf("这次请求未完成，请再试一次") })
        assertEquals(2, hud.snapshot(5999).size)
        assertEquals("prompt", hud.snapshot(6000).single().id)
    }
    @Test fun newestArrivalIsLastAndOldPresentationsAreBounded() {
        val hud = HudCards("glasses")
        repeat(40) { hud.accept(card("card-$it"), it.toLong()) }
        assertEquals(32, hud.snapshot(40).size)
        assertEquals("card-39", hud.snapshot(40).last().id)
        assertNull(hud.action("card-0", "yes", 40))
        hud.accept(card("card-10"), 41)
        assertEquals("card-10", hud.snapshot(41).last().id)
    }
    @Test fun reconnectRecoversResultAfterFirstChunkWithExactFieldsAndTimestamp() {
        val hud = HudCards("glasses"); hud.accept(header(), 1000)
        val ack = hud.accept(chunk(1), 1000).single().ack!!
        assertEquals("1970-01-01T00:00:01.000Z", ack.getJSONObject("ack").getString("observed_at"))
        confirm(hud, hud.replies.rendered(ack, 1001)!!, 1002)
        hud.replies.detached()
        val command = hud.replies.recoveryRequests().single()
        assertEquals(setOf("operation", "processed_event_id"), command.keys().asSequence().toSet())
        assertEquals("result", command.getString("operation")); assertEquals("processed", command.getString("processed_event_id"))
        hud.accept(header().put("text_replay", "pending").put("rendered_text_through_seq", 1).put("pending_text_chunk_count", 1), 1003)
        val remaining = hud.accept(chunk(2), 1004).last()
        confirm(hud, hud.replies.rendered(remaining.ack!!, 1005)!!, 1006)
        assertTrue(hud.replies.recoveryRequests().isEmpty())
    }
    @Test fun saturatedPendingRepliesRetainNewestDeliveryWindow() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        repeat(40) { hud.accept(header().put("processed_event_id", "pending-$it"), it.toLong()) }
        val pending = FormalReplies("glasses", JSONObject(saved)).recoveryRequests().map { it.getString("processed_event_id") }
        assertEquals((8 until 40).map { "pending-$it" }, pending)
    }
    @Test fun livePushNeverReadsResultWhileVoiceIsPendingOrPlaying() = runBlocking<Unit> {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        val sent = mutableListOf<JSONObject>(); var cycles = 0
        hud.accept(voiceHeader(count = 0), 1)
        val one = voice(1, false); val two = voice(2, true)
        val finished = CancellationException("fixture finished")
        try {
            hud.replies.observe({ command ->
                sent += command
                if (command.getString("operation") == "ack") confirm(hud, command, 1000)
            }, {
                assertTrue(sent.none { it.getString("operation") == "result" })
                when (++cycles) {
                    1 -> assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
                    2 -> {
                        hud.accept(voiceHeader(count = 2, status = "ready"), 2)
                        assertTrue(hud.replies.admitVoice(one)); assertTrue(hud.replies.admitVoice(two))
                    }
                    3 -> { assertTrue(hud.replies.canPlay(one)); hud.replies.played(one, 1000) }
                    4 -> { assertFalse(hud.replies.canPlay(one)); hud.replies.played(two, 1001) }
                    5 -> { assertTrue(hud.replies.pendingReceipts("processed").isEmpty()); throw finished }
                }
            })
        } catch (error: CancellationException) { assertSame(finished, error) }
        assertEquals(listOf("played", "played"), sent.map { it.getJSONObject("ack").getString("status") })
        assertTrue(FormalReplies("glasses", JSONObject(saved)).recoveryRequests().isEmpty())
    }
    @Test fun reconnectObservesDelayedVoiceUntilSettlementAndRealPlayback() = runBlocking<Unit> {
        val hud = HudCards("glasses"); hud.accept(voiceHeader(count = 0), 1)
        hud.replies.detached()
        val reads = mutableListOf<Long>(); val acknowledgments = mutableListOf<JSONObject>()
        var clock = 0L; var cycles = 0
        val one = voice(1, false)
        val finished = CancellationException("fixture finished")
        try {
            hud.replies.observe({ command ->
                assertEquals("processed", command.getString("processed_event_id"))
                when (command.getString("operation")) {
                    "result" -> {
                        reads += clock
                        hud.accept(voiceHeader(count = if (reads.size >= 8) 1 else 0,
                            status = if (reads.size == 9) "ready" else "pending"), 2)
                        if (reads.size == 8) assertTrue(hud.replies.admitVoice(one))
                        if (reads.size == 9) assertFalse(hud.replies.admitVoice(voice(1, true)))
                    }
                    "ack" -> { acknowledgments += command; confirm(hud, command, 1001) }
                    else -> fail("Recovery cannot start a native run")
                }
            }, { delay ->
                clock += delay
                when (++cycles) {
                    9 -> {
                        assertEquals(9, reads.size)
                        assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
                        hud.replies.played(one, 1000); assertFalse(hud.replies.canPlay(one))
                    }
                    10 -> { assertEquals(9, reads.size); throw finished }
                }
            }, { clock })
        } catch (error: CancellationException) { assertSame(finished, error) }
        assertEquals(listOf(0L, 1000L, 3000L, 7000L, 15000L, 31000L, 61000L, 91000L, 92000L), reads)
        assertEquals("played", acknowledgments.single().getJSONObject("ack").getString("status"))
        assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
    }
    @Test fun recoveryReadsMissingChunksButNotLocalRenderingOrUnconfirmedPlayback() {
        val hud = HudCards("glasses"); hud.accept(header(), 1); hud.replies.detached()
        hud.replies.recoveryRequests(0); hud.accept(header(), 2); hud.accept(chunk(2), 3)
        assertEquals("result", hud.replies.recoveryRequests(1000).single().getString("operation"))
        hud.accept(header(), 4); hud.accept(chunk(1), 5)
        assertTrue(hud.replies.recoveryRequests(30000).isEmpty())
        hud.snapshot(5).forEach { hud.replies.rendered(it.ack!!, 1000) }
        assertEquals("rendered", hud.replies.pendingReceipts("processed").single().getJSONObject("ack").getString("status"))
        assertTrue(hud.replies.recoveryRequests(60000).isEmpty())
        val audio = HudCards("glasses"); audio.accept(voiceHeader(count = 1), 1)
        val one = voice(1, false); audio.replies.admitVoice(one)
        confirm(audio, audio.replies.played(one, 1000), 2)
        audio.replies.detached(); audio.replies.recoveryRequests(0)
        audio.accept(voiceHeader(count = 1, status = "ready"), 3)
        assertEquals("result", audio.replies.recoveryRequests(1000).single().getString("operation"))
        audio.accept(voiceHeader(count = 1, status = "ready"), 4)
        val two = voice(2, true); assertTrue(audio.replies.admitVoice(two))
        assertTrue(audio.replies.recoveryRequests(30000).isEmpty())
        audio.replies.played(two, 1001)
        assertTrue(audio.replies.recoveryRequests(60000).isEmpty())
    }
    @Test fun coldRebuildRestoresUnconfirmedRenderAndPlayWithoutClaimingUnseenOutput() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        fun both() = header().put("reply_mode", "text_and_voice").put("pending_voice_chunk_count", 2)
            .put("voice_status", "pending").put("voice_transport", "wav_byte_stream_v1").apply {
                getJSONArray("output_plan").getJSONObject(0).put("output_modes", JSONArray().put("text").put("voice"))
            }
        hud.accept(both(), 1)
        val rendered = hud.replies.rendered(hud.accept(chunk(1), 2).single().ack!!, 1000)!!
        val one = voice(1, false); hud.replies.admitVoice(one)
        val played = hud.replies.played(one, 1001)
        val cold = HudCards("glasses", FormalReplies("glasses", JSONObject(saved)) { saved = it.toString() })
        assertEquals("result", cold.replies.recoveryRequests().single().getString("operation"))
        assertFalse(cold.replies.canPlay(one))
        cold.accept(both().put("text_replay", "pending"), 3)
        assertEquals(listOf(rendered.toString(), played.toString()), cold.replies.pendingReceipts("processed").map { it.toString() })
        assertFalse(cold.replies.admitVoice(one))
        confirm(cold, rendered, 4); confirm(cold, played, 5)
        val remaining = cold.accept(chunk(2), 6).single().ack!!
        assertEquals(2, cold.accepted!!.getJSONObject("ack").getInt("highest_contiguous_seq"))
        confirm(cold, cold.replies.rendered(remaining, 1002)!!, 7)
        val two = voice(2, true); assertTrue(cold.replies.admitVoice(two)); assertTrue(cold.replies.canPlay(two))
        confirm(cold, cold.replies.played(two, 1003), 8)
        cold.accept(both().put("voice_status", "ready").put("pending_voice_chunk_count", 0), 9)
        assertTrue(FormalReplies("glasses", JSONObject(saved)).recoveryRequests().isEmpty())
        assertThrows(IllegalArgumentException::class.java) { FormalReplies("different-device", JSONObject(saved)) }
    }
    @Test fun coldAcceptedIdentitySurvivesBeforeAnyResultHeaderAndDoesNotResubmit() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        hud.accept(packet("accepted").put("processed_event_id", "processed"), 1)
        val cold = FormalReplies("glasses", JSONObject(saved))
        assertEquals("result", cold.recoveryRequests(0).single().getString("operation"))
        assertTrue(cold.recoveryRequests(30000).isEmpty()) // One outstanding read per D.
        assertTrue(cold.rejected(packet("rejected").put("request_operation", "result")
            .put("processed_event_id", "processed").put("error_code", "RUN_NOT_ACCEPTED")))
        assertTrue(cold.recoveryRequests(0).isEmpty())
        assertEquals("result", cold.recoveryRequests(1000).single().getString("operation"))
        assertTrue(cold.pendingReceipts("processed").isEmpty())
    }
    @Test fun uncorrelatedResultRejectionLeavesTheOutstandingRecoveryReadIntact() {
        val hud = HudCards("glasses")
        hud.accept(packet("accepted").put("processed_event_id", "processed"), 1)
        assertEquals("processed", hud.replies.recoveryRequests(0).single().getString("processed_event_id"))
        val rejection = packet("rejected").put("request_operation", "result")
            .put("processed_event_id", JSONObject.NULL).put("event_id", JSONObject.NULL)
            .put("control_id", JSONObject.NULL).put("error_code", "FORMAL_TEXT_RESULT_INVALID")
        assertFalse(hud.replies.rejected(rejection))
        assertTrue(hud.replies.recoveryRequests(30000).isEmpty())
        val cancelled = JSONObject(rejection.toString()).put("request_operation", "cancel_playback")
            .put("processed_event_id", "processed").put("control_id", "cancel-1")
            .put("error_code", "FORMAL_CONTROL_ARGUMENT_INVALID")
        assertFalse(hud.replies.rejected(cancelled))
        assertTrue(hud.replies.recoveryRequests(30000).isEmpty())
        assertTrue(hud.replies.rejected(rejection.put("processed_event_id", "processed")
            .put("error_code", "RUN_NOT_ACCEPTED")))
        assertEquals("processed", hud.replies.recoveryRequests(30000).single().getString("processed_event_id"))
    }
    @Test fun playbackCancellationUsesTheOriginalVoiceIdentityAndFormalControlFields() {
        val voice = voice(1, true, 7)
        val control = cancelPlaybackControl(voice)
        assertEquals(setOf("operation", "control_id", "processed_event_id", "reply_epoch"), control.keys().asSequence().toSet())
        assertEquals("cancel_playback", control.getString("operation"))
        assertEquals(voice.getString("processed_event_id"), control.getString("processed_event_id"))
        assertEquals(7L, control.getLong("reply_epoch"))
        assertNotEquals(control.getString("control_id"), cancelPlaybackControl(voice).getString("control_id"))
        System.getenv("GL_CONTROL_WIRE_OUT")?.let { java.io.File(it).writeText(JSONArray().put(control).toString()) }
    }
    @Test fun coldEpochChangeDropsOldReceiptsAndCannotPlayRetiredOutput() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        hud.accept(voiceHeader(count = 1), 1)
        val old = voice(1, true); hud.replies.admitVoice(old); hud.replies.played(old, 1000)
        val cold = HudCards("glasses", FormalReplies("glasses", JSONObject(saved)) { saved = it.toString() })
        cold.accept(voiceHeader(epoch = 2, count = 1), 2)
        assertTrue(cold.replies.pendingReceipts("processed").isEmpty())
        assertFalse(cold.replies.admitVoice(old)); assertFalse(cold.replies.canPlay(old))
        val next = voice(1, true, 2); assertTrue(cold.replies.admitVoice(next)); assertTrue(cold.replies.canPlay(next))
        cold.replies.played(next, 1001)
        cold.accept(voiceHeader(epoch = 2, count = 1).put("reply_phase", "interrupted"), 3)
        assertFalse(cold.replies.canPlay(next)); assertTrue(cold.replies.pendingReceipts("processed").isEmpty())
        assertTrue(FormalReplies("glasses", JSONObject(saved)).recoveryRequests().isEmpty())
    }
    @Test fun revokedBindingClearsDurableRecoveryWithoutForgingReceipts() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        hud.accept(voiceHeader(count = 1), 1)
        val one = voice(1, true); hud.replies.admitVoice(one)
        hud.clear()
        assertFalse(hud.replies.canPlay(one)); assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
        assertTrue(FormalReplies("glasses", JSONObject(saved)).recoveryRequests().isEmpty())
    }
    @Test fun missingDStopsRepeatedReadsButRetainsRecoveryUntilAnotherConnection() {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() })
        hud.accept(voiceHeader(count = 1), 1); hud.replies.detached(); hud.replies.recoveryRequests()
        val one = voice(1, true); hud.replies.admitVoice(one)
        // Missing storage is a generic rejection on the existing gateway; it is not a delivery receipt.
        assertFalse(hud.replies.rejected(packet("rejected").put("request_operation", "result")
            .put("processed_event_id", "processed").put("error_code", "FORMAL_TEXT_REQUEST_FAILED")))
        assertTrue(hud.replies.recoveryRequests().isEmpty()); assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
        assertFalse(hud.replies.canPlay(one))
        val cold = FormalReplies("glasses", JSONObject(saved))
        assertEquals("result" to "processed", cold.recoveryRequests().single().let {
            it.getString("operation") to it.getString("processed_event_id")
        })
    }
    @Test fun completedRepliesCanRetireButPendingReceiptsRemainAvailable() {
        val hud = HudCards("glasses"); hud.accept(voiceHeader(), 1)
        val one = voice(1, false); hud.replies.admitVoice(one)
        val ack = hud.replies.played(one, 1000)
        hud.accept(voiceHeader(count = 0, status = "ready"), 1001)
        hud.accept(voiceHeader(count = 0).put("processed_event_id", "synthesis-pending"), 1002)
        repeat(40) { index ->
            hud.accept(header().put("processed_event_id", "done-$index").put("reply_mode", "none")
                .put("text_chunk_count", 0).put("pending_text_chunk_count", 0), index + 2L)
        }
        assertEquals(ack.toString(), hud.replies.pendingReceipts("processed").single().toString())
        assertTrue(hud.replies.recoveryRequests().isEmpty())
        hud.replies.detached()
        assertEquals(listOf("processed", "synthesis-pending"), hud.replies.recoveryRequests().map { it.getString("processed_event_id") })
    }
    private fun voiceHeader(epoch: Int = 1, count: Int = 3, status: String = "pending") = header().apply {
        put("reply_epoch", epoch); put("reply_mode", "voice"); put("text_chunk_count", 0)
        put("pending_text_chunk_count", 0); put("pending_voice_chunk_count", count)
        put("voice_status", status); put("voice_transport", "wav_byte_stream_v1")
        getJSONArray("output_plan").getJSONObject(0).put("output_modes", JSONArray().put("voice"))
    }
    @Test fun malformedCardCannotReplaceVisibleSnapshot() {
        val hud = HudCards("glasses")
        hud.accept(card(), 1)
        val malformed = card().put("title", "替换").apply { getJSONArray("actions").getJSONObject(1).remove("label") }
        assertThrows(org.json.JSONException::class.java) { hud.accept(malformed, 2) }
        assertEquals("请选择", hud.snapshot(2).single().title)
        assertEquals("no", hud.action("prompt", "no", 2)!!.getString("answer"))
    }
    private fun voice(seq: Int, final: Boolean, epoch: Int = 1) = packet("voice_chunk")
        .put("processed_event_id", "processed").put("event_id", "event").put("chunk", JSONObject()
            .put("output_id", "voice:one").put("reply_id", "reply").put("reply_epoch", epoch).put("target_device_id", "glasses")
            .put("route_version", "route").put("seq", seq).put("final", final).put("codec", "pcm_s16le").put("sample_rate", 16000).put("channels", 1)
            .put("text_range", JSONObject().put("start", 0).put("end", 1)).put("audio", JSONObject().put("ref", "audio:$seq")
                .put("sha256", "0".repeat(64)).put("mime", "audio/wav").put("bytes", 3244).put("duration_ms", 100)))
    private fun confirm(hud: HudCards, ack: JSONObject, now: Long) = hud.accept(packet("ack_receipt")
        .put("processed_event_id", "processed").put("receipt", JSONObject(ack.getJSONObject("ack").toString())
            .put("receipt_ref", "out-ack:" + ack.getJSONObject("ack").getInt("highest_contiguous_seq"))), now)

    @Test fun streamedVoiceWaitsForContiguousPlaybackAndKeepsEachReceipt() {
        val hud = HudCards("glasses"); hud.accept(voiceHeader(), 1)
        val one = voice(1, false); val two = voice(2, false); val three = voice(3, true)
        listOf(three, one, two).forEach { assertTrue(hud.replies.admitVoice(it)) }
        assertFalse(hud.replies.canPlay(two)); assertFalse(hud.replies.canPlay(three))
        listOf(one, two, three).forEachIndexed { index, packet ->
            assertTrue(hud.replies.canPlay(packet))
            val ack = hud.replies.played(packet, 1000L + index)
            assertEquals(index + 1, ack.getJSONObject("ack").getInt("highest_contiguous_seq"))
            assertEquals("played", ack.getJSONObject("ack").getString("status"))
            assertFalse(hud.replies.canPlay(packet))
        }
        val receipts = hud.replies.pendingReceipts("processed")
        assertEquals(listOf(1, 2, 3), receipts.map { it.getJSONObject("ack").getInt("highest_contiguous_seq") })
        receipts.forEach { confirm(hud, it, 2000) }
        assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
        hud.accept(voiceHeader(count = 0, status = "ready"), 2001)
        assertFalse(hud.replies.admitVoice(three))
    }
    @Test fun playedReplayPreservesAckAndFinalOnlyClosureDoesNotReplayAudio() {
        val hud = HudCards("glasses"); hud.accept(voiceHeader(), 1)
        val one = voice(1, false); assertTrue(hud.replies.admitVoice(one))
        val ack = hud.replies.played(one, 1000)
        assertFalse(hud.replies.admitVoice(one)); assertFalse(hud.replies.canPlay(one))
        assertEquals(ack.toString(), hud.replies.pendingReceipts("processed").single().toString())
        val closure = voice(1, true)
        assertFalse(hud.replies.admitVoice(closure)); assertFalse(hud.replies.canPlay(closure))
        val conflict = voice(1, true).apply { getJSONObject("chunk").getJSONObject("audio").put("ref", "audio:changed") }
        assertThrows(IllegalArgumentException::class.java) { hud.replies.admitVoice(conflict) }
        confirm(hud, ack, 1001)
        assertTrue(hud.replies.pendingReceipts("processed").isEmpty())
    }
    @Test fun malformedHeaderAndInterruptedTransferLeaveUnrelatedPlaybackUsable() {
        val hud = HudCards("glasses"); hud.accept(voiceHeader(), 1)
        val one = voice(1, false); val two = voice(2, true)
        val malformedVoice = voice(1, false).apply { getJSONObject("chunk").remove("seq") }
        assertThrows(org.json.JSONException::class.java) { hud.replies.admitVoice(malformedVoice) }
        hud.replies.admitVoice(one); hud.replies.admitVoice(two)
        val malformed = voiceHeader(epoch = 2).apply { remove("text_replay") }
        assertThrows(org.json.JSONException::class.java) { hud.accept(malformed, 2) }
        assertTrue(hud.replies.canPlay(one))
        hud.replies.releaseVoice(two)
        assertTrue(hud.replies.canPlay(one)); assertTrue(hud.replies.admitVoice(two))
        val ack = hud.replies.played(one, 1000)
        hud.replies.releaseVoice(one)
        assertTrue(hud.replies.canPlay(two)); assertEquals(ack.toString(), hud.replies.pendingReceipts("processed").single().toString())
    }
    @Test fun voiceWaitsForHeaderAndRetiredEpochCannotResume() = runBlocking<Unit> {
        var saved = ""
        val hud = HudCards("glasses", FormalReplies("glasses") { saved = it.toString() }); val one = voice(1, true)
        val waiting = async { hud.replies.awaitHeader(one) }
        yield(); assertFalse(waiting.isCompleted)
        assertEquals("processed", FormalReplies("glasses", JSONObject(saved)).recoveryRequests().single().getString("processed_event_id"))
        hud.accept(voiceHeader(count = 1), 1); waiting.await()
        assertTrue(hud.replies.admitVoice(one)); assertTrue(hud.replies.canPlay(one))
        hud.accept(voiceHeader(count = 1).put("reply_phase", "interrupted"), 2)
        assertFalse(hud.replies.voiceCurrent(one)); assertFalse(hud.replies.canPlay(one))
        assertThrows(IllegalArgumentException::class.java) { hud.accept(voiceHeader(count = 1), 3) }
        hud.accept(voiceHeader(epoch = 2, count = 1), 4)
        assertFalse(hud.replies.admitVoice(one)); assertFalse(hud.replies.canPlay(one))
        assertTrue(hud.replies.admitVoice(voice(1, true, 2)))
        hud.replies.releaseVoice(one)
        assertTrue(hud.replies.canPlay(voice(1, true, 2)))
        hud.accept(voiceHeader(epoch = 2, count = 0, status = "ready"), 5)
        assertFalse(hud.replies.canPlay(voice(1, true, 2)))
    }
}
