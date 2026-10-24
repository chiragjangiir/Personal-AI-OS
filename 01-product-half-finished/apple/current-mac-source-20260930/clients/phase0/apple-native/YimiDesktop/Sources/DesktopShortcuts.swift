import KeyboardShortcuts

extension KeyboardShortcuts.Name {
    static let holdToTalk = Self("holdToTalk", default: .init(.space, modifiers: [.option]))
    static let pauseDesktop = Self("pauseDesktop", default: .init(.period, modifiers: [.control, .option]))
}

import SwiftUI

struct DesktopChatTextCommands: Commands {
    @AppStorage("desktop.chatTextSize") private var textSize = 14.0
    var body: some Commands {
        CommandGroup(after: .textEditing) {
            Button("放大对话文字") { textSize = min(24, textSize + 1) }.keyboardShortcut("+", modifiers: .command)
            Button("缩小对话文字") { textSize = max(11, textSize - 1) }.keyboardShortcut("-", modifiers: .command)
        }
    }
}
