import CoreLocation
import Foundation
import OSLog
#if os(iOS)
import UIKit
#endif

enum AssistantLocationQuality: String, Equatable, Sendable {
    case precise
    case degraded
    case unavailable

    var displayName: String {
        switch self {
        case .precise: return "Precise"
        case .degraded: return "Degraded"
        case .unavailable: return "Unavailable"
        }
    }
}

struct AssistantLocationObservation: Equatable, Sendable {
    // Local capture identifier only; not a canonical Observation object ID.
    let localCaptureID: String
    let latitude: Double
    let longitude: Double
    let horizontalAccuracy: Double
    let observedAt: Date
    /// Human-readable place from on-device reverse geocoding, when available.
    var place: String? = nil

    var quality: AssistantLocationQuality {
        guard latitude.isFinite, longitude.isFinite,
              horizontalAccuracy >= 0
        else {
            return .unavailable
        }
        let stale = Date().timeIntervalSince(observedAt) > 300
        return horizontalAccuracy > 1_000 || stale
            ? .degraded
            : .precise
    }
}

/// Why the phone has no fix, in the words of the `unavailable_reason` field of a `location_update` (the wire values).
enum AssistantLocationUnavailableReason: String, Equatable, Sendable {
    case sharingOff = "sharing_off"
    case permissionDenied = "permission_denied"
    case permissionRestricted = "permission_restricted"
    case permissionNotDetermined = "permission_not_determined"
    case locationUnknown = "location_unknown"
    case network
    case timeout
    /// CoreLocation answered with a position measured before the request, so it is not a fresh observation.
    case staleFix = "stale_fix"
    case invalidFix = "invalid_fix"
    /// Only While Using authorization and the app is not in the foreground: CoreLocation gives nothing then.
    case backgroundWhenInUse = "background_when_in_use"
    case reducedAccuracy = "reduced_accuracy"
    case failed = "location_failed"

    /// A failure while the app is off-screen under While Using authorization is that, whatever CoreLocation called it.
    static func failure(_ reason: Self, status: CLAuthorizationStatus, foreground: Bool) -> Self {
        // 4 is authorizedWhenInUse, which macOS does not declare.
        status.rawValue == 4 && !foreground ? .backgroundWhenInUse : reason
    }

    /// The permission that stops a fix; nil while location is authorized.
    static func blocking(_ status: AssistantPermissionStatus) -> Self? {
        switch status {
        case .authorized: return nil
        case .denied: return .permissionDenied
        case .restricted: return .permissionRestricted
        case .notDetermined: return .permissionNotDetermined
        case .unavailable: return .failed
        }
    }

    init(clError code: CLError.Code?) {
        switch code {
        case .locationUnknown: self = .locationUnknown
        case .denied: self = .permissionDenied
        case .network: self = .network
        default: self = .failed
        }
    }

    init(_ error: Error) {
        switch error {
        case AssistantLocationError.unavailable(let reason): self = reason
        case AssistantLocationError.permissionDenied: self = .permissionDenied
        default: self = Self(clError: (error as? CLError)?.code)
        }
    }
}

enum AssistantLocationError: LocalizedError, Equatable, Sendable {
    case requestWasNotUserInitiated
    case permissionDenied
    case unavailable(AssistantLocationUnavailableReason)
    case supersededRequest

    var errorDescription: String? {
        switch self {
        case .requestWasNotUserInitiated:
            return "位置权限只能由明确的用户操作触发。"
        case .permissionDenied:
            return "位置权限未允许。"
        case .unavailable:
            return "当前无法取得位置。"
        case .supersededRequest:
            return "已有位置请求被新的用户请求替代。"
        }
    }
}

@MainActor
protocol AssistantLocationProviding: AnyObject {
    func authorizationStatus() -> AssistantPermissionStatus
    func cachedFixAgeMilliseconds() -> Int?
    func requestWhenInUseAuthorization(
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus
    func requestOneShot(
        userInitiated: Bool
    ) async throws -> AssistantLocationObservation
}

protocol AssistantBackgroundLocationManaging: AnyObject {
    var allowsBackgroundLocationUpdates: Bool { get set }
    var showsBackgroundLocationIndicator: Bool { get set }
}

#if os(iOS)
extension CLLocationManager: AssistantBackgroundLocationManaging {}
#endif

@MainActor
final class LocationService: NSObject, AssistantLocationProviding {
    static func configureBackgroundLocation(_ manager: any AssistantBackgroundLocationManaging) {
        manager.allowsBackgroundLocationUpdates = true
        // With When In Use authorization, iOS still shows its required background indicator.
        manager.showsBackgroundLocationIndicator = false
    }

