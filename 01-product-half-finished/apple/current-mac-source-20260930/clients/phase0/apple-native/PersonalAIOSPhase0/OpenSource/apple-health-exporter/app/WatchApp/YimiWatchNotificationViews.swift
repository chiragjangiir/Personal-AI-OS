import SwiftUI
import UserNotifications
import WatchKit

enum YimiWatchNotificationKind: String, CaseIterable {
    case question = "question_card"
    case reply = "assistant_reply"
    case payment = "payment_confirmation"
    case care = "care_checkin"

    var staticTitle: String {
        switch self {
        case .question: return "依米在问你"
        case .reply: return "依米有新消息"
        case .payment: return "有一笔付款等你确认"
        case .care: return "你还好吗？"
        }
    }
}

struct YimiWatchNotificationView: View {
    let kind: YimiWatchNotificationKind
    let title: String
    let lines: [String]
    @Environment(\.isLuminanceReduced) private var dimmed
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.headline)
            if !dimmed {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in Text(line).font(.body) }
            }
            if kind == .payment {
                Text("请在 iPhone 上确认。手表不能付款。").font(.callout).foregroundStyle(Yimi.ink2)
            } else { Text("点开回她").font(.footnote).foregroundStyle(Yimi.klein) }
        }.padding(.horizontal, 8).background(.black)
    }
}

/// Dynamic long-look only. watchOS builds its static fallback from the originating
/// notification category/title/body. The initial body below is not a static interface.
/// The system owns dismissal; these controllers never install notification actions.
class YimiWatchNotificationController: WKUserNotificationHostingController<YimiWatchNotificationView> {
    override class var sashColor: Color? { Yimi.klein }
    var kind: YimiWatchNotificationKind { .reply }
    private var notificationTitle: String?
    private var lines: [String] = []
    override var body: YimiWatchNotificationView {
        YimiWatchNotificationView(kind: kind, title: notificationTitle ?? kind.staticTitle, lines: lines)
    }
    override func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        notificationTitle = content.title.isEmpty ? kind.staticTitle : content.title
        lines = content.body.components(separatedBy: .newlines)
    }
}
final class YimiWatchQuestionNotificationController: YimiWatchNotificationController {
    override var kind: YimiWatchNotificationKind { .question }
}
final class YimiWatchReplyNotificationController: YimiWatchNotificationController {
    override var kind: YimiWatchNotificationKind { .reply }
}
final class YimiWatchPaymentNotificationController: YimiWatchNotificationController {
    override var kind: YimiWatchNotificationKind { .payment }
}
final class YimiWatchCareNotificationController: YimiWatchNotificationController {
    override var kind: YimiWatchNotificationKind { .care }
}
