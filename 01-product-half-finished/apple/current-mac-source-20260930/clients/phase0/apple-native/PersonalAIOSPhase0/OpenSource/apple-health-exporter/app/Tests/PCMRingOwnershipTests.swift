import Foundation
import XCTest
@testable import HealthKitExporter

final class PCMRingOwnershipTests: XCTestCase {
    /// Multiple callback/control threads exercise the one owner. Each accepted frame and each snapshot is coherent.
    func testConcurrentProducersRenderFlushAndStatsRemainCoherent() {
        let ring = PCMRing(cap: 64, target: 32, prime: 16, refill: 64)
        ring.setOpen(true)
        let group = DispatchGroup(), result = RingStressResult()
        for sample in [Int16(111), Int16(222)] {
            DispatchQueue.global().async(group: group) {
                let frame = [Int16](repeating: sample, count: 16)
                for _ in 0..<4000 { frame.withUnsafeBufferPointer { ring.push($0) } }
            }
        }
        DispatchQueue.global().async(group: group) {
            var out = [Float](repeating: 0, count: 16)
            for _ in 0..<8000 {
                let taken = out.withUnsafeMutableBufferPointer { ring.pull(into: $0.baseAddress!, count: 16) }
                if taken > 0, !out.prefix(taken).allSatisfy({ $0 == out[0] && ($0 == Float(111) / 32768 || $0 == Float(222) / 32768) }) {
                    result.fail()
                }
                let stats = ring.stats()
                if !(0...ring.cap).contains(stats.buffered) ||
                    stats.pushed != stats.played + stats.overflowed + stats.discarded + stats.buffered { result.fail() }
            }
        }
        DispatchQueue.global().async(group: group) {
            for _ in 0..<2000 { ring.flush(); ring.setOpen(false); ring.setOpen(true) }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 30), .success)
        XCTAssertFalse(result.failed, "A copied frame or a synchronized accounting snapshot was torn")
        ring.flush()
        let stats = ring.stats()
        XCTAssertEqual(stats.pushed + stats.refused, 128000)
        XCTAssertEqual(stats.buffered, 0)
        XCTAssertEqual(stats.pushed, stats.played + stats.overflowed + stats.discarded)
    }
}

private final class RingStressResult: @unchecked Sendable {
    private let lock = NSLock()
    private var failure = false
    var failed: Bool { lock.withLock { failure } }
    func fail() { lock.withLock { failure = true } }
}
