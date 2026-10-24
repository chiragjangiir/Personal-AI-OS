import SwiftUI
import UIKit

struct YimiAppearanceCrop: View {
    let image: UIImage
    let x: Double
    let y: Double
    var body: some View {
        GeometryReader { geo in
            let scale = max(geo.size.width / image.size.width, geo.size.height / image.size.height)
            let width = image.size.width * scale, height = image.size.height * scale
            Image(uiImage: image).resizable().frame(width: width, height: height)
                .offset(x: min(0, max(geo.size.width - width, geo.size.width / 2 - x * width)),
                        y: min(0, max(geo.size.height - height, geo.size.height / 2 - y * height)))
        }.clipped().clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

struct YimiAppearanceStyleSample: View {
    let index: Int
    private var image: UIImage? {
        guard let url = Bundle.main.url(forResource: "yimi-cartoon-reference", withExtension: "jpg", subdirectory: "Avatar"),
              let source = UIImage(contentsOfFile: url.path)?.cgImage else { return nil }
        let width = source.width / 3
        return source.cropping(to: CGRect(x: CGFloat(width * index), y: 0, width: CGFloat(width), height: CGFloat(source.height))).map { UIImage(cgImage: $0) }
    }
    var body: some View {
        if let image { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("静态卡通风格示意") }
        else { Text("静态风格示意无法载入") }
    }
}

struct YimiAppearanceCamera: UIViewControllerRepresentable {
    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(onPhoto: onPhoto, onCancel: { dismiss() }) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera; picker.cameraDevice = .front; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onPhoto: (UIImage) -> Void
        let onCancel: () -> Void
        init(onPhoto: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) { self.onPhoto = onPhoto; self.onCancel = onCancel }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { onPhoto(image) }
            else { onCancel() }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onCancel() }
    }
}

enum YimiAppearanceJPEG {
    static func encode(_ image: UIImage) throws -> Data {
        let scale = min(1, 1600 / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            UIColor.white.setFill(); UIRectFill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = normalized.jpegData(compressionQuality: 0.9), data.count <= 5_242_880 else { throw CocoaError(.fileReadTooLarge) }
        return data
    }
}
