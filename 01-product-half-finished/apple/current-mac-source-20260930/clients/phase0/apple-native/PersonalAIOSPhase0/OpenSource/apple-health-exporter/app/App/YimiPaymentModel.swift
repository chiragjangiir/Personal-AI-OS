import Combine
import Foundation
import LocalAuthentication

/// The phone's projection and owner actions. It never evaluates payment eligibility or grants money.
@MainActor
final class YimiPaymentModel: ObservableObject {
    @Published private(set) var settings: CentralPaymentSettings?
    @Published private(set) var cards: [CentralPaymentCard] = []
    @Published private(set) var approvals: [CentralPaymentApproval] = []
    @Published private(set) var records: [CentralPaymentRecordItem] = []
    @Published private(set) var record: CentralPaymentRecord?
    @Published private(set) var nextBefore: String?
    @Published private(set) var error: String?
    @Published private(set) var busy = false
    @Published private var submittedControls: [String: String] = [:]
    var submitted: Set<String> { Set(submittedControls.keys) }
    @Published private var recordsRequest: String?
    var loadingRecords: Bool { recordsRequest != nil }
    @Published private var recordRequest: (id: String, paymentID: String, beforeSeq: Int?)?
    var loadingRecord: Bool { recordRequest != nil }
    @Published private(set) var receivedAt = Date()
    @Published private(set) var approvalReceivedAt = Date()
    @Published private(set) var binding: CentralTransportBinding?
    @Published private(set) var wireUnsupported = false
    let appLock: YimiAppLock
    var available: Bool { !wireUnsupported && binding != nil && settings?.wire_version == 1 }
    private let timeout: TimeInterval?
    private let notifications: (any AssistantNotificationScheduling)?
    private let makeKeys: (String) -> any AssistantPaymentSigning
    private let authenticate: (LAContext, String) async throws -> Void
    private var send: ((Data, String, TimeInterval) async throws -> CentralTextPacket)?
    private var sendPresence: ((String) async throws -> Void)?
    private var events: Task<Void, Never>?
    private var lockObservation: AnyCancellable?
    private var refreshing = false
    private var registering = false
    private struct Authorization { let binding: CentralTransportBinding; let generation: UInt64 }
    private var authenticationContext: LAContext?
    private var authorizingRequests: [String: Task<CentralTextPacket, Error>] = [:]
    private var notificationWork: Task<Void, Never>?
    private var notificationExpiry: Task<Void, Never>?

    init(appLock: YimiAppLock? = nil, notifications: (any AssistantNotificationScheduling)? = nil,
         timeout: TimeInterval? = nil,
         sender: ((Data, String, TimeInterval) async throws -> CentralTextPacket)? = nil,
         presence: ((String) async throws -> Void)? = nil,
         makeKeys: @escaping (String) -> any AssistantPaymentSigning = { AssistantPaymentKeys(deviceID: $0) },
         authenticate: @escaping (LAContext, String) async throws -> Void = { context, reason in
             _ = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
         }) {
        self.appLock = appLock ?? YimiAppLock()
        self.notifications = notifications
        self.timeout = timeout
        self.send = sender
        self.sendPresence = presence
        self.makeKeys = makeKeys
        self.authenticate = authenticate
        lockObservation = self.appLock.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        self.appLock.onPresence = { [weak self] state in await self?.presence(state) }
        self.appLock.onAuthorizationInvalidated = { [weak self] in
            self?.authenticationContext?.invalidate()
            self?.authorizingRequests.values.forEach { $0.cancel() }
        }
    }

    func connect(_ coordinator: AssistantSessionCoordinator) {
        let channel = coordinator.paymentChannel
        send = { try await channel.request($0, id: $1, timeout: $2) }
        sendPresence = { try await channel.presence($0) }
        events?.cancel()
        let (stream, continuation) = AsyncStream<AssistantPaymentEvent>.makeStream()
        events = Task { [weak self] in
            await channel.setObserver { continuation.yield($0) }
            for await event in stream {
                guard !Task.isCancelled else { return }
                self?.receive(event)
            }
        }
    }

