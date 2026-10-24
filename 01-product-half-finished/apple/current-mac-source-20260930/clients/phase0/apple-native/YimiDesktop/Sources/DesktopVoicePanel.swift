import AppKit
import Combine
import KeyboardShortcuts
import SwiftUI

extension KeyboardShortcuts.Name { static let voiceCancel = Self("voiceCancel") }

/// Owns the keyboard gesture and its panel; Core owns the recording and turn lifecycle.
@MainActor final class DesktopVoicePanel {
    private let model: DesktopAppModel
    private var panel: VoicePanel?
    private var delay: Task<Void, Never>?
    private var dismiss: Task<Void, Never>?
    private var held = false
    private var recording = false
    init(model: DesktopAppModel) { self.model = model }
    func keyDown() {
        guard !held, model.connected else { return }
        held = true; recording = false
        delay = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard held else { return }; recording = true
            show(DesktopVoiceHUD(model: model), typing: false, height: 86)
            KeyboardShortcuts.setShortcut(.init(.escape), for: .voiceCancel)
            KeyboardShortcuts.enable(.voiceCancel)
            KeyboardShortcuts.onKeyDown(for: .voiceCancel) { [weak self] in self?.cancel() }
            await model.holdStart()
        }
    }
    func keyUp() {
        guard held else { return }; held = false; delay?.cancel()
        KeyboardShortcuts.disable(.voiceCancel)
        if recording {
            Task { await model.holdEnd() }
            // The panel stays until the turn has its outcome and then shows it for 2 s: nothing ends unseen.
            dismiss = Task { [model] in
                do {
                    while !model.voiceSettled { try await Task.sleep(for: .milliseconds(200)) }
                    try await Task.sleep(for: .seconds(2))
                } catch { return }
                close()
            }
        } else {
            show(DesktopQuickInput(model: model, close: { [weak self] in self?.close() }), typing: true, height: 84)
        }
    }
    private func cancel() {
        guard held else { return }; held = false; delay?.cancel(); recording = false
        KeyboardShortcuts.disable(.voiceCancel)
        Task { await model.holdCancel() }; close()
    }
    private func show<V: View>(_ view: V, typing: Bool, height: CGFloat) {
        close()
        let panel = VoicePanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: height), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.acceptsKeyboard = typing; panel.isFloatingPanel = true; panel.hidesOnDeactivate = false
        panel.level = .statusBar; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        panel.contentView = NSHostingView(rootView: view)
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 210, y: screen.visibleFrame.maxY - height - 8))
        }
        self.panel = panel
        if typing { panel.makeKeyAndOrderFront(nil) } else { panel.orderFrontRegardless() }
    }
    private func close() { dismiss?.cancel(); dismiss = nil; panel?.orderOut(nil); panel = nil }
}

private final class VoicePanel: NSPanel {
    var acceptsKeyboard = false
    override var canBecomeKey: Bool { acceptsKeyboard }
    override var canBecomeMain: Bool { false }
}

struct DesktopVoiceHUD: View {
    @ObservedObject var model: DesktopAppModel
    var body: some View {
        HStack(spacing: 12) {
            YimiPortrait(breathes: false).frame(width: 36, height: 36).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                // The microphone opens on press; until central's window records, words would be lost.
                Text(model.listening ? (model.lastVoicePhase == .recording ? "依米在听…" : "准备中…") : model.voiceFeedback)
                    .fontWeight(.semibold)
                if !model.listeningText.isEmpty { Text(model.listeningText).lineLimit(1) }
                if model.listening { Text("松开发送 · Esc 取消").font(.caption).foregroundStyle(Yimi.ink2) }
            }
            Spacer(minLength: 0)
            Image(systemName: "waveform").foregroundStyle(Yimi.klein).accessibilityHidden(true)
        }.padding(14).foregroundStyle(Yimi.ink).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct DesktopQuickInput: View {
    @ObservedObject var model: DesktopAppModel
    @ObservedObject private var composer: DesktopComposer
    let close: () -> Void
    @FocusState private var focused: Bool
    init(model: DesktopAppModel, close: @escaping () -> Void) { self.model = model; composer = model.composer; self.close = close }
    var body: some View {
        HStack {
            TextField("跟依米说…", text: $composer.text).textFieldStyle(.plain).focused($focused)
                .onSubmit { Task { await model.send(); if composer.text.isEmpty { close() } } }
            Button { Task { await model.send(); if composer.text.isEmpty { close() } } } label: { Image(systemName: "arrow.up.circle.fill") }
                .buttonStyle(.plain).foregroundStyle(Yimi.klein)
        }.padding(18).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            .onAppear { focused = true }.onExitCommand(perform: close)
    }
}
