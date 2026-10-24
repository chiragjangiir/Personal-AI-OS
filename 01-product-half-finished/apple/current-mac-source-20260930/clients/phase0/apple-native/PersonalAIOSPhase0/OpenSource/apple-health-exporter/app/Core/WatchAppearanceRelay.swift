#if os(iOS)
import Combine
import Foundation
import UIKit

/// Projects the canonical phone cache through the existing WCSession owner.
@MainActor
final class WatchAppearanceRelay: ObservableObject {
    static let shared = WatchAppearanceRelay()
    @Published private(set) var receipt: WatchAppearanceReceipt?
    @Published private(set) var error: String?
    private weak var adapter: WatchConnectivityPhoneAdapter?
    private var observation: AnyCancellable?
    private var scope: WatchBindingScope?
    private var owner: String?
    private var sent: WatchAppearanceProjection?
    private var sequence = WatchSenderSequence(key: "paios.phone.appearance-sequence.v1", defaults: .standard, clock: { Date() })

    func attach(_ adapter: WatchConnectivityPhoneAdapter) {
        self.adapter = adapter
        adapter.setAppearanceReceiptHandler { [weak self] data in
            await self?.receive(data)
        }
        observation = YimiAvatarStore.shared.$imageData.combineLatest(YimiAvatarStore.shared.$profile, YimiAvatarStore.shared.$loadedVersion)
            .receive(on: RunLoop.main).sink { [weak self] _ in self?.publish() }
    }
    func project(_ state: Data?) {
        let next = state.flatMap { try? WatchYimiState.decodeStrict($0) }?.scope
        let identity = YimiAvatarStore.shared.pairingIdentity
        if next != scope || identity != owner { receipt = nil; sent = nil }
        scope = next; owner = identity
        publish()
    }
    private func publish() {
        guard let scope, let owner, RealtimePairingSessionIdentity.shared.matches(owner),
              YimiAvatarStore.shared.pairingIdentity == owner else {
            sent = nil; receipt = nil
            do {
                let reset = try scope.map { scope -> Data in
                    guard let value = sequence.next() else { throw CocoaError(.coderInvalidValue) }
                    return try JSONEncoder().encode(WatchAppearanceProjection(projectionID: UUID(), sequence: value,
                        scope: scope, profile: nil, image: nil))
                }
                try adapter?.publishAppearance(reset)
            } catch { self.error = error.localizedDescription }
            return
        }
        do {
            let avatar = YimiAvatarStore.shared
            let bytes: Data?
            let defaultData = Bundle.main.url(forResource: "yimi-portrait", withExtension: "jpg", subdirectory: "Avatar")
                .flatMap { try? Data(contentsOf: $0) }
            if let data = avatar.imageData ?? (avatar.profile == nil ? defaultData : nil), let image = UIImage(data: data) {
                let ratio = min(1, 256 / max(image.size.width, image.size.height))
                let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
                let format = UIGraphicsImageRendererFormat(); format.scale = 1
                bytes = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                    image.draw(in: CGRect(origin: .zero, size: size))
                }.jpegData(compressionQuality: 0.75)
            } else { bytes = nil }
            guard avatar.profile == nil || bytes != nil else { return }
            guard bytes == nil || bytes!.count <= 65_536 else { throw CocoaError(.fileReadTooLarge) }
            guard let revision = avatar.loadedVersion else { return }
            if sent?.scope == scope, sent?.profileVersion == revision, sent?.profile == avatar.profile, sent?.image == bytes { return }
            guard let value = sequence.next() else { throw CocoaError(.coderInvalidValue) }
            let projection = WatchAppearanceProjection(projectionID: UUID(), sequence: value, scope: scope, profile: avatar.profile, image: bytes, profileVersion: revision)
            let data = try JSONEncoder().encode(projection)
            try adapter?.publishAppearance(data)
            sent = projection; receipt = nil; error = nil
        } catch { self.error = "手表形象待同步：" + error.localizedDescription }
    }
    private func receive(_ data: Data) {
        guard let value = try? JSONDecoder().decode(WatchAppearanceReceipt.self, from: data),
              let sent, value.projectionID == sent.projectionID, value.scope == sent.scope,
              value.profileVersion == (sent.profileVersion ?? sent.profile?.version ?? 0),
              let owner, RealtimePairingSessionIdentity.shared.matches(owner),
              YimiAvatarStore.shared.pairingIdentity == owner else { return }
        receipt = value
    }
}

#endif