    /// Used by the ordered transport event stream; it is also the fixture boundary in simulator tests.
    func receive(_ event: AssistantPaymentEvent) {
        switch event {
        case .attached(let binding):
            self.binding = binding
            wireUnsupported = false
            settings = nil
            recordsRequest = nil; recordRequest = nil
            Task { await presence(appLock.presence); await refresh() }
        case .detached:
            binding = nil
            settings = nil
            cards = []; approvals = []; records = []; record = nil; recordsRequest = nil; recordRequest = nil
        case .failed:
            binding = nil
            settings = nil
            recordsRequest = nil; recordRequest = nil
            self.error = "付款连接中断，重新连接后再试"
        case .output(let packet):
            do { try project(packet) } catch { self.error = "付款信息未能读取，请重新连接" }
        }
    }

    private func project(_ packet: CentralTextPacket) throws {
        guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { return }
        if packet.unsupportedPaymentWireVersion != nil {
            wireUnsupported = true
            settings = nil; cards = []; approvals = []; records = []; record = nil; recordsRequest = nil; recordRequest = nil
            error = "请更新依米后再使用付款"
            return
        }
        guard !wireUnsupported else { return }
        let decoder = JSONDecoder()
        switch try packet.fields.value("operation", as: String.self) {
        case "payment_settings":
            let snapshot = try decoder.decode(CentralPaymentSettings.self, from: packet.bytes)
            settings = snapshot
            guard snapshot.wire_version == 1 else {
                cards = []; approvals = []; self.error = "请更新依米后再使用付款"; return
            }
            appLock.configure(snapshot.locks.phone)
            if !snapshot.keys.device { Task { await registerDevice() } }
        case "payment_cards":
            let snapshot = try decoder.decode(CentralPaymentCards.self, from: packet.bytes)
            guard snapshot.complete else { return }
            let oldIDs = Set(cards.map(\.id))
            cards = snapshot.cards
            receivedAt = Date()
            let pending = Set(cards.filter { $0.state.canDecide }.map(\.id))
            reconcileNotifications(retaining: Set(pending.map { "payment-" + $0 }), approvals: false)
            reconcileSubmissions(pending.union(approvals.map(\.id)))
            updateNotificationExpiry()
            if appLock.presence != "foreground" {
                for card in cards where !oldIDs.contains(card.id) && card.state.canDecide {
                    notify(.payment(card))
                }
            }
        case "payment_approvals":
            let snapshot = try decoder.decode(CentralPaymentApprovals.self, from: packet.bytes)
            guard snapshot.complete else { return }
            let oldIDs = Set(approvals.map(\.id))
            approvals = snapshot.approvals
            reconcileNotifications(retaining: Set(approvals.map { "payment-approval-" + $0.id }), approvals: true)
            reconcileSubmissions(Set(approvals.map(\.id) + cards.filter { $0.state.canDecide }.map(\.id)))
            approvalReceivedAt = Date()
            updateNotificationExpiry()
            if appLock.presence != "foreground" {
                for item in approvals where !oldIDs.contains(item.id) { notify(.paymentApproval(item)) }
            }
        case "payment_records":
            let snapshot = try decoder.decode(CentralPaymentRecords.self, from: packet.bytes)
            guard snapshot.request_id == recordsRequest else { return }
            let ids = Set(records.map(\.id))
            records += snapshot.items.filter { !ids.contains($0.id) }
            nextBefore = snapshot.next_before
            recordsRequest = nil
        case "payment_record":
            let snapshot = try decoder.decode(CentralPaymentRecord.self, from: packet.bytes)
            guard let query = recordRequest, snapshot.request_id == query.id,
                  snapshot.payment.payment_id == query.paymentID else { return }
            if query.beforeSeq != nil, let current = record, current.payment.payment_id == query.paymentID {
                record = CentralPaymentRecord(request_id: snapshot.request_id, payment: snapshot.payment,
                    timeline: snapshot.timeline + current.timeline, next_seq: snapshot.next_seq)
            } else { record = snapshot }
            recordRequest = nil
        case "payment_receipt":
            let receipt = try decoder.decode(CentralPaymentReceipt.self, from: packet.bytes)
            if !receipt.ok, receipt.state?.canDecide == true {
                submittedControls = submittedControls.filter { $0.value != receipt.control_id }
            }
            if !receipt.ok { self.error = AssistantPayment.errorLine(receipt.error_code ?? "PAYMENT_NOT_PENDING") }
        default: break
        }
    }

