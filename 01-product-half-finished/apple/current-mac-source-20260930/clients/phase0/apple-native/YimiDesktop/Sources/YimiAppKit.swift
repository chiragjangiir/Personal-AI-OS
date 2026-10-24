import AppKit
import SwiftUI

// Keep the shared iPhone design source unchanged; convert only its platform colour/image boundary.
typealias UIColor = NSColor
typealias UIImage = NSImage
extension NSColor {
    convenience init(_ provider: @escaping (NSAppearance) -> NSColor) {
        self.init(name: nil, dynamicProvider: provider)
    }
}
extension NSAppearance {
    enum YimiInterfaceStyle { case light, dark }
    var userInterfaceStyle: YimiInterfaceStyle {
        bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light
    }
}
extension Color {
    init(uiColor: NSColor) { self.init(nsColor: uiColor) }
}
extension Image {
    init(uiImage: NSImage) { self.init(nsImage: uiImage) }
}
