import CoreImage
import SwiftUI

struct DesktopPairingQRView: View {
    @ObservedObject var pairing: DesktopPairingController
    @State private var generation = UUID()
    @State private var loadError: String?
    @Environment(\.desktopRendering) private var rendering
    var body: some View {
        VStack(spacing: 14) {
            Text("用 iPhone 连接这台 Mac").font(.title2.weight(.semibold))
            Text("电脑名称：" + pairing.computerName).accessibilityIdentifier("mac.pairing.computerName")
            Text("在 iPhone「设备 → 添加电脑」扫码").foregroundStyle(Yimi.ink2)
            if let data = pairing.qrData, let image = qrImage(data) {
                Image(nsImage: image).interpolation(.none).resizable()
                    .frame(width: 240, height: 240).padding(12).background(.white)
                    .accessibilityLabel("连接这台 Mac 的二维码，请用 iPhone 扫描")
                    .accessibilityIdentifier("mac.pairing.qr")
            } else if pairing.isPairing { ProgressView("正在生成二维码").frame(height: 264) }
            Text(pairing.qrStatus ?? "正在生成二维码")
                .accessibilityIdentifier("mac.pairing.status")
            if let loadError { Text(loadError).foregroundStyle(Yimi.danger) }
            if !pairing.isPairing {
                Button("刷新二维码") { generation = UUID() }
                    .accessibilityIdentifier("mac.pairing.refresh")
            }
        }.task(id: generation) {
            guard !rendering else { return }
            loadError = nil
            do {
                let settings = try await UserDefaultsSettingsStore().loadSettings()
                await pairing.beginQRPairing(origin: settings.endpoint)
            } catch { loadError = DesktopUserFacingError.message(error) }
        }.onDisappear { if !rendering { pairing.cancelQRPairing() } }
    }
    private func qrImage(_ data: Data) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
