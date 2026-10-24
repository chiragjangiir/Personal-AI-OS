#if canImport(WatchConnectivity)
import Foundation
import WatchConnectivity

struct WatchInstallationIdentityContextDiagnostic: Equatable, Sendable {
    let presence: String
    let version: String
    let kind: String
    let decision: String
}

#if os(iOS)
/// Owns installation identity verification and pairing epochs, not transport publication.
final class WatchIdentityHandler: @unchecked Sendable {
    private let sender: any WatchPhoneConnectivitySending
    private let physicalExportLock = NSLock()
    private var physicalReachabilityContinuation:
        CheckedContinuation<Bool, Never>?
    private var physicalReachabilityGeneration: UInt64 = 0
    private var physicalContextContinuation:
        CheckedContinuation<InstallationIdentityContextState, Never>?
    private var physicalContextGeneration: UInt64 = 0
    private var physicalReachabilityTimeoutNanoseconds: UInt64 = 5_000_000_000
    private var acceptedInstallationIdentityObservation:
        WatchInstallationIdentityObservation?
    private var installationIdentityChannelClosed = false
    private var installationIdentityEpoch: UInt64 = 0
    private var installationIdentityRequestGeneration: UInt64 = 0
    private var installationIdentityRequest: (
        generation: UInt64, epoch: UInt64, nonce: String, rebind: Bool,
        continuation: CheckedContinuation<WatchInstallationIdentityReply?, Never>
    )?
    private var installationIdentityContextDiagnosticHandler:
        @Sendable (WatchInstallationIdentityContextDiagnostic) -> Void = {
            diagnostic in
            print(
                "PAIOS_PHONE_INSTALL_CONTEXT"
                    + " presence=\(diagnostic.presence)"
                    + " version=\(diagnostic.version)"
                    + " kind=\(diagnostic.kind)"
                    + " decision=\(diagnostic.decision)"
            )
        }

    private enum InstallationIdentityContextState {
        case absent
        case invalid
        case valid(WatchInstallationIdentityObservation)
    }

    init(sender: any WatchPhoneConnectivitySending) { self.sender = sender }
    func setInstallationIdentityContextDiagnosticHandlerForTests(
        _ handler: @escaping @Sendable (
            WatchInstallationIdentityContextDiagnostic
        ) -> Void
    ) {
        physicalExportLock.lock()
        installationIdentityContextDiagnosticHandler = handler
        physicalExportLock.unlock()
    }

