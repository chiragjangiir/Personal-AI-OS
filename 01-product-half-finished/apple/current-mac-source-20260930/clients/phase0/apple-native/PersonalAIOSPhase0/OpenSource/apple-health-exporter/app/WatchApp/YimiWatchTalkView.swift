import SwiftUI
import WatchKit

struct YimiWatchTalkView: View {
    @ObservedObject var client: WatchTalkClient
    @Environment(\.dismiss) private var dismiss
    @State private var thinkingSince = Date()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                switch client.state.phase {
                case .idle:
                    Text("和依米说一句").font(.headline)
                case .listening:
                    VStack(spacing: 8) {
                        WaveBars(count: 15, maxHeight: 30, color: Yimi.klein)
                        Text("我在听…").font(.headline)
                        Text("停一下就发给她").font(.footnote).foregroundStyle(Yimi.ink2)
                    }.frame(maxWidth: .infinity)
                case .thinking:
                    if let heard = client.state.heard {
                        Text("你").font(.footnote).foregroundStyle(Yimi.ink3)
                        Text(heard).foregroundStyle(Yimi.ink2)
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        VStack(spacing: 8) {
                            ProgressRing()
                            Text(context.date.timeIntervalSince(thinkingSince) >= 8 ? "她还在办" : "她在想…")
                            if context.date.timeIntervalSince(thinkingSince) >= 8 {
                                Text("回好了会轻震告诉你，现在可以放下手腕。").font(.footnote).foregroundStyle(Yimi.ink2)
                            }
                        }.frame(maxWidth: .infinity)
                    }
                case .reply:
                    if let heard = client.state.heard { Text("你：\(heard)").font(.footnote).foregroundStyle(Yimi.ink3).lineLimit(1) }
                    Text("依米").font(.footnote).foregroundStyle(Yimi.klein)
                    Text(client.state.reply ?? "")
                case .failure:
                    Text(client.state.failure ?? "这次没能发出去").font(.headline)
                    if client.state.failureScreen == .microphone {
                        Text("在手表上打开：设置 › 隐私与安全性 › 麦克风 › 依米").font(.footnote).foregroundStyle(Yimi.ink2)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10)
        }.safeAreaInset(edge: .bottom) { bottomControl }
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button { client.cancel(); dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("不发了")
            }}
            .onChange(of: client.state.phase) { _, phase in
                if phase == .thinking { thinkingSince = Date() }
            }
            .navigationTitle(client.state.phase == .reply ? "依米" : "")
    }
    @ViewBuilder private var bottomControl: some View {
        switch client.state.phase {
        case .listening:
            Button("说完了") { client.finishByUser() }.buttonStyle(.borderedProminent).tint(Yimi.klein)
        case .thinking: EmptyView()
        case .failure:
            VStack {
                if client.state.canRetry {
                    Button("再发一次") { client.retryByUser() }.buttonStyle(.borderedProminent).tint(Yimi.klein)
                } else {
                    Button("说话") { client.startByUser() }.buttonStyle(.borderedProminent).tint(Yimi.klein)
                }
                Button("算了") { client.cancel(); dismiss() }
            }
        case .idle, .reply:
            Button { client.startByUser() } label: { Label("说话", systemImage: "mic.fill") }
                .buttonStyle(.borderedProminent).tint(Yimi.klein)
        }
    }
}
