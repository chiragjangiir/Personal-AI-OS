import Foundation
import LiveKit
import CoreImage
import ImageIO
import AVFoundation

protocol AssistantCameraRequestTransport: Sendable {
    func captureRequestedFrame(frameID: String, camera: String) async throws
}

/// Reads the existing published track; it never opens another camera session.
final class AssistantCameraJPEG: NSObject, VideoRenderer, @unchecked Sendable {
    private let frames: AsyncStream<VideoFrame>
    private let continuation: AsyncStream<VideoFrame>.Continuation
    @MainActor var isAdaptiveStreamEnabled: Bool { false }
    @MainActor var adaptiveStreamSize: CGSize { .zero }

    private let position: AVCaptureDevice.Position
    private let minimumTimestamp: Int64

    init(position: AVCaptureDevice.Position) {
        self.position = position
        minimumTimestamp = VideoCapturer.createTimeStampNs()
        let stream = AsyncStream<VideoFrame>.makeStream(bufferingPolicy: .bufferingNewest(1))
        frames = stream.stream; continuation = stream.continuation
        super.init()
    }

    nonisolated func render(frame: VideoFrame, captureDevice: AVCaptureDevice?, captureOptions: VideoCaptureOptions?) {
        guard captureDevice?.position == position, frame.timeStampNs >= minimumTimestamp else { return }
        continuation.yield(frame)
    }

    static func capture(_ track: LocalVideoTrack, position: AVCaptureDevice.Position) async throws -> Data {
        let renderer = AssistantCameraJPEG(position: position)
        track.add(videoRenderer: renderer)
        defer { track.remove(videoRenderer: renderer); renderer.continuation.finish() }
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                for await frame in renderer.frames {
                    try Task.checkCancellation()
                    guard let buffer = frame.toCVPixelBuffer() else { throw CentralTextError.unavailable }
                    let orientation: Int32 = switch frame.rotation {
                    case ._0: 1
                    case ._90: 6
                    case ._180: 3
                    case ._270: 8
                    }
                    let image = CIImage(cvPixelBuffer: buffer).oriented(forExifOrientation: orientation)
                    let context = CIContext()
                    guard let color = CGColorSpace(name: CGColorSpace.sRGB),
                          let jpeg = context.jpegRepresentation(of: image, colorSpace: color, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.82]) else {
                        throw CentralTextError.unavailable
                    }
                    return jpeg
                }
                throw CancellationError()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 8_000_000_000)
                throw CentralTextError.unavailable
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
}