    private func notify(_ message: AssistantNotificationMessage) {
        guard let notifications else { return }
        let previous = notificationWork
        notificationWork = Task { await previous?.value; _ = await notifications.deliver(message) }
    }

    private func withdraw(_ ids: [String]) {
        guard let notifications, !ids.isEmpty else { return }
        let previous = notificationWork
        notificationWork = Task { await previous?.value; for id in ids { await notifications.revoke(identifier: id) } }
    }

    private func reconcileNotifications(retaining ids: Set<String>, approvals: Bool) {
        guard let notifications else { return }
        let previous = notificationWork
        notificationWork = Task {
            await previous?.value
            for id in await notifications.paymentNotificationIDs()
            where id.hasPrefix("payment-approval-") == approvals && !ids.contains(id) {
                await notifications.revoke(identifier: id)
            }
        }
    }

    private func updateNotificationExpiry() {
        notificationExpiry?.cancel()
        guard notifications != nil else { return }
        let deadlines = (cards.filter { $0.state.canDecide }.map {
            ("payment-" + $0.id, receivedAt.addingTimeInterval(Double($0.expires_in_ms) / 1000))
        } + approvals.map {
            ("payment-approval-" + $0.id, approvalReceivedAt.addingTimeInterval(Double($0.expires_in_ms) / 1000))
        }).sorted { $0.1 < $1.1 }
        notificationExpiry = Task { [weak self] in
            for (id, deadline) in deadlines {
                do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
                self?.withdraw([id])
            }
        }
    }

    private func reconcileSubmissions(_ pending: Set<String>) {
        submittedControls = submittedControls.filter { pending.contains($0.key) }
    }

    func presence(_ state: String) async {
        do { try await sendPresence?(state) }
        catch { self.error = "解锁状态未同步，重新连接后再试" }
    }

    func refresh() async {
        guard binding != nil, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        await perform {
            _ = try await self.request("payment_settings_get", fields: [:], requestID: true)
        }
    }

    func decide(_ card: CentralPaymentCard, decision: String) async {
        // Never mint a second authorization after a lost reply. A fresh snapshot or reconnect reconciles it.
        guard (decision == "cancel" || !submitted.contains(card.id)), card.state.canDecide else { return }
        await perform {
            var fields: [String: Any] = ["payment_id": card.id, "decision": decision]
            var authorization: Authorization?
            if decision == "pay" {
                authorization = try self.authorization()
                guard !self.appLock.covered else { throw ActionError.code("PAYMENT_TERMINAL_LOCKED") }
                let (id, keys) = try self.identity()
                let statement = try AssistantPayment.decisionStatement(deviceID: id, card: card)
                fields.merge(AssistantPayment.signedFields(statement: statement,
                    signature: try keys.sign(statement, role: .device, context: nil))) { _, new in new }
            }
            _ = try await self.request("payment_decide", fields: fields, suppressing: card.id, authorization: authorization)
        }
    }

