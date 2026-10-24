import SwiftUI

struct YimiWatchHomeView: View {
    @ObservedObject var store: WatchYimiStore
    let phoneReachable: Bool
    let talk: () -> Void
    let ride: () -> Void
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(phoneReachable ? WatchStateReducer.linkText(.ok) : "手机不在身边").foregroundStyle(Yimi.ink2)
                    if phoneReachable { LiveDot(size: 7) }
                }.font(.callout)
                if store.state?.link == .server_unreachable {
                    Text(WatchStateReducer.linkText(.server_unreachable)).font(.footnote).foregroundStyle(Yimi.ink2)
                }
                if let care = store.state?.care {
                    NavigationLink { YimiWatchCareView(store: store, care: care, talk: talk) } label: {
                        homeCard("你还好吗？", care.text, question: true)
                    }.buttonStyle(.plain)
                }
                if let question = store.state?.question, let expiry = WatchStateReducer.date(question.expires_at), expiry.addingTimeInterval(2) > context.date {
                    NavigationLink { YimiWatchQuestionView(store: store, question: question, talk: talk) } label: {
                        homeCard("她在问你", expiry <= context.date ? "这个问题过时了，她会再问你" : question.question ?? "选一个告诉依米", question: expiry > context.date)
                    }.buttonStyle(.plain).disabled(expiry <= context.date)
                }
                ForEach(store.state?.errands ?? [], id: \.job_id) { errand in
                    NavigationLink { YimiWatchErrandView(store: store, errand: errand) } label: {
                        HStack(spacing: 8) {
                            ProgressRing(progress: errand.max_steps > 0 ? Double(errand.step) / Double(errand.max_steps) : nil)
                                .scaleEffect(0.65).frame(width: 28, height: 28)
                            VStack(alignment: .leading) {
                                Text(errand.title).font(.headline)
                                Text("第 \(errand.step) 步" + elapsed(errand.started_at, now: context.date)).font(.footnote).foregroundStyle(Yimi.ink2)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(9)
                            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: Yimi.Radius.watchCard))
                    }.buttonStyle(.plain)
                }
                if let latest = store.state?.latest {
                    NavigationLink { YimiWatchMessageView(message: latest, talk: talk) } label: {
                        homeCard("她刚说", latest.lines.joined(separator: "\n"))
                    }.buttonStyle(.plain)
                }
                if let payment = store.state?.payment_pending, payment.count > 0 {
                    homeCard("有一笔付款等你确认", "\(payment.summary)\n请在 iPhone 上确认。手表不能付款。")
                }
                NavigationLink { YimiWatchAppearanceView() } label: {
                    Label("她的样子", systemImage: "person.crop.circle")
                }.accessibilityIdentifier("watch.appearance.open")
                if let error = store.lastError { Text(error).font(.footnote).foregroundStyle(Yimi.danger) }
            }.padding(.horizontal, 8)
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button(action: ride) { Image(systemName: "bicycle").frame(minWidth: 36, minHeight: 40) }
                    .buttonStyle(.bordered).clipShape(Circle()).accessibilityLabel("开始骑行")
                Button(action: talk) { Label("说话", systemImage: "mic.fill").frame(minHeight: 40) }
                    .buttonStyle(.borderedProminent).tint(Yimi.klein)
            }.padding(.horizontal, 8).background(.black.opacity(0.95))
        }
        .navigationTitle("")
        .toolbar { ToolbarItem(placement: .topBarLeading) { YimiWatchHeader() } }
        }
    }
    private func elapsed(_ timestamp: String?, now: Date) -> String {
        guard let timestamp, let start = WatchStateReducer.date(timestamp) else { return "" }
        return " · 已用 " + yimiClock(Int(max(0, now.timeIntervalSince(start))))
    }
    private func homeCard(_ label: String, _ text: String, question: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.footnote).foregroundStyle(question ? Yimi.klein : Yimi.ink3)
            Text(text).font(.body).foregroundStyle(Yimi.ink).lineLimit(question ? 2 : 3)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(9)
            .background(question ? Yimi.tint : Yimi.surface, in: RoundedRectangle(cornerRadius: Yimi.Radius.watchCard))
    }
}

struct YimiWatchHeader: View {
    var body: some View {
        Image("YimWatchHeader").resizable().scaledToFit().frame(width: 80, height: 25)
            .accessibilityLabel("依米").accessibilityIdentifier("watch.brand.header")
    }
}
