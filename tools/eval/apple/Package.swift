// swift-tools-version:6.2
// Scores Apple's on-device model on the synthetic eval set; see README.md.
import PackageDescription

let package = Package(
    name: "EvalApple",
    platforms: [.macOS(.v26)],
    targets: [
        // The app's shim files are linked in, not copied, so the harness
        // runs exactly the code the app ships.
        .executableTarget(name: "EvalApple", path: "Sources/EvalApple")
    ],
    // The language mode the app builds the shim in.
    swiftLanguageModes: [.v5]
)
