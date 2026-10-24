package com.personalaios.glasses

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import org.junit.Assert.*
import org.junit.Test

class CaptureStateTest {
    @Test fun recoveryPublishesOnlyTheReconciledStateToAnImmediateCollector() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            for (status in listOf("ready", "paused", "unavailable", "capturing", "call", "closing")) {
                val failed = CaptureState(worn = true, status = "error", error = "Camera disconnected",
                    policyCurrent = true, privatePaused = false, callCameraRequested = false)
                val state = MutableStateFlow(failed)
                val observed = mutableListOf<CaptureState>()
                val collector = scope.launch { state.collect { observed += it } }
                observed.clear()

                state.reconcileCapture(clearError = true) { current ->
                    assertNull("projection must see the cleared error", current.error)
                    current.copy(status = status)
                }

                assertEquals("recovery must never publish error status without an error",
                    listOf(failed.copy(status = status, error = null)), observed)
                collector.cancel()
            }
        } finally { scope.cancel() }
    }

    @Test fun reconciliationWithoutRecoveryPreservesFailureAndCaptureGates() {
        val failed = CaptureState(worn = false, status = "error", error = "Camera disconnected",
            privacyPending = true, policyCurrent = true, callCameraRequested = false)
        val state = MutableStateFlow(failed)

        state.reconcileCapture { current ->
            assertEquals(failed, current)
            current.copy(capturing = false, closing = true)
        }

        assertEquals(failed.copy(closing = true), state.value)
    }
}
