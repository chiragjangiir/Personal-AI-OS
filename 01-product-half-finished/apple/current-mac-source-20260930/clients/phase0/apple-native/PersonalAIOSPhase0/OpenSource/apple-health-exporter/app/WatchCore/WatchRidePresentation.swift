import Foundation

/// Presentation timing only. Online heart-rate decisions belong to the server.
struct WatchRidePresentation: Equatable {
    static let bannerDuration: TimeInterval = 6
    static func needsSaveDecision(elapsed: TimeInterval) -> Bool { elapsed < 60 }
    private(set) var banner: String?
    private(set) var expiresAt: Date?
    private(set) var explicitLimit: Int?
    private var lastOfflineAlert: Date?

    mutating func receive(_ ride: WatchYimiRide?, now: Date) -> Bool {
        if let limit = ride?.max_hr_bpm { explicitLimit = limit }
        guard let text = ride?.text, !text.isEmpty else { return false }
        guard banner != text || expiresAt.map({ $0 <= now }) ?? true else { return false }
        banner = text
        expiresAt = now.addingTimeInterval(Self.bannerDuration)
        return true
    }

    mutating func expire(at now: Date) {
        if let expiry = expiresAt, now >= expiry { banner = nil; expiresAt = nil }
    }

    mutating func update(heartRate: Double?, phoneReachable: Bool, now: Date) -> Bool {
        expire(at: now)
        guard !phoneReachable, let limit = explicitLimit, let heartRate,
              heartRate.isFinite, heartRate > Double(limit),
              lastOfflineAlert.map({ now.timeIntervalSince($0) >= 180 }) ?? true else { return false }
        banner = "心率 \(Int(heartRate.rounded())) 了，慢一点，喝口水。"
        expiresAt = now.addingTimeInterval(Self.bannerDuration)
        lastOfflineAlert = now
        return true
    }
}
