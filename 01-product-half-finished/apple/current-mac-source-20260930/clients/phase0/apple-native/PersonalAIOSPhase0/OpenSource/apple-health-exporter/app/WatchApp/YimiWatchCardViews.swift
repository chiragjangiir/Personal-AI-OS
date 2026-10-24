import SwiftUI

struct YimiWatchMessageView: View {
    let message: WatchYimiLatest
    let talk: () -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 7) {
                Text("依米").font(.footnote).foregroundStyle(Yimi.ink3)
                Text(message.title).font(.title3.bold())
                ForEach(Array(message.lines.enumerated()), id: \.offset) { _, line in Text(line) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10)
        }.safeAreaInset(edge: .bottom) {
            Button(action: talk) { Label("说话", systemImage: "mic.fill") }
                .buttonStyle(.borderedProminent).tint(Yimi.klein)
        }
    }
}

struct YimiWatchErrandView: View {
    @ObservedObject var store: WatchYimiStore
    let errand: WatchYimiErrand
    @State private var confirmsStop = false
    @State private var pendingID: String?
    @State private var actionError: String?
    @State private var told = false
    private var current: WatchYimiErrand? { store.state?.errands.first { $0.job_id == errand.job_id } }
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let item = current {
                    ProgressRing(progress: item.max_steps > 0 ? Double(item.step) / Double(item.max_steps) : nil)
                    Text(item.title).font(.headline)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("第 \(item.step) 步" + elapsed(item.started_at, now: context.date))
                            .font(.footnote).foregroundStyle(Yimi.ink2).monospacedDigit()
                    }
                    Button(told ? "已告诉依米" : pendingID != nil ? "正在告诉依米…" : item.state == .stopping ? "正在停下…" : "停下") { confirmsStop = true }
                        .foregroundStyle(Yimi.danger).disabled(item.state == .stopping || pendingID != nil || told)
                } else { Text("这件事已结束") }
                if let error = actionError ?? store.lastError { Text(error).font(.footnote).foregroundStyle(Yimi.danger) }
            }.padding(.horizontal, 10)
        }.confirmationDialog("让依米停下这件事？她会马上停手；已经做完的步骤不会撤销。", isPresented: $confirmsStop, titleVisibility: .visible) {
            Button("停下", role: .destructive) {
                guard current != nil else { return }
                pendingID = store.stopErrand(jobID: errand.job_id)
            }
            Button("取消", role: .cancel) {}
        }.onChange(of: store.lastReceipt) { _, receipt in
            guard let pendingID, receipt?.requestID == pendingID else { return }
            told = receipt?.status == .accepted || receipt?.status == .duplicate
            actionError = watchActionFailure(receipt?.status)
            self.pendingID = nil
        }.onChange(of: store.lastError) { _, _ in pendingID = nil }
    }
    private func elapsed(_ timestamp: String?, now: Date) -> String {
        guard let timestamp, let start = WatchStateReducer.date(timestamp) else { return "" }
        return " · 已用 " + yimiClock(Int(max(0, now.timeIntervalSince(start))))
    }
}

