import ActivityKit
import SwiftUI
import WidgetKit

@main
struct YimiCallActivityBundle: WidgetBundle {
    var body: some Widget { YimiCallActivity() }
}

struct YimiCallActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CallActivityAttributes.self) { context in
            let state = presentation(context)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    mark(size: 24)
                    Text("依米").font(.headline)
                    Spacer(minLength: 8)
                    Label(context.isStale ? "状态待确认" : "通话中", systemImage: "phone.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Label(state.title, systemImage: state.symbol)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if !state.detail.isEmpty {
                    Text(state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("点开查看通话").font(.caption2).foregroundStyle(.secondary)
            }
            .padding(16)
            .widgetURL(URL(string: "paios://call"))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("yimi.voice.activity.open-call")
        } dynamicIsland: { context in
            let state = presentation(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { mark(size: 24) }
                DynamicIslandExpandedRegion(.trailing) {
                    Label(context.isStale ? "状态待确认" : "通话中", systemImage: "phone.fill").font(.caption)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(state.title, systemImage: state.symbol)
                            .font(.headline)
                        if !state.detail.isEmpty {
                            Text(state.detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Text("点开查看通话").font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .combine)
                }
            } compactLeading: {
                mark(size: 18)
            } compactTrailing: {
                Label(state.compactTitle, systemImage: state.symbol)
                    .font(.caption2)
                    .lineLimit(1)
                    .accessibilityLabel(state.title)
                    .accessibilityIdentifier("yimi.voice.island.status")
            } minimal: {
                Image(systemName: state.symbol).accessibilityLabel("依米，\(state.title)")
            }
            .widgetURL(URL(string: "paios://call"))
        }
    }

    private func presentation(_ context: ActivityViewContext<CallActivityAttributes>) -> CallActivityAttributes.ContentState {
        context.isStale
            ? .init(title: "通话状态待确认", compactTitle: "待确认", detail: "打开依米查看当前通话", symbol: "questionmark.circle")
            : context.state
    }

    private func mark(size: CGFloat) -> some View {
        Image("YimMarkHeader").resizable().scaledToFit().frame(width: size, height: size)
            .accessibilityLabel("依米")
    }
}
