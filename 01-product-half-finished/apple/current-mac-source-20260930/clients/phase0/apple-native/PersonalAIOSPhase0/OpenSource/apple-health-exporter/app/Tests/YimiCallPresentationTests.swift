import XCTest
import CoreGraphics
@testable import HealthKitExporter

final class YimiCallPresentationTests: XCTestCase {
    func testAvatarRequiresRequestAndActualFirstFrame() {
        XCTAssertEqual(YimiCallAvatarPresentation(requested: false, firstFrame: true, failed: false), .off)
        XCTAssertEqual(YimiCallAvatarPresentation(requested: true, firstFrame: false, failed: false), .waiting)
        XCTAssertEqual(YimiCallAvatarPresentation(requested: true, firstFrame: true, failed: false), .on)
        XCTAssertEqual(YimiCallAvatarPresentation(requested: true, firstFrame: true, failed: true), .unavailable)
        XCTAssertEqual(YimiCallAvatarPresentation(requested: false, firstFrame: false, failed: false), .off)
        XCTAssertEqual(YimiCallAvatarPresentation.waiting.label, "数字人：关")
        XCTAssertEqual(YimiCallAvatarPresentation.unavailable.label, "数字人：关")
        XCTAssertEqual(YimiCallAvatarPresentation.on.label, "数字人：开")
    }

    func testWindowStaysInsideMediaStageDuringDragAndPinch() {
        let stage = CGSize(width: 390, height: 420)
        for scale: CGFloat in [0.1, 1, 4] {
            for offset in [CGSize(width: -1000, height: -1000), CGSize(width: 1000, height: 1000)] {
                let frame = YimiCallWindowLayout.frame(in: stage, offset: offset, scale: scale)
                XCTAssertGreaterThanOrEqual(frame.minX, 12)
                XCTAssertGreaterThanOrEqual(frame.minY, 12)
                XCTAssertLessThanOrEqual(frame.maxX, stage.width - 12)
                XCTAssertLessThanOrEqual(frame.maxY, stage.height - 12)
                XCTAssertEqual(frame.width / frame.height, 102 / 144, accuracy: 0.001)
                XCTAssertEqual(YimiCallWindowLayout.frame(in: stage, offset: YimiCallWindowLayout.offset(for: frame, in: stage), scale: scale), frame)
            }
        }
    }

    func testWindowResizesToLandscapeAndSmallStage() {
        for stage in [CGSize(width: 700, height: 160), CGSize(width: 90, height: 90)] {
            let frame = YimiCallWindowLayout.frame(in: stage, scale: 1.8)
            XCTAssertLessThanOrEqual(frame.maxX, stage.width - 12)
            XCTAssertLessThanOrEqual(frame.maxY, stage.height - 12)
        }
    }

    func testWindowRemainsInsideCollapsedAndTinyStages() {
        for stage in [CGSize.zero, CGSize(width: 10, height: 10), CGSize(width: 0, height: 100), CGSize(width: 100, height: 8)] {
            let frame = YimiCallWindowLayout.frame(in: stage, offset: CGSize(width: 100, height: -100), scale: 1.8)
            XCTAssertGreaterThanOrEqual(frame.minX, 0)
            XCTAssertGreaterThanOrEqual(frame.minY, 0)
            XCTAssertLessThanOrEqual(frame.maxX, stage.width)
            XCTAssertLessThanOrEqual(frame.maxY, stage.height)
            XCTAssertEqual(YimiCallWindowLayout.frame(in: stage, offset: YimiCallWindowLayout.offset(for: frame, in: stage), scale: 1.8), frame)
        }
    }
}
