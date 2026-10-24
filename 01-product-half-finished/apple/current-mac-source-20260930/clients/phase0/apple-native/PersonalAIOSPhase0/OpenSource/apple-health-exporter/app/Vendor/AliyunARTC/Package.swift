// swift-tools-version: 6.0
import PackageDescription
import Foundation

// AliVCSDK_ARTC 7.11.0: https://alivc-demo-cms.alicdn.com/versionProduct/sdk/mone/7.11.0/ios/AliVCSDK_ARTC.library.zip
// Recorded archive SHA-256 (not a vendor-published checksum): 4adeadf8f13e361324d6d385043678650d1ab171f20ba0ac4b0f68df3ba340b9; arm64 slices in XCFramework containers; CocoaPods licence: MIT, Alibaba-INC copyright.
let vendorRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
for artifact in ["AliVCSDK_ARTC.xcframework", "alivcffmpeg.xcframework"] {
    guard FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent(artifact).path) else {
        fatalError("Missing AliyunARTC asset \(artifact). Follow docs/clients.md, step A (iOS AliyunARTC 7.11.0).")
    }
}
let package = Package(
    name: "AliyunARTC", platforms: [.iOS(.v17)],
    products: [.library(name: "AliyunARTC", targets: ["AliVCSDK_ARTC", "alivcffmpeg"])],
    targets: [
        .binaryTarget(name: "AliVCSDK_ARTC", path: "AliVCSDK_ARTC.xcframework"),
        .binaryTarget(name: "alivcffmpeg", path: "alivcffmpeg.xcframework")
    ]
)
