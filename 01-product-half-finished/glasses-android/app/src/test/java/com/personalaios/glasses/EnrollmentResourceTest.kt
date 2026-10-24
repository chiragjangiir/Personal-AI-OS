package com.personalaios.glasses

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.CoroutineContext

class EnrollmentResourceTest {
    private class QueueDispatcher : CoroutineDispatcher() {
        private val tasks = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { tasks.addLast(block) }
        fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private class Camera { var closes = 0; fun close() { closes++ } }
    private class Scan {
        val dispatcher = QueueDispatcher()
        val owner = EnrollmentResource<Camera> { it.close() }
        var delivered: Camera? = null
        val job = CoroutineScope(Job() + dispatcher).launch {
            try { delivered = owner.await() } finally { owner.close() }
        }
        init { dispatcher.drain() }
    }

    @Test fun cancellationAfterCallbackBeforeAwaitResumesClosesOnce() {
        val scan = Scan(); val camera = Camera()
        scan.owner.complete(camera)
        scan.job.cancel(); scan.dispatcher.drain()
        assertNull(scan.delivered)
        assertEquals(1, camera.closes)
    }

    @Test fun cancellationBeforeCallbackClosesLateCameraOnce() {
        val scan = Scan(); val camera = Camera()
        scan.job.cancel(); scan.dispatcher.drain()
        scan.owner.complete(camera)
        assertNull(scan.delivered)
        assertEquals(1, camera.closes)
    }

    @Test fun successfulHandoffClosesOnceAtTeardown() {
        val scan = Scan(); val camera = Camera()
        scan.owner.complete(camera)
        assertEquals(0, camera.closes)
        scan.dispatcher.drain()
        assertSame(camera, scan.delivered)
        assertEquals(1, camera.closes)
    }

    @Test fun cameraFailureAfterCallbackBeforeResumeClosesOnce() {
        val scan = Scan(); val camera = Camera()
        scan.owner.complete(camera)
        scan.owner.fail(camera, IllegalStateException("disconnected"))
        scan.job.cancel(); scan.dispatcher.drain()
        assertNull(scan.delivered)
        assertEquals(1, camera.closes)
    }
}