    func change(_ fields: [String: Any]) async {
        let change: CentralPaymentChange
        do { change = try JSONDecoder().decode(CentralPaymentChange.self, from: JSONSerialization.data(withJSONObject: fields)) }
        catch { self.error = "付款设置未能读取"; return }
        await perform(exclusive: change.requiresUserSignature) {
            guard let policy = self.settings else { throw CentralTextError.unavailable }
            var input: [String: Any] = ["policy_version": policy.policy_version, "change": fields]
            var context: LAContext?
            let authorization = change.requiresUserSignature ? try self.authorization() : nil
            if change.requiresUserSignature && !policy.keys.user && !(change.kind == "phone_lock" && change.enabled == true) {
                throw ActionError.userKeySetup
            }
            if change.requiresUserSignature {
                let challenge = try await self.challenge("settings", authorization: authorization)
                let authenticated = try await self.userContext("确认付款设置", authorization: authorization!)
                context = authenticated
                if change.kind == "phone_lock", change.enabled == true {
                    try await self.registerUser(context: authenticated, authorization: authorization!)
                }
                try self.check(authorization!)
                let (id, keys) = try self.identity()
                let statement = try AssistantPayment.settingsStatement(deviceID: id, nonce: challenge.nonce,
                    policyVersion: policy.policy_version, change: change)
                input.merge(AssistantPayment.signedFields(statement: statement,
                    signature: try keys.sign(statement, role: .user, context: authenticated))) { _, new in new }
            }
            _ = try await self.request("payment_settings_set", fields: input, authorization: authorization)
            if change.kind == "phone_lock", change.enabled == true, let context, let authorization {
                try await self.unlock(context: context, authorization: authorization)
            }
        }
    }

    func unlock() async {
        await perform(exclusive: true) {
            let authorization = try self.authorization()
            let challenge = try await self.challenge("phone_unlock", authorization: authorization)
            let context = try await self.userContext("解锁依米", authorization: authorization)
            try await self.unlock(context: context, authorization: authorization, challenge: challenge)
        }
    }

    private func unlock(context: LAContext, authorization: Authorization, challenge: CentralPaymentChallenge? = nil) async throws {
        try check(authorization)
        let nonce: String
        if let challenge { nonce = challenge.nonce } else { nonce = try await self.challenge("phone_unlock", authorization: authorization).nonce }
        try check(authorization)
        let (id, keys) = try identity()
        let statement = try AssistantPayment.unlockStatement(deviceID: id, nonce: nonce)
        _ = try await request("phone_unlock", fields: AssistantPayment.signedFields(statement: statement,
            signature: try keys.sign(statement, role: .user, context: context)), authorization: authorization)
        try check(authorization)
        appLock.didUnlock(generation: authorization.generation)
    }

    func approve(_ approval: CentralPaymentApproval, allow: Bool) async {
        guard !allow || (!busy && !submitted.contains(approval.id)) else { return }
        await perform(exclusive: allow) {
            var fields: [String: Any] = ["approval_id": approval.id, "decision": allow ? "approve" : "deny"]
            let authorization = allow ? try self.authorization() : nil
            if allow {
                guard self.settings?.keys.user == true else { throw ActionError.userKeySetup }
                let context = try await self.userContext("确认眼镜上的请求", authorization: authorization!)
                let (id, keys) = try self.identity()
                let statement = try AssistantPayment.approvalStatement(deviceID: id, approval: approval)
                fields.merge(AssistantPayment.signedFields(statement: statement,
                    signature: try keys.sign(statement, role: .user, context: context))) { _, new in new }
            }
            _ = try await self.request("payment_approval_decide", fields: fields, suppressing: approval.id, authorization: authorization)
        }
    }

    func loadRecords(before: String? = nil) async {
        guard !loadingRecords else { return }
        let id = Self.id()
        recordsRequest = id
        defer { if recordsRequest == id { recordsRequest = nil } }
        if before == nil { records = []; nextBefore = nil }
        await perform {
            var fields: [String: Any] = ["request_id": id]
            if let before { fields["before"] = before }
            let packet = try await self.exchange(AssistantCentralTextWire.encode("payment_records_get", fields: fields), id: id)
            try self.project(packet)
        }
    }

