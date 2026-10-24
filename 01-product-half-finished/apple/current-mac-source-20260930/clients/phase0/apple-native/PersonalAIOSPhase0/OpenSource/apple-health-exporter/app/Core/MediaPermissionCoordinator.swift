import AVFoundation
import Foundation

enum AssistantPermissionStatus: String, Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
    case restricted
    case unavailable

    var displayName: String {
        switch self {
        case .notDetermined: return "未请求"
        case .authorized: return "已允许"
        case .denied: return "已拒绝"
        case .restricted: return "受限制"
        case .unavailable: return "不可用"
        }
    }
}

struct AssistantMediaPermissionSnapshot: Equatable, Sendable {
    let camera: AssistantPermissionStatus
    let microphone: AssistantPermissionStatus

    var hasDeniedMedia: Bool {
        camera == .denied || microphone == .denied
    }

    static let initial = AssistantMediaPermissionSnapshot(
        camera: .notDetermined,
        microphone: .notDetermined
    )
}

enum MediaPermissionError: LocalizedError, Equatable, Sendable {
    case cameraDenied
    case microphoneDenied
    case requestWasNotUserInitiated

    var errorDescription: String? {
        switch self {
        case .cameraDenied:
            return "摄像头权限未允许。"
        case .microphoneDenied:
            return "麦克风权限未允许。"
        case .requestWasNotUserInitiated:
            return "媒体权限只能由明确的用户操作触发。"
        }
    }
}

protocol MediaPermissionProviding: Sendable {
    func snapshot() async -> AssistantMediaPermissionSnapshot
    func authorize(
        source: AssistantMediaSource,
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus
}

struct MediaPermissionCoordinator: MediaPermissionProviding {
    func snapshot() async -> AssistantMediaPermissionSnapshot {
        AssistantMediaPermissionSnapshot(
            camera: Self.map(
                AVCaptureDevice.authorizationStatus(for: .video)
            ),
            microphone: Self.map(
                AVCaptureDevice.authorizationStatus(for: .audio)
            )
        )
    }

    func authorize(
        source: AssistantMediaSource,
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus {
        guard userInitiated else {
            throw MediaPermissionError.requestWasNotUserInitiated
        }

        let mediaType: AVMediaType =
            source == .camera ? .video : .audio
        let current = Self.map(
            AVCaptureDevice.authorizationStatus(for: mediaType)
        )
        guard current == .notDetermined else {
            try Self.requireAuthorized(current, source: source)
            return current
        }

        let granted = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: mediaType) { value in
                continuation.resume(returning: value)
            }
        }
        let resolved: AssistantPermissionStatus =
            granted ? .authorized : .denied
        try Self.requireAuthorized(resolved, source: source)
        return resolved
    }

    static func map(
        _ status: AVAuthorizationStatus
    ) -> AssistantPermissionStatus {
        switch status {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unavailable
        }
    }

    private static func requireAuthorized(
        _ status: AssistantPermissionStatus,
        source: AssistantMediaSource
    ) throws {
        guard status == .authorized else {
            if source == .camera {
                throw MediaPermissionError.cameraDenied
            }
            throw MediaPermissionError.microphoneDenied
        }
    }
}
