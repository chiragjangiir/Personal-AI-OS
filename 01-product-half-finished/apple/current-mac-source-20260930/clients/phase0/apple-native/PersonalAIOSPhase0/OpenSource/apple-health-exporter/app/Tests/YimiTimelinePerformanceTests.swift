import Darwin
import Foundation
import XCTest
@testable import HealthKitExporter

final class YimiTimelinePerformanceTests: XCTestCase {
    private func setting(_ name: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[name].flatMap(Int.init) ?? fallback
    }

    /// The same history and two-second terminal cadence on both sides of a source change.
    /// Time is compressed; CPU/600 estimates only this projection's share of a ten-minute call.
    @MainActor func testMainThreadCallUpdatesAtOwnerScale() {
        let count = setting("YIMI_PERF_ITEMS", 5000), calls = setting("YIMI_PERF_CALLS", 100)
        let lines = setting("YIMI_PERF_LINES", 40), ticks = setting("YIMI_PERF_TICKS", 300)
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        var history: [YimiItem] = []
        for index in 0..<(count - calls) {
            history.append(YimiItem(id: "server-\(index)", kind: index.isMultiple(of: 2) ? .me : .her,
                text: "合成历史 \(index)", date: date.addingTimeInterval(Double(index)), seq: index + 1, ownerIdentity: "owner"))
        }
        for index in 0..<calls {
            history.append(YimiItem(id: "call-history-\(index)", kind: .call, text: "",
                lines: (0..<lines).map { YimiItem.CallLine(role: $0.isMultiple(of: 2) ? "user" : "assistant", text: "历史通话 \($0)") },
                date: date.addingTimeInterval(Double(count + index)), endedAt: date))
        }
        let start = ProcessInfo.processInfo.systemUptime
        var timeline = YimiConversationTimeline(items: history)
        let expanded = timeline.items.count
        let setup = ProcessInfo.processInfo.systemUptime - start
        var terminal = YimiConversationTimeline(items: history.filter { $0.seq != nil })
        let bootstrapStart = ProcessInfo.processInfo.systemUptime
        timeline.merge(terminal, ownerIdentity: "owner")
        let bootstrap = ProcessInfo.processInfo.systemUptime - bootstrapStart
        var call = CentralCall(); call.id = "growing"; call.state = "live"
        var samples: [Double] = []
        var threadSamples: [Double] = []
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        let cpuStart = cpu(usage)
        for tick in 0..<ticks {
            XCTAssertTrue(Thread.isMainThread)
            let seq = count - calls + tick + 1
            let row = YimiItem(id: "server-\(seq)", kind: tick.isMultiple(of: 2) ? .me : .her,
                text: "新通话回合 \(tick)", date: date.addingTimeInterval(Double(count + calls + tick * 2)),
                seq: seq, ownerIdentity: "owner")
            terminal.upsert(row)
            call.lines.append(CentralCall.Line(callID: "growing", turn: tick / 2,
                role: tick.isMultiple(of: 2) ? "user" : "assistant", text: "通话 \(tick)", interrupted: false))
            call.lines = Array(call.lines.suffix(60))
            let snapshot = timeline
            let begin = ProcessInfo.processInfo.systemUptime
            let threadBegin = threadCPU()
            timeline.merge(terminal, ownerIdentity: "owner")
            timeline.accept(call, at: date.addingTimeInterval(Double(count + calls + tick * 2)))
            threadSamples.append(threadCPU() - threadBegin)
            samples.append(ProcessInfo.processInfo.systemUptime - begin)
            XCTAssertNil(snapshot.item(id: row.id), "publishing a new row must not change an already retained snapshot")
        }
        getrusage(RUSAGE_SELF, &usage)
        let usedCPU = cpu(usage) - cpuStart
        let sorted = samples.sorted(), p95 = sorted[min(sorted.count - 1, Int(Double(ticks) * 0.95))]
        let worst = sorted.last!
        let threadWorst = threadSamples.max()!
        print("YIMI_PERF inputs=\(count) calls=\(calls)x\(lines) expanded=\(expanded) ticks=\(ticks) setup_ms=\(setup * 1000) bootstrap_ms=\(bootstrap * 1000) p50_ms=\(sorted[ticks / 2] * 1000) p95_ms=\(p95 * 1000) max_ms=\(worst * 1000) max_thread_ms=\(threadWorst * 1000) cpu_s=\(usedCPU) projected_cpu_percent=\(usedCPU / Double(ticks * 2) * 100)")
        XCTAssertEqual(timeline.callLines("growing").map(\.id), (0..<ticks).map {
            "call-growing/\($0 / 2)-\($0.isMultiple(of: 2) ? "user" : "assistant")"
        })
        XCTAssertEqual(timeline.items.filter { $0.seq != nil }.count, min(5000, count - calls + ticks))
        // GB6 single-core: M1 Pro 2191, A15 2348. Round their ratio plus a 2x reserve up to 2.
        // This is a host proxy; the lead verifies the actual device's latency and whole-app CPU.
        XCTAssertLessThanOrEqual(threadWorst * 2, 0.008, "main-thread CPU projection budget; verify the allowance on the lead's device")
        XCTAssertLessThan(usedCPU * 2 / Double(ticks * 2), 0.20)
    }

    private func cpu(_ usage: rusage) -> Double {
        Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) +
            Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
    }

    private func threadCPU() -> Double {
        var time = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time)
        return Double(time.tv_sec) + Double(time.tv_nsec) / 1_000_000_000
    }
}
