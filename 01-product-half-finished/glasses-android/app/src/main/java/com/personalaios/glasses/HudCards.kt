package com.personalaios.glasses

import org.json.JSONObject

data class HudAction(val id: String, val label: String, val command: JSONObject, val lines: List<String>? = null)
data class HudCard(val id: String, val title: String, val lines: List<String>, val priority: Int,
    val expiresAt: Long, val progress: String? = null,
    val actions: List<HudAction> = emptyList(), val ack: JSONObject? = null, val startedAt: Long = 0)
/** A call_transcript line (mine = the owner's); the same turn's partial updates replace it in place. */
data class HudCaption(val id: String, val role: String, val turn: Long, val text: String, val at: Long) {
    val mine get() = role == "user"
}
data class HudState(val status: String = "配置连接", val cards: List<HudCard> = emptyList(),
    val paired: Boolean = false, val listening: Boolean = false, val callId: String? = null,
    val camera: Boolean = false, val busy: Boolean = false, val gateway: String = "", val capture: CaptureState = CaptureState(), val micMuted: Boolean = false,
    val ride: JSONObject? = null, val nav: JSONObject? = null, val moveAt: Long = 0, val rideAt: Long = moveAt, val say: String? = null, val sayAt: Long = 0,
    val navigationRoute: NavigationRoute? = null, val navigationFix: NavigationFix? = null,
    val routeOverviewUntil: Long = 0, val navigationMoving: Boolean = false,
    val summary: JSONObject? = null, val summaryAt: Long = 0, val captions: List<HudCaption> = emptyList(),
    val payment: PaymentNotice? = null, val paymentLock: GlassesLockState = GlassesLockState(),
    val voiceEnrollment: VoiceEnrollmentState = VoiceEnrollmentState(), val voiceSupplement: VoiceSupplementState = VoiceSupplementState(), val ambient: Boolean = false,
    val localWake: LocalWakeState = LocalWakeState.Off, val localWakeEnabled: Boolean = false, val phoneAudio: Boolean = false,
    val callPcmPublished: Boolean = false, val callClosing: Boolean = false, val callPlayback: Boolean = false, val callEnded: Boolean = false,
    val foregroundCalls: Set<String> = emptySet(), val backgroundWorkCount: Int? = null,
    val avatarPhase: String = "Off", val recording: Boolean = false,
    val conversation: CallConversation? = null, val conversationPending: CallModeRequest? = null, val conversationError: String? = null,
    val avatar: AvatarPortrait? = null, val ambientConfirmation: Boolean = false,
    val activities: List<ActivityCard> = emptyList(),
    val microphoneApplied: Microphone? = null, val ambientRequestedAt: Long = 0L, val ambientError: String? = null)

