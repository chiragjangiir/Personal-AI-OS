import Foundation
import CoreGraphics

/// Geometry is restricted to the media stage, above subtitles and call controls.
enum YimiCallWindowLayout {
    static func frame(in stage: CGSize, offset: CGSize = .zero, scale: CGFloat = 1) -> CGRect {
        let horizontalMargin = min(12, max(0, stage.width) / 2)
        let verticalMargin = min(12, max(0, stage.height) / 2)
        let availableWidth = max(0, stage.width - horizontalMargin * 2)
        let availableHeight = max(0, stage.height - verticalMargin * 2)
        let width = min(102 * min(max(scale, 0.8), 1.8), availableWidth, availableHeight * 102 / 144)
        let size = CGSize(width: width, height: width * 144 / 102)
        let origin = CGPoint(x: stage.width - horizontalMargin - size.width + offset.width,
                             y: verticalMargin + offset.height)
        return CGRect(x: min(max(origin.x, horizontalMargin), max(horizontalMargin, stage.width - horizontalMargin - size.width)),
                      y: min(max(origin.y, verticalMargin), max(verticalMargin, stage.height - verticalMargin - size.height)),
                      width: size.width, height: size.height)
    }

    static func offset(for frame: CGRect, in stage: CGSize) -> CGSize {
        CGSize(width: frame.minX - (stage.width - min(12, max(0, stage.width) / 2) - frame.width),
               height: frame.minY - min(12, max(0, stage.height) / 2))
    }
}
