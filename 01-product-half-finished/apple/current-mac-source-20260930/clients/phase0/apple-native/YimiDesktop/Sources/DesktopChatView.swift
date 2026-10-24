import AppKit
import SwiftUI
import DesktopKit

struct DesktopChatView: View {
    @ObservedObject var model: DesktopAppModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.desktopRendering) private var rendering
    @State private var dropTargeted = false
    @State private var scroll = YimiChatScrollState()
    @State private var viewportHeight: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @AppStorage("desktop.chatTextSize") private var chatTextSize = 14.0
    var body: some View {
        VStack(spacing: 0) {
            if model.connectionLabel == "这台电脑已解除配对" {
                VStack(spacing: 18) {
                    Image(systemName: "desktopcomputer.trianglebadge.exclamationmark").font(.system(size: 42)).foregroundStyle(Yimi.ink2)
                    Text("这台电脑已解除配对").font(.title2).fontWeight(.semibold)
                    Text("本机对话缓存已清除；活动记录、文件和文件夹设置保留。").foregroundStyle(Yimi.ink2).multilineTextAlignment(.center)
                    Button("重新添加这台电脑") { openWindow(id: "pairing") }.buttonStyle(.borderedProminent)
                }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
            if model.pause.paused || !model.connected {
                HStack {
                    Label(model.pause.paused ? "已暂停操作电脑 · 聊天照常" : model.connectionLabel,
                          systemImage: model.pause.paused ? "pause.circle" : "wifi.slash")
                    Spacer()
                    if model.pause.paused { Button("继续") { Task { await model.togglePause() } } }
                    else if !model.connected { Button("重新连接") { Task { await model.connect() } } }
                }.padding(12).background(Yimi.surface)
            }
            DesktopVoiceConfirmationCards(model: model)
            if let sharing = model.screenSharing {
                DesktopScreenSharingControls(sharing: sharing).padding(12).background(Yimi.surface)
            }
            HStack {
                Text(model.toolLockReason ?? (model.pause.paused ? "电脑操作 · 已暂停" : !model.desktopReady ? "电脑操作 · 连接中" : model.inFlight > 0 ? "电脑操作 · 进行中 · 可手动暂停" : "电脑操作 · 就绪 · 可手动暂停"))
                    .font(.caption).foregroundStyle(Yimi.ink2)
                    .accessibilityIdentifier("mac.operations.status")
                Spacer()
                Button(model.pause.paused ? "继续电脑操作" : "暂停电脑操作") { Task { await model.togglePause() } }
                    .accessibilityIdentifier("mac.operations.pause")
            }.padding(12)
            ForEach(model.errands) { errand in
                DesktopErrandStrip(errand: errand) { Task { await model.cancelErrand(errand.id) } }
            }
            ScrollViewReader { reader in
                let entries = model.chatEntries
                let viewport = viewportHeight
                DesktopContentScroll(spacing: 14, padding: EdgeInsets(top: 20, leading: 20, bottom: 20, trailing: 20)) {
                    VStack(alignment: .leading, spacing: 14) {
                        Button("载入更早的对话") { Task { await model.loadOlder() } }
                            .font(.caption).buttonStyle(.plain).foregroundStyle(Yimi.ink2)
                            .disabled(!model.canLoadOlder)
                        if entries.isEmpty {
                            Image("YimLockup").resizable().scaledToFit().frame(width: 180, height: 60)
                                .frame(maxWidth: .infinity).padding(.vertical, 40).accessibilityLabel("依米")
                        }
                        ForEach(entries) { entry in
                            switch entry {
                            case .message(let item):
                                DesktopMessageRow(item: item, textSize: chatTextSize, retry: model.canRetry(item) ? { Task { await model.retry(item) } } : nil)
                                    .disabled(model.sending).id(entry.id)
                                    .onAppear { if !rendering { Task { await model.shown(item) } } }
                                    .onChange(of: item.text) { _, _ in if !rendering { Task { await model.shown(item) } } }
                            case .activity(let activity, let collapsed):
                                DesktopActivityCard(activity: activity, collapsed: collapsed).id(entry.id)
                            case .file(let entry):
                                if let file = entry.reveal { DesktopFileResultCard(url: file) }
                            }
                        }
                        ForEach(model.confirmations) { DesktopConfirmationCard(confirmation: $0) }
                        Color.clear.frame(height: 1).id("chat.bottom")
                    }
                    .onGeometryChange(for: YimiChatScrollState.Metrics.self) { content in
                        let frame = content.frame(in: .named("chat.viewport"))
                        return .init(top: frame.minY, bottom: frame.maxY, viewport: viewport)
                    } action: { metrics in
                        _ = scroll.update(metrics)
                        contentHeight = metrics.height
                    }
                }
                .coordinateSpace(.named("chat.viewport"))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                // Rows, streaming text, cards, confirmations and a banner under the list all change these two sizes: a list
                // that was at the bottom stays there, one the owner is reading does not move. A line sent from here always
                // shows.
                .onChange(of: contentHeight) { _, _ in followLatest(reader) }
                .onChange(of: viewportHeight) { _, _ in followLatest(reader) }
                .onChange(of: entries.last?.id) { _, _ in
                    if case .message(let item)? = entries.last, item.kind == .me, item.seq == nil {
                        scroll.showLatest(); reader.scrollTo("chat.bottom", anchor: .bottom)
                    }
                }
            }.background(Yimi.paper)
            if let error = model.error { Text(error).foregroundStyle(Yimi.danger).padding(8).textSelection(.enabled) }
            DesktopComposerView(model: model, composer: model.composer)
            }
        }
        .background(Yimi.ground).foregroundStyle(Yimi.ink).tint(Yimi.klein)
        .frame(minWidth: 360, minHeight: 480)
        .navigationTitle("依米")
        .toolbar {
            ToolbarItem(placement: .principal) {
                DesktopIdentityHeader(model: model, showsConnection: false)
            }
            ToolbarItem {
                Button { openWindow(id: "call") } label: { Label("通话", systemImage: "phone") }
                    .accessibilityIdentifier("mac.call.open")
            }
            ToolbarItem { Button { openWindow(id: "activity") } label: { Label("活动", systemImage: "clock.arrow.circlepath") } }
        }
        .overlay(alignment: .top) { if dropTargeted { Text("松开，把文件交给依米").padding(12).background(Yimi.tint, in: Capsule()).padding() } }
        .onDrop(of: [.fileURL, .pdf, .image, .rtf, .html], isTargeted: $dropTargeted) { providers in
            guard model.connectionLabel != "这台电脑已解除配对" else { return false }
            return model.composer.receive(providers: providers)
        }
    }
}

