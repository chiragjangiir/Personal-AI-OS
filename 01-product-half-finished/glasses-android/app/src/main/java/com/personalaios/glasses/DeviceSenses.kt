package com.personalaios.glasses

import android.content.Context
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive

/** Mercury 0.2.6 exposes no wear callback; the capture owner polls at the server's cadence (default 2 s). */
open class DeviceSenses(context: Context) {
    private val resolver = context.contentResolver
    open fun wearState(): String = checkNotNull(resolver.call(android.net.Uri.parse("content://com.ffalconxr.mercury.launcher.InteractProvider"),
        "getWearingState", null, null)?.getString("wearingState")) { "Wear provider returned no state" }
}

internal suspend fun pollWear(interval: StateFlow<Long>, read: suspend () -> Unit,
    wait: suspend (Long) -> Unit = { delay(it) }) {
    interval.collectLatest { ms ->
        while (currentCoroutineContext().isActive) {
            val started = System.nanoTime()
            read()
            wait((ms - (System.nanoTime() - started) / 1000000).coerceAtLeast(0))
        }
    }
}
