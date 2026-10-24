import Foundation

/// A call keeps this value even when the shared appearance cache changes.
struct YimiCallPortraitSnapshot: Equatable, Sendable {
    let ownerIdentity: String?
    let profile: CentralAvatarProfile?
    let imageData: Data?
    static let initial = Self(ownerIdentity: nil, profile: nil, imageData: nil)
}

/// Display projection only. The coordinator owns requested state and first-frame evidence.
enum YimiCallAvatarPresentation: Equatable {
    case off, waiting, on, unavailable

    init(requested: Bool, firstFrame: Bool, failed: Bool) {
        if failed { self = .unavailable }
        else if !requested { self = .off }
        else { self = firstFrame ? .on : .waiting }
    }

    var optionState: String {
        switch self {
        case .off: return "关"
        case .waiting: return "等待开启"
        case .on: return "开"
        case .unavailable: return "暂不可用"
        }
    }

    var label: String {
        switch self {
        case .off: return "数字人：关"
        case .waiting: return "数字人：关"
        case .on: return "数字人：开"
        case .unavailable: return "数字人：关"
        }
    }
}
