import SwiftUI
import KeyboardShortcuts

/// ImageRenderer cannot flatten AppKit scroll/form/checkbox/recorder controls. These wrappers use the same bound
/// content and values for content-only exports; interactive windows keep the native controls.
struct DesktopContentScroll<Content: View>: View {
    var axes: Axis.Set = .vertical
    var spacing: CGFloat = 0
    var padding = EdgeInsets()
    @ViewBuilder var content: Content
    @Environment(\.desktopRendering) private var rendering
    var body: some View {
        if rendering {
            VStack(alignment: .leading, spacing: spacing) { content }.padding(padding)
                .fixedSize(horizontal: axes == .horizontal, vertical: axes == .vertical)
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: axes == .vertical ? .infinity : nil, alignment: .topLeading).clipped()
        } else { ScrollView(axes) {
            // An eager stack: its layout is a function of the content and width alone. A lazy stack re-estimates
            // unrealized rows and re-anchors the offset on every pass; with long selectable replies that never settled.
            if axes == .horizontal { content }
            else { VStack(alignment: .leading, spacing: spacing) { content }.padding(padding) }
        } }
    }
}

struct DesktopCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    @Environment(\.desktopRendering) private var rendering
    var body: some View {
        if rendering {
            Label(title, systemImage: isOn ? "checkmark.square.fill" : "square")
        } else { Toggle(title, isOn: $isOn).toggleStyle(.checkbox) }
    }
}

struct DesktopShortcutRecorder: View {
    let title: String
    let name: KeyboardShortcuts.Name
    @Environment(\.desktopRendering) private var rendering
    var body: some View {
        if rendering { LabeledContent(title, value: KeyboardShortcuts.getShortcut(for: name)?.description ?? "未设置") }
        else { KeyboardShortcuts.Recorder(title, name: name) }
    }
}
