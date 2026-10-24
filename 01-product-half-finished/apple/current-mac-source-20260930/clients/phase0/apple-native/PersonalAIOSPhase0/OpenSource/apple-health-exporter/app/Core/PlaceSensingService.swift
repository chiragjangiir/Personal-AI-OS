import Combine
import CoreLocation
import Foundation
import OSLog
#if os(iOS)
import UIKit
#endif

struct PlaceSensingState: Codable, Equatable, Sendable {
    var enabled = false
    var identity: String?
    var regionVersion: Int?
    var regions: [PlaceRegion] = []
    var lastUpload: Date?
    var needsRegionSync = false
    var needsRotation = false
    var revokePending = false
    var isolatingPoison = false
    var failedAttempts = 0
    var nextAttempt: Date?
}

/// Consent, durable delivery and retry ownership for places; LocationService owns the sensors.
@MainActor
final class PlaceSensingService: ObservableObject {
    @Published private(set) var state: PlaceSensingState
    @Published private(set) var permissionLevel = "未请求"
    @Published private(set) var monitoredRegionCount = 0
    @Published private(set) var errorMessage: String?
    private let database: AssistantLocalOperationDatabase
    private let location: LocationService
    private let client: PlaceGatewayClient
    private let credentials: any PlaceCredentialStoring
    private let pairingProvider: PairedRealtimeRequestBodyProvider
    private let now: () -> Date
    private let logger = Logger(subsystem: "ai.paios.personal.phase0", category: "places")
    private var revision = 0
    private var worker: Task<Bool, Never>?
    private var retry: Task<Void, Never>?
    private var foreground = false

    init(database: AssistantLocalOperationDatabase, location: LocationService,
         client: PlaceGatewayClient = PlaceGatewayClient(), credentials: any PlaceCredentialStoring = KeychainPlaceCredentialStore(),
         pairingProvider: PairedRealtimeRequestBodyProvider = PairedRealtimeRequestBodyProvider(), now: @escaping () -> Date = Date.init) throws {
        self.database = database; self.location = location; self.client = client
        self.credentials = credentials; self.pairingProvider = pairingProvider; self.now = now
        state = try database.placeState()
        location.onPlaceEvent = { [weak self] event in self?.capture(event) }
        location.onPlaceAuthorizationChange = { [weak self] in self?.refreshPermission() }
        location.configurePlaces(enabled: state.enabled, regions: state.regions)
        refreshPermission()
        logger.info("Place launch restored enabled=\(self.state.enabled) regions=\(self.monitoredRegionCount)")
    }

    deinit { worker?.cancel(); retry?.cancel() }

    func setEnabled(_ enabled: Bool) async {
        do {
            try reload()
            guard enabled != state.enabled else { return }
            revision += 1
            let change = revision
            var next = PlaceSensingState(); next.revokePending = state.revokePending || state.enabled
            if enabled {
                guard let pairing = try pairingProvider.pairing() else { throw RealtimeDevicePairingError.unavailable }
                next.enabled = true; next.identity = CentralOwnerDataIdentity.pairing(pairing); next.needsRegionSync = true
            }
            state = next
            location.configurePlaces(enabled: enabled, regions: state.regions)
            try database.savePlaceState(state, clearOutbox: true)
            if !enabled { try credentials.save(nil); logger.info("Place switch off: monitoring stopped, outbox deleted, revocation pending") }
            retry?.cancel(); worker?.cancel()
            if let worker { _ = await worker.value }
            guard change == revision else { return }
            if enabled {
                do { try await location.requestAlwaysAuthorization(userInitiated: true) }
                catch { report(error) }
            }
            guard change == revision else { return }
            _ = await flush(force: true)
        } catch { report(error) }
    }

    func capture(_ event: PlaceEvent) {
        do {
            try reload()
            guard state.enabled, let identity = state.identity else { return }
            logger.info("Place event created id=\(event.id, privacy: .public) kind=\(event.kind.rawValue, privacy: .public)")
            guard try database.persistPlaceEvent(event, identity: identity) else { return }
            logger.info("Place event persisted id=\(event.id, privacy: .public)")
            Task { _ = await flush(force: true) } // A fresh event never waits behind the backoff.
        } catch { report(error) }
    }

    func appBecameActive() {
        foreground = true; refreshPermission()
        Task { _ = await flush(force: state.needsRotation || state.revokePending) }
    }

    func appDidEnterBackground() { foreground = false; retry?.cancel(); retry = nil }
    func cancelUpload() { worker?.cancel() }