    private struct LocationPayload: Sendable {
        let latitude: Double
        let longitude: Double
        let horizontalAccuracy: Double
        let timestamp: Date
    }

    private final class DelegateBridge: NSObject, CLLocationManagerDelegate {
        weak var owner: LocationService?

        nonisolated func locationManagerDidChangeAuthorization(
            _ manager: CLLocationManager
        ) {
            let status = manager.authorizationStatus
            let owner = self.owner
            Task { @MainActor [weak owner] in
                owner?.handleAuthorizationChange(status)
            }
        }

        nonisolated func locationManager(
            _ manager: CLLocationManager,
            didUpdateLocations locations: [CLLocation]
        ) {
            let payload = locations.last.map {
                LocationPayload(
                    latitude: $0.coordinate.latitude,
                    longitude: $0.coordinate.longitude,
                    horizontalAccuracy: $0.horizontalAccuracy,
                    timestamp: $0.timestamp
                )
            }
            let owner = self.owner
            Task { @MainActor [weak owner] in
                owner?.handleLocationUpdate(payload)
            }
        }

        nonisolated func locationManager(
            _ manager: CLLocationManager,
            didFailWithError error: Error
        ) {
            let owner = self.owner
            let reason = AssistantLocationUnavailableReason(clError: (error as? CLError)?.code)
            Task { @MainActor [weak owner] in
                owner?.handleLocationFailure(reason)
            }
        }
#if os(iOS)
        nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
            let coordinate = visit.coordinate, accuracy = visit.horizontalAccuracy
            let arrival = visit.arrivalDate, departure = visit.departureDate
            Task { @MainActor [weak owner] in
                owner?.handleVisit(latitude: coordinate.latitude, longitude: coordinate.longitude,
                    accuracy: accuracy, arrival: arrival, departure: departure)
            }
        }
#endif
        nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
            sendRegion(region, kind: .regionEnter)
        }
        nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
            sendRegion(region, kind: .regionExit)
        }
        nonisolated private func sendRegion(_ region: CLRegion, kind: PlaceEvent.Kind) {
            let id = region.identifier, crossedAt = Date()
            Task { @MainActor [weak owner] in owner?.handleRegion(id, kind: kind, crossedAt: crossedAt) }
        }
        nonisolated func locationManager(_ manager: CLLocationManager, didStartMonitoringFor region: CLRegion) {
            Task { @MainActor [weak owner] in owner?.onPlaceAuthorizationChange?() }
        }
        nonisolated func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
            Task { @MainActor [weak owner] in owner?.placeLogger.error("Place region monitoring failed"); owner?.onPlaceAuthorizationChange?() }
        }

    }

    private let manager: CLLocationManager
    private let delegateBridge: DelegateBridge
    private let oneShotTimeout: UInt64
    private let defaults: UserDefaults
    private let requestAlways: () -> Void
    private let isForeground: () -> Bool
    private static let alwaysRequestedKey = "paios.location.always-requested"
    var onAuthorizationChange: (() -> Void)?
    private var authorizationContinuations: [CheckedContinuation<AssistantPermissionStatus, Error>] = []
    private var locationTimeout: Task<Void, Never>?
    private var locationContinuations:
        [(id: UUID, requestedAt: Date, continuation: CheckedContinuation<AssistantLocationObservation, Error>)] = []
    private let placeLogger = Logger(subsystem: "ai.paios.personal.phase0", category: "places")
    /// nil until `configurePlaces` brings a successfully read state: what the OS persisted is never touched before.
    private var placesEnabled: Bool?
    private var placeRegions: [PlaceRegion] = []
    var placeAuthorization: CLAuthorizationStatus { manager.authorizationStatus }
    var monitoredPlaceRegionCount: Int { manager.monitoredRegions.count }
    var onPlaceEvent: ((PlaceEvent) -> Void)?
    var onPlaceAuthorizationChange: (() -> Void)?
    /// Asked when a visit or region arrives before the state was read (relaunched before the first unlock).
    var onPlaceStateNeeded: (() -> Void)?

    init(manager: CLLocationManager = CLLocationManager(), oneShotTimeout: UInt64 = 10_000_000_000,
         defaults: UserDefaults = .standard, requestAlways: (() -> Void)? = nil,
         isForeground: @escaping () -> Bool = { LocationService.appIsForeground() }) {
        self.manager = manager
        self.oneShotTimeout = oneShotTimeout
        self.defaults = defaults
        self.isForeground = isForeground
        self.requestAlways = requestAlways ?? {
#if os(iOS)
            manager.requestAlwaysAuthorization()
#endif
        }
        self.delegateBridge = DelegateBridge()
        super.init()
        delegateBridge.owner = self
        manager.delegate = delegateBridge
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = false
    }

    nonisolated static func appIsForeground() -> Bool {
#if os(iOS)
        MainActor.assumeIsolated { UIApplication.shared.applicationState == .active }
#else
        true
#endif
    }

    func authorizationStatus() -> AssistantPermissionStatus {
        Self.map(manager.authorizationStatus)
    }

    func cachedFixAgeMilliseconds() -> Int? {
        guard let fix = manager.location, fix.horizontalAccuracy >= 0 else { return nil }
        let age = Date().timeIntervalSince(fix.timestamp)
        return age >= 0 ? Int(age * 1_000) : nil
    }

    func requestWhenInUseAuthorization(
        userInitiated: Bool
    ) async throws -> AssistantPermissionStatus {
        guard userInitiated else {
            throw AssistantLocationError.requestWasNotUserInitiated
        }

        let current = authorizationStatus()
        guard current == .notDetermined else {
            guard current == .authorized else {
                throw AssistantLocationError.permissionDenied
            }
            return current
        }

        return try await withCheckedThrowingContinuation { continuation in
            let shouldRequest = authorizationContinuations.isEmpty
            authorizationContinuations.append(continuation)
            if shouldRequest { manager.requestWhenInUseAuthorization() }
        }
    }

    func requestOneShot(
        userInitiated: Bool
    ) async throws -> AssistantLocationObservation {
        let requestedAt = Date()
        let status = authorizationStatus() == .notDetermined
            ? try await requestWhenInUseAuthorization(userInitiated: userInitiated)
            : authorizationStatus()
        guard status == .authorized else { throw AssistantLocationError.permissionDenied }
        guard manager.accuracyAuthorization == .fullAccuracy else {
            throw AssistantLocationError.unavailable(.reducedAccuracy)
        }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let shouldRequest = locationContinuations.isEmpty
                locationContinuations.append((id, requestedAt, continuation))
                guard shouldRequest else { return }
                locationTimeout = Task { [weak self, oneShotTimeout] in
                    do { try await Task.sleep(nanoseconds: oneShotTimeout) } catch { return }
                    guard !Task.isCancelled else { return }
                    self?.handleLocationFailure(.timeout)
                }
                // A continuous burst can outlive the initial cached callback and obtain a new background fix.
                #if os(iOS)
                Self.configureBackgroundLocation(manager)
                #endif
                manager.startUpdatingLocation()
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelLocationRequest(id) }
        }
    }

    private func cancelLocationRequest(_ id: UUID) {
        guard let index = locationContinuations.firstIndex(where: { $0.id == id }) else { return }
        locationContinuations.remove(at: index).continuation.resume(throwing: CancellationError())
        if locationContinuations.isEmpty { stopOneShot() }
    }

    private func stopOneShot() {
        locationTimeout?.cancel(); locationTimeout = nil
        manager.stopUpdatingLocation()
        #if os(iOS)
        manager.allowsBackgroundLocationUpdates = false
        #endif
    }

    nonisolated static func map(
        _ status: CLAuthorizationStatus
    ) -> AssistantPermissionStatus {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            return .authorized
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .unavailable
        }
    }

    private func handleAuthorizationChange(_ rawStatus: CLAuthorizationStatus) {
        let status = Self.map(rawStatus)
        if let blocked = AssistantLocationUnavailableReason.blocking(status), status != .notDetermined { handleLocationFailure(blocked) }
        else if manager.accuracyAuthorization == .reducedAccuracy { handleLocationFailure(.reducedAccuracy) }
        syncPlaceMonitoring()
        onPlaceAuthorizationChange?()
        onAuthorizationChange?()
        guard status != .notDetermined else { return }
        let continuations = authorizationContinuations
        authorizationContinuations.removeAll()
        for continuation in continuations {
            if status == .authorized { continuation.resume(returning: status) }
            else { continuation.resume(throwing: AssistantLocationError.permissionDenied) }
        }
    }

    private func handleLocationUpdate(_ payload: LocationPayload?) {
        guard !locationContinuations.isEmpty else { return }
        guard let payload,
              CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: payload.latitude, longitude: payload.longitude)),
              payload.horizontalAccuracy.isFinite, payload.horizontalAccuracy >= 0,
              payload.timestamp <= Date()
        else {
            handleLocationFailure(.invalidFix)
            return
        }
        guard manager.accuracyAuthorization == .fullAccuracy else { handleLocationFailure(.reducedAccuracy); return }
        let fix = AssistantLocationObservation(localCaptureID: UUID().uuidString.lowercased(),
            latitude: payload.latitude, longitude: payload.longitude,
            horizontalAccuracy: payload.horizontalAccuracy, observedAt: payload.timestamp)
        // Core Location may deliver its cache first. Keep each caller waiting for a measurement made after it asked.
        let ready = locationContinuations.filter { payload.timestamp >= $0.requestedAt }
        locationContinuations.removeAll { payload.timestamp >= $0.requestedAt }
        if locationContinuations.isEmpty { stopOneShot() }
        for item in ready { item.continuation.resume(returning: fix) }
    }

    private func handleLocationFailure(_ reason: AssistantLocationUnavailableReason) {
        // Standard updates report locationUnknown while acquiring a signal. The bounded wait still owns completion.
        if reason == .locationUnknown { return }
        let pending = locationContinuations
        locationContinuations.removeAll()
        if !pending.isEmpty { stopOneShot() }
        let reason = AssistantLocationUnavailableReason.failure(reason, status: manager.authorizationStatus, foreground: isForeground())
        for item in pending { item.continuation.resume(throwing: AssistantLocationError.unavailable(reason)) }
    }

    func requestAlwaysAuthorization(userInitiated: Bool, glassesPaired: Bool = false) async throws {
        guard userInitiated, isForeground(), placesEnabled == true || glassesPaired else { throw AssistantLocationError.requestWasNotUserInitiated }
        guard placeAuthorization != .authorizedAlways, !defaults.bool(forKey: Self.alwaysRequestedKey) else { return }
        _ = try await requestWhenInUseAuthorization(userInitiated: true)
        // When In Use may finish while inactive. Only an issued Always request consumes the one prompt.
        guard isForeground(), placeAuthorization != .authorizedAlways,
              !defaults.bool(forKey: Self.alwaysRequestedKey) else { return }
        defaults.set(true, forKey: Self.alwaysRequestedKey)
        requestAlways()
    }

    /// The first call restores: regions the OS already monitors are kept by identifier (restored circles may differ in
    /// their last bits, and replacing one could drop its pending crossing). A changed set from the server replaces them.
    func configurePlaces(enabled: Bool, regions: [PlaceRegion]) {
        let replace = placesEnabled != nil && regions != placeRegions
        placesEnabled = enabled; placeRegions = regions
        syncPlaceMonitoring(replace: replace)
        onPlaceAuthorizationChange?()
    }

    private func syncPlaceMonitoring(replace: Bool = false) {
        guard let enabled = placesEnabled else { return }
        let active = enabled && placeAuthorization == .authorizedAlways
#if os(iOS)
        if active { manager.startMonitoringVisits() } else { manager.stopMonitoringVisits() }
#endif
        let desired = active ? placeRegions : []
        var kept = Set<String>()
        for region in manager.monitoredRegions {
            if !replace, desired.contains(where: { $0.id == region.identifier }) { kept.insert(region.identifier) }
            else { manager.stopMonitoring(for: region) }
        }
        for region in desired where !kept.contains(region.id) {
            guard CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: region.latitude, longitude: region.longitude)),
                  region.radius_m.isFinite, region.radius_m > 0 else {
                placeLogger.error("Dropped invalid place region"); continue
            }
            manager.startMonitoring(for: CLCircularRegion(center: CLLocationCoordinate2D(latitude: region.latitude,
                longitude: region.longitude), radius: region.radius_m, identifier: region.id))
        }
    }

    private func placesActive() -> Bool {
        if placesEnabled == nil { onPlaceStateNeeded?() }
        if placesEnabled == nil { placeLogger.error("Dropped place event: place state unreadable; monitoring kept") }
        return placesEnabled == true && placeAuthorization == .authorizedAlways
    }

