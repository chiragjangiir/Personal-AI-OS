import AppKit
import SwiftUI

struct DesktopStatusIcon: View {
    @ObservedObject var model: DesktopAppModel
    var body: some View {
        HStack(spacing: 4) {
            Image(nsImage: Self.symbol())
            Text("依米 · " + model.voiceStatus.compactTitle)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("依米 · " + model.voiceStatusTitle)
        .accessibilityIdentifier("desktop.voice.menu-bar")
    }
    static func symbol() -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            NSImage(named: "YimMenuBar")!.draw(in: NSRect(x: 0, y: 0, width: 16, height: 16))
            return true
        }
        image.isTemplate = true; return image
    }
}
