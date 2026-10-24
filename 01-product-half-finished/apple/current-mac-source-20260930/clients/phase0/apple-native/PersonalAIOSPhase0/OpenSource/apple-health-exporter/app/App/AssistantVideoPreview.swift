import Combine
import LiveKit
import SwiftUI
import UIKit

struct ARTCVideoView: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView { view }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

@MainActor
struct AssistantVideoPreview: View {
    @ObservedObject private var model: AssistantVideoPreviewModel

    init(model: AssistantVideoPreviewModel) {
        self.model = model
    }

    var body: some View {
        ZStack {
            Color.black
            if let track = model.localVideoTrack ?? model.remoteVideoTrack {
                SwiftUIVideoView(track)
                    .aspectRatio(track.aspectRatio, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .padding(8)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "video.slash")
                        .font(.title2)
                    Text("No local or remote video track available")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 180)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("assistant.videoPreview")
    }
}