    func loadRecord(_ paymentID: String, beforeSeq: Int? = nil) async {
        if beforeSeq != nil {
            guard !loadingRecord, record?.payment.payment_id == paymentID else { return }
        } else { record = nil }
        let id = Self.id()
        recordRequest = (id, paymentID, beforeSeq)
        defer { if recordRequest?.id == id { recordRequest = nil } }
        await perform {
            var fields: [String: Any] = ["request_id": id, "payment_id": paymentID]
            if let beforeSeq { fields["before_seq"] = beforeSeq }
            let packet = try await self.exchange(AssistantCentralTextWire.encode("payment_record_get", fields: fields), id: id)
            try self.project(packet)
        }
    }

    func dispute(_ paymentID: String) async {
        await perform { _ = try await self.request("payment_dispute", fields: ["payment_id": paymentID]) }
    }

    func forgetGlassesVoice() async {
        await perform(exclusive: true) {
            let authorization = try self.authorization()
            guard self.settings?.keys.user == true else { throw ActionError.userKeySetup }
            let challenge = try await self.challenge("voiceprint_forget", authorization: authorization)
            let context = try await self.userContext("忘记眼镜录入的声音", authorization: authorization)
            let (id, keys) = try self.identity()
            let statement = try AssistantPayment.forgetStatement(deviceID: id, nonce: challenge.nonce)
            var fields = AssistantPayment.signedFields(statement: statement,
                signature: try keys.sign(statement, role: .user, context: context))
            fields["channel"] = "glasses"
            _ = try await self.request("voiceprint_channel_forget", fields: fields, authorization: authorization)
        }
    }

    /// Reuses the registered user-presence key and current transport authorization.
    func authorizeMacPairing(_ qr: RealtimeMacPairingQR, pairing: RealtimeDevicePairing) async throws -> [String: Any] {
        let authorization = try authorization()
        guard authorization.binding.deviceID == pairing.deviceID else { throw CentralTextError.unavailable }
        let context = try await userContext("确认添加这台 Mac 到依米", authorization: authorization)
        defer { context.invalidate() }
        try await registerUser(context: context, authorization: authorization)
        try check(authorization)
        let (id, keys) = try identity()
        let statement = try JSONSerialization.data(withJSONObject: ["purpose": "mac_pairing", "device_id": id,
            "nonce": qr.nonce, "public_key_sha256": qr.publicKeySHA256], options: [.sortedKeys, .withoutEscapingSlashes])
        let signature = try keys.sign(statement, role: .user, context: context)
        try check(authorization)
        return AssistantPayment.signedFields(statement: statement, signature: signature)
    }

    private func registerDevice() async {
        guard !registering, available else { return }
        registering = true
        defer { registering = false }
        await perform { try await self.register(role: .device, context: nil, authorization: self.authorization()) }
    }

    private func registerUser(context: LAContext, authorization: Authorization) async throws {
        guard settings?.keys.user == false else { return }
        try await register(role: .user, context: context, authorization: authorization)
    }

    private func register(role: AssistantPaymentKeys.Role, context: LAContext?, authorization: Authorization) async throws {
        let challenge = try await challenge("keys_register", authorization: authorization)
        try check(authorization)
        let (id, keys) = try identity()
        let controlID = Self.id()
        let bytes = try keys.registration(controlID: controlID, deviceID: id, nonce: challenge.nonce, role: role, context: context)
        _ = try await exchange(bytes, id: controlID, authorization: authorization)
    }

    private func userContext(_ reason: String, authorization: Authorization) async throws -> LAContext {
        try check(authorization)
        let context = LAContext()
        authenticationContext = context
        defer { if authenticationContext === context { authenticationContext = nil } }
        try await authenticate(context, reason)
        try check(authorization)
        return context
    }

    private func authorization() throws -> Authorization {
        guard let binding, available else { throw CentralTextError.unavailable }
        let value = Authorization(binding: binding, generation: appLock.generation)
        try check(value)
        return value
    }

    private func check(_ authorization: Authorization) throws {
        guard binding == authorization.binding, appLock.generation == authorization.generation,
              appLock.protectedDataAvailable else { throw ActionError.authorizationExpired }
    }

