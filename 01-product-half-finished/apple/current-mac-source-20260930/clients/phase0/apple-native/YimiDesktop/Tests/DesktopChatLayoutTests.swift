import AppKit
import SwiftUI
import XCTest

/// Live windows must settle: an idle view graph uses no main-thread CPU.
@MainActor final class DesktopChatLayoutTests: XCTestCase {
    private func text(_ count: Int, paragraphs: Int) -> String {
        let sentence = "依米把这件事拆成几步说明，每一步都写清楚要做什么、为什么这样做，以及做完以后你会看到什么结果。"
        let paragraph = String(repeating: sentence, count: max(1, count / max(1, paragraphs) / sentence.count + 1))
        return String(Array(repeating: paragraph, count: max(1, paragraphs)).joined(separator: "\n\n").prefix(count))
    }
    private func cpu() -> Double {
        var time = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time)
        return Double(time.tv_sec) + Double(time.tv_nsec) / 1e9
    }
    /// Runs the window's run loop for `seconds` and returns the main-thread CPU it used.
    private func spin(_ window: NSWindow, _ seconds: Double) -> Double {
        let start = cpu(), end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.current.run(mode: .default, before: min(end, Date().addingTimeInterval(0.02)))
            window.layoutIfNeeded(); window.displayIfNeeded()
        }
        return cpu() - start
    }

    func testLongReplyThenShortReplySettles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yimi-chat-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root)
        model.connected = true; model.connectionLabel = "已连接 · 测试环境"
        // The production conversation's shape (speaker, length, paragraphs) on the morning of the hang.
        let shape: [(YimiItem.Kind, Int, Int)] = [(.her, 229, 2), (.me, 37, 0), (.her, 17, 0), (.me, 62, 0), (.her, 1080, 4), (.me, 99, 0),
            (.her, 78, 6), (.me, 33, 0), (.her, 14, 0), (.her, 20, 0), (.me, 15, 0), (.her, 50, 0), (.her, 19, 0), (.me, 35, 0),
            (.her, 19, 0), (.her, 80, 2), (.me, 302, 0), (.her, 471, 8), (.me, 128, 0), (.her, 424, 4), (.me, 33, 0), (.her, 117, 2),
            (.me, 30, 0), (.her, 186, 4), (.me, 24, 0), (.her, 49, 0), (.me, 188, 0), (.her, 1715, 32), (.me, 373, 0)]
        let start = Date().addingTimeInterval(-36000)
        model.timeline = shape.enumerated().map { index, row in
            YimiItem(id: "row-\(index)", kind: row.0, text: text(row.1, paragraphs: row.2), date: start.addingTimeInterval(Double(index) * 60), seq: index + 1)
        }
        let host = NSHostingView(rootView: DesktopChatView(model: model))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 440, height: 660), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        _ = spin(window, 1.5)

        let long = text(700, paragraphs: 10)
        model.timeline.append(YimiItem(id: "her-long", kind: .her, text: String(long.prefix(80)), date: Date(), seq: 100))
        for count in stride(from: 160, through: 700, by: 80) {
            model.timeline[model.timeline.count - 1].text = String(long.prefix(count)); _ = spin(window, 0.05)
        }
        _ = spin(window, 2)
        model.timeline.append(YimiItem(id: "her-short", kind: .her, text: "还有一件小事：明早八点提醒你。", date: Date(), seq: 101))
        _ = spin(window, 2)

        let idle = spin(window, 2)
        XCTAssertLessThan(idle, 0.3, "The chat view graph kept updating with no new input (\(idle) s CPU in 2 s)")
    }

    func testConnectedHeaderIdlesWhileItsDotPulses() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yimi-header-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root)
        model.connected = true; model.connectionLabel = "已连接 · 测试环境"
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 320, height: 60), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DesktopIdentityHeader(model: model, showsConnection: false))
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        _ = spin(window, 1)
        let idle = spin(window, 3)
        print("connected header idle main-thread CPU: \(idle) s in 3 s")
        XCTAssertLessThan(idle, 0.3, "The header's live dot re-ran the view graph every frame (\(idle) s CPU in 3 s)")
    }

    // MARK: follow and window

    private func history(_ count: Int) -> [YimiItem] {
        let start = Date().addingTimeInterval(-Double(count) * 60)
        return (0..<count).map { YimiItem(id: "row-\($0)", kind: $0 % 2 == 0 ? .me : .her, text: "第 \($0) 句：" + text(60, paragraphs: 1),
            date: start.addingTimeInterval(Double($0) * 60), seq: $0 + 1) }
    }
    private func scrollView(in view: NSView) -> NSScrollView? {
        if let found = view as? NSScrollView { return found }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }
    /// Points of the list below the visible area.
    private func belowFold(_ scroll: NSScrollView) -> CGFloat {
        scroll.documentView.map { $0.frame.height - scroll.contentView.bounds.maxY } ?? 0
    }
    private func chat(_ model: DesktopAppModel) -> (NSWindow, NSScrollView) {
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 440, height: 660), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DesktopChatView(model: model))
        window.orderFrontRegardless()
        _ = spin(window, 1)
        return (window, scrollView(in: window.contentView!)!)
    }
    private func connectedModel() throws -> (DesktopAppModel, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("yimi-chat-" + UUID().uuidString)
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root)
        model.connected = true; model.connectionLabel = "已连接 · 测试环境"
        return (model, root)
    }

    func testLargeRestoredHistoryRendersOnlyTheTailAndOlderWidensBeforeAskingTheServer() async throws {
        let (model, root) = try connectedModel(); defer { try? FileManager.default.removeItem(at: root) }
        model.timeline = history(500)
        XCTAssertEqual(model.chatEntries.count, YimiChatWindow.tail)
        XCTAssertEqual(model.chatEntries.last?.id, "message-row-499")
        XCTAssertEqual(model.chatEntries.first?.id, "message-row-350")
        XCTAssertTrue(model.canLoadOlder, "rows are hidden, so older history is available without the server")
        await model.loadOlder(); await model.loadOlder()
        XCTAssertEqual(model.chatEntries.count, YimiChatWindow.tail + 2 * YimiChatWindow.step)
        XCTAssertEqual(model.chatEntries.first?.id, "message-row-150")
    }

    func testPinnedListFollowsANewReplyAndAReadingListDoesNotMove() throws {
        let (model, root) = try connectedModel(); defer { try? FileManager.default.removeItem(at: root) }
        model.timeline = history(400)
        let (window, scroll) = chat(model)
        defer { window.orderOut(nil); window.close() }
        XCTAssertLessThan(belowFold(scroll), 40, "opens on the newest row")
        let long = text(900, paragraphs: 6)
        model.timeline.append(YimiItem(id: "her-new", kind: .her, text: String(long.prefix(60)), date: Date(), seq: 1000))
        _ = spin(window, 0.5)
        XCTAssertLessThan(belowFold(scroll), 40, "a reply from another device while at the bottom")
        for count in stride(from: 200, through: 900, by: 140) {
            model.timeline[model.timeline.count - 1].text = String(long.prefix(count)); _ = spin(window, 0.2)
        }
        XCTAssertLessThan(belowFold(scroll), 40, "streaming growth of the last bubble while at the bottom")

        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, scroll.contentView.bounds.minY - 1500)))
        scroll.reflectScrolledClipView(scroll.contentView)
        _ = spin(window, 0.5)
        let reading = belowFold(scroll)
        XCTAssertGreaterThan(reading, 500)
        model.timeline.append(YimiItem(id: "her-later", kind: .her, text: "又一条回复", date: Date(), seq: 1001))
        _ = spin(window, 0.5)
        XCTAssertGreaterThan(belowFold(scroll), 500, "reading history: the list grew below and the view stayed")

        model.timeline.append(YimiItem(id: "me-sent", kind: .me, text: "刚发的话", date: Date(), delivery: .sending, via: "text"))
        _ = spin(window, 0.5)
        XCTAssertLessThan(belowFold(scroll), 40, "a line sent from here always shows")
    }
}
