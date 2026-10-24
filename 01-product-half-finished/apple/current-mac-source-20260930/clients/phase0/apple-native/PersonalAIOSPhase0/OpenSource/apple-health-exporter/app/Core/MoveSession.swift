import CoreLocation
import Foundation

struct MoveCoordinate: Codable, Equatable, Sendable {
    let lat: Double
    let lng: Double
    func distance(to other: Self) -> Double {
        CLLocation(latitude: lat, longitude: lng).distance(from: CLLocation(latitude: other.lat, longitude: other.lng))
    }
}
struct MovePosition: Codable, Sendable {
    let lat: Double
    let lng: Double
    let accuracy_m: Double
    var course_deg: Double? = nil
    var at: Date? = nil
    var coordinate: MoveCoordinate { MoveCoordinate(lat: lat, lng: lng) }
}
struct MoveFix: Codable, Sendable {
    let position: MovePosition
    let at: Date
    let speedKmh: Double?
}
struct RideMetrics: Codable, Sendable {
    let speed_kmh: Double?
    let avg_kmh: Double
    let max_kmh: Double
    let distance_m: Double
    let moving_s: Double
    let elapsed_s: Double
    var elev_gain_m: Double? = nil
    var hr_bpm: Double? = nil
    var hr_sample_at: Date? = nil
    var speed_sample_at: Date? = nil
    var kcal: Double? = nil
    var cadence_rpm: Double? = nil
    var cadence_source: String? = nil
}
struct RideSummary: Codable, Sendable {
    let started_at: Date
    let ended_at: Date
    let distance_m: Double
    let moving_s: Double
    let elapsed_s: Double
    let avg_kmh: Double
    let max_kmh: Double
    let elev_gain_m: Double?
    let kcal: Double?
    let hr_avg: Double?
    let hr_max: Double?
}
struct RideState: Codable, Sendable {
    let ride_id: String
    let state: String
    let at: Date
    let started_by: String
    var summary: RideSummary? = nil
}
struct NavStep: Codable, Sendable {
    let index: Int
    let maneuver: String
    let instruction: String
    var road: String? = nil
    let distance_m: Double
    let duration_s: Double
    let polyline: [MoveCoordinate]
}
struct NavRoute: Codable, Sendable {
    let nav_id: String
    let revision: Int
    let mode: String
    let destination: Destination
    let total_m: Double
    let total_s: Double
    let steps: [NavStep]
    struct Destination: Codable, Sendable { let name: String; let lat: Double; let lng: Double }
}
struct NavProgress: Codable, Sendable {
    let nav_id: String
    let revision: Int
    let step_index: Int
    let maneuver: String
    let distance_to_maneuver_m: Double
    let road: String?
    let remaining_m: Double
    let remaining_s: Double
    let route_segment_index: Int
    let segment_fraction: Double
}
struct NavState: Encodable, Sendable {
    let nav_id: String
    let state: String
    let at: Date
    var position: MoveCoordinate? = nil
}
struct MoveFrame: Encodable, Sendable {
    let ride_id: String?
    let nav_id: String?
    let seq: Int
    let at: Date
    let position: MovePosition?
    let ride: RideMetrics?
    let nav: NavProgress?
}
enum MoveEvent: Encodable, Sendable {
    case rideState(RideState), navState(NavState), frame(MoveFrame)
    var operation: String {
        switch self { case .rideState: return "ride_state"; case .navState: return "nav_state"; case .frame: return "move_frame" }
    }
    func encode(to encoder: Encoder) throws {
        switch self {
        case .rideState(let body): try body.encode(to: encoder)
        case .navState(let body): try body.encode(to: encoder)
        case .frame(let body): try body.encode(to: encoder)
        }
    }
}

struct RideStatistics: Codable, Sendable {
    let startedAt: Date
    private var previous: MoveFix?
    private var speeds: [Double] = []
    private var altitude: Double?
    private var heartIntegral = 0.0, heartDuration = 0.0, heartMax: Double?
    private struct HeartSample: Codable, Sendable { let value: Double; let at: Date }
    private var lastHeart: HeartSample?
    private var movingDistance = 0.0
    private var watch: WatchCyclingMetricEnvelope?
    private(set) var speedKmh: Double?
    private var speedSampleAt: Date?
    private var intervalSpeed: Double?
    private(set) var distance = 0.0, moving = 0.0, maximum = 0.0
    private(set) var elevationGain: Double?
    var average: Double { moving > 0 ? movingDistance / moving * 3.6 : 0 }
    init(startedAt: Date) { self.startedAt = startedAt }