extension DesktopChatView {
    fileprivate func followLatest(_ reader: ScrollViewProxy) {
        if scroll.pinned { reader.scrollTo("chat.bottom", anchor: .bottom) }
    }
}

struct DesktopMessageRow: View {
    let item: YimiItem
    var textSize: Double = 14
    var retry: (() -> Void)? = nil
    var body: some View {
        HStack(alignment: .top) {
            if item.kind == .me { Spacer(minLength: 70) }
            VStack(alignment: .leading, spacing: 8) {
                Text(item.text).font(.system(size: textSize)).textSelection(.enabled)
                ForEach(Array((item.attachments ?? []).enumerated()), id: \.offset) { _, file in
                    Label(file.name, systemImage: "doc").font(.callout).padding(7)
                        .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
                HStack {
                    Text(item.date, style: .time)
                    if let via = item.via, via != "text" { Text(via == "ptt" ? "按住说话" : via) }
                    if let status = item.deliveryStatus {
                        Text(status).accessibilityIdentifier(item.isQueued ? "desktop.message.queued" : "desktop.message.delivery")
                    }
                }.font(.caption2).opacity(0.65)
                if let retry {
                    Button(item.delivery == .unconfirmed ? "重发这段文字（如已送达会重复）" : item.via == "ptt" ? "重发这段文字" : "重试发送", action: retry)
                        .buttonStyle(.bordered).font(.caption)
                        .accessibilityIdentifier("desktop.message.retry")
                }
            }
            .padding(12).foregroundStyle(item.kind == .me ? Color.white : Yimi.ink)
            .background(item.kind == .me ? Yimi.klein : Yimi.surface, in: DesktopBubbleShape(mine: item.kind == .me))
            .frame(maxWidth: 420, alignment: item.kind == .me ? .trailing : .leading)
            if item.kind != .me { Spacer(minLength: 70) }
        }
    }
}

struct DesktopConfirmationCard: View {
    let confirmation: CentralPendingConfirmation
    @State private var receivedAt = Date()
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("等你在手机上确认", systemImage: "iphone").fontWeight(.semibold)
                Spacer()
                TimelineView(.periodic(from: receivedAt, by: 1)) { context in
                    let remaining = max(0, confirmation.expires_in_ms / 1000 - Int(context.date.timeIntervalSince(receivedAt)))
                    Text(remaining > 0 ? "还剩 \(remaining / 60):" + String(format: "%02d", remaining % 60) : "已过期")
                        .font(.caption).monospacedDigit().foregroundStyle(Yimi.ink2)
                }
            }
            if let text = confirmation.text { Text(text).textSelection(.enabled) }
            Label("在手机上确认", systemImage: "iphone").font(.callout.weight(.semibold)).foregroundStyle(Yimi.klein)
            Text("请在手机上回答，这里只显示状态。").font(.callout).foregroundStyle(Yimi.ink2)
            Text("付款只在手机上确认 · 电脑上不会出现付款按钮").font(.caption).foregroundStyle(Yimi.ink3)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Yimi.tint, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Yimi.tint2))
            .onChange(of: confirmation.expires_in_ms) { _, _ in receivedAt = Date() }
    }
}

