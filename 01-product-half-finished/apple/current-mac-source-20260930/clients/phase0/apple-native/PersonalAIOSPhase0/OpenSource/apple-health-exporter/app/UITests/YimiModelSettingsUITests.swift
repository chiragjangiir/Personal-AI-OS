import XCTest

/// Lead-only acceptance on an already paired iPhone; no simulated biometrics or provider secrets.
final class YimiModelSettingsUITests: XCTestCase {
    private var app: XCUIApplication!
    private var environment: [String: String] { ProcessInfo.processInfo.environment }
    override func setUpWithError() throws {
        try XCTSkipUnless(environment["YIMI_MODEL_SETTINGS_REAL_CLICK"] == "1", "Lead runs after owner device approval")
        continueAfterFailure = false
        app = XCUIApplication(); app.launch()
        let settings = app.buttons["她了解你"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        let entry = app.descendants(matching: .any)["modelSettings.entry"].firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10)); entry.tap()
        XCTAssertTrue(app.navigationBars["模型与密钥"].waitForExistence(timeout: 10))
    }

    func testReadUsageAndFrozenBudgetReviewWithoutMutation() {
        XCTAssertTrue(app.staticTexts["已保存版本"].waitForExistence(timeout: 20))
        shot("settings-loaded")
        app.staticTexts["用量与提醒"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["已知费用"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["估算费用"].exists)
        let review = app.buttons["查看策略更改"].firstMatch
        if !review.isHittable { app.swipeUp() }
        XCTAssertTrue(review.isEnabled); review.tap()
        XCTAssertTrue(app.navigationBars["确认更改"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["已读取分页"].exists)
        let payload = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "pause_on_limit")).firstMatch
        if !payload.isHittable { app.swipeUp() }
        XCTAssertTrue(payload.exists)
        shot("frozen-budget")
        app.buttons["modelSettings.review.cancel"].tap()
        XCTAssertFalse(app.navigationBars["确认更改"].exists)
    }

    func testKeyInputClearsAfterPrepareAndNeverCommitsTheProbeKey() throws {
        try XCTSkipUnless(environment["YIMI_MODEL_SETTINGS_PROVIDER_ID"] != nil, "Choose the exact provider to inspect")
        let provider = try XCTUnwrap(environment["YIMI_MODEL_SETTINGS_PROVIDER_ID"])
        let entry = app.descendants(matching: .any)["modelSettings.provider." + provider].firstMatch
        if !entry.isHittable { app.swipeUp() }
        XCTAssertTrue(entry.waitForExistence(timeout: 10)); entry.tap()
        let field = app.secureTextFields["model-settings-key"]
        if !field.isHittable { app.swipeUp() }
        XCTAssertTrue(field.exists)
        field.tap(); field.typeText("ui-probe-not-a-real-api-key")
        let prepare = app.buttons["查看密钥更改"].firstMatch
        if !prepare.isHittable { app.swipeUp() }
        prepare.tap()
        XCTAssertTrue(app.navigationBars["确认更改"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ui-probe-not-a-real-api-key")).firstMatch.exists)
        app.buttons["modelSettings.review.cancel"].tap()
        XCTAssertNotEqual(field.value as? String, "ui-probe-not-a-real-api-key")
        XCTAssertTrue((field.value as? String ?? "").isEmpty || field.value as? String == "填写新密钥")
        shot("key-cleared-after-cancel")
    }

    func testResumeWithUnavailableBrain() throws {
        try XCTSkipUnless(environment["YIMI_MODEL_SETTINGS_MUTATE"] == "1" && environment["YIMI_MODEL_SETTINGS_BRAIN_UNAVAILABLE"] == "1",
                          "Prepare paused work and an unavailable brain to verify a signed resume")
        app.staticTexts["用量与提醒"].firstMatch.tap()
        let resume = app.buttons["model-settings-resume"]
        if !resume.isHittable { app.swipeUp() }
        XCTAssertTrue(resume.waitForExistence(timeout: 10)); XCTAssertTrue(resume.isEnabled)
        shot("brain-unavailable-resume-available")
        resume.tap()
        XCTAssertTrue(app.navigationBars["确认更改"].waitForExistence(timeout: 15))
        app.buttons["modelSettings.review.confirm"].tap()
        // The owner completes real Face ID; the test never injects a biometric result.
        let receipt = app.staticTexts["已恢复，暂停的工作会自动继续"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 60))
        shot("resume-receipt")
    }

    func testAuthorizeExactPendingMac() throws {
        try XCTSkipUnless(environment["YIMI_MODEL_SETTINGS_MUTATE"] == "1", "Explicit lead mutation run only")
        let deviceID = try XCTUnwrap(environment["YIMI_MODEL_SETTINGS_MAC_ID"])
        let fingerprint = try XCTUnwrap(environment["YIMI_MODEL_SETTINGS_MAC_FINGERPRINT"])
        app.staticTexts["授权 Mac"].firstMatch.tap()
        let authorize = app.buttons["modelSettings.authorize." + deviceID]
        if !authorize.isHittable { app.swipeUp() }
        XCTAssertTrue(authorize.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts[fingerprint].exists, "Compare the exact fingerprint supplied from this Mac")
        authorize.tap()
        XCTAssertTrue(app.navigationBars["确认更改"].waitForExistence(timeout: 15))
        app.buttons["modelSettings.review.confirm"].tap()
        XCTAssertTrue(app.navigationBars["确认更改"].waitForNonExistence(timeout: 60))
        shot("mac-authorization-receipt")
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "model-settings-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
