import Combine
import LiveKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class AssistantVideoPreviewModel: ObservableObject {
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var remoteVideoTrack: VideoTrack?
#if os(iOS)
    @Published private(set) var artcRemoteView: UIView?
    @Published private(set) var artcLocalView: UIView?

    func setARTC(remote: UIView?, local: UIView?) { artcRemoteView = remote; artcLocalView = local }
#elseif os(macOS)
    @Published private(set) var artcRemoteView: NSView?
    @Published private(set) var artcLocalView: NSView?

    func setARTC(remote: NSView?, local: NSView?) { artcRemoteView = remote; artcLocalView = local }
#endif

    func update(
        localVideoTrack: VideoTrack?,
        remoteVideoTrack: VideoTrack?
    ) {
        self.localVideoTrack = localVideoTrack
        self.remoteVideoTrack = remoteVideoTrack
    }

    func update(_ update: AssistantVideoTrackUpdate) {
        self.update(
            localVideoTrack: update.localVideoTrack,
            remoteVideoTrack: update.remoteVideoTrack
        )
    }
}

