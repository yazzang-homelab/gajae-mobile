// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "GjcMobileCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "GjcMobileCore", targets: ["GjcMobileCore"]),
    ],
    dependencies: [
        // On Apple platforms `Crypto` re-exports CryptoKit; on Linux it is BoringSSL-backed with the same API.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0" ..< "5.0.0"),
    ],
    targets: [
        .target(
            name: "GjcMobileCore",
            dependencies: [.product(name: "Crypto", package: "swift-crypto")]
        ),
        .testTarget(
            name: "GjcMobileCoreTests",
            dependencies: ["GjcMobileCore"]
        ),
    ]
)