    private func identity() throws -> (String, any AssistantPaymentSigning) {
        guard available, let id = binding?.deviceID else { throw CentralTextError.unavailable }
        guard appLock.protectedDataAvailable else { throw ActionError.authorizationExpired }
        return (id, makeKeys(id))
    }

    private func challenge(_ purpose: String, authorization: Authorization? = nil) async throws -> CentralPaymentChallenge {
        let packet = try await request("payment_challenge_get", fields: ["purpose": purpose], requestID: true, authorization: authorization)
        let challenge = try JSONDecoder().decode(CentralPaymentChallenge.self, from: packet.bytes)
        guard challenge.purpose == purpose, challenge.expires_in_ms > 0 else { throw CentralTextError.invalidPacket }
        return challenge
    }

    private func request(_ operation: String, fields: [String: Any], requestID: Bool = false,
                         suppressing: String? = nil, authorization: Authorization? = nil) async throws -> CentralTextPacket {
        var fields = fields
        let id = Self.id()
        fields[requestID ? "request_id" : "control_id"] = id
        return try await exchange(AssistantCentralTextWire.encode(operation, fields: fields), id: id,
                                  suppressing: suppressing, authorization: authorization)
    }

    private func exchange(_ bytes: Data, id: String, suppressing: String? = nil,
                          authorization: Authorization? = nil) async throws -> CentralTextPacket {
        guard let send, let timeout, timeout > 0, let binding else { throw CentralTextError.unavailable }
        if let authorization { try check(authorization) }
        if let suppressing, submittedControls[suppressing] == nil { submittedControls[suppressing] = id }
        let dispatch = Task { try await send(bytes, id, timeout) }
        if authorization != nil { authorizingRequests[id] = dispatch }
        defer { authorizingRequests.removeValue(forKey: id) }
        let response: CentralTextPacket
        do { response = try await dispatch.value }
        catch AssistantPaymentChannelError.notDispatched(let reason) {
            if let suppressing, submittedControls[suppressing] == id { submittedControls.removeValue(forKey: suppressing) }
            throw reason
        }
        guard self.binding == binding else { throw CentralTextError.contextChanged() }
        if try response.fields.value("operation", as: String.self) == "payment_receipt" {
            let receipt = try JSONDecoder().decode(CentralPaymentReceipt.self, from: response.bytes)
            if !receipt.ok, receipt.state?.canDecide == true {
                submittedControls = submittedControls.filter { $0.value != receipt.control_id }
            }
            guard receipt.ok else { throw ActionError.code(receipt.error_code ?? "PAYMENT_NOT_PENDING") }
        }
        return response
    }

    private func perform(exclusive: Bool = false, _ action: () async throws -> Void) async {
        if exclusive && busy { return }
        if exclusive { busy = true }
        defer { if exclusive { busy = false } }
        self.error = nil
        do { try await action() }
        catch ActionError.userKeySetup { self.error = "请先开启 iPhone 上的依米锁，再确认这个操作" }
        catch ActionError.authorizationExpired { self.error = "依米已重新锁定，请重新确认这次操作" }
        catch AssistantPaymentKeys.KeyError.missing { self.error = "请重新配对这台 iPhone" }
        catch ActionError.code(let code) {
            self.error = AssistantPayment.errorLine(code)
            if code == "PAYMENT_POLICY_VERSION_STALE" { await refresh(); self.error = AssistantPayment.errorLine(code) }
        }
        catch let failure as LAError where failure.code == .passcodeNotSet {
            self.error = "请先设置 iPhone 密码，再重新配对依米"
        }
        catch let failure as LAError where failure.code == .userCancel || failure.code == .appCancel || failure.code == .systemCancel {
            self.error = "没有确认，这次操作未完成"
        }
        catch { self.error = "未能确认这次操作，请检查连接后再试" }
    }

    private enum ActionError: Error { case code(String), userKeySetup, authorizationExpired }
    private static func id() -> String { "payment-" + UUID().uuidString.lowercased() }
}
