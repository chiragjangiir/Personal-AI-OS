package com.personalaios.glasses

import kotlinx.coroutines.CompletableDeferred

/** Callback and teardown run on the same handler; await never owns the resource. */
internal class EnrollmentResource<T : Any>(private val dispose: (T) -> Unit) {
    private val ready = CompletableDeferred<T>()
    private var resource: T? = null
    private var closed = false

    fun complete(value: T) {
        if (resource === value) return
        resource = value
        if (closed) dispose(value) else ready.complete(value)
    }
    suspend fun await(): T = ready.await()
    fun fail(error: Throwable) { ready.completeExceptionally(error) }
    fun fail(value: T, error: Throwable) {
        fail(error)
        complete(value)
        close()
    }
    fun close() {
        if (closed) return
        closed = true
        ready.cancel()
        resource?.let(dispose)
    }
}