struct YimiWatchQuestionView: View {
    @ObservedObject var store: WatchYimiStore
    let question: WatchYimiQuestion
    let talk: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: String?
    @State private var openedAt = Date()
    @State private var acknowledged = false
    @State private var pendingID: String?
    @State private var actionError: String?
    private var current: WatchYimiQuestion? {
        guard let current = store.state?.question, current.card_id == question.card_id else { return nil }
        return current
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = current != question || (expiry.map { $0 <= context.date } ?? true)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Text("她在问你").font(.footnote.bold()).foregroundStyle(Yimi.klein)
                    if let expiry {
                        ProgressView(value: max(0, expiry.timeIntervalSince(context.date)), total: max(1, expiry.timeIntervalSince(openedAt)))
                            .tint(Yimi.klein).accessibilityLabel("回答剩余时间")
                    }
                    Text(question.question ?? "选一个告诉依米").font(.headline)
                    if expired {
                        Text("这个问题过时了，她会再问你").foregroundStyle(Yimi.ink2)
                            .task { try? await Task.sleep(for: .seconds(2)); dismiss() }
                    } else {
                        ForEach(question.options, id: \.id) { option in
                            Button {
                                guard let current, current.options == question.options,
                                      let expiry, expiry > Date() else { return }
                                chosen = option.id
                                pendingID = store.answer(cardID: question.card_id, optionID: option.id)
                                if pendingID == nil { chosen = nil }
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    if option.recommended { Text("推荐").font(.footnote).foregroundStyle(Yimi.klein) }
                                    Text(chosen == option.id ? (acknowledged ? "✓ 已告诉依米" : "正在告诉依米…") : option.label)
                                    ForEach(Array(option.lines.enumerated()), id: \.offset) { _, line in Text(line).font(.footnote).foregroundStyle(Yimi.ink2) }
                                }.frame(maxWidth: .infinity, minHeight: 40, alignment: question.options.count == 2 ? .center : .leading)
                            }.buttonStyle(.bordered).tint(option.recommended ? Yimi.klein : Yimi.surface)
                                .disabled(chosen != nil)
                        }
                        Button("其他（说一句）", action: talk).frame(minHeight: 40)
                        if question.options.count > 2 {
                            Text("选好后，付款仍在 iPhone 上确认").font(.footnote).foregroundStyle(Yimi.ink2)
                        }
                    }
                    if let error = actionError ?? store.lastError { Text(error).font(.footnote).foregroundStyle(Yimi.danger) }
                }.padding(.horizontal, 8)
            }
        }.navigationTitle("依米")
            .onChange(of: store.lastReceipt) { _, receipt in
                guard let pendingID, receipt?.requestID == pendingID,
                      store.lastCompletedRequest?.args?.card_id == question.card_id,
                      store.lastCompletedRequest?.args?.option_id == chosen else { return }
                if receipt?.status == .accepted || receipt?.status == .duplicate {
                    acknowledged = true
                    Task { try? await Task.sleep(for: .seconds(1)); dismiss() }
                } else { chosen = nil; self.pendingID = nil; actionError = watchActionFailure(receipt?.status) }
            }.onChange(of: store.lastError) { _, _ in chosen = nil; pendingID = nil }
    }
    private var expiry: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = question.expires_at.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: question.expires_at)
    }
}

struct YimiWatchCareView: View {
    @ObservedObject var store: WatchYimiStore
    let care: WatchYimiCare
    let talk: () -> Void
    @State private var pendingID: String?
    @State private var actionError: String?
    @State private var told = false
    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("你还好吗？").font(.title3.bold())
                Text(care.text).font(.callout).foregroundStyle(Yimi.ink2)
                Button(told ? "已告诉依米" : pendingID != nil ? "正在告诉依米…" : "我没事") {
                    guard store.state?.care?.care_id == care.care_id else { return }
                    pendingID = store.careSafe(careID: care.care_id)
                }
                    .buttonStyle(.borderedProminent).tint(Yimi.okTint).foregroundStyle(Yimi.ok)
                    .frame(minHeight: 50)
                    .disabled(store.state?.care?.care_id != care.care_id || pendingID != nil || told)
                Button("和她说", action: talk)
                if let error = actionError ?? store.lastError { Text(error).font(.footnote).foregroundStyle(Yimi.danger) }
            }.padding(.horizontal, 8)
        }.navigationTitle("依米")
            .onChange(of: store.lastReceipt) { _, receipt in
                guard let pendingID, receipt?.requestID == pendingID else { return }
                told = receipt?.status == .accepted || receipt?.status == .duplicate
                actionError = watchActionFailure(receipt?.status)
                self.pendingID = nil
            }.onChange(of: store.lastError) { _, _ in pendingID = nil }
    }
}

private func watchActionFailure(_ status: WatchLocalAckStatus?) -> String? {
    switch status {
    case .accepted, .duplicate: return nil
    case .conflict: return "这件事有变化，请重新打开。"
    case .rejected: return "这次没能告诉依米，请重试。"
    case .unknown, nil: return "还没收到确认，请重试。"
    }
}