    mutating func record(_ fix: MoveFix) {
        guard fix.position.accuracy_m.isFinite, (0...20).contains(fix.position.accuracy_m) else {
            loseFix(); return
        }
        if let previous, fix.at <= previous.at { return }
        if let previous {
            let seconds = fix.at.timeIntervalSince(previous.at)
            if seconds > 0, seconds <= 5 {
                let speed = intervalSpeed ?? previous.position.coordinate.distance(to: fix.position.coordinate) / seconds * 3.6
                let meters = speed / 3.6 * seconds
                distance += meters
                maximum = max(maximum, speed)
                if speed >= 3 { movingDistance += meters; moving += seconds }
            }
        }
        previous = fix
        intervalSpeed = nil
        if let speed = fix.speedKmh, speed.isFinite, speed >= 0 {
            speeds.append(speed); if speeds.count > 3 { speeds.removeFirst() }
            let accepted = speeds.count == 3 ? speeds.sorted()[1] : speed
            intervalSpeed = accepted
            speedKmh = accepted; speedSampleAt = fix.at
            maximum = max(maximum, accepted)
        } else {
            speeds.removeAll(keepingCapacity: true)
        }
    }
    // Display values remain available for this ride; loss only breaks integration.
    mutating func loseFix() { previous = nil; intervalSpeed = nil; speeds.removeAll(keepingCapacity: true) }
    mutating func recordAltitude(_ meters: Double) {
        if let altitude { elevationGain = (elevationGain ?? 0) + max(0, meters - altitude) }
        else { elevationGain = 0 }
        altitude = meters
    }
    mutating func recordWatch(_ metric: WatchCyclingMetricEnvelope) {
        if let watch, metric.observedAt < watch.observedAt { return }
        watch = metric
        // Only old version-1 packets use the envelope date as the sample date.
        let sampleAt = metric.heartRateSampleAt ?? metric.observedAt
        guard let heart = metric.heartRateBPM,
              heart.isFinite, heart > 0, sampleAt >= startedAt, sampleAt <= metric.observedAt,
              lastHeart.map({ sampleAt > $0.at }) ?? true else { return }
        if let lastHeart {
            let seconds = min(WatchCyclingMetricEnvelope.freshnessInterval, sampleAt.timeIntervalSince(lastHeart.at))
            heartIntegral += lastHeart.value * seconds; heartDuration += seconds
        }
        lastHeart = HeartSample(value: heart, at: sampleAt)
        heartMax = max(heartMax ?? heart, heart)
    }
    mutating func loseWatch() { watch = nil }
    func metrics(at date: Date, cadence: Double?) -> RideMetrics {
        var result = RideMetrics(speed_kmh: speedKmh, avg_kmh: average, max_kmh: maximum,
            distance_m: distance, moving_s: moving, elapsed_s: max(0, date.timeIntervalSince(startedAt)), elev_gain_m: elevationGain)
        result.speed_sample_at = speedSampleAt
        result.hr_bpm = lastHeart?.value; result.hr_sample_at = lastHeart?.at
        if let watch, WatchCyclingMetricEnvelope.isFresh(watch.observedAt, at: date) {
            result.kcal = watch.activeEnergyKcal
        }
        if let intervalSpeed, intervalSpeed > 5, let cadence { result.cadence_rpm = cadence; result.cadence_source = "pocket_estimate" }
        return result
    }
    func summary(at date: Date) -> RideSummary {
        let tail = lastHeart.map { min(WatchCyclingMetricEnvelope.freshnessInterval, max(0, date.timeIntervalSince($0.at))) } ?? 0
        let duration = heartDuration + tail
        let heartAverage = duration > 0 ? (heartIntegral + (lastHeart?.value ?? 0) * tail) / duration : lastHeart?.value
        return RideSummary(started_at: startedAt, ended_at: date, distance_m: distance, moving_s: moving,
            elapsed_s: max(0, date.timeIntervalSince(startedAt)), avg_kmh: average, max_kmh: maximum,
            elev_gain_m: elevationGain, kcal: watch?.activeEnergyKcal,
            hr_avg: heartAverage, hr_max: heartMax)
    }
}

