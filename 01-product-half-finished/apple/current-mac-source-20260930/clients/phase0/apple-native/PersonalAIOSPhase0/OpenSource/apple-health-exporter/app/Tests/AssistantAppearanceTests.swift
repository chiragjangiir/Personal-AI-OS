import Foundation
import XCTest
@testable import HealthKitExporter

final class AssistantAppearanceTests: XCTestCase {
    private let quote: [String: Any] = ["quote_id": "price-v1", "price_text": "实际供应商报价", "scope_text": "一次准备，所有已配对终端和后续通话使用"]
    private let acceptedQuote = AssistantAppearanceQuote(quote_id: "price-v1", price_text: "实际供应商报价", scope_text: "一次准备，所有已配对终端和后续通话使用")
    private let look: [String: Any] = ["look_id": "approved", "style": "清线卡通", "image_url": "https://assets.example/approved.jpg", "focus": ["x": 0.5, "y": 0.4]]
    private func object(_ data: Data) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]) }
    private func fields(_ operation: String, _ data: [String: Any]) throws -> CentralBody {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: ["schema_version": AssistantCentralTextWire.schema,
            "session_id": "session", "operation": operation].merging(data) { _, value in value })).fields
    }
    private func load(_ state: inout AssistantAppearanceState, quote: [String: Any]? = nil) throws {
        let request = try object(state.requestOptions())
        _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": try XCTUnwrap(request["request_id"]),
            "looks": [look], "photo_upload_available": true, "preparation_quote": quote ?? self.quote]))
    }
    func testPrepareRequiresRealQuoteAndExplicitCurrentConsentAndPreservesFocus() throws {
        var state = AssistantAppearanceState()
        XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        try load(&state)
        XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: AssistantAppearanceQuote(quote_id: "price-v1", price_text: "旧报价", scope_text: "旧范围")))
        XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 2, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        let request = try object(state.prepare(lookID: "approved", focus: .init(x: 0.2, y: 0.7), expectedVersion: 3, confirmedQuote: acceptedQuote))
        XCTAssertEqual(request["expected_version"] as? Int, 3)
        XCTAssertEqual(request["focus"] as? [String: Double], ["x": 0.2, "y": 0.7])
        XCTAssertTrue((request["owner_request"] as? String)?.contains("一次准备") == true)
    }
    func testStaleResponsesCannotReplaceOptionsAndQuoteChangesRequireNewConsent() throws {
        var state = AssistantAppearanceState()
        let stale = try object(state.requestOptions())
        try load(&state)
        XCTAssertFalse(try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": try XCTUnwrap(stale["request_id"]), "looks": [], "photo_upload_available": false])))
        XCTAssertEqual(state.options?.looks.count, 1)
        try load(&state, quote: ["quote_id": "price-v2", "price_text": "新实际报价", "scope_text": "新的使用范围"])
        XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
    }
    func testPendingAndUnknownSubmissionCannotIssueAnotherPaidPrepare() throws {
        for status in ["pending", "submission_uncertain"] {
            var state = AssistantAppearanceState(); try load(&state)
            let request = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
            let command = try XCTUnwrap(request["command_id"])
            XCTAssertTrue(try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": try XCTUnwrap(request["request_id"]), "command_id": command, "status": status, "profile": NSNull()])))
            XCTAssertNil(state.preparation?.profile)
            XCTAssertTrue(state.preparation?.message.contains("当前样子继续使用") == true)
            XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
            let reconcile = try object(state.reconcile())
            XCTAssertEqual(reconcile["command_id"] as? String, command as? String)
        }
    }
    func testTransportFailurePreservesCommandAndAllowsReconcileWithoutDuplicatePrepare() throws {
        var state = AssistantAppearanceState(); try load(&state)
        let request = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        state.fail("连接断开，提交结果未知")
        XCTAssertTrue(state.hasOutstandingCommand)
        XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        let first = try object(state.reconcile()), second = try object(state.reconcile())
        XCTAssertEqual(first["command_id"] as? String, request["command_id"] as? String)
        XCTAssertEqual(second["command_id"] as? String, first["command_id"] as? String)
        XCTAssertNotEqual(first["request_id"] as? String, second["request_id"] as? String)
    }
    func testFreshSessionResumesServerCommandWithoutAnotherPaidPrepare() throws {
        for status in ["pending", "submission_uncertain"] {
            var state = AssistantAppearanceState()
            let request = try object(state.requestOptions())
            _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", [
                "request_id": try XCTUnwrap(request["request_id"]), "looks": [look], "photo_upload_available": true,
                "preparation_quote": quote, "current_preparation": ["command_id": "durable-command", "status": status, "profile": NSNull()]]))
            XCTAssertEqual(state.commandID, "durable-command")
            XCTAssertEqual(state.preparation?.status.rawValue, status)
            XCTAssertTrue(state.hasOutstandingCommand)
            XCTAssertThrowsError(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
            XCTAssertEqual(try object(state.reconcile())["command_id"] as? String, "durable-command")
        }
    }
    func testOptionsCannotOverwriteNewLocalPrepareWithAnOlderServerCommand() throws {
        var state = AssistantAppearanceState(); try load(&state)
        let prepared = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        let request = try object(state.requestOptions())
        _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", [
            "request_id": try XCTUnwrap(request["request_id"]), "looks": [look], "photo_upload_available": true,
            "preparation_quote": quote, "current_preparation": ["command_id": "older-command", "status": "ready", "profile": NSNull()]]))
        XCTAssertEqual(state.commandID, prepared["command_id"] as? String)
        XCTAssertNil(state.preparation)
        XCTAssertTrue(state.hasOutstandingCommand)
    }
    func testUploadedPhotoRequiresServerUploadCapabilityAndJoinsExistingCatalogueOnly() throws {
        var state = AssistantAppearanceState()
        let uploaded = AssistantAppearanceLook(look_id: "image-00000000-0000-0000-0000-000000000000", style: "自选照片", image_url: URL(string: "https://assets.example/photo.jpg")!, focus: .init(x: 0.5, y: 0.4))
        XCTAssertThrowsError(try state.registerUploadedLook(uploaded))
        try load(&state); try state.registerUploadedLook(uploaded)
        XCTAssertEqual(state.options?.looks.last, uploaded)
        XCTAssertNoThrow(try state.prepare(lookID: uploaded.look_id, focus: .init(x: 0.2, y: 0.7), expectedVersion: 0, confirmedQuote: acceptedQuote))
    }
    func testCancelKeepsCommandForReconciliationAndIgnoresLatePrepareReply() throws {
        var state = AssistantAppearanceState(); try load(&state)
        let prepare = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        state.fail("transport interrupted")
        let cancel = try object(state.cancel())
        XCTAssertEqual(cancel["command_id"] as? String, prepare["command_id"] as? String)
        XCTAssertFalse(try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": prepare["request_id"]!, "command_id": prepare["command_id"]!, "status": "ready", "profile": NSNull(), "profile_version": 1])))
        XCTAssertTrue(try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": cancel["request_id"]!, "command_id": cancel["command_id"]!, "status": "cancelled", "profile": NSNull(), "profile_version": 0, "error": "processing_timeout"])))
        XCTAssertFalse(state.hasOutstandingCommand)
        XCTAssertEqual(try object(state.reconcile())["command_id"] as? String, prepare["command_id"] as? String)
        state.fail("reconcile transport interrupted")
        XCTAssertNoThrow(try state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
    }
    func testFinishedLocalJobAdoptsAnotherTerminalPendingJobOnRefresh() throws {
        for status in ["ready", "cancelled", "superseded"] {
            var state = AssistantAppearanceState(); try load(&state)
            let prepared = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
            _ = try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": prepared["request_id"]!, "command_id": prepared["command_id"]!, "status": status, "profile": NSNull()]))
            let refresh = try object(state.requestOptions())
            _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": refresh["request_id"]!, "looks": [look], "photo_upload_available": false, "current_preparation": ["command_id": "other-terminal", "status": "pending", "profile": NSNull()]]))
            XCTAssertEqual(state.commandID, "other-terminal")
            XCTAssertEqual(state.preparation?.status, .pending)
            XCTAssertTrue(state.hasOutstandingCommand)
        }
    }
    func testOptionsUpdateTheSamePendingCommandToTerminalStatus() throws {
        for status in ["ready", "failed"] {
            var state = AssistantAppearanceState(); try load(&state)
            let prepared = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
            _ = try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": prepared["request_id"]!, "command_id": prepared["command_id"]!, "status": "pending", "profile": NSNull()]))
            let refresh = try object(state.requestOptions())
            _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": refresh["request_id"]!, "looks": [look], "photo_upload_available": false, "current_preparation": ["command_id": prepared["command_id"]!, "status": status, "profile": NSNull()]]))
            XCTAssertEqual(state.commandID, prepared["command_id"] as? String)
            XCTAssertEqual(state.preparation?.status.rawValue, status)
            XCTAssertFalse(state.hasOutstandingCommand)
        }
    }
    func testPendingLocalJobCannotBeReplacedByOlderOptions() throws {
        var state = AssistantAppearanceState(); try load(&state)
        let prepared = try object(state.prepare(lookID: "approved", focus: .init(x: 0.5, y: 0.4), expectedVersion: 0, confirmedQuote: acceptedQuote))
        _ = try state.consume("avatar_preparation", fields: fields("avatar_preparation", ["request_id": prepared["request_id"]!, "command_id": prepared["command_id"]!, "status": "pending", "profile": NSNull()]))
        let refresh = try object(state.requestOptions())
        _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": refresh["request_id"]!, "looks": [look], "photo_upload_available": false, "current_preparation": ["command_id": "older-terminal", "status": "pending", "profile": NSNull()]]))
        XCTAssertEqual(state.commandID, prepared["command_id"] as? String)
        XCTAssertEqual(state.preparation?.status, .pending)
    }
    func testHistoryReuseAndDefaultRestoreNeedNoGenerationQuote() throws {
        var state = AssistantAppearanceState()
        let request = try object(state.requestOptions())
        _ = try state.consume("avatar_options_state", fields: fields("avatar_options_state", ["request_id": request["request_id"]!, "looks": [], "photo_upload_available": false, "current_version": 4, "recent_versions": [["version": 3, "profile": NSNull()]]]))
        XCTAssertEqual(state.options?.current_version, 4)
        let reused = try object(state.reuse(version: 3, expectedVersion: 4))
        XCTAssertEqual(reused["operation"] as? String, "avatar_reuse")
        XCTAssertNil(reused["quote_id"])
        state.fail("connection interrupted")
        let reset = try object(state.reuse(version: 0, expectedVersion: 4))
        XCTAssertEqual(reset["version"] as? Int, 0)
        XCTAssertNotEqual(reset["command_id"] as? String, reused["command_id"] as? String)
    }

}
