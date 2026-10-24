import SwiftUI
import VisionKit

/// The phone approves a server-verified Mac request; only exchange receipt means connected.
struct YimiInternalMacPairingView: View {
    @ObservedObject var payment: YimiPaymentModel
    @Environment(\.dismiss) private var dismiss
    @State private var scanned: String?
    @State private var scannerError: String?
    @State private var cameraReady = false
    @State private var phase: Phase = .scanning
    @State private var preview: RealtimeMacPairingPreview?
    @State private var approving = false
    private enum Phase { case scanning, loading, confirmation, waiting, connected, expired, failed }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    if phase == .scanning {
                        Text("扫描 Mac 窗口中的二维码").font(.title2.weight(.semibold))
                        Text("在 Mac 打开依米，然后用这台 iPhone 扫码。").foregroundStyle(Yimi.ink2)
                        if cameraReady && DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                            InternalMacQRScanner(scanned: $scanned, error: $scannerError)
                                .frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 18))
                                .accessibilityIdentifier("macPairing.scanner")
                        } else if cameraReady {
                            Text("这台 iPhone 暂时无法扫码。请检查相机权限。")
                        } else if scannerError == nil { ProgressView("正在请求相机权限") }
                        if let scannerError { Text(scannerError).foregroundStyle(Yimi.ink2) }
                    } else if phase == .confirmation, let preview {
                        Image(systemName: "desktopcomputer").font(.system(size: 44)).foregroundStyle(Yimi.klein)
                        Text("连接这台 Mac？").font(.title2.weight(.semibold))
                        Text("电脑名称：" + preview.label).font(.headline)
                            .accessibilityIdentifier("macPairing.computerName")
                        Text("请与 Mac 窗口显示的名称核对。").foregroundStyle(Yimi.ink2)
                        Button("确认连接") { approving = true }.buttonStyle(.borderedProminent).tint(Yimi.klein)
                            .accessibilityIdentifier("macPairing.confirm")
                        Button("取消", role: .cancel) { reset() }.accessibilityIdentifier("macPairing.cancel")
                    } else if phase == .loading || phase == .waiting {
                        ProgressView(phase == .loading ? "正在核对电脑名称" : "正在等待 Mac 完成连接")
                            .accessibilityIdentifier("macPairing.progress")
                    } else if phase == .connected {
                        Image(systemName: "checkmark.circle").font(.system(size: 44)).foregroundStyle(Yimi.klein)
                        Text("已连接你的 Mac。可到“设备”撤销。")
                            .accessibilityIdentifier("macPairing.connected")
                        Button("完成") { dismiss() }.buttonStyle(.borderedProminent).tint(Yimi.klein)
                            .accessibilityIdentifier("macPairing.done")
                    } else if phase == .expired {
                        Text("二维码已失效 · 回到 Mac 刷新").accessibilityIdentifier("macPairing.expired")
                        Button("重新扫描") { reset() }.accessibilityIdentifier("macPairing.rescan")
                    } else {
                        Text("连接失败 · 重试").accessibilityIdentifier("macPairing.failed")
                        Button("重试") { phase = .loading; approving = false }.accessibilityIdentifier("macPairing.retry")
                        Button("重新扫描") { reset() }.accessibilityIdentifier("macPairing.rescan")
                    }
                }.frame(maxWidth: .infinity).padding(24)
            }
            .background(Yimi.ground).navigationTitle("连接电脑").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("关闭") { dismiss() }.accessibilityIdentifier("macPairing.close") }
            .task { await authorizeCamera() }
            .task(id: scanned) { if scanned != nil { phase = .loading } }
            .task(id: phase) { if phase == .loading { await resolve() } }
            .task(id: approving) { if approving { await connect() } }
        }
    }

    @MainActor private func reset() {
        scanned = nil; preview = nil; scannerError = nil; approving = false; phase = .scanning
    }
    @MainActor private func authorizeCamera() async {
        do {
            _ = try await MediaPermissionCoordinator().authorize(source: .camera, userInitiated: true)
            cameraReady = true
        } catch { scannerError = "相机权限未允许，请在系统设置中允许依米使用相机。" }
    }
    private func request() throws -> (RealtimeMacPairingQR, RealtimeDevicePairing) {
        guard let scanned, let pairing = try PairedRealtimeRequestBodyProvider().pairing() else {
            throw RealtimeDevicePairingError.unavailable
        }
        return (try RealtimeMacPairingQR.decode(Data(scanned.utf8), origin: pairing.origin), pairing)
    }
    @MainActor private func resolve() async {
        do {
            let (qr, pairing) = try request()
            let value = try await RealtimeMacPairingAPI.preview(qr, pairing: pairing)
            try Task.checkCancellation()
            guard try PairedRealtimeRequestBodyProvider().pairing() == pairing else { throw RealtimeDevicePairingError.invalidPairing }
            preview = value
            if value.status == .connected { phase = .connected }
            else if value.status == .approved { approving = true }
            else { phase = .confirmation }
        } catch { fail(error) }
    }
    @MainActor private func connect() async {
        do {
            let (qr, pairing) = try request()
            phase = .waiting
            if preview?.status == .pending {
                let proof = try await payment.authorizeMacPairing(qr, pairing: pairing)
                try Task.checkCancellation()
                guard try PairedRealtimeRequestBodyProvider().pairing() == pairing else { throw RealtimeDevicePairingError.invalidPairing }
                try await RealtimeMacPairingAPI.approve(qr, pairing: pairing, ownerProof: proof)
            }
            while true {
                try Task.checkCancellation()
                guard try PairedRealtimeRequestBodyProvider().pairing() == pairing else { throw RealtimeDevicePairingError.invalidPairing }
                let receipt = try await RealtimeMacPairingAPI.preview(qr, pairing: pairing)
                try Task.checkCancellation()
                guard try PairedRealtimeRequestBodyProvider().pairing() == pairing else { throw RealtimeDevicePairingError.invalidPairing }
                if receipt.status == .connected { phase = .connected; return }
                try await Task.sleep(for: .seconds(2))
            }
        } catch { fail(error) }
    }
    @MainActor private func fail(_ error: Error) {
        if Task.isCancelled || error is CancellationError { return }
        if error is RealtimeMacPairingError { phase = .expired; return }
        do { _ = try request(); phase = .failed }
        catch is RealtimeMacPairingError { phase = .expired }
        catch { phase = .failed }
    }
}

private struct InternalMacQRScanner: UIViewControllerRepresentable {
    @Binding var scanned: String?
    @Binding var error: String?
    func makeCoordinator() -> Coordinator { Coordinator(scanned: $scanned, error: $error) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard scanned == nil, !scanner.isScanning else { return }
        do { try scanner.startScanning() }
        catch { context.coordinator.error.wrappedValue = "相机扫描未启动，请关闭后重试。" }
    }
    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) { scanner.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var scanned: Binding<String?>
        var error: Binding<String?>
        init(scanned: Binding<String?>, error: Binding<String?>) { self.scanned = scanned; self.error = error }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let code) = item, let payload = code.payloadStringValue {
                    scanner.stopScanning(); scanned.wrappedValue = payload
                    return
                }
            }
        }
    }
}
