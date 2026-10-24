package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AvatarStreamTest {
    private fun state(revision: Long = 1, avatar: Boolean = true, id: String = "call", phase: String = "live",
        token: String = "fixture") = JSONObject().put("call_id", id).put("state", phase)
        .put("avatar_revision", revision).put("avatar", avatar).put("media", JSONObject()
            .put("provider", "artc").put("audio_input", "gateway").put("user_id", "viewer")
            .put("token", token).put("token_expire_at", "200"))
    private fun stream() = AvatarStream { 100_000 }

    @Test fun defaultsOffAndNeverStartsFromUnrequestedServerMedia() {
        val stream = stream()
        val off = stream.receive(state(), "call")!!
        assertFalse(off.getBoolean("avatar"))
        assertEquals(2, off.getInt("avatar_revision"))
        assertEquals(AvatarStream.Phase.Off, stream.phase.value)
        assertNull(stream.media.value)
    }

    @Test fun explicitOnReceivesFirstFrameAndDuplicateSnapshotKeepsDecoder() {
        val stream = stream()
        val request = stream.request("call", true)!!
        assertTrue(request.getBoolean("avatar")); assertEquals(1, request.getInt("avatar_revision"))
        stream.receive(state(), "call")
        val media = stream.media.value!!
        assertEquals(AvatarStream.Phase.Joining, stream.phase.value)
        stream.drawn(media)
        stream.receive(state(), "call")
        assertSame(media, stream.media.value)
        assertEquals(AvatarStream.Phase.Playing, stream.phase.value)
    }

    @Test fun earlyReplayedAvatarCannotKeepChargingBeforeBaseCallSnapshot() {
        val stream = stream()
        val off = stream.receive(state(), null)!!
        assertFalse(off.getBoolean("avatar"))
        assertEquals("call", off.getString("call_id"))
        assertNull(stream.media.value)
        stream.receive(state(revision = 2, avatar = false), null)
        assertNull(stream.replayOff())
    }

    @Test fun offRejectsLateOnAndOldCallbacks() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val retired = stream.media.value!!
        assertEquals(2, stream.request("call", false)!!.getInt("avatar_revision"))
        stream.receive(state(), "call"); stream.drawn(retired)
        assertNull(stream.media.value); assertNull(stream.failed(retired))
        assertEquals(AvatarStream.Phase.Off, stream.phase.value)
    }

    @Test fun serverOffIsAuthoritativeAndDoesNotAutomaticallyRetry() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(avatar = false), "call")
        stream.receive(state(revision = 2), "call")
        assertNull(stream.media.value)
        assertEquals(AvatarStream.Phase.Off, stream.phase.value)
    }

    @Test fun failureEmitsExactlyOneVoiceFallbackAndDoesNotCloseCall() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val media = stream.media.value!!
        val fallback = stream.failed(media)!!
        assertEquals("call_avatar", fallback.getString("operation"))
        assertFalse(fallback.getBoolean("avatar")); assertEquals(2, fallback.getInt("avatar_revision"))
        assertNull(stream.failed(media)); assertNull(stream.unavailable())
        assertEquals(AvatarStream.Phase.Failed, stream.phase.value)
        stream.receive(state(revision = 2, avatar = false), "call")
        assertEquals(AvatarStream.Phase.Failed, stream.phase.value)
        assertNull(stream.media.value)
    }

    @Test fun repeatedOnKeepsPlayingAndDoesNotIssueAnotherCommand() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val media = stream.media.value!!; stream.drawn(media)
        assertNull(stream.request("call", true))
        assertSame(media, stream.media.value)
        assertEquals(AvatarStream.Phase.Playing, stream.phase.value)
    }

    @Test fun failedAttemptRetainsRevisionFenceForNextExplicitOn() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        stream.unavailable()
        val next = stream.request("call", true)!!
        assertEquals(3, next.getInt("avatar_revision"))
        stream.receive(state(revision = 1, avatar = false), "call")
        assertEquals(AvatarStream.Phase.Waiting, stream.phase.value)
    }

    @Test fun reconnectNeedsNewCredentialsAndPreservesExplicitIntent() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val retired = stream.media.value!!
        stream.linkLost()
        assertNull(stream.media.value); assertNull(stream.failed(retired))
        stream.receive(state(token = "rejoin"), "call")
        assertEquals("rejoin", stream.media.value!!.token)
    }

    @Test fun lostOffReplaysSameRevisionUntilServerConfirmsVoiceRoute() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val off = stream.request("call", false)!!
        stream.linkLost()
        assertSame(off, stream.replayOff())
        assertSame(off, stream.receive(state(), "call"))
        assertSame(off, stream.request("call", false))
        stream.receive(state(revision = 2, avatar = false), "call")
        assertNull(stream.replayOff())
        assertNull(stream.media.value)
    }

    @Test fun terminalStateWinsOverRevisionAndNextCallDefaultsOff() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        stream.receive(state(revision = 0, phase = "closed"), null)
        stream.receive(state(id = "next"), "next")
        assertNull(stream.media.value); assertEquals(AvatarStream.Phase.Off, stream.phase.value)
    }

    @Test fun wrongCallAndOldRevisionCannotReplaceMedia() {
        val stream = stream()
        stream.request("call", true); stream.receive(state(), "call")
        val current = stream.media.value
        stream.receive(state(id = "other"), "call")
        stream.receive(state(revision = 0, token = "old"), "call")
        assertSame(current, stream.media.value)
    }

    @Test(expected = IllegalArgumentException::class) fun expiredCredentialsAreRejected() {
        val stream = AvatarStream { 201_000 }
        stream.request("call", true); stream.receive(state(), "call")
    }

    @Test(expected = IllegalArgumentException::class) fun unsupportedCaptureOwnershipIsRejected() {
        val stream = stream(); stream.request("call", true)
        val packet = state(); packet.getJSONObject("media").put("audio_input", "client")
        stream.receive(packet, "call")
    }
}
