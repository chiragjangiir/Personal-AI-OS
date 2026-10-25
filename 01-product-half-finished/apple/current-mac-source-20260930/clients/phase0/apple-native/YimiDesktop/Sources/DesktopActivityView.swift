import AppKit
import KeyboardShortcuts
import SwiftUI
import DesktopKit

struct DesktopActivityView: View {
    @ObservedObject var model: DesktopAppModel
    @State private var filter = "全部"
    @State private var search = ""
    @Environment(\.desktopRendering) private var rendering
    private var entries: [AuditEntry] {
        model.auditEntries.filter { entry in
            (filter != "拦下的" || entry.decision == "denied") &&
            (filter != "文件" || ["read", "write", "transfer", "trash", "grant"].contains(entry.toolClass)) &&
            (search.isEmpty || (entry.names.joined() + entry.tool).localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 12) {
                if rendering {
                    HStack { ForEach(["全部", "文件", "拦下的"], id: \.self) { title in
                        Text(title).padding(.horizontal, 16).padding(.vertical, 5).background(filter == title ? Yimi.surface : Yimi.paper, in: RoundedRectangle(cornerRadius: 6))
                    } }.padding(3).background(Yimi.paper, in: RoundedRectangle(cornerRadius: 8))
                } else { Picker("显示", selection: $filter) {
                    ForEach(["全部", "文件", "拦下的"], id: \.self) { Text($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 300) }
                ForEach(model.confirmations) { DesktopConfirmationCard(confirmation: $0) }
            }.padding(16)
            Divider()
            DesktopContentScroll(padding: EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 22)) {
                    if !model.grants.isEmpty {
                        Text("临时交的文件").font(.headline).padding(.vertical, 12)
                        Text("不会改写原文件，结果存到“文稿 / 依米”。").font(.caption).foregroundStyle(Yimi.ink2)
                        ForEach(model.grants) { grant in
                            HStack {
                                VStack(alignment: .leading) {
                                    Label(grant.name, systemImage: "doc.badge.clock")
                                    Text("有效至 " + grant.expiresAt.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption).foregroundStyle(Yimi.ink2)
                                }
                                Spacer()
                                Button("撤销") { operation { try await model.desktop.revoke(grant: grant.id) } }
                            }.padding(.vertical, 10)
                        }
                        Divider()
                    }
                    if entries.isEmpty {
                        ContentUnavailableView(search.isEmpty ? "还没有活动记录" : "没有找到活动", systemImage: "clock.arrow.circlepath")
                            .frame(maxWidth: .infinity).padding(.top, 70)
                    }
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        if index == 0 || day(entries[index - 1].at) != day(entry.at) {
                            Text(day(entry.at)).font(.headline).padding(.top, 18)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .top, spacing: 14) {
                                Text(entry.at, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(Yimi.ink3).frame(width: 42)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(title(entry)).fontWeight(.medium)
                                    Text(entry.names.joined(separator: "、")).font(.callout).foregroundStyle(Yimi.ink2)
                                    if let error = entry.errorCode { Text(DesktopUserFacingError.code(error)).font(.caption).foregroundStyle(Yimi.danger) }
                                    HStack {
                                        if let url = entry.reveal {
                                            Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                                                .onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
                                        }
                                        if entry.undoneAt != nil { YimiPill(text: "已撤销", tone: .muted) }
                                        else if entry.undo != nil {
                                            Button(entry.undo == .trash ? "放回原处" : "撤销") {
                                                operation { try await model.desktop.undo(entry.id) }
                                            }.help("撤销她对这些文件的操作")
                                        }
                                        if entry.decision == "denied" { Text("已拦下").foregroundStyle(Yimi.danger) }
                                        if entry.result == "cancelled" { Text("已中断 · 结果待核实").foregroundStyle(Yimi.ink2) }
                                    }.font(.callout)
                                }
                                Spacer(minLength: 0)
                            }.padding(.vertical, 16)
                            Divider()
                        }
                    }
                    Button("查看更早的活动") { Task { await model.loadOlderActivity() } }.padding(.vertical, 16)
            }.background(Yimi.paper)
            if let error = model.error { Text(error).foregroundStyle(Yimi.danger).padding(10) }
        }.background(Yimi.ground).tint(Yimi.klein).foregroundStyle(Yimi.ink)
        .frame(minWidth: 540, minHeight: 560).navigationTitle("活动与确认")
        .searchable(text: $search, prompt: "搜索活动")
        .toolbar {
            if let url = model.sshAuditURL { Button("命令记录") { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
            Button(model.pause.paused ? "继续" : "暂停") { Task { await model.togglePause() } } }
        .task { if !rendering { await model.refreshActivity() } }
    }
    private func day(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "今天" }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
    private func title(_ entry: AuditEntry) -> String {
        let verbs = ["find_files": "查找文件", "read_text_file": "读取文件", "extract_text": "提取文字", "write_file": "写入文件",
                     "edit_file": "修改文件", "move_file": "移动文件", "trash": "移到废纸篓", "save_from_workshop": "保存处理结果",
                     "window_capture": "查看共享窗口", "upload_to_workshop": "送去离线处理", "file_grant": "临时交的文件", "undo": "撤销操作"]
        return (entry.decision == "denied" ? "拦下：" : "") + (verbs[entry.tool] ?? entry.tool) + (entry.count > 1 ? " · \(entry.count) 项" : "")
    }
    private func operation(_ action: @escaping () async throws -> Void) {
        Task { do { try await action(); model.error = nil; await model.refreshActivity() } catch { model.error = DesktopUserFacingError.message(error) } }
    }
}

struct DesktopMenuContents: View {
    @ObservedObject var model: DesktopAppModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.desktopRendering) private var rendering
    var body: some View {
        DesktopIdentityHeader(model: model)
        Text("依米 · " + model.voiceStatusTitle).accessibilityIdentifier("desktop.voice.status")
        Text(model.voiceStatus.detail).accessibilityIdentifier("desktop.voice.detail")
        if let standby = model.voiceStatus.standby {
            Text(standby).accessibilityIdentifier("desktop.voice.standby")
        }
        if let count = model.voiceStatus.backgroundCount {
            Text("后台有 \(count) 件事在办").accessibilityIdentifier("desktop.voice.background-count")
        } else {
            Text("正在读取后台事项…").accessibilityIdentifier("desktop.voice.background-count")
        }
        Button(model.call.isActive || model.callSnapshot?.isDialing == true ? "返回通话窗口" : "和依米通话…") { openWindow(id: "call") }
            .accessibilityIdentifier("desktop.voice.open-call")
        Toggle("语音唤醒", isOn: Binding(get: { model.callSnapshot?.media.wakeArmed == true },
                                     set: { enabled in Task { await model.setWakeEnabled(enabled) } }))
            .disabled(!model.connected).accessibilityIdentifier("desktop.voice.wake-toggle")
        ForEach(Array(model.errands.prefix(5))) { errand in
            if rendering { Text(errand.title) }
            else { Menu(errand.title) {
                Text("第 \(errand.step) 步 · \(errand.step)/\(errand.maxSteps)")
                Button("停下", role: .destructive) { Task { await model.cancelErrand(errand.id) } }
            } }
        }
        if model.inFlight > 0 { Text("正在办 · \(model.inFlight) 项操作") }
        if !model.confirmations.isEmpty {
            if rendering { Text("等你在手机上确认（\(model.confirmations.count)）") }
            else { Menu("等你在手机上确认（\(model.confirmations.count)）") {
                ForEach(Array(model.confirmations.prefix(5))) { confirmation in Text(confirmation.text ?? "请在手机上查看") }
                Button("全部…") { openWindow(id: "activity") }
            } }
        }
        Divider()
        Button("和依米说话…") { openWindow(id: "chat") }.disabled(!model.connected).globalKeyboardShortcut(.holdToTalk)
        Button("打开依米") { openWindow(id: "chat") }.keyboardShortcut("o")
        Button("活动与确认") { openWindow(id: "activity") }.keyboardShortcut("l")
        Divider()
        Button(model.pause.paused ? "继续让依米操作电脑" : "暂停依米操作电脑") { Task { await model.togglePause() } }.globalKeyboardShortcut(.pauseDesktop)

        Button("设置…") { openWindow(id: "settings") }.keyboardShortcut(",")
        Divider()
        Button("退出依米") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