    /// A forced flush (fresh event, foreground, unlock) skips the backoff and retries a network failure once, shortly,
    /// under the same background lease; only a failure after that counts towards the backoff.
    @discardableResult
    func flush(force: Bool = false) async -> Bool {
        if let worker { return await worker.value }
        let operation = Task { [self] in
            defer { worker = nil; scheduleRetry() }
#if os(iOS)
            let lease = UIApplication.shared.beginBackgroundTask(withName: "place upload") { [weak self] in
                Task { @MainActor in self?.cancelUpload() }
            }
            defer { if lease != .invalid { UIApplication.shared.endBackgroundTask(lease) } }
#endif
            var retryOnce = force
            while true {
                do { return try await deliver(force: force) } catch {
                    do { try reload() } catch { report(error); return false }
                    if Task.isCancelled { return false }
                    report(error)
                    if retryOnce, error is URLError {
                        retryOnce = false
                        do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return false }
                        continue
                    }
                    state.failedAttempts += 1
                    state.nextAttempt = now().addingTimeInterval(min(3_600, 60 * pow(2, Double(min(6, state.failedAttempts - 1)))))
                    do { try database.savePlaceState(state) } catch { report(error) }
                    return false
                }
            }
        }
        worker = operation
        return await withTaskCancellationHandler { await operation.value } onCancel: { operation.cancel() }
    }

    private func deliver(force: Bool) async throws -> Bool {
        try reload()
        guard force || state.nextAttempt.map({ $0 <= now() }) ?? true else { return true }
        let current = revision
        let pairing = try? pairingProvider.pairing() // The main item remains unavailable while locked.
        if state.revokePending {
            guard let pairing else { throw RealtimeDevicePairingError.unavailable }
            _ = try await client.manageCredential(pairing: pairing, action: "revoke")
            try Task.checkCancellation(); try reload()
            guard current == revision else { return false }
            state.revokePending = false; state.failedAttempts = 0; state.nextAttempt = nil
            try database.savePlaceState(state)
            logger.info("Place credential revoked")
        }
        guard state.enabled else { return true }
        var credential = try credentials.load()
        if credential?.pairingIdentity != state.identity { credential = nil } // Issued under an earlier pairing.
        if let pairing, let existing = credential, existing.origin != pairing.origin,
           existing.pairingIdentity == CentralOwnerDataIdentity.pairing(pairing) {
            credential = PlaceCredential(pairing: pairing, token: existing.token)
            try credentials.save(credential)
        }
        var rotated = false
        while state.enabled {
            try Task.checkCancellation()
            if credential == nil || state.needsRotation { // The gateway's rotate also issues the first token.
                guard let pairing else { throw RealtimeDevicePairingError.unavailable }
                credential = try await client.manageCredential(pairing: pairing, action: "rotate")
                guard try isCurrent(current) else { return false }
                try credentials.save(credential); rotated = true
                state.needsRotation = false; try database.savePlaceState(state)
                logger.info("Place credential rotated")
            }
            guard let credential else { throw RealtimeDevicePairingError.unavailable }
            let events = state.needsRegionSync ? [] : try database.pendingPlaceEvents(limit: state.isolatingPoison ? 1 : 64)
            do {
                let response = try await client.upload(credential: credential, events: events, regionVersion: state.needsRegionSync ? nil : state.regionVersion)
                guard try isCurrent(current) else { return false }
                if let items = response.regions.items { state.regions = items; state.regionVersion = response.regions.version }
                else if state.regionVersion != response.regions.version { throw RealtimePublicControlAdapterError.invalidHTTPResponse }
                state.needsRegionSync = false; state.lastUpload = now(); state.failedAttempts = 0; state.nextAttempt = nil
                try database.savePlaceState(state, removing: response.stored_ids + response.duplicate_ids + response.expired_ids)
                location.configurePlaces(enabled: true, regions: state.regions)
                for id in response.stored_ids + response.duplicate_ids { logger.info("Place event uploaded id=\(id, privacy: .public)") }
                for id in response.expired_ids { logger.info("Place event dropped id=\(id, privacy: .public) reason=expired") }
                logger.info("Place upload succeeded events=\(events.count) region_version=\(response.regions.version)")
                errorMessage = nil
                if try database.pendingPlaceEvents().isEmpty {
                    state.isolatingPoison = false; try database.savePlaceState(state); return true
                }
            } catch RealtimePublicControlAdapterError.unexpectedHTTPStatus(let status, let code) {
                guard try isCurrent(current) else { return false }
                if status == 401 || status == 403 {
                    state.needsRotation = true; try database.savePlaceState(state)
                    if !rotated { continue }
                } else if [400, 409, 413, 422].contains(status), !events.isEmpty { // Payload rejected: isolate, drop the culprit.
                    state.isolatingPoison = true
                    try database.savePlaceState(state, removing: events.count == 1 ? [events[0].id] : [])
                    if events.count == 1 {
                        logger.error("Place event dropped id=\(events[0].id, privacy: .public) reason=\(code ?? String(status), privacy: .public)")
                    }
                    continue
                }
                throw RealtimePublicControlAdapterError.unexpectedHTTPStatus(status, code)
            }
        }
        return true
    }

    private func isCurrent(_ current: Int) throws -> Bool { try Task.checkCancellation(); try reload(); return current == revision && state.enabled }

    /// A consent or pairing change retires in-flight work through `revision`; the database rejects its late writes.
    private func reload() throws {
        let stored = try database.placeState()
        let changed = stored.identity != state.identity || stored.enabled != state.enabled
        state = stored
        if changed { revision += 1; location.configurePlaces(enabled: stored.enabled, regions: stored.regions) }
    }

    private func refreshPermission() {
        switch location.placeAuthorization {
        case .authorizedAlways: permissionLevel = "始终允许"
        case .authorizedWhenInUse: permissionLevel = "使用 App 时允许"
        default: permissionLevel = location.authorizationStatus().displayName
        }
        monitoredRegionCount = location.monitoredPlaceRegionCount
    }

    private func scheduleRetry() {
        retry?.cancel()
        guard foreground, let at = state.nextAttempt else { return }
        retry = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0, at.timeIntervalSince(self?.now() ?? Date())) * 1_000_000_000)) } catch { return }
            guard !Task.isCancelled else { return }
            _ = await self?.flush()
        }
    }

    private func report(_ error: Error) {
        errorMessage = "地点同步未完成：" + UserFacingError.message(for: error)
        logger.error("Place operation failed: \(String(describing: error), privacy: .public)")
    }
}
