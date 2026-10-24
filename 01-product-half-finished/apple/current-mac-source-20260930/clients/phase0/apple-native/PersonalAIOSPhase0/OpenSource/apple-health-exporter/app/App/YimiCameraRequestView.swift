import SwiftUI
import LiveKit

struct YimiCameraRequestView: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject var videoPreview: AssistantVideoPreviewModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let track = videoPreview.localVideoTrack {
                SwiftUIVideoView(track, layoutMode: .fill)
                    .ignoresSafeArea()
                    .accessibilityIdentifier("yimi.camera.request.preview")
            } else {
                ProgressView("正在打开摄像头")
                    .tint(.white).foregroundStyle(.white)
                    .accessibilityIdentifier("yimi.camera.request.opening")
            }
            VStack {
                Text(vm.cameraRequestCamera == "back" ? "依米正在看 · 后置摄像头" : "依米正在看 · 前置摄像头")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(.black.opacity(0.72), in: Capsule())
                    .accessibilityIdentifier("yimi.camera.request.status")
                    .padding(.top, 16)
                Spacer()
                Button("结束") { Task { await vm.endCameraRequest() } }
                    .font(.headline)
                    .foregroundStyle(.black)
                    .padding(.horizontal, 40)
                    .frame(minHeight: 52)
                    .background(.white, in: Capsule())
                    .accessibilityIdentifier("yimi.camera.request.end")
                    .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.keyboard)
        .accessibilityAddTraits(.isModal)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("yimi.camera.request.surface")
    }
}
