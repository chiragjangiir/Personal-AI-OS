// swift-tools-version: 5.9
import PackageDescription
import Foundation

// URLs and checksums are the official v1.13.8 sherpa-onnx / v1.28.2
// onnxruntime-libs SwiftPM manifests (the latter publishes ORT 1.28.1).
let kwsRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("Sources/VoiceWake/Resources/kws")
for artifact in ["encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                 "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                 "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "tokens.txt", "keywords.txt"] {
    guard FileManager.default.fileExists(atPath: kwsRoot.appendingPathComponent(artifact).path) else {
        fatalError("Missing VoiceWake KWS asset \(artifact). Follow docs/clients.md, step C (KWS model).")
    }
}
let package = Package(
    name: "VoiceWake",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "VoiceWake", targets: ["VoiceWake"])],
    targets: [
        .binaryTarget(name: "SherpaOnnxMacOS", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/sherpa-onnx-v1.13.8-macos-static.xcframework.zip", checksum: "93f7a064abe99e0d6185a88c5b36ce18c4bff35cd0d5e4e81f81151de8e3e7e5"),
        .binaryTarget(name: "SherpaOnnxIOS", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/sherpa-onnx-v1.13.8-ios-static.xcframework.zip", checksum: "6b8e769cb153343270fdccbe92e3b3db0d1c421d67fa0989ab01fdf5b2fcf2de"),
        .binaryTarget(name: "OnnxruntimeMacOS", url: "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.28.1/onnxruntime-macos-static-xcframework-1.28.1.xcframework.zip", checksum: "38c9a1e8bcf2497ff5eb721195743e4b4367ade3cd1eb9869c0cfd1bd367c36b"),
        .binaryTarget(name: "OnnxruntimeIOS", url: "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.28.1/onnxruntime-ios-static-xcframework-1.28.1.xcframework.zip", checksum: "992d8a0cc6014cccc3a7815c36bbff5e5a06833ea2c4d47dd43ef071f639cf9d"),
        .target(name: "VoiceWake", dependencies: [
            .target(name: "SherpaOnnxMacOS", condition: .when(platforms: [.macOS])),
            .target(name: "SherpaOnnxIOS", condition: .when(platforms: [.iOS])),
            .target(name: "OnnxruntimeMacOS", condition: .when(platforms: [.macOS])),
            .target(name: "OnnxruntimeIOS", condition: .when(platforms: [.iOS]))
        ], resources: [.copy("Resources/kws")], linkerSettings: [
            .linkedLibrary("c++"), .linkedFramework("Foundation"),
            .linkedFramework("CoreFoundation"), .linkedFramework("CoreML")
        ]),
        .testTarget(name: "VoiceWakeTests", dependencies: ["VoiceWake"])
    ]
)
