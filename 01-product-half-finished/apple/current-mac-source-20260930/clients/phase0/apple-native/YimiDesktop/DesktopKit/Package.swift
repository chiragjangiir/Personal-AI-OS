// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "DesktopKit",
    platforms: [.macOS(.v14)],
    products: [.library(name: "DesktopKit", targets: ["DesktopKit"])],
    dependencies: [.package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", exact: "0.12.1")],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .target(name: "DesktopKit", dependencies: ["CSQLite", .product(name: "MCP", package: "swift-sdk")],
                resources: [.process("Resources")], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "DesktopKitTests", dependencies: ["DesktopKit"], exclude: ["Fixtures"], swiftSettings: [.swiftLanguageMode(.v5)])
    ]
)