struct DesktopErrandStrip: View {
    let errand: CentralErrand
    @Environment(\.desktopRendering) private var rendering
    var stop: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(errand.title).fontWeight(.medium)
                if errand.maxSteps > 0 {
                    if rendering {
                        GeometryReader { geometry in
                            Capsule().fill(Yimi.hair).overlay(alignment: .leading) {
                                Capsule().fill(Yimi.klein).frame(width: geometry.size.width * min(1, max(0, Double(errand.step) / Double(errand.maxSteps))))
                            }
                        }.frame(height: 4)
                    } else { ProgressView(value: Double(errand.step), total: Double(errand.maxSteps)) }
                    Text("第 \(errand.step) 步 · \(errand.step)/\(errand.maxSteps)").font(.caption).foregroundStyle(Yimi.ink2)
                } else { ProgressView().controlSize(.small) }
            }
            Spacer()
            Button("停下", role: .destructive, action: stop).buttonStyle(.plain).foregroundStyle(Yimi.danger)
        }.padding(14).background(Yimi.surface)
    }
}

struct DesktopBubbleShape: Shape {
    let mine: Bool
    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: mine ? 20 : 6,
                               bottomTrailingRadius: mine ? 6 : 20, topTrailingRadius: 20, style: .continuous).path(in: rect)
    }
}

struct DesktopFileResultCard: View {
    let url: URL
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.fill").font(.title2).foregroundStyle(Yimi.klein)
            VStack(alignment: .leading, spacing: 5) {
                Text(url.lastPathComponent).fontWeight(.medium)
                Text("已保存 · " + url.deletingLastPathComponent().path).font(.caption).foregroundStyle(Yimi.ink2).lineLimit(1)
                Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([url]) }.font(.callout)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.down.doc").foregroundStyle(Yimi.ink3).accessibilityHidden(true)
        }.padding(14).frame(maxWidth: 420, alignment: .leading)
            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Yimi.hair))
            .onDrag { NSItemProvider(object: url as NSURL) }
            .accessibilityHint("可以把文件拖到访达")
    }
}

/// The same display component as the phone; width only changes how many items are visible.
private struct DesktopActivityCard: View {
    let activity: ActivityPresentation
    let collapsed: Bool
    var body: some View {
        ViewThatFits(in: .horizontal) {
            YimiActivityCard(activity: activity, collapsed: collapsed, wide: true).frame(width: 560)
            YimiActivityCard(activity: activity, collapsed: collapsed)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
