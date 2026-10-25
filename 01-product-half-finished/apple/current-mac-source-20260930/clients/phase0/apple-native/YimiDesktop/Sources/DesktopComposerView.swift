import AppKit
import SwiftUI
import UniformTypeIdentifiers
import DesktopKit
import KeyboardShortcuts

struct DesktopComposerView: View {
    @ObservedObject var model: DesktopAppModel
    @ObservedObject var composer: DesktopComposer
    @State private var talkShortcut = KeyboardShortcuts.getShortcut(for: .holdToTalk)
    @State private var holding = false
    @State private var dropTargeted = false
    @Environment(\.desktopRendering) private var rendering
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !composer.files.isEmpty {
                DesktopContentScroll(axes: .horizontal) {
                    HStack {
                        ForEach(composer.files) { file in
                            HStack {
                                Label(file.name, systemImage: "doc")
                                Button { composer.remove(id: file.id) } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.plain).accessibilityLabel("移除附件：" + file.name)
                            }.padding(8).background(Yimi.paper, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                Text("不会改写原文件，结果存到“文稿 / 依米”。").font(.caption).foregroundStyle(Yimi.ink2)
            }
            HStack(alignment: .bottom, spacing: 10) {
                Button { chooseFiles() } label: { Image(systemName: "plus") }.help("添加文件（⇧⌘A）")
                    .keyboardShortcut("a", modifiers: [.command, .shift]).disabled(!model.connected)
                if rendering {
                    Text(composer.text.isEmpty ? "跟依米说…" : composer.text).font(.system(size: 14))
                        .foregroundStyle(composer.text.isEmpty ? Yimi.ink3 : Yimi.ink).frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
                } else { DesktopTextInput(text: $composer.text, paste: { pasteboard in
                    try await composer.paste(pasteboard)
                }, report: { composer.error = $0 }, submit: { Task { await model.send() } })
                .frame(minHeight: 38, maxHeight: 100) }
                Button { } label: { Image(systemName: model.listening ? "mic.fill" : "mic") }
                    .buttonStyle(.bordered).foregroundStyle(model.listening ? Yimi.danger : Yimi.ink2)
                    .help("按住说话，松开发送。依米用文字回复。")
                    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in
                        guard !holding, model.connected else { return }; holding = true
                        Task { await model.holdStart() }
                    }.onEnded { _ in holding = false; Task { await model.holdEnd() } })
                    .accessibilityAction(named: Text(model.listening ? "发送语音" : "开始说话")) {
                        Task { if model.listening { await model.holdEnd() } else { await model.holdStart() } }
                    }
                    .disabled(!model.connected)
                Button { Task { await model.send() } } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                    .disabled(model.sending || !model.connected || (composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && composer.files.isEmpty))
            }
            if let error = composer.error {
                HStack {
                    Text(error).font(.caption).foregroundStyle(Yimi.danger)
                    if error.contains("文件夹") {
                        Button("授权文件夹…") {
                            UserDefaults.standard.set(DesktopSettingsPane.folders.rawValue, forKey: "desktop.settingsPane"); openWindow(id: "settings"); NotificationCenter.default.post(name: .desktopShowFolders, object: nil)
                        }
                    }
                }
            }
            Text(!model.connected ? "连上后才能发" : model.voiceNote ?? talkShortcut.map { "跟依米说… · 按住 \($0.description) 说话" } ?? "跟依米说…")
                .font(.caption).foregroundStyle(Yimi.ink3)
        }.padding(14).background(Yimi.ground)
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
            talkShortcut = KeyboardShortcuts.getShortcut(for: .holdToTalk)
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(dropTargeted ? Yimi.klein : .clear, lineWidth: 2))
        .onDrop(of: [.fileURL, .pdf, .image, .rtf, .html], isTargeted: $dropTargeted) { composer.receive(providers: $0) }
    }
    private func chooseFiles() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
        panel.begin { response in
            guard response == .OK else { return }
            Task { do { try await composer.attach(panel.urls, via: .drag) } catch { composer.error = DesktopUserFacingError.message(error) } }
        }
    }
}

private struct DesktopTextInput: NSViewRepresentable {
    @Binding var text: String
    var paste: @MainActor (NSPasteboard) async throws -> Bool
    var report: (String) -> Void
    var submit: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let editor = ComposerTextView()
        editor.delegate = context.coordinator; editor.isRichText = false; editor.font = .systemFont(ofSize: 14)
        editor.drawsBackground = false; editor.textContainerInset = NSSize(width: 5, height: 8)
        editor.autoresizingMask = [.width]; editor.isVerticallyResizable = true
        editor.textContainer?.widthTracksTextView = true
        editor.configurePaste(paste: paste, report: report)
        scroll.documentView = editor; scroll.drawsBackground = false
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? NSTextView else { return }
        // Marked (IME composing) text never reaches textDidChange, so the binding lags it; writing
        // the binding back during composition would erase what the owner is typing.
        if !editor.hasMarkedText(), editor.string != text { editor.string = text }
    }
    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
        (scroll.documentView as? ComposerTextView)?.invalidatePaste()
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: DesktopTextInput
        init(_ parent: DesktopTextInput) { self.parent = parent }
        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard commandSelector == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText(),
                  !NSEvent.modifierFlags.contains(.shift) else { return false }
            parent.submit(); return true
        }
        func textDidChange(_ notification: Notification) {
            if let editor = notification.object as? NSTextView { parent.text = editor.string }
        }
    }
}

final class ComposerTextView: NSTextView {
    var filePaste: ((NSPasteboard) -> Void)?
    private(set) var pasteTasks: [UUID: Task<Void, Never>] = [:]
    func configurePaste(paste: @escaping @MainActor (NSPasteboard) async throws -> Bool, report: @escaping (String) -> Void) {
        filePaste = { [weak self] pasteboard in
            guard let self else { return }
            let id = UUID(), text = pasteboard.string(forType: .string) ?? ""
            pasteTasks[id] = Task { @MainActor [weak self] in
                defer { self?.pasteTasks[id] = nil }
                do {
                    let handled = try await paste(pasteboard)
                    guard !Task.isCancelled, let self else { return }
                    if !handled { self.insertText(text, replacementRange: self.selectedRange()) }
                } catch {
                    guard !Task.isCancelled, self != nil else { return }
                    report(DesktopUserFacingError.message(error))
                }
            }
        }
    }
    func invalidatePaste() {
        filePaste = nil; delegate = nil
        for task in pasteTasks.values { task.cancel() }
        pasteTasks.removeAll()
    }
    override func paste(_ sender: Any?) { filePaste?(.general) }
}
