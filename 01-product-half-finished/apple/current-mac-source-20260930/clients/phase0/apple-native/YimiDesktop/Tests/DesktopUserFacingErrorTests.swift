import Foundation
import DesktopKit
import XCTest

@MainActor final class DesktopUserFacingErrorTests: XCTestCase {
    func testKnownInputAndPairingErrorsKeepSafeGuidance() {
        XCTAssertEqual(DesktopUserFacingError.message(DesktopComposer.InputError.folder), "文件夹请在设置里授权")
        XCTAssertEqual(DesktopUserFacingError.message(DesktopComposer.InputError.limit), "每条消息最多添加 10 个文件")
        XCTAssertEqual(DesktopUserFacingError.message(DesktopPairingError.rejected(403)), "二维码已失效 · 回到 Mac 刷新")
        XCTAssertFalse(DesktopUserFacingError.message(DesktopPairingError.rejected(503)).contains("503"))
    }
    func testTypedFailuresGiveActionableChinese() {
        XCTAssertTrue(DesktopUserFacingError.message(CentralTextError.contextChanged()).contains("确认结果"))
        XCTAssertTrue(DesktopUserFacingError.message(MediaPermissionError.microphoneDenied).contains("系统设置"))
        XCTAssertEqual(DesktopUserFacingError.message(DesktopError.sensitivePath("/secret")), DesktopUserFacingError.code("GUARD_SENSITIVE_PATH"))
        XCTAssertTrue(DesktopUserFacingError.message(URLError(.timedOut)).contains("网络"))
        XCTAssertTrue(DesktopUserFacingError.message(CocoaError(.fileWriteOutOfSpace)).contains("磁盘空间"))
    }
    func testVoiceConfirmationRefusalsExplainUpgradeExpiryAndUnknownResult() {
        for code in ["VOICE_CONFIRMATION_APP_UPDATE_REQUIRED", "VOICE_CONFIRMATION_BIOMETRIC_INVALID", "FORMAL_VOICE_CONFIRM_INPUT_INVALID"] {
            let message = DesktopUserFacingError.message(CentralVoiceprintFailure(code: code))
            XCTAssertTrue(message.contains("更新") || message.contains("升级"))
            XCTAssertTrue(message.contains("配对手机打字")); XCTAssertFalse(message.contains(code))
        }
        XCTAssertTrue(DesktopUserFacingError.message(CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_EXPIRED")).contains("已过期"))
        XCTAssertTrue(DesktopUserFacingError.message(CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_TIMEOUT")).contains("尚未收到"))
    }
    func testUnknownErrorsAndCodesNeverExposeRawDescriptions() {
        struct Untrusted: LocalizedError { var errorDescription: String? { "secret-token /private/file raw_failure" } }
        let fallback = DesktopUserFacingError.code(nil)
        XCTAssertEqual(DesktopUserFacingError.message(Untrusted()), fallback)
        XCTAssertEqual(DesktopUserFacingError.message(NSError(domain: "backend", code: 1, userInfo: [NSLocalizedDescriptionKey: "secret"])), fallback)
        XCTAssertEqual(DesktopUserFacingError.code("NEW_RAW_FAILURE"), fallback)
        XCTAssertTrue(DesktopUserFacingError.code("GUARD_PATH_NOT_AUTHORIZED").contains("设置"))
    }

    func testContextChangedCarriesTheThrowSiteWithoutPuttingItInTheMessage() {
        let expectedLine = UInt(#line + 1)
        let failure = CentralTextError.contextChanged()
        guard case let .contextChanged(fileID, line) = failure else { return XCTFail("Missing source site") }
        XCTAssertEqual(fileID, #fileID)
        XCTAssertEqual(line, expectedLine)
        XCTAssertEqual(String(describing: failure), "contextChanged", "Other clients must not expose diagnostic metadata")
        XCTAssertEqual(DesktopUserFacingError.message(failure), "连接已变化，请先查看对话确认结果，再重试。")
    }
}
