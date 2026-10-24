package com.personalaios.glasses

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeoutOrNull

class PairingAuthenticationLost(message: String) : IOException(message)
// Client startup bound reused from the existing LiveSession ready wait and CompanionService send limit.
// CallLifecycle starts this budget at local open; reconnects and opening/connecting packets do not extend it.
// This is not the server's live-call rejoin lease or its PCM-source admission timeout.
internal const val GATEWAY_READY_TIMEOUT_MS = 15_000L
class GatewayReadinessTimeout : IOException("连接超时，请重试")

/** One reconnect authority for the companion session and the device socket probe. */
class ConnectionLoop(private val wait: suspend (Long) -> Unit = { delay(it) }) {
    private var ready = CompletableDeferred<Unit>()
    fun connected() { ready.complete(Unit) }
    fun disconnected() { if (ready.isCompleted) ready = CompletableDeferred() }
    fun failed(error: Throwable) { disconnected(); ready.completeExceptionally(error) }
    suspend fun awaitConnected() = ready.await()
    suspend fun awaitConnected(timeoutMillis: Long) {
        if (withTimeoutOrNull(timeoutMillis) { ready.await(); true } == null) throw GatewayReadinessTimeout()
    }
    suspend fun run(open: suspend (connected: () -> Unit) -> Unit, onRetry: (Exception, Long) -> Unit) {
        var backoff = 1000L
        while (true) {
            try { open { connected(); backoff = 1000L } }
            catch (error: Exception) {
                disconnected()
                if (error is CancellationException && error !is TimeoutCancellationException) { ready.cancel(error); throw error }
                if (error is PairingAuthenticationLost) { ready.completeExceptionally(error); throw error }
                onRetry(error, backoff)
                wait(backoff)
                backoff = (backoff * 2).coerceAtMost(60000)
            }
        }
    }
}