class HudCards(private val deviceId: String, val replies: FormalReplies = FormalReplies(deviceId),
    private val monotonic: () -> Long = android.os.SystemClock::elapsedRealtime) {
    private val activities = linkedMapOf<String, ActivityCard>()
    fun activities() = activities.values.toList()
    private val cards = linkedMapOf<String, HudCard>()
    private val captions = linkedMapOf<String, HudCaption>()
    private var payment: PaymentNotice? = null
    var accepted: JSONObject? = null
        private set
    fun captions() = captions.values.toList()
    fun payment(now: Long = System.currentTimeMillis()) = payment?.takeIf { it.until > now }
    fun clearPayment() { payment = null }

    fun accept(message: JSONObject, now: Long = System.currentTimeMillis()): List<HudCard> {
        snapshot(now)
        accepted = null
        when (message.getString("operation")) {
            "activity_update" -> {
                val next = ActivityCard.from(message, monotonic())
                if (next.revision > (activities[next.id]?.revision ?: -1)) {
                    activities.remove(next.id)
                    activities[next.id] = next
                }
            }
            "payment_notice" -> {
                val next = PaymentNotice.from(message, now)
                payment = if (next != null && next.paymentId == payment?.paymentId && next.state == payment?.state)
                    next.copy(until = minOf(next.until, payment!!.until)) else next
            }
            "display_card" -> {
                val id = message.getString("card_id")
                val lines = message.getJSONArray("lines").let { v -> (0 until v.length()).map { v.getString(it) } }
                val actions = message.optJSONArray("actions")?.let { v -> (0 until v.length()).map {
                    val action = v.getJSONObject(it); val command = action.getJSONObject("command")
                    val detail = action.optJSONArray("lines")?.let { v -> (0 until v.length()).map { v.getString(it) } }
                    HudAction(action.getString("id"), action.getString("label"), command, detail)
                } }.orEmpty()
                val priority = when (message.getString("priority")) {
                    "normal" -> 1; "high" -> 2; else -> error("Unknown display priority")
                }
                val progress = message.optJSONObject("progress")?.let {
                    val total = it.getInt("total"); require(total > 0) { "Progress total must be positive" }
                    "${it.getInt("current")}/$total"
                }
                val delivery = message.optJSONObject("delivery")
                val title = message.getString("title")
                val caption = if (message.has("caption")) message.getJSONObject("caption").also {
                    require(it.keys().asSequence().toSet() == setOf("role", "turn")) { "Unknown caption fields" }
                    require(it.get("role") in setOf("user", "assistant", "main_agent")) { "Unknown caption role" }
                    val turn = (it.get("turn") as? Number)?.toDouble()
                    require(turn != null && turn.isFinite() && turn in 0.0..9007199254740991.0 && turn % 1.0 == 0.0) { "Caption turn must be a safe nonnegative integer" }
                } else null
                if (delivery == null && caption != null) {
                    captions[id] = HudCaption(id, caption.getString("role"), caption.getLong("turn"), lines.joinToString(" "), now)
                    while (captions.size > 8) captions.remove(captions.keys.first())
                    return snapshot(now)
                }
                val update = if (delivery != null) replies.accept(message, now).lastOrNull() ?: return snapshot(now) else null
                val card = HudCard(id, title, lines, priority,
                    now + message.getLong("lifetime_ms"), progress = progress, actions = actions, ack = update?.cardAck,
                    startedAt = cards[id]?.startedAt ?: now)
                accepted = update?.ack
                put(card)
            }
            "accepted", "result_header", "ack_receipt" -> {
                replies.accept(message, now).forEach { update ->
                    if (update.reset) cards.values.filter { it.ack?.optString("processed_event_id") == update.id }
                        .forEach { cards.remove(it.id) }
                }
            }
        }
        return snapshot(now)
    }
    fun callFailure(text: String, now: Long = System.currentTimeMillis()): List<HudCard> {
        put(HudCard("call-failure", "", listOf(text), 2, now + 5000, startedAt = now))
        return snapshot(now)
    }
    fun notice(now: Long = System.currentTimeMillis(), text: String = "这次请求未完成，请再试一次", priority: Int = 1): List<HudCard> {
        put(HudCard("request-notice", "", listOf(text), priority, now + 5000, startedAt = now))
        return snapshot(now)
    }
    fun snapshot(now: Long = System.currentTimeMillis()): List<HudCard> {
        cards.values.filter { it.expiresAt <= now }.forEach {
            cards.remove(it.id)
        }
        return cards.values.toList()
    }
    // Arrival order is stable; the last card is the newest presentation.
    private fun put(card: HudCard) {
        cards.remove(card.id)
        cards[card.id] = card
        while (cards.size > 32) cards.remove(cards.keys.first())
    }
    fun action(cardId: String, actionId: String, now: Long = System.currentTimeMillis()): JSONObject? =
        cards[cardId]?.takeIf { it.expiresAt > now }?.actions?.firstOrNull { it.id == actionId }?.command
    fun consume(id: String) { cards.remove(id) }
    fun clearInteractions() { cards.values.filter { it.actions.isNotEmpty() }.forEach { cards.remove(it.id) } }
    fun clear() { activities.clear(); cards.clear(); captions.clear(); replies.clear(); payment = null; accepted = null }
}
