import Foundation
import SwiftUI

enum WatchCyclingDisplayFormatter {
    private static let posixLocale = Locale(identifier: "en_US_POSIX")

    static func speedText(_ metersPerSecond: Double?) -> String {
        guard let value = finiteNonNegative(metersPerSecond) else {
            return "--"
        }
        return number(value * 3.6, fractionDigits: 1)
    }

    static func valueText(
        _ value: Double?,
        unit: String,
        fractionDigits: Int = 0
    ) -> String {
        guard let value = finiteNonNegative(value) else { return "--" }
        return "\(number(value, fractionDigits: fractionDigits)) \(unit)"
    }

    static func distanceText(_ meters: Double?) -> String {
        guard let value = finiteNonNegative(meters) else { return "--" }
        if value < 1_000 {
            return "\(number(value, fractionDigits: 0)) m"
        }
        return "\(number(value / 1_000, fractionDigits: 2)) km"
    }

    static func elapsedText(_ seconds: Double?) -> String {
        guard let value = finiteNonNegative(seconds),
              value <= Double(Int.max) else {
            return "--"
        }
        let totalSeconds = Int(value.rounded(.down))
        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let remainder = totalSeconds % 60
        return String(
            format: "%02d:%02d:%02d",
            hours,
            minutes,
            remainder
        )
    }

    private static func finiteNonNegative(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value == 0 ? 0 : value
    }

    private static func number(_ value: Double, fractionDigits: Int) -> String {
        String(
            format: "%.*f",
            locale: posixLocale,
            fractionDigits,
            value
        )
    }
}