struct PocketCadenceEstimator: Sendable {
    private var samples: [(time: Double, axes: [Double])] = []
    mutating func sample(at time: Double, x: Double, y: Double, z: Double) {
        samples.append((time, [x, y, z]))
        samples.removeAll { time - $0.time > 6 }
    }
    func estimate(speedKmh: Double, at time: Double) -> Double? {
        guard speedKmh > 5, let first = samples.first, let last = samples.last,
              last.time - first.time >= 4, time - last.time < 0.2 else { return nil }
        let rate = Double(samples.count - 1) / (last.time - first.time)
        let axes = (0..<3).map { axis -> [Double] in
            let values = samples.map { $0.axes[axis] }, mean = values.reduce(0, +) / Double(values.count)
            return values.map { $0 - mean }
        }
        let values = axes.max { a, b in a.reduce(0) { $0 + $1 * $1 } < b.reduce(0) { $0 + $1 * $1 } }!
        guard values.reduce(0, { $0 + $1 * $1 }) > 0.001 else { return nil }
        let low = max(1, Int(rate * 60 / 120)), high = min(values.count - 2, Int(ceil(rate * 60 / 40)))
        guard low < high else { return nil }
        var correlations: [Int: Double] = [:]
        for lag in (low - 1)...(high + 1) {
            var cross = 0.0, left = 0.0, right = 0.0
            for i in lag..<values.count {
                cross += values[i] * values[i - lag]; left += values[i] * values[i]; right += values[i - lag] * values[i - lag]
            }
            correlations[lag] = left * right > 0 ? cross / sqrt(left * right) : 0
        }
        let peaks = (low...high).filter { correlations[$0]! >= correlations[$0 - 1]! && correlations[$0]! >= correlations[$0 + 1]! }
        guard let strongest = peaks.map({ correlations[$0]! }).max(), strongest >= 0.65,
              let lag = peaks.first(where: { correlations[$0]! >= strongest - 0.05 }) else { return nil }
        // Repeated periods are harmonics, not competing cadence estimates.
        let rivals = peaks.filter { other in
            let ratio = Double(other) / Double(lag)
            return other != lag && abs(ratio - ratio.rounded()) > 0.12
        }
        guard rivals.allSatisfy({ correlations[lag]! - correlations[$0]! >= 0.15 }) else { return nil }
        let a = correlations[lag - 1]!, b = correlations[lag]!, c = correlations[lag + 1]!
        let offset = a - 2 * b + c == 0 ? 0 : 0.5 * (a - c) / (a - 2 * b + c)
        return min(120, max(40, rate * 60 / (Double(lag) + offset)))
    }
}

struct NavigationFollower: Codable, Sendable {
    private enum CodingKeys: String, CodingKey { case route, step, offFixes, offReported }
    let route: NavRoute
    private var step = 0, offFixes = 0
    private var offReported = false
    private(set) var progress: NavProgress?
    init(route: NavRoute) { self.route = route }
    mutating func loseFix() { offFixes = 0 }
    mutating func update(_ fix: MoveFix, countOffRouteFix: Bool = true) -> String? {
        let coordinate = fix.position.coordinate
        if coordinate.distance(to: MoveCoordinate(lat: route.destination.lat, lng: route.destination.lng)) <= 25 { return "arrived" }
        let projections = route.steps.map { project(coordinate, onto: $0.polyline) }
        var state: String?
        if projections.map(\.distance).min()! > 40 {
            if countOffRouteFix { offFixes += 1 }
            if offFixes >= 3, !offReported { offReported = true; state = "off_route" }
        } else {
            offFixes = 0
            while step < route.steps.count - 1, projections[step + 1].distance <= 40,
                  projections[step + 1].distance < projections[step].distance || projections[step].fraction >= 0.999 {
                step += 1
            }
        }
        let current = route.steps[step], toTurn = current.distance_m * (1 - projections[step].fraction)
        let unscaled = toTurn + route.steps.dropFirst(step + 1).reduce(0) { $0 + $1.distance_m }
        let length = route.steps.reduce(0) { $0 + $1.distance_m }
        let remaining = length > 0 ? route.total_m * unscaled / length : 0
        progress = NavProgress(nav_id: route.nav_id, revision: route.revision, step_index: current.index,
            maneuver: current.maneuver, distance_to_maneuver_m: toTurn, road: current.road,
            remaining_m: remaining, remaining_s: route.total_m > 0 ? route.total_s * remaining / route.total_m : 0,
            route_segment_index: max(0, route.steps.prefix(step).reduce(0) { $0 + $1.polyline.count } + projections[step].segment),
            segment_fraction: projections[step].segmentFraction)
        return state
    }
    private func project(_ point: MoveCoordinate, onto line: [MoveCoordinate]) -> (distance: Double, fraction: Double, segment: Int, segmentFraction: Double) {
        let scale = cos(point.lat * .pi / 180), radians = Double.pi / 180 * 6_371_000
        var nearest = Double.infinity, along = 0.0, length = 0.0, selectedFraction = 0.0
        var selectedSegment = 0
        if line.count == 1 { return (point.distance(to: line[0]), 0, -1, 1) }
        for (index, pair) in zip(line, line.dropFirst()).enumerated() {
            let (a, b) = pair
            let ax = (a.lng - point.lng) * scale * radians, ay = (a.lat - point.lat) * radians
            let dx = (b.lng - a.lng) * scale * radians, dy = (b.lat - a.lat) * radians
            let squared = dx * dx + dy * dy, segment = sqrt(squared)
            let t = squared > 0 ? min(1, max(0, -(ax * dx + ay * dy) / squared)) : 0
            let distance = hypot(ax + t * dx, ay + t * dy)
            if distance < nearest { nearest = distance; along = length + t * segment; selectedSegment = index; selectedFraction = t }
            length += segment
        }
        return (nearest, length > 0 ? along / length : 0, selectedSegment, selectedFraction)
    }
}

