// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HealthKitExporterHostTests",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "HealthKitExporter", targets: ["HealthKitExporter"])
    ],
    dependencies: [
        .package(path: "Vendor/AliyunARTC"),
        .package(path: "../../../../VoiceWake"),
        .package(
            url: "https://github.com/groue/GRDB.swift.git",
            exact: "7.11.1"
        ),
        .package(
            url: "https://github.com/livekit/client-sdk-swift.git",
            exact: "2.17.0"
        )
    ],
    targets: [
        .target(
            name: "HealthKitExporter",
            dependencies: [
                .product(name: "VoiceWake", package: "VoiceWake"),
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "LiveKit", package: "client-sdk-swift"),
                .product(name: "AliyunARTC", package: "AliyunARTC", condition: .when(platforms: [.iOS]))
            ],
            path: ".",
            exclude: [
                "Tests",
                "UITests",
                "Watch",
                "WatchApp",
                "WatchTests",
                "Vendor",
                "Core/AssistantLocalOperationDatabase.swift.orig",
                "Core/BackgroundSyncRegistrar.swift"
            ],
            sources: ["Core", "Shared", "WatchShared", "WatchCore", "App/YimiPaymentModel.swift", "App/YimiAppLock.swift"],
            resources: [.copy("Contracts")],
            linkerSettings: [
                .linkedFramework("HealthKit"),
                .linkedFramework("Contacts"),
                .linkedFramework("Security")
            ]
        ),
        .testTarget(
            name: "HealthKitExporterTests",
            dependencies: ["HealthKitExporter"],
            path: "Tests",
            resources: [.copy("Fixtures")]
        )
    ],
    swiftLanguageModes: [.v5]
)
