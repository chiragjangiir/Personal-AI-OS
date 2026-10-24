package com.personalaios.glasses

import java.util.PriorityQueue

object NavPolyline {
    /** Douglas-Peucker by greatest remaining geometric error, with a hard vertex budget. */
    fun simplify(points: List<NavCoordinate>, maxPoints: Int = 300): List<NavCoordinate> {
        require(maxPoints in 2..300)
        if (points.size <= maxPoints) return points.toList()
        data class Split(val start: Int, val end: Int, val index: Int, val error: Double)
        fun split(start: Int, end: Int): Split? {
            var index = -1; var error = 0.0
            for (i in start+1 until end) {
                val distance = NavMetric.projection(points[i], points[start], points[end]).second
                if (distance > error) { index = i; error = distance }
            }
            return if (index >= 0) Split(start, end, index, error) else null
        }
        val queue = PriorityQueue<Split>(compareByDescending<Split> { it.error }.thenBy { it.index })
        val retained = sortedSetOf(0, points.lastIndex)
        split(0, points.lastIndex)?.let(queue::add)
        while (retained.size < maxPoints && queue.isNotEmpty()) {
            val best = queue.remove()
            retained.add(best.index)
            split(best.start, best.index)?.let(queue::add)
            split(best.index, best.end)?.let(queue::add)
        }
        return retained.map(points::get)
    }
}