/// Source-owned server feedback for one locally active ride. No phone heart-rate policy.
struct CentralRideFeedback: Codable, Equatable, Sendable {
    let ride_id: String
    let at: String
    let hr_zone: Int?
    let text: String?
    let max_hr_bpm: Int?
}

struct MoveSession: Codable, Sendable {
    private(set) var rideID: String?
    private(set) var lastRideState: RideState?
    private(set) var lastRideWorkoutID: String?
    private(set) var feedback: CentralRideFeedback?
    private(set) var ride: RideStatistics?
    private(set) var navigation: NavigationFollower?
    private var lastRideEndedAt: Date?
    private var startedBy = "phone", sequence = 0
    private var fix: MoveFix?
    private(set) var watchWorkoutID: String?
    private var awaitingWatchSnapshot = false
    private var lastWatchSnapshotSequence: UInt64 = 0
    var isActive: Bool { !awaitingWatchSnapshot && (ride != nil || navigation != nil) }

    init() {}
    init(checkpoint: Data) throws {
        self = try JSONDecoder().decode(Self.self, from: checkpoint)
        awaitingWatchSnapshot = ride != nil && watchWorkoutID != nil
        lastWatchSnapshotSequence = 0
        loseFix(); loseWatch(); feedback = nil
    }
    func checkpoint() throws -> Data { try JSONEncoder().encode(self) }

    /// Recovery is dormant until the paired Watch publishes its current workout.
    mutating func reconcileWatchWorkout(_ snapshot: WatchCyclingWorkoutSnapshot, at date: Date) -> [MoveEvent] {
        let metric = snapshot.metric
        guard metric.sequence > lastWatchSnapshotSequence else { return [] }
        lastWatchSnapshotSequence = metric.sequence
        if let lastRideEndedAt, snapshot.startedAt <= lastRideEndedAt { return [] }
        if let watchWorkoutID, watchWorkoutID != metric.workoutID { return [] }
        if metric.workoutState == .ended {
            guard ride == nil || watchWorkoutID == metric.workoutID else { return [] }
            awaitingWatchSnapshot = false
            ride?.recordWatch(metric)
            let events = endRide(at: metric.observedAt)
            lastRideEndedAt = metric.observedAt
            return events
        }
        guard metric.workoutState == .started else { return [] }
        var events: [MoveEvent] = []
        if ride == nil {
            guard metric.workoutOrigin == .watch else { return [] }
            events = startRide(by: "watch", at: snapshot.startedAt)
        }
        guard metric.observedAt >= ride!.startedAt,
              watchWorkoutID != nil || snapshot.startedAt >= ride!.startedAt else { return events }
        watchWorkoutID = metric.workoutID
        awaitingWatchSnapshot = false
        ride?.recordWatch(metric)
        return events
    }

    mutating func acceptFeedback(_ next: CentralRideFeedback) -> Bool {
        guard ride != nil, next.ride_id == rideID,
              let at = RealtimeControlValidation.parseTimestamp(next.at),
              feedback.flatMap({ RealtimeControlValidation.parseTimestamp($0.at) }).map({ at > $0 }) ?? true else { return false }
        feedback = next
        return true
    }
    mutating func clearFeedback() { feedback = nil }

