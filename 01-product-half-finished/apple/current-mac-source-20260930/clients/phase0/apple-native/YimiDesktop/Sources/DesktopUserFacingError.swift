import Foundation
import os
import DesktopKit

/// Presentation only: never expose server payloads, paths, or arbitrary error descriptions.
@MainActor enum DesktopUserFacingError {
    static func message(_ error: Error) -> String {
        if let error = error as? DesktopCallError { return error.errorDescription! }
        if let error = error as? DesktopComposer.InputError { return error.errorDescription! }
        if let error = error as? DesktopPairingError { return error.errorDescription! }
        if let error = error as? DesktopPairingCameraError { return error.errorDescription! }
        if let error = error as? CentralVoiceprintFailure { return code(error.code) }
        if let error = error as? CentralTextError {
            switch error {
            case .unavailable: return "暂时无法发送，请连接后重试。"
            case .contextChanged(let fileID, let line):
                Logger(subsystem: "ai.paios.personal.desktop", category: "central-text")
                    .error("PAIOS_CONTEXT_CHANGED site=\(fileID, privacy: .public):\(line, privacy: .public)")
                return "连接有变化，请先在对话里确认结果，再决定是否重试。"
            case .invalidPacket: return "消息未能处理，请重新发送。"
            }
        }
        if let error = error as? MediaPermissionError {
            switch error {
            case .cameraDenied: return "请在系统设置的隐私与安全性中允许依米使用摄像头，或回到语音。"
            case .microphoneDenied: return "请在系统设置的隐私与安全性中允许依米使用麦克风，再试一次。"
            case .requestWasNotUserInitiated: return "请点相应按钮，再申请摄像头或麦克风权限。"
            }
        }
        if let error = error as? DesktopError {
            switch error {
            case .folderNotAllowed: return code("GUARD_PATH_NOT_AUTHORIZED")
            case .sensitivePath: return code("GUARD_SENSITIVE_PATH")
            case .notAFile: return "请选择文件；要交给她整个文件夹，请到设置里添加。"
            case .unavailable: return code("DESKTOP_OFFLINE")
            }
        }
        if error is RealtimeDevicePairingError { return "配对信息不可用，请在 Mac 上刷新二维码，再用 iPhone 扫码。" }
        if error is CancellationError { return code("DESKTOP_CANCELLED") }
        let value = error as NSError
        if value.domain == NSURLErrorDomain {
            switch value.code {
            case NSURLErrorCancelled: return code("DESKTOP_CANCELLED")
            case NSURLErrorTimedOut: return "连接超时，请检查网络后重试。"
            case NSURLErrorUserAuthenticationRequired: return "连接信息已失效，请重新配对后再试。"
            default: return "网络连接失败，请检查网络后重试。"
            }
        }
        if value.domain == NSCocoaErrorDomain {
            switch value.code {
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: return code("GUARD_PERMISSION_REQUIRED")
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError: return code("GUARD_NOT_FOUND")
            case NSFileWriteOutOfSpaceError: return "磁盘空间不足，请腾出空间后重试。"
            case NSFileWriteFileExistsError: return code("GUARD_EXISTS")
            case NSFileReadUnknownError, NSFileReadInvalidFileNameError: return "无法读取这个文件，请重新选择文件后重试。"
            default: break
            }
        }
        return code(nil)
    }

    static func code(_ code: String?) -> String {
        switch code {
        case "VOICE_CONFIRMATION_APP_UPDATE_REQUIRED": return "这次需要验证是你本人，请更新依米后再试，或在已配对的手机上打字告诉她。"
        case "VOICE_CONFIRMATION_BIOMETRIC_INVALID": return "没能确认是你，请更新依米后再试，或在已配对的手机上打字告诉她。"
        case "FORMAL_VOICE_CONFIRM_INPUT_INVALID": return "当前服务还不支持这种身份确认，请升级服务后再试，或在已配对的手机上打字告诉她。"
        case "VOICE_CONFIRMATION_EXPIRED": return "确认卡已过期，请重新说一次，或在已配对的手机上打字告诉她。"
        case "VOICE_CONFIRMATION_TIMEOUT": return "还没收到确认结果，请先在对话里看看进度，再决定是否重试。"
        case "GUARD_SENSITIVE_PATH": return "这个位置受保护，请选择其他文件。"
        case "GUARD_PATH_NOT_AUTHORIZED", "GUARD_PERMISSION_REQUIRED": return "请到设置里添加这个文件夹，再试一次。"
        case "GUARD_PATH_INVALID": return "文件位置无效，请重新选择文件。"
        case "GUARD_NOT_FOUND": return "文件已不存在，请重新选择文件。"
        case "GUARD_EXISTS": return "已有同名文件，请更换名称后重试。"
        case "GUARD_TYPE_UNSUPPORTED": return "暂不支持这个文件类型，请选择其他文件。"
        case "GUARD_TOO_LARGE", "TRANSFER_TOO_LARGE", "DESKTOP_FRAME_TOO_LARGE": return "文件或内容过大，请缩小后重试。"
        case "GUARD_CONSENT_DENIED": return "这次操作没有获得同意。需要的话请重新发起，并在手机上确认。"
        case "GUARD_RECOVERY_REQUIRED": return "文件操作尚未恢复，请先查看活动记录并核实文件状态。"
        case "GUARD_RATE_LIMITED", "DESKTOP_BUSY": return "正在处理的事较多，请稍后再试。"
        case "DESKTOP_PAUSED": return "电脑操作已暂停，请恢复后重试。"
        case "DESKTOP_OFFLINE": return "电脑连接不可用，请重新连接后重试。"
        case "DESKTOP_CANCELLED": return "操作已中断，请核实结果后再试。"
        case "DESKTOP_TIMEOUT": return "操作超时，请核实结果后再试。"
        case "DESKTOP_AUDIT_STORE": return "活动记录暂时不可用，请稍后重试。"
        case "TRANSFER_INTEGRITY": return "文件传输未完成，请重新发送文件。"
        default: return "操作没完成，请重试；仍失败的话，请重新连接。"
        }
    }
}
