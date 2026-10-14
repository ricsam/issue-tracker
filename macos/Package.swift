// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Threadline",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "Threadline", targets: ["Threadline"])],
    targets: [
        .target(name: "ThreadlineCore"),
        .executableTarget(name: "Threadline", dependencies: ["ThreadlineCore"]),
        .testTarget(name: "ThreadlineCoreTests", dependencies: ["ThreadlineCore"]),
        .testTarget(name: "ThreadlineTests", dependencies: ["Threadline", "ThreadlineCore"]),
    ]
)
