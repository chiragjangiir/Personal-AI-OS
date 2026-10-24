package com.personalaios.glasses

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlinx.coroutines.*

class WakePcmTest {
    private val epoch = 1_700_000_000_000L
    private fun feed(audio: WakePcm, tick: Int, value: Int, rate: Int = 16000, channels: Int = 1, muted: Boolean = false) {
        val count = rate / 100
        val bytes = ByteBuffer.allocate(count * channels * 2).order(ByteOrder.LITTLE_ENDIAN)
        repeat(count) { repeat(channels) { bytes.putShort(value.toShort()) } }
        bytes.flip()
        audio.onData(wakeCaptureSamples(bytes, muted), 16, rate, channels, count, 10010L + tick * 10)
    }
    private fun queue(overflows: MutableList<String> = mutableListOf()) =
        WakePcm({}, overflows::add, { epoch }, { 10000L })

    @Test fun wakeWireEnvelopeUsesCurrentBindingWithoutChangingOtherOperations() {
        val input = WakePcm.Packet("call", 0, epoch, byteArrayOf(1, 0)).message()
            .put("schema_version", "stale-schema").put("session_id", "old-binding")
        val first = outboundPacket(input, "current-binding")
        val decoded = formalPacket(first.toString().toByteArray(), "current-binding")
        assertEquals("call_pcm", decoded.getString("operation"))
        assertEquals(setOf("schema_version", "operation", "session_id", "call_id", "seq", "captured_at_ms",
            "sample_rate", "pcm_s16le_base64"), decoded.keys().asSequence().toSet())
        assertEquals(16000, decoded.getInt("sample_rate"))
        assertEquals("next-binding", outboundPacket(input, "next-binding").getString("session_id"))
        assertEquals("old-binding", input.getString("session_id"))
        val open = JSONObject().put("operation", "call_open").put("call_id", "call")
        assertEquals(setOf("operation", "call_id"), outboundPacket(open, "current-binding").keys().asSequence().toSet())
    }

    @Test fun muteRetainsOnlySilenceAndUnmuteKeepsSequenceAndCaptureTimeContinuous() {
        val audio = queue(); audio.standby(true); audio.begin("call"); audio.standby(false)
        audio.acknowledge("call")
        repeat(10) { feed(audio, it, 12345, muted = true) }
        val silent = checkNotNull(audio.next())
        assertArrayEquals(ByteArray(3200), silent.pcm)
        audio.sent(silent.callId, silent.seq)
        repeat(10) { feed(audio, 10 + it, 12345) }
        val resumed = checkNotNull(audio.next())
        assertEquals(silent.seq + 1, resumed.seq)
        assertEquals(silent.capturedAtMs + 100, resumed.capturedAtMs)
        assertEquals(12345, ByteBuffer.wrap(resumed.pcm).order(ByteOrder.LITTLE_ENDIAN).short.toInt())
    }

    @Test fun questionSeventyMsAfterWakeSurvivesSixHundredMsReceiptDelayInOrder() {
        val audio = queue(); audio.standby(true)
        repeat(100) { feed(audio, it, 11) }
        audio.begin("call"); audio.standby(false)
        // Wake word ended at t=1000ms; the question starts 70ms later, before opening acknowledgement.
        repeat(60) { feed(audio, 100 + it, if (it >= 7) 13000 else 0) }
        audio.acknowledge("stale-call"); assertNull(audio.next())
        audio.acknowledge("call")
        val packets = mutableListOf<WakePcm.Packet>()
        while (true) {
            val packet = audio.next() ?: break
            packets.add(packet); audio.sent(packet.callId, packet.seq)
        }
        assertEquals(16, packets.size)
        assertEquals((0L..15L).toList(), packets.map { it.seq })
        assertEquals((0L..15L).map { epoch + it * 100 }, packets.map { it.capturedAtMs })
        val questionFrame = ByteBuffer.wrap(packets[10].pcm).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(0, questionFrame.getShort(1119 * 2).toInt())
        assertEquals(13000, questionFrame.getShort(1120 * 2).toInt())
        assertArrayEquals(packets[10].pcm, Base64.getDecoder().decode(packets[10].message().getString("pcm_s16le_base64")))
    }