#if os(iOS)
    private func handleVisit(latitude: Double, longitude: Double, accuracy: Double, arrival: Date, departure: Date) {
        guard placesActive() else { return }
        guard arrival != .distantPast else { placeLogger.error("Dropped place visit: unknown arrival time"); return }
        let departed = departure != .distantFuture
        let observedAt = departed ? departure : arrival
        guard observedAt != .distantPast, observedAt != .distantFuture, observedAt <= Date(),
              arrival != .distantFuture, arrival <= observedAt,
              CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: latitude, longitude: longitude)),
              accuracy.isFinite, accuracy >= 0 else { placeLogger.error("Dropped invalid place visit sensor"); return }
        let fix = AssistantLocationObservation(localCaptureID: UUID().uuidString.lowercased(),
            latitude: latitude, longitude: longitude, horizontalAccuracy: accuracy, observedAt: observedAt)
        onPlaceEvent?(PlaceEvent(kind: departed ? .visitDeparture : .visitArrival, location: fix,
            arrivalAt: arrival, departureAt: departed ? departure : nil))
    }
#endif

    /// Emitted at once with the region's own circle (centre, radius as accuracy, crossing time): a crossing where no
    /// fresh fix comes (garage, lift) is still recorded.
    private func handleRegion(_ id: String, kind: PlaceEvent.Kind, crossedAt: Date) {
        guard placesActive(), let region = placeRegions.first(where: { $0.id == id }) else { return }
        let fix = AssistantLocationObservation(localCaptureID: UUID().uuidString.lowercased(), latitude: region.latitude,
            longitude: region.longitude, horizontalAccuracy: region.radius_m, observedAt: crossedAt)
        onPlaceEvent?(PlaceEvent(kind: kind, location: fix, regionID: id))
    }
}