    mutating func startRide(by source: String, at date: Date) -> [MoveEvent] {
        guard ride == nil else { return [] }
        if !isActive { sequence = 0; fix = nil }
        let id = UUID().uuidString.lowercased()
        rideID = id; ride = RideStatistics(startedAt: date); startedBy = source; feedback = nil
        let state = RideState(ride_id: id, state: "started", at: date, started_by: source)
        lastRideState = state; lastRideWorkoutID = nil
        return [.rideState(state)]
    }
    mutating func endRide(at date: Date) -> [MoveEvent] {
        guard let rideID, let ride else { return [] }
        lastRideWorkoutID = watchWorkoutID
        self.rideID = nil; self.ride = nil; watchWorkoutID = nil; feedback = nil; awaitingWatchSnapshot = false
        lastRideEndedAt = date
        let state = RideState(ride_id: rideID, state: "ended", at: date, started_by: startedBy, summary: ride.summary(at: date))
        lastRideState = state
        return [.rideState(state)]
    }
    mutating func follow(_ route: NavRoute, at date: Date) -> [MoveEvent] {
        if let old = navigation?.route, old.nav_id == route.nav_id, old.revision >= route.revision { return [] }
        var events = navigation?.route.nav_id != route.nav_id ? stopNavigation(at: date) : []
        if !isActive { sequence = 0; fix = nil }
        navigation = NavigationFollower(route: route)
        if let fix { events += advanceNavigation(fix, countOffRouteFix: false) }
        return events
    }
    mutating func stopNavigation(at date: Date) -> [MoveEvent] {
        guard let navigation else { return [] }
        self.navigation = nil
        return [.navState(NavState(nav_id: navigation.route.nav_id, state: "cancelled", at: date))]
    }
    mutating func observe(_ fix: MoveFix) -> [MoveEvent] {
        guard isActive else { return [] }
        guard fix.position.accuracy_m >= 0, fix.position.accuracy_m <= 20 else { ride?.loseFix(); navigation?.loseFix(); return [] }
        guard self.fix == nil || fix.at > self.fix!.at else { return [] }
        self.fix = fix
        if fix.at >= (ride?.startedAt ?? fix.at) { ride?.record(fix) }
        return advanceNavigation(fix)
    }
    private mutating func advanceNavigation(_ fix: MoveFix, countOffRouteFix: Bool = true) -> [MoveEvent] {
        guard let state = navigation?.update(fix, countOffRouteFix: countOffRouteFix), let id = navigation?.route.nav_id else { return [] }
        if state == "arrived" { navigation = nil }
        return [.navState(NavState(nav_id: id, state: state, at: fix.at, position: fix.position.coordinate))]
    }
    mutating func loseFix() { fix = nil; ride?.loseFix(); navigation?.loseFix() }
    mutating func watchMetric(_ metric: WatchCyclingMetricEnvelope, at date: Date) -> [MoveEvent] {
        var events: [MoveEvent] = []
        if awaitingWatchSnapshot {
            guard metric.workoutState == .ended, metric.workoutID == watchWorkoutID,
                  metric.observedAt >= ride!.startedAt else { return [] }
            ride?.recordWatch(metric)
            return endRide(at: metric.observedAt)
        }
        if metric.workoutState == .started {
            if let lastRideEndedAt, metric.observedAt <= lastRideEndedAt { return [] }
            if ride == nil, metric.workoutOrigin != .phone { events = startRide(by: "watch", at: metric.observedAt) }
        }
        guard ride != nil else { return events }
        if watchWorkoutID == nil {
            guard metric.workoutState == .started else { return events }
            watchWorkoutID = metric.workoutID
        }
        guard watchWorkoutID == metric.workoutID else { return events }
        if metric.workoutState == .ended, metric.observedAt < ride!.startedAt {
            watchWorkoutID = nil; ride?.loseWatch(); return events
        }
        guard metric.observedAt >= ride!.startedAt else { return events }
        ride?.recordWatch(metric)
        if metric.workoutState == .ended {
            // The phone keeps tracking until delivery; its stop time bounds the GPS summary.
            events += endRide(at: date)
            lastRideEndedAt = metric.observedAt
        }
        return events
    }
    mutating func loseWatch() { ride?.loseWatch() }
    mutating func recordAltitude(_ meters: Double) { ride?.recordAltitude(meters) }
    mutating func frame(at date: Date, cadence: Double?) -> MoveEvent? {
        guard isActive else { return nil }
        if let fix, !(0...5).contains(date.timeIntervalSince(fix.at)) { loseFix() }
        sequence += 1
        var sampledPosition = fix?.position
        sampledPosition?.at = fix?.at
        return .frame(MoveFrame(ride_id: rideID, nav_id: navigation?.route.nav_id, seq: sequence, at: date,
            position: sampledPosition, ride: ride?.metrics(at: date, cadence: cadence), nav: fix == nil ? nil : navigation?.progress))
    }
}