    func requestInstallationIdentity(
        nonce: String, rebind: Bool = false
    ) async -> WatchInstallationIdentityReply? {
        guard !Task.isCancelled,
              WatchInstallationIdentityRequest.isCanonicalUUID(nonce)
        else { return nil }

        let (epoch, generation, closed, verify) = physicalExportLock.withLock {
            installationIdentityRequestGeneration &+= 1
            return (installationIdentityEpoch, installationIdentityRequestGeneration,
                installationIdentityChannelClosed,
                rebind || installationIdentityEpoch > 0 && acceptedInstallationIdentityObservation == nil)
        }
        guard !closed else { return nil }
        if !verify {
            var contextState = currentInstallationIdentityContext()
            if case .absent = contextState {
                contextState = await waitForInstallationIdentityContext()
            }
            switch contextState {
            case .valid(let observation):
                guard !Task.isCancelled, physicalExportLock.withLock({
                    !installationIdentityChannelClosed && epoch == installationIdentityEpoch
                }) else { return nil }
                return observation.reply(nonce: nonce)
            case .invalid: return nil
            case .absent: break
            }
        }

        guard await waitForPhysicalReachability(),
              !Task.isCancelled,
              let payload = try? WatchInstallationIdentityRequest(
                nonce: nonce
              ).encodedStrict() else { return nil }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                physicalExportLock.lock()
                guard !Task.isCancelled, !installationIdentityChannelClosed,
                      epoch == installationIdentityEpoch, installationIdentityRequest == nil else {
                    physicalExportLock.unlock()
                    continuation.resume(returning: nil)
                    return
                }
                installationIdentityRequest = (generation, epoch, nonce, rebind, continuation)
                let timeout = physicalReachabilityTimeoutNanoseconds
                physicalExportLock.unlock()
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: timeout)
                    self?.finishInstallationIdentityRequest(generation: generation, reply: nil)
                }
                sender.sendMessage(["payload": payload], replyHandler: { [weak self] reply in
                    let value = Set(reply.keys) == Set(["payload"])
                        ? (reply["payload"] as? Data).flatMap { try? WatchInstallationIdentityReply.decodeStrict($0) } : nil
                    self?.finishInstallationIdentityRequest(generation: generation, reply: value)
                }, errorHandler: { [weak self] _ in
                    self?.finishInstallationIdentityRequest(generation: generation, reply: nil)
                })
            }
        } onCancel: { [weak self] in
            self?.finishInstallationIdentityRequest(generation: generation, reply: nil)
        }
    }

    private func finishInstallationIdentityRequest(generation: UInt64? = nil,
        reply: WatchInstallationIdentityReply?) {
        physicalExportLock.lock()
        guard let pending = installationIdentityRequest,
              generation == nil || generation == pending.generation else {
            physicalExportLock.unlock()
            return
        }
        installationIdentityRequest = nil
        var accepted: WatchInstallationIdentityReply?
        if !installationIdentityChannelClosed, pending.epoch == installationIdentityEpoch,
           let reply, reply.nonce == pending.nonce,
           pending.rebind || acceptedInstallationIdentityObservation == nil
               || acceptedInstallationIdentityObservation?.localClientInstanceID == reply.localClientInstanceID {
            acceptedInstallationIdentityObservation = WatchInstallationIdentityObservation(version: 1,
                kind: WatchInstallationIdentityObservation.currentKind,
                localClientInstanceID: reply.localClientInstanceID, localClientSource: reply.localClientSource)
            if pending.rebind { installationIdentityEpoch &+= 1 }
            accepted = reply
        }
        physicalExportLock.unlock()
        pending.continuation.resume(returning: accepted)
    }

    func closeInstallationIdentityChannel() {
        physicalExportLock.lock()
        installationIdentityChannelClosed = true
        acceptedInstallationIdentityObservation = nil
        installationIdentityEpoch &+= 1
        physicalExportLock.unlock()
        finishInstallationIdentityRequest(reply: nil)
        finishPhysicalInstallationContext(result: .invalid)
        finishPhysicalReachability(result: false)
    }

    private func currentInstallationIdentityContext()
        -> InstallationIdentityContextState {
        installationIdentityContextState(
            from: sender.receivedApplicationContext
        )
    }

    private func installationIdentityContextState(
        from context: [String: Any]
    ) -> InstallationIdentityContextState {
        guard let rawPayload = context["payload"] else {
            emitInstallationIdentityContextDiagnostic(
                presence: "missing",
                version: "missing",
                kind: "missing",
                decision: "waiting"
            )
            return .absent
        }
        guard let payload = rawPayload as? Data else {
            emitInstallationIdentityContextDiagnostic(
                presence: "present",
                version: "unknown",
                kind: "unknown",
                decision: "rejected_non_data"
            )
            return .invalid
        }

        let metadata = Self.installationIdentityContextMetadata(payload)
        guard metadata.kind == "installation_identity" else {
            emitInstallationIdentityContextDiagnostic(
                presence: "present",
                version: metadata.version,
                kind: metadata.kind,
                decision: "ignored_other_kind"
            )
            return .absent
        }
        guard Set(context.keys) == Set(["payload"]),
              let observation = try?
                WatchInstallationIdentityObservation.decodeStrict(payload)
        else {
            emitInstallationIdentityContextDiagnostic(
                presence: "present",
                version: metadata.version,
                kind: metadata.kind,
                decision: "rejected_malformed"
            )
            return .invalid
        }

        physicalExportLock.lock()
        let decision: String
        let result: InstallationIdentityContextState
        if installationIdentityChannelClosed {
            decision = "rejected_closed"
            result = .invalid
        } else if installationIdentityEpoch > 0, acceptedInstallationIdentityObservation == nil {
            decision = "awaiting_verification"
            result = .absent
        } else if let acceptedInstallationIdentityObservation,
                  acceptedInstallationIdentityObservation.localClientInstanceID != observation.localClientInstanceID {
            decision = "rejected_replacement"
            result = .invalid
        } else {
            acceptedInstallationIdentityObservation = observation
            decision = "accepted"
            result = .valid(observation)
        }
        physicalExportLock.unlock()
        emitInstallationIdentityContextDiagnostic(
            presence: "present",
            version: metadata.version,
            kind: metadata.kind,
            decision: decision
        )
        return result
    }

    private static func installationIdentityContextMetadata(
        _ payload: Data
    ) -> (version: String, kind: String) {
        guard let object = try? JSONSerialization.jsonObject(with: payload),
              let dictionary = object as? [String: Any] else {
            return ("unknown", "unknown")
        }
        let version: String
        if let value = dictionary["version"] as? Int {
            version = value == WatchInstallationIdentityObservation.currentVersion
                ? "current" : "other"
        } else {
            version = "missing"
        }
        let kind: String
        if let value = dictionary["kind"] as? String {
            kind = value == WatchInstallationIdentityObservation.currentKind
                ? "installation_identity" : "other"
        } else {
            kind = "missing"
        }
        return (version, kind)
    }

    private func emitInstallationIdentityContextDiagnostic(
        presence: String,
        version: String,
        kind: String,
        decision: String
    ) {
        physicalExportLock.lock()
        let handler = installationIdentityContextDiagnosticHandler
        physicalExportLock.unlock()
        handler(
            WatchInstallationIdentityContextDiagnostic(
                presence: presence,
                version: version,
                kind: kind,
                decision: decision
            )
        )
    }

    private func waitForInstallationIdentityContext() async
        -> InstallationIdentityContextState {
        let current = currentInstallationIdentityContext()
        if case .absent = current {} else { return current }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                physicalExportLock.lock()
                guard physicalContextContinuation == nil,
                      !installationIdentityChannelClosed else {
                    physicalExportLock.unlock()
                    continuation.resume(returning: .invalid)
                    return
                }
                physicalContextGeneration &+= 1
                let generation = physicalContextGeneration
                let timeout = physicalReachabilityTimeoutNanoseconds
                physicalContextContinuation = continuation
                physicalExportLock.unlock()
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: timeout)
                    self?.finishPhysicalInstallationContext(
                        generation: generation,
                        result: .absent
                    )
                }
                finishPhysicalInstallationContextIfAvailable()
            }
        } onCancel: { [weak self] in
            self?.finishPhysicalInstallationContext(result: .invalid)
        }
    }

    private func finishPhysicalInstallationContextIfAvailable(
        _ context: [String: Any]? = nil
    ) {
        let result = installationIdentityContextState(
            from: context ?? sender.receivedApplicationContext
        )
        if case .absent = result { return }
        finishPhysicalInstallationContext(result: result)
    }

    private func finishPhysicalInstallationContext(
        generation: UInt64? = nil,
        result: InstallationIdentityContextState
    ) {
        physicalExportLock.lock()
        if let generation, generation != physicalContextGeneration {
            physicalExportLock.unlock()
            return
        }
        let continuation = physicalContextContinuation
        physicalContextContinuation = nil
        physicalContextGeneration &+= 1
        physicalExportLock.unlock()
        continuation?.resume(returning: result)
    }

    func setPhysicalReachabilityTimeoutForTests(_ nanoseconds: UInt64) {
        physicalExportLock.lock()
        physicalReachabilityTimeoutNanoseconds = nanoseconds
        physicalExportLock.unlock()
    }

    private func waitForPhysicalReachability() async -> Bool {
        if sender.isActivated, sender.isReachable {
            return true
        }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                physicalExportLock.lock()
                guard physicalReachabilityContinuation == nil else {
                    physicalExportLock.unlock()
                    continuation.resume(returning: false)
                    return
                }
                physicalReachabilityGeneration &+= 1
                let generation = physicalReachabilityGeneration
                let timeout = physicalReachabilityTimeoutNanoseconds
                physicalReachabilityContinuation = continuation
                physicalExportLock.unlock()
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: timeout)
                    self?.finishPhysicalReachability(
                        generation: generation,
                        result: false
                    )
                }
                finishPhysicalReachabilityIfReady()
            }
        } onCancel: { [weak self] in
            self?.finishPhysicalReachability(result: false)
        }
    }

    private func finishPhysicalReachabilityIfReady() {
        guard sender.isActivated, sender.isReachable else {
            return
        }
        finishPhysicalReachability(result: true)
    }

    private func finishPhysicalReachability(
        generation: UInt64? = nil,
        result: Bool
    ) {
        physicalExportLock.lock()
        if let generation, generation != physicalReachabilityGeneration {
            physicalExportLock.unlock()
            return
        }
        let continuation = physicalReachabilityContinuation
        physicalReachabilityContinuation = nil
        physicalReachabilityGeneration &+= 1
        physicalExportLock.unlock()
        continuation?.resume(returning: result)
    }

    func activated(_ isActivated: Bool, error: Error?) {
        guard isActivated, error == nil else {
            finishPhysicalInstallationContext(result: .invalid)
            finishPhysicalReachability(result: false)
            return
        }
        finishPhysicalInstallationContextIfAvailable()
        finishPhysicalReachabilityIfReady()
    }
    func pairingChanged() {
        physicalExportLock.withLock {
            acceptedInstallationIdentityObservation = nil
            installationIdentityEpoch &+= 1
        }
        finishInstallationIdentityRequest(reply: nil)
        finishPhysicalInstallationContext(result: .invalid)
        finishPhysicalReachability(result: false)
    }
    func reachabilityChanged() { finishPhysicalReachabilityIfReady() }
    func receiveContext(_ context: [String: Any]) -> Bool {
        let state = installationIdentityContextState(from: context)
        switch state {
        case .valid, .invalid:
            finishPhysicalInstallationContext(result: state)
            return true
        case .absent: return false
        }
    }
}
#endif
#endif
