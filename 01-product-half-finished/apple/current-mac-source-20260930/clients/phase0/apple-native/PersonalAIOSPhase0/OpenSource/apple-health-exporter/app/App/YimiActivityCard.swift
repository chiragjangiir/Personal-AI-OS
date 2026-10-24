import SwiftUI

/// One request, one display snapshot. Expanding never sends an action to the server.
struct YimiActivityCard: View {
    let activity: ActivityPresentation
    var collapsed = false
    var wide = false
    @State private var expanded = false

    var body: some View {
        TimelineView(.periodic(from: activity.arrivedAt, by: 1)) { context in
            if collapsed {
                VStack(alignment: .leading, spacing: 6) {
                    Button { expanded.toggle() } label: {
                        Text("已完成 · 用时 \(ActivityPresentation.duration(activity.card.elapsed_ms))")
                            .font(.caption).foregroundStyle(Yimi.ink2)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }.buttonStyle(.plain).accessibilityIdentifier("yimi.activity.collapsed")
                        .accessibilityValue(expanded ? "已展开" : "已收起")
                    if expanded { card(at: context.date) }
                }
            } else {
                card(at: context.date)
            }
        }
        .onChange(of: collapsed) { _, completed in
            if completed { expanded = false }
        }
    }

    private var visibleItems: [CentralActivityCard.Item] {
        expanded || wide ? activity.card.items : Array(activity.card.items.prefix(2))
    }
    private var showsItems: Bool {
        activity.card.items.count > 1
    }
    private func tint(at now: Date) -> Color {
        if activity.card.state == .failed || activity.card.state == .partial { return Yimi.activityFailure }
        if activity.slowSeconds(at: now) != nil { return Yimi.activitySlow }
        return activity.card.state == .succeeded ? Yimi.ok : Yimi.activityAccent
    }
    private var symbol: String {
        switch activity.card.state {
        case .running: return "clock"
        case .succeeded: return "checkmark"
        case .failed, .partial: return "exclamationmark.triangle"
        case .cancelled: return "xmark.circle"
        }
    }
    private func card(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        statusHeading(at: now)
                        Spacer(minLength: 8)
                        elapsedLabel(at: now)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        statusHeading(at: now)
                        elapsedLabel(at: now)
                    }
                }
                Text(verbatim: activity.card.summary)
                    .font(.headline).foregroundStyle(Yimi.ink).lineLimit(2).padding(.top, 5)
                if let step = activity.card.step_summary {
                    Text(verbatim: step).font(.subheadline).foregroundStyle(Yimi.ink2)
                }
                if let progress = activity.card.progress {
                    progressBar(progress, tint: tint(at: now))
                }
                if let reason = activity.card.failure_reason {
                    Text(verbatim: reason).font(.subheadline).foregroundStyle(Yimi.activityFailure)
                }
                if let seconds = activity.slowSeconds(at: now) {
                    Text("这一步较慢 · \(seconds) 秒没有新进度")
                        .font(.caption).foregroundStyle(Yimi.activitySlow)
                }
                if showsItems {
                    ForEach(visibleItems) { item in itemRow(item, at: now) }
                }
                if activity.card.omitted_items > 0 {
                    Text("另 \(activity.card.omitted_items) 项").font(.caption).foregroundStyle(Yimi.ink2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(at: now))
            .accessibilityIdentifier("yimi.activity.card")
            if activity.card.items.count > 2 && !wide {
                Divider().overlay(Yimi.hair).padding(.top, 12)
                Button {
                    expanded.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: expanded ? "chevron.up" : "chevron.right")
                        Text(expanded ? "收起" : "展开全部")
                        Spacer()
                    }.font(.subheadline).frame(minHeight: 44)
                }.buttonStyle(.plain).foregroundStyle(Yimi.activityAccent)
                    .accessibilityIdentifier("yimi.activity.expand")
                    .accessibilityValue(expanded ? "已展开" : "已收起")
            }
        }
        .padding(15)
        .background(Yimi.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Yimi.hair, lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func accessibilityLabel(at now: Date) -> String {
        let summaries: [String] = showsItems ? visibleItems.map { item -> String in
            let elapsed = item.elapsed_ms + (item.state == .running ? activity.elapsed(at: now) - activity.card.elapsed_ms : 0)
            return [item.summary, item.statusLabel, item.failure_reason ?? item.step_summary,
                    item.progress?.accessibilityLabel, "用时 \(ActivityPresentation.duration(elapsed))"]
                .compactMap { $0 }.joined(separator: "，")
        } : []
        return ([activity.accessibilityLabel(at: now).dropLast().description] + summaries).joined(separator: "，") + "。"
    }
    private func progressBar(_ progress: CentralActivityProgress, tint: Color) -> some View {
        ProgressView(value: progress.value, total: progress.total)
            .progressViewStyle(.linear).tint(tint)
            .accessibilityLabel(progress.accessibilityLabel)
    }
    private func statusHeading(at now: Date) -> some View {
        Label(activity.heading, systemImage: symbol)
            .font(.subheadline).fontWeight(.semibold).foregroundStyle(tint(at: now))
    }
    private func elapsedLabel(at now: Date) -> some View {
        Text("用时 \(ActivityPresentation.duration(activity.elapsed(at: now)))")
            .font(.caption).monospacedDigit().foregroundStyle(Yimi.ink2).fixedSize()
    }
    private func itemRow(_ item: CentralActivityCard.Item, at now: Date) -> some View {
        let attention = item.state == .failed || item.state == .partial
        let elapsed = item.elapsed_ms + (item.state == .running ? activity.elapsed(at: now) - activity.card.elapsed_ms : 0)
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: item.state == .succeeded ? "checkmark" : attention ? "exclamationmark.triangle" : item.state == .cancelled ? "xmark.circle" : "clock")
                .foregroundStyle(item.state == .succeeded ? Yimi.ok : attention ? Yimi.activityFailure : Yimi.activityAccent)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: item.summary).font(.subheadline).foregroundStyle(Yimi.ink).lineLimit(2)
                Text(verbatim: item.statusLabel).font(.caption)
                    .foregroundStyle(attention ? Yimi.activityFailure : Yimi.ink2)
                if let detail = item.failure_reason ?? item.step_summary {
                    Text(verbatim: detail).font(.caption).foregroundStyle(Yimi.ink2)
                }
                Text("用时 \(ActivityPresentation.duration(elapsed))")
                    .font(.caption2).monospacedDigit().foregroundStyle(Yimi.ink2)
                if let progress = item.progress { progressBar(progress, tint: Yimi.activityAccent) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.vertical, 8)
            .overlay(alignment: .bottom) { Rectangle().fill(Yimi.hair).frame(height: 1) }
    }
}

struct YimiActivityPill: View {
    let activity: ActivityPresentation
    var body: some View {
        TimelineView(.periodic(from: activity.arrivedAt, by: 1)) { context in
            let slow = activity.slowSeconds(at: context.date) != nil
            let failed = activity.card.state == .failed || activity.card.state == .partial
            HStack(spacing: 8) {
                Image(systemName: failed ? "exclamationmark.triangle" : activity.card.state == .succeeded ? "checkmark" : activity.card.state == .cancelled ? "xmark.circle" : "clock")
                    .foregroundStyle(failed ? Yimi.activityFailure : slow ? Yimi.activitySlow : Yimi.activityAccent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: (slow ? "这一步较慢 · " : "") + activity.pill)
                        .font(.caption).lineLimit(2)
                    Text("用时 \(ActivityPresentation.duration(activity.elapsed(at: context.date)))")
                        .font(.caption2).monospacedDigit()
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(Yimi.ink2).padding(12)
            .background(Yimi.paper, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(activity.accessibilityLabel(at: context.date))
        }
    }
}