/// One low-accuracy feed shared by 随身模式 and paired glasses with Always authorization.
/// Standard updates keep background execution eligible; significant changes restore it after system termination.
/// Neither service guarantees immediate delivery or overrides a user's force quit.
@MainActor
final class AssistantAmbientLocationFeed: NSObject {
    static let movementFilterMeters: CLLocationDistance = 200
    static let stillHereInterval: UInt64 = 300_000_000_000

    private final class Bridge: NSObject, CLLocationManagerDelegate {
        weak var owner: AssistantAmbientLocationFeed?
        nonisolated let consent: UInt64
        init(consent: UInt64) { self.consent = consent; super.init() }
        nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            guard let last = locations.last else { return }
            let fix = AssistantLocationObservation(localCaptureID: UUID().uuidString.lowercased(), latitude: last.coordinate.latitude,
                longitude: last.coordinate.longitude, horizontalAccuracy: last.horizontalAccuracy, observedAt: last.timestamp)
            let consent = consent
            Task { @MainActor [weak owner] in owner?.moved(fix, consent: consent) }
        }
        nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            let blocked = AssistantLocationUnavailableReason.blocking(LocationService.map(manager.authorizationStatus))
            let consent = consent
            Task { @MainActor [weak owner] in if let blocked, owner?.bridge?.consent == consent { owner?.lost(blocked); owner?.stop() } }
        }
        nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
            let consent = consent, reason = AssistantLocationUnavailableReason(clError: (error as? CLError)?.code)
            Task { @MainActor [weak owner] in
                guard let owner, owner.bridge?.consent == consent else { return }
                owner.lost(.failure(reason, status: owner.manager.authorizationStatus, foreground: LocationService.appIsForeground()))
            }
        }
    }

    private let manager: CLLocationManager
    private let locationService: any AssistantLocationProviding
    private var bridge: Bridge?
    private var report: ((AssistantLocationObservation?, Bool, AssistantLocationUnavailableReason?) -> Void)?
    private var last: AssistantLocationObservation?
    private var heartbeat: Task<Void, Never>?
    private var lossAt: Date?
    private var startedAt = Date()
    private(set) var navigationStandby = false
    private var reconnect: (() -> Void)?

    init(locationService: any AssistantLocationProviding, manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
        self.locationService = locationService
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = Self.movementFilterMeters
        manager.activityType = .other
        manager.pausesLocationUpdatesAutomatically = false
    }

    var isRunning: Bool { report != nil }

    func syncOwners(ambient: Bool, glassesPaired: Bool, locationEnabled: Bool, consent: UInt64,
                    report: @escaping (AssistantLocationObservation?, Bool, AssistantLocationUnavailableReason?) -> Void,
                    reconnect: @escaping () -> Void) {
        let standby = locationEnabled && glassesPaired && manager.authorizationStatus == .authorizedAlways
        let wanted = locationEnabled && (ambient || standby)
        if !wanted { stop(); return }
        start(consent: consent, report: report)
        self.reconnect = reconnect
        if standby != navigationStandby {
            navigationStandby = standby
            if standby { manager.startMonitoringSignificantLocationChanges(); reconnect() }
            else { manager.stopMonitoringSignificantLocationChanges() }
        }
    }

    /// Starts the feed (already authorized for location while in use; never prompts). `report` gets every fix and
    /// whether it is a sensor observation or a heartbeat of the retained observation; a loss carries its reason.
    func start(consent: UInt64, report: @escaping (AssistantLocationObservation?, Bool, AssistantLocationUnavailableReason?) -> Void) {
        guard self.report == nil, LocationService.map(manager.authorizationStatus) == .authorized else { return }
        let bridge = Bridge(consent: consent)
        bridge.owner = self; self.bridge = bridge; manager.delegate = bridge
        self.report = report; startedAt = Date(); lossAt = nil
        #if os(iOS)
        LocationService.configureBackgroundLocation(manager)
        #endif
        manager.startUpdatingLocation()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.stillHereInterval)
                guard !Task.isCancelled, let self else { return }
                await self.sendHeartbeat()
            }
        }
    }

    func sendHeartbeat() async {
        guard let bridge else { return }
        if lossAt == nil, Date().timeIntervalSince(last?.observedAt ?? startedAt) < 900 {
            if let last { report?(Self.stillHere(last, now: Date()), false, nil) }
            return
        }
        do {
            let fix = try await locationService.requestOneShot(userInitiated: false)
            guard self.bridge === bridge, !Task.isCancelled else { return }
            moved(fix, consent: bridge.consent)
        } catch {
            guard self.bridge === bridge, !Task.isCancelled else { return }
            lost(AssistantLocationUnavailableReason(error))
        }
    }

    func stop() {
        guard report != nil else { return }
        if navigationStandby { manager.stopMonitoringSignificantLocationChanges() }
        navigationStandby = false; reconnect = nil
        report = nil; last = nil
        bridge = nil; manager.delegate = nil
        heartbeat?.cancel(); heartbeat = nil
        manager.stopUpdatingLocation()
        #if os(iOS)
        manager.allowsBackgroundLocationUpdates = false
        #endif
    }

    private func moved(_ fix: AssistantLocationObservation, consent: UInt64) {
        guard report != nil, bridge?.consent == consent else { return }
        guard fix.quality != .unavailable else { lost(.invalidFix); return }
        if navigationStandby { reconnect?() }
        guard lossAt.map({ fix.observedAt > $0 }) ?? true else { return }
        lossAt = nil; last = fix
        report?(fix, true, nil)
    }

    private func lost(_ reason: AssistantLocationUnavailableReason) {
        if lossAt == nil { lossAt = Date() }
        last = nil; report?(nil, false, reason)
    }

    /// Feed liveness supplies no new evidence about the position, measurement time or accuracy.
    nonisolated static func stillHere(_ fix: AssistantLocationObservation, now: Date) -> AssistantLocationObservation {
        fix
    }
}
