//! Besides Tauri's own build step, this compiles the on-device assistant's
//! Swift shim (apple/Intel) into a static library and links it into the
//! Apple binaries: the macOS executable, and the iOS library that Xcode
//! links into the app. The framework it talks to is weak-linked, so the
//! app still launches on macOS 14 and iOS 16 and answers "unavailable"
//! there. Without a Swift toolchain the shim is skipped and the Rust side
//! compiles its stub.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(engram_intel_shim)");
    println!("cargo::rerun-if-env-changed=ENGRAM_INTEL_SHIM");
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let disabled = env::var("ENGRAM_INTEL_SHIM").map(|v| v == "off").unwrap_or(false);
    if !disabled && (target_os == "macos" || target_os == "ios") {
        match build_swift_shim(&target_os) {
            Ok(()) => println!("cargo::rustc-cfg=engram_intel_shim"),
            Err(reason) => println!("cargo::warning=on-device assistant shim not built: {reason}"),
        }
    }
    tauri_build::build()
}

fn xcrun(args: &[&str]) -> Result<String, String> {
    let output = Command::new("xcrun").args(args).output().map_err(|err| format!("xcrun: {err}"))?;
    if !output.status.success() {
        return Err(format!("xcrun {} failed", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The SDK name, the Swift target triple, and the toolchain library
/// directory for the target cargo is building.
fn apple_platform(target_os: &str) -> Result<(&'static str, String, &'static str), String> {
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => return Err(format!("unsupported architecture {other}")),
    };
    if target_os == "macos" {
        return Ok(("macosx", format!("{arch}-apple-macos14.0"), "macosx"));
    }
    let simulator = env::var("CARGO_CFG_TARGET_ABI").map(|abi| abi == "sim").unwrap_or(false)
        || arch == "x86_64";
    if simulator {
        Ok(("iphonesimulator", format!("{arch}-apple-ios16.0-simulator"), "iphonesimulator"))
    } else {
        Ok(("iphoneos", format!("{arch}-apple-ios16.0"), "iphoneos"))
    }
}

fn build_swift_shim(target_os: &str) -> Result<(), String> {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let sources_dir = manifest.join("apple").join("Intel");
    println!("cargo::rerun-if-changed={}", sources_dir.display());
    let mut sources: Vec<PathBuf> = std::fs::read_dir(&sources_dir)
        .map_err(|err| format!("{}: {err}", sources_dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().map(|ext| ext == "swift").unwrap_or(false))
        .collect();
    sources.sort();
    if sources.is_empty() {
        return Err("no Swift sources".to_string());
    }
    let (sdk_name, triple, toolchain_dir) = apple_platform(target_os)?;
    let swiftc = xcrun(&["--find", "swiftc"])?;
    let sdk = xcrun(&["--sdk", sdk_name, "--show-sdk-path"])?;
    let out = PathBuf::from(env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let library = out.join("libEngramIntel.a");
    let status = Command::new(&swiftc)
        .args([
            "-emit-library",
            "-static",
            "-parse-as-library",
            "-module-name",
            "EngramIntel",
            "-swift-version",
            "5",
            "-O",
            "-sdk",
            &sdk,
            "-target",
            &triple,
            "-o",
        ])
        .arg(&library)
        .args(&sources)
        .status()
        .map_err(|err| format!("swiftc: {err}"))?;
    if !status.success() {
        return Err("swiftc failed".to_string());
    }
    // The toolchain's Swift library directory holds the compatibility
    // shims an older deployment target autolinks; the SDK's holds the
    // stubs for the runtime that ships in the OS itself.
    let toolchain_swift = PathBuf::from(&swiftc)
        .parent()
        .and_then(|bin| bin.parent())
        .map(|usr| usr.join("lib").join("swift").join(toolchain_dir))
        .ok_or_else(|| "cannot locate the Swift toolchain libraries".to_string())?;
    println!("cargo::rustc-link-search=native={}", out.display());
    println!("cargo::rustc-link-lib=static=EngramIntel");
    println!("cargo::rustc-link-search=native={}/usr/lib/swift", sdk);
    println!("cargo::rustc-link-search=native={}", toolchain_swift.display());
    println!("cargo::rustc-link-arg=-Wl,-weak_framework,FoundationModels");
    // The toolchain stubs name the concurrency runtime by run path; the
    // OS keeps it under /usr/lib/swift, which Xcode adds for every Swift
    // app and a Rust link must add itself.
    println!("cargo::rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    Ok(())
}
