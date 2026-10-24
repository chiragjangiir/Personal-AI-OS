import CoreLocation
import CoreMotion
import Foundation

@MainActor
final class MoveSessionSensors: NSObject, CLLocationManagerDelegate {
    private let location = CLLocationManager()
    #if os(iOS)
    private let motion = CMMotionManager()
    private let altimeter = CMAltimeter()
    #endif
    private var cadence = PocketCadenceEstimator()
    private var timer: Task<Void, Never>?
    private var generation = 0
    private var startedAt = Date()
    private var riding = false
    private var report: (@Sendable (MoveSensorEvent) async -> Void)?

    func start(ride: Bool, report: @escaping @Sendable (MoveSensorEvent) async -> Void) {
        if self.report == nil {
            generation += 1; self.report = report; startedAt = Date()
            location.delegate = self
            location.activityType = .fitness
            location.desiredAccuracy = kCLLocationAccuracyBest
            location.distanceFilter = kCLDistanceFilterNone
            location.pausesLocationUpdatesAutomatically = false
            #if os(iOS)
            LocationService.configureBackgroundLocation(location)
            #endif
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
            else if LocationService.map(location.authorizationStatus) == .authorized { location.startUpdatingLocation() }
            else { Task { await report(.failure(AssistantLocationError.permissionDenied, location: true)) } }
            timer = Task { [weak self] in
                let clock = ContinuousClock()
                var next = clock.now
                while !Task.isCancelled {
                    next += .seconds(1)
                    if next < clock.now { next = clock.now + .seconds(1) }
                    do { try await clock.sleep(until: next) } catch { return }
                    guard !Task.isCancelled, let report = self?.report else { return }
                    await report(.tick(Date()))
                }
            }
        }
        let startRide = ride && !riding
        if riding != ride { generation += 1 }
        riding = ride
        #if os(iOS)
        let generation = generation
        if startRide, motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 1 / 50
            motion.startDeviceMotionUpdates(to: .main) { [weak self] data, error in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation, self.motion.isDeviceMotionActive else { return }
                    if let error { self.motion.stopDeviceMotionUpdates(); await self.report?(.failure(error, location: false)); return }
                    if let data {
                        let a = data.userAcceleration
                        self.cadence.sample(at: data.timestamp, x: a.x, y: a.y, z: a.z)
                    }
                }
            }
        }
        if startRide, CMAltimeter.isRelativeAltitudeAvailable() {
            altitudeRunning = true
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, error in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation, self.altitudeRunning else { return }
                    if let error { self.altimeter.stopRelativeAltitudeUpdates(); self.altitudeRunning = false; await self.report?(.failure(error, location: false)); return }
                    if let data { await self.report?(.altitude(data.relativeAltitude.doubleValue)) }
                }
            }
        }
        #endif
        if !ride { stopRideSensors() }
    }
    private var altitudeRunning = false
    private func stopRideSensors() {
        #if os(iOS)
        motion.stopDeviceMotionUpdates(); altimeter.stopRelativeAltitudeUpdates()
        #endif
        altitudeRunning = false; cadence = PocketCadenceEstimator()
    }
    func stop() {
        generation += 1; report = nil; riding = false
        timer?.cancel(); timer = nil
        location.stopUpdatingLocation(); location.delegate = nil
        #if os(iOS)
        location.allowsBackgroundLocationUpdates = false
        #endif
        stopRideSensors()
    }
    func estimatedCadence(speedKmh: Double) -> Double? {
        cadence.estimate(speedKmh: speedKmh, at: ProcessInfo.processInfo.systemUptime)
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations.map { MoveFix(position: MovePosition(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude,
            accuracy_m: $0.horizontalAccuracy, course_deg: $0.course >= 0 ? $0.course : nil),
            at: $0.timestamp, speedKmh: $0.speed >= 0 ? $0.speed * 3.6 : nil) }
        Task { @MainActor [weak self] in
            guard let self else { return }
            for fix in fixes where fix.at >= self.startedAt { await self.report?(.fix(fix)) }
        }
    }
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let authorized = LocationService.map(manager.authorizationStatus) == .authorized
        Task { @MainActor [weak self] in
            guard let self, let report = self.report else { return }
            if authorized { self.location.startUpdatingLocation() }
            else if self.location.authorizationStatus != .notDetermined {
                self.location.stopUpdatingLocation(); await report(.failure(AssistantLocationError.permissionDenied, location: true))
            }
        }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor [weak self] in await self?.report?(.failure(error, location: true)) }
    }
}

enum MoveSensorEvent: Sendable {
    case fix(MoveFix), altitude(Double), tick(Date), failure(Error, location: Bool)
}
