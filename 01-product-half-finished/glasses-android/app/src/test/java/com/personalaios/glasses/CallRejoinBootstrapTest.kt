package com.personalaios.glasses

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CallRejoinBootstrapTest {
    @Test fun actualBootstrapConnectionCarriesTheOptionalServerWindow() = runBlocking {
        for (window in listOf(37L, null)) {
            val enrollment = Enrollment(PreferenceDisk().preferences, PlainTestCipher)
            val pairing = pair(DEFAULT_GATEWAY).put("media", JSONArray(listOf("audio", "data")))
            enrollment.seed(pairing)
            val client = GatewayClient(enrollment, openConnection = { url -> FakeControl(url) {
                val request = JSONObject(it.bytes.toString())
                val response = if (url.path.endsWith("bootstrap")) accepted(request).also {
                    it.getJSONObject("central_text_transport").put("call_rejoin_window_s", window).put("future_field", true)
                } else JSONObject()
                200 to response.toString()
            } }, openKey = { _, _, _ -> ByteArray(32) })
            val connection = client.connect(pairing)
            assertEquals(window, connection.callRejoinWindowS)
            if (window == null) {
                val hud = MutableStateFlow(HudState())
                val calls = CallLifecycle(this, hud, {}, {}).apply { windowS = connection.callRejoinWindowS }
                calls.open("call")
                assertTrue(calls.receive(JSONObject().put("call_id", "call").put("state", "live")))
                calls.linkLost()
                assertNull(hud.value.callId); assertEquals(AMBIENT_OFF_STATUS, hud.value.status)
            }
            client.clear()
        }
    }

    @Test fun bootstrapRejectsInvalidServerWindowsWithoutInventingAPolicy() {
        val request = bootstrapRequest()
        for (invalid in listOf(0, -1, 1.5, "7", 2147484, JSONObject.NULL)) {
            val response = accepted(request)
            response.getJSONObject("central_text_transport").put("call_rejoin_window_s", invalid)
            assertThrows(IllegalArgumentException::class.java) { ControlResponse.bootstrap(response, request, pair()) }
        }
        ControlResponse.bootstrap(accepted(request), request, pair()) // An omitted window means no call recovery.
    }
}
