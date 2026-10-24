import Foundation

#if DEBUG
enum PAIOSDebugPairingLaunch {
    static let registrationExport =
        "--paios-e2ee-registration-export"
    static let devicePairingImport =
        "--paios-device-pairing-import"
    static let productionStartOnce =
        PAIOSDebugProductionStartOnce.launchArgument

    static var arguments: [String] {
        ProcessInfo.processInfo.arguments
    }

    static func shouldAutoImportPairing(
        arguments: [String],
        isPhysicalDevice: Bool,
        applicationSupportURL: URL?,
        fileExists: (URL) -> Bool
    ) -> Bool {
        guard isPhysicalDevice,
              arguments.dropFirst().isEmpty,
              let applicationSupportURL
        else {
            return false
        }
        return fileExists(
            applicationSupportURL.appendingPathComponent(
                RealtimeDevicePairingRuntime.pairingRelativePath
            )
        )
    }

}

enum PAIOSDebugProductionStartMarker: String, Equatable {
    case active = "ACTIVE"
    case failed = "FAILED"
    case notReady = "NOT_READY"
}

enum PAIOSDebugProductionStartErrorMarker {
    private static let knownCodes: Set<String> = [
        "bootstrap_not_configured",
        "camera_denied",
        "disconnected",
        "e2ee_failed",
        "e2ee_unavailable",
        "location_denied",
        "microphone_denied",
        "network",
        "realtime_superseded",
        "start_failed"
    ]

    /// Any identifier-shaped failure code is printed (codes never carry secrets); an opaque UNKNOWN hid
    /// every real-device start failure outside the original short list.
    static func value(for state: AssistantSessionState) -> String {
        guard case .failed(let code) = state,
              knownCodes.contains(code) || code.range(of: "^[a-z0-9_]{1,64}$", options: .regularExpression) != nil else {
            return "UNKNOWN"
        }
        return code
    }
}

@MainActor
final class PAIOSDebugProductionStartOnce {
    static let launchArgument = "--paios-production-start-once"

    private var consumed = false

    func run(
        importResult: RealtimePairingImportResult,
        providerReady: Bool,
        start: @MainActor () async -> Bool
    ) async -> PAIOSDebugProductionStartMarker? {
        guard !consumed else {
            return nil
        }
        consumed = true
        guard importResult != .rejected, providerReady else {
            return .notReady
        }
        return await start() ? .active : .failed
    }
}

@MainActor
final class PAIOSDebugPhysicalEndpointPreparationOnce {
    private var consumed = false

    func run(
        importResult: RealtimePairingImportResult,
        providerReady: Bool,
        pairingOrigin: String,
        saveSettings: @MainActor (AppSettings) async throws -> Void,
        onPrepared: @MainActor () -> Void
    ) async -> Bool? {
        guard !consumed else {
            return nil
        }
        consumed = true
        guard providerReady, importResult != .rejected else {
            return false
        }
        do {
            try await saveSettings(
                AppSettings(
                    endpoint: pairingOrigin
                )
            )
        } catch {
            return false
        }
        onPrepared()
        return true
    }
}

enum PAIOSDebugPhysicalProductionLaunch {
    static func shouldPrepareEndpoint(
        importResult: RealtimePairingImportResult?,
        providerReady: Bool,
        startOnceRequested: Bool
    ) -> Bool {
        guard startOnceRequested, providerReady, let importResult else {
            return false
        }
        return importResult != .rejected
    }

    static func shouldRetryAfterForeground(
        startOnceRequested: Bool,
        recoveryAttempted: Bool,
        sessionState: AssistantSessionState
    ) -> Bool {
        guard startOnceRequested, !recoveryAttempted else {
            return false
        }
        if case .failed = sessionState {
            return true
        }
        return false
    }
}

enum PAIOSDebugPairingPresentation {
    static let title = "个人 AI 助手"
    static let exportSucceeded =
        "E2EE 公钥注册收据已生成\n请在 Mac 上执行配对。"
    static let exportFailed =
        "E2EE 公钥注册导出失败\n请检查设备日志。"
    static let supportDirectoryUnavailable =
        "无法访问应用支持目录\n未生成注册收据。"
    static let importSucceeded = "配对完成"
    static let importRejected = "配对文件缺失或校验失败"
    static let importUnavailable =
        "无法访问应用支持目录\n未导入配对。"
}
#endif

