import AVFoundation
import Combine
import Foundation
import Vision

/// AVFoundation + Vision are the system QR scanner; no camera capability is registered.
@MainActor
final class DesktopPairingCamera: ObservableObject {
    let session: AVCaptureSession
    @Published private(set) var errorMessage: String?
    var onCode: ((String) -> Void)?
    private let capture: DesktopQRCodeCapture
    private var generation = UUID()
    private var starting = false

    init() {
        let capture = DesktopQRCodeCapture()
        self.capture = capture
        session = capture.session
    }

    /// The pairing screen calls this only after the user chooses “扫描二维码”.
    func start() async {
        guard !starting else { return }
        starting = true
        let current = UUID()
        generation = current
        errorMessage = nil
        do {
            _ = try await MediaPermissionCoordinator().authorize(source: .camera, userInitiated: true)
            guard current == generation else { return }
            capture.start { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.starting = false
                    switch result {
                    case .success(let code): self.errorMessage = nil; self.stop(); self.onCode?(code)
                    case .failure(let error): self.errorMessage = DesktopUserFacingError.message(error)
                    }
                }
            }
        } catch {
            guard current == generation else { return }
            starting = false
            errorMessage = DesktopUserFacingError.message(error)
        }
    }

    /// Call on disappearance, pairing completion, or app backgrounding.
    func stop() {
        generation = UUID()
        starting = false
        capture.stop()
    }
}

private final class DesktopQRCodeCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.paios.desktop.pairing-camera", qos: .userInitiated)
    private var completion: (@Sendable (Result<String, Error>) -> Void)?
    private var lastScan = Date.distantPast

    func start(completion: @escaping @Sendable (Result<String, Error>) -> Void) {
        queue.async { [self] in
            self.completion = completion
            do {
                if session.inputs.isEmpty { try configure() }
                session.startRunning()
            } catch {
                self.completion = nil
                completion(.failure(error))
            }
        }
    }
    func stop() {
        queue.async { [self] in
            completion = nil
            session.stopRunning()
        }
    }
    private func configure() throws {
        guard let camera = AVCaptureDevice.default(for: .video) else { throw DesktopPairingCameraError.unavailable }
        let input = try AVCaptureDeviceInput(device: camera)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .vga640x480
        guard session.canAddInput(input), session.canAddOutput(output) else { throw DesktopPairingCameraError.unavailable }
        session.addInput(input)
        session.addOutput(output)
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard completion != nil, Date().timeIntervalSince(lastScan) >= 0.2,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastScan = Date()
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        do {
            try VNImageRequestHandler(cvPixelBuffer: buffer).perform([request])
            guard let code = request.results?.compactMap(\.payloadStringValue).first else { return }
            let callback = completion
            completion = nil
            queue.async { [self] in session.stopRunning() }
            callback?(.success(code))
        } catch {
            let callback = completion
            completion = nil
            queue.async { [self] in session.stopRunning() }
            callback?(.failure(error))
        }
    }
}

enum DesktopPairingCameraError: LocalizedError {
    case unavailable
    var errorDescription: String? { "摄像头不可用，请粘贴手机上的配对码。" }
}

// Core's permission coordinator uses the same public AVFoundation API on macOS.
typealias DesktopMediaPermissionProvider = MediaPermissionCoordinator

@MainActor
final class DesktopLocationProvider: AssistantLocationProviding {
    func authorizationStatus() -> AssistantPermissionStatus { .unavailable }
    func cachedFixAgeMilliseconds() -> Int? { nil }
    func requestWhenInUseAuthorization(userInitiated: Bool) async throws -> AssistantPermissionStatus { .unavailable }
    func requestOneShot(userInitiated: Bool) async throws -> AssistantLocationObservation { throw AssistantLocationError.unavailable(.failed) }
}