    @Test fun workerFreezeRetainsFirstQuestionWhenMainQueueIsLateByMoreThanOneSecond() {
        val audio = queue(); audio.standby(true)
        repeat(10) { feed(audio, it, 77) }
        assertTrue(audio.begin("worker-token"))
        // No main-thread acknowledgement for 1500ms; standby's ordinary one-second ring would evict sample 77.
        repeat(150) { feed(audio, 10 + it, 1000 + it) }
        assertNull(audio.next())
        audio.acknowledge("worker-token")
        assertEquals(77, ByteBuffer.wrap(audio.next()!!.pcm).order(ByteOrder.LITTLE_ENDIAN).short.toInt())
        assertFalse(audio.begin("second-token"))
    }

    @Test fun localCloseSendsQueuedFramesAndShortTailBeforeItsClosePacket() = runBlocking {
        val audio = queue(); audio.standby(true); audio.begin("call"); audio.acknowledge("call")
        repeat(17) { feed(audio, it, 2345) }
        val wire = mutableListOf<String>(); val sizes = mutableListOf<Int>()
        assertTrue(audio.finish("call", { packet ->
            feed(audio, 17, 9999) // The producer is sealed before draining, so this new speech is not retained.
            wire += packet.message().getString("operation") + ":" + packet.seq
            sizes += packet.pcm.size
        }, { wire += "call_close" }))
        assertEquals(listOf("call_pcm:0", "call_pcm:1", "call_close"), wire)
        assertEquals(listOf(3200, 2240), sizes)
        audio.end(); assertNull(audio.next())
    }

    @Test fun finalDrainWaitsForTheInFlightHeadAndNeverSendsItTwice() = runBlocking {
        val audio = queue(); audio.standby(true); audio.begin("call"); audio.acknowledge("call")
        repeat(17) { feed(audio, it, 123) }
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val wire = mutableListOf<String>()
        val streaming = launch(start = CoroutineStart.UNDISPATCHED) {
            audio.drain("call") { packet ->
                wire += "pcm:" + packet.seq
                if (packet.seq == 0L) { entered.complete(Unit); release.await() }
            }
        }
        entered.await()
        val closing = async(start = CoroutineStart.UNDISPATCHED) {
            audio.finish("call", { wire += "pcm:" + it.seq }, { wire += "call_close" })
        }
        assertFalse(closing.isCompleted)
        release.complete(Unit); streaming.join(); assertTrue(closing.await())
        assertEquals(listOf("pcm:0", "pcm:1", "call_close"), wire)
    }

    @Test fun callbackOutageAndRateChangePreserveEstimatedClockGapsAndPartialSamples() {
        val audio = queue(); audio.standby(true); audio.begin("call"); audio.acknowledge("call")
        repeat(5) { feed(audio, it, 111) }
        repeat(10) { feed(audio, 105 + it, 222) } // A one-second callback outage after the first 50ms.
        val tail = checkNotNull(audio.next())
        assertEquals(1600, tail.pcm.size); assertEquals(epoch, tail.capturedAtMs)
        audio.sent(tail.callId, tail.seq)
        val resumed = checkNotNull(audio.next())
        assertEquals(tail.seq + 1, resumed.seq); assertEquals(epoch + 1050, resumed.capturedAtMs)
        audio.sent(resumed.callId, resumed.seq)
        repeat(10) { feed(audio, 115 + it, 333, rate = 48000) }
        val changed = checkNotNull(audio.next())
        assertEquals(resumed.seq + 1, changed.seq); assertEquals(epoch + 1150, changed.capturedAtMs)
    }

    @Test fun fiveSecondsIncludingPrerollAndSendingHeadFailExplicitlyWithoutDroppingOldFrames() {
        val failures = mutableListOf<String>(); val audio = queue(failures); audio.standby(true)
        repeat(100) { feed(audio, it, 1) }
        audio.begin("call"); audio.acknowledge("call")
        val sending = checkNotNull(audio.next())
        repeat(400) { feed(audio, 100 + it, 2) }
        assertTrue(failures.isEmpty()); assertEquals(sending.seq, audio.next()!!.seq)
        feed(audio, 500, 3)
        assertEquals(listOf("call"), failures); assertNull(audio.next())
    }

    @Test fun stereoFortyEightKCaptureBecomesOneHundredMsMonoSixteenKFrames() {
        val audio = queue(); audio.standby(true)
        repeat(10) { feed(audio, it, 1234, rate = 48000, channels = 2) }
        audio.begin("call"); audio.acknowledge("call")
        val packet = checkNotNull(audio.next())
        assertEquals(3200, packet.pcm.size)
        val samples = ByteBuffer.wrap(packet.pcm).order(ByteOrder.LITTLE_ENDIAN)
        repeat(1600) { assertEquals(1234, samples.short.toInt()) }
        audio.end(); assertNull(audio.next())
    }
}
