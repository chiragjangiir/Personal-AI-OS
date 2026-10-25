import Darwin
import Foundation
import XCTest
@testable import HealthKitExporter

final class YimiActivityLayoutTests: XCTestCase {
    private func activity(_ id: String, state: CentralActivityCard.State = .succeeded) -> ActivityPresentation {
        let at = "2026-10-24T00:00:00.000Z"
        let card = CentralActivityCard(id: id, revision: 1, state: state, summary: "合成任务",
            step_summary: nil, summary_source: .generic, started_at: at, observed_at: at, last_progress_at: at,
            elapsed_ms: 1000, completed_at: state == .running ? nil : at,
            counts: .init(total: 1, running: state == .running ? 1 : 0, succeeded: state == .succeeded ? 1 : 0,
                failed: 0, cancelled: 0, partial: nil), items: [], omitted_items: 0, failure_reason: nil)
        return ActivityPresentation(update: .init(operation: "activity_update", session_id: "test",
            processed_event_id: id, card: card), arrivedAt: Date())
    }

    func testAnchorsUseWholeHistoryAndKeepRequestAndReplySemantics() {
        let date = Date()
        let items = [
            YimiItem(id: "me-first", kind: .me, text: "request", date: date, submissionProcessedID: "done"),
            YimiItem(id: "me-second", kind: .me, text: "request", date: date, submissionProcessedID: "done"),
            YimiItem(id: "her-done", kind: .her, text: "reply", date: date),
            YimiItem(id: "me-running", kind: .me, text: "request", date: date, submissionProcessedID: "running")
        ]
        let cards = [activity("done"), activity("running", state: .running), activity("missing")]
        let layout = YimiActivityLayout(items: items, activities: cards, consumer: nil)
        XCTAssertEqual(layout.under["her-done"]?.map(\.id), ["done"])
        XCTAssertNil(layout.under["me-first"])
        XCTAssertEqual(layout.under["me-running"]?.map(\.id), ["running"])
        XCTAssertEqual(layout.unanchored.map(\.id), ["missing"])
        XCTAssertEqual(layout.anchor(for: cards[0]), "her-done")
        let waiting = YimiActivityLayout(items: Array(items.prefix(2)), activities: [cards[0]], consumer: nil)
        XCTAssertEqual(waiting.under["me-first"]?.map(\.id), ["done"])
        XCTAssertEqual(waiting.under["me-second"]?.map(\.id), ["done"])
        XCTAssertEqual(waiting.anchor(for: cards[0]), "me-first")
        XCTAssertTrue(waiting.unanchored.isEmpty)
    }

    @MainActor func testOwnerScaleActivityProjection() {
        let count = ProcessInfo.processInfo.environment["YIMI_PERF_ITEMS"].flatMap(Int.init) ?? 5000
        let items = (0..<count).map { YimiItem(id: "her-\($0)", kind: .her, text: "历史", date: .distantPast) }
        let cards = [activity("missing")]
        let start = ProcessInfo.processInfo.systemUptime
        var threadTime = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &threadTime)
        let cpuStart = Double(threadTime.tv_sec) + Double(threadTime.tv_nsec) / 1_000_000_000
        var orphaned: [ActivityPresentation]
        if ProcessInfo.processInfo.environment["YIMI_PERF_LEGACY_ACTIVITY"] == "1" {
            // The pre-fix UI's exact orphan-card search, retained only to reproduce its measured regression.
            orphaned = cards.filter { card in
                !items.contains { item in
                    let replies = Set(items.filter { $0.kind == .her }.compactMap(\.processedEventID))
                    if card.collapsed(replyProcessedIDs: replies) {
                        return item.kind == .her && item.processedEventID == card.processedEventID
                    }
                    return item.kind == .me && item.activityProcessedEventID(consumer: nil) == card.processedEventID
                }
            }
        } else {
            orphaned = YimiActivityLayout(items: items, activities: cards, consumer: nil).unanchored
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &threadTime)
        let usedCPU = Double(threadTime.tv_sec) + Double(threadTime.tv_nsec) / 1_000_000_000 - cpuStart
        print("YIMI_ACTIVITY_PERF items=\(count) orphan_cards=1 wall_ms=\(elapsed * 1000) thread_cpu_ms=\(usedCPU * 1000)")
        XCTAssertEqual(orphaned.map(\.id), ["missing"])
        XCTAssertLessThan(usedCPU, 0.020, "one card must not repeatedly scan the full history")
    }
}
