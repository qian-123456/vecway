// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VecwayCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "VecwayCore",
            targets: ["VecwayCore"]
        ),
    ],
    targets: [
        .target(
            name: "VecwayCore",
            path: "Vecway",
            exclude: [
                "App",
                "Audio",
                "Push",
                "Scanner",
                "Web",
                "Resources",
                "Assets.xcassets",
                "Info.plist",
                "Vecway.entitlements",
                "Vecway-Push.entitlements",
            ],
            sources: [
                "Security",
                "Network",
            ]
        ),
        .testTarget(
            name: "VecwayCoreTests",
            dependencies: ["VecwayCore"],
            path: "VecwayTests"
        ),
    ]
)
