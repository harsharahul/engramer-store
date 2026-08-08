#!/usr/bin/env node
/**
 * Builds EngramCore.xcframework: the Rust encryption core with its Swift
 * bindings, packaged the way Xcode expects a binary dependency shared by
 * the app and its extensions.
 *
 * Steps: cargo staticlib for device and simulator, UniFFI Swift bindings
 * from the built library, a module map, then xcodebuild assembles the
 * xcframework. Output lands in src-tauri/ios/ (gitignored; rebuilt on
 * demand). The generated Swift file is copied beside it for the Xcode
 * target to compile.
 *
 * Run from apps/desktop:  node scripts/ios-core-build.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const iosDir = join(here, "..", "src-tauri", "ios");
const out = join(iosDir, "EngramCore.xcframework");
const staging = join(iosDir, ".core-build");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const libPath = (triple) => join(repo, "target", triple, "release", "libengram_ffi.a");

// The device gets one arch; the simulator slice is universal so it links
// on both Apple-silicon and Intel Macs (the simulator archive builds both
// arm64 and x86_64, and a slice missing either fails the extension link).
const deviceTriple = "aarch64-apple-ios";
const simTriples = ["aarch64-apple-ios-sim", "x86_64-apple-ios"];

for (const triple of [deviceTriple, ...simTriples]) {
  run("cargo", ["build", "-p", "engram-ffi", "--release", "--target", triple], repo);
}

rmSync(staging, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });

// Bindings are generated from the built library so they always match it.
const bindings = join(staging, "bindings");
run(
  "cargo",
  [
    "run", "-p", "engram-ffi", "--bin", "uniffi-bindgen", "--",
    "generate", "--library", libPath(deviceTriple), "--language", "swift", "--out-dir", bindings,
  ],
  repo,
);

// lipo the two simulator arches into one fat static library.
const simFat = join(staging, "libengram_ffi-sim.a");
run("lipo", ["-create", ...simTriples.map(libPath), "-output", simFat]);

// One headers directory per slice: the FFI header plus a module map that
// names the module the generated Swift expects to import.
const slices = [
  { lib: libPath(deviceTriple), name: "device" },
  { lib: simFat, name: "simulator" },
];
const args = ["-create-xcframework"];
for (const { lib, name } of slices) {
  const headers = join(staging, name, "Headers");
  mkdirSync(headers, { recursive: true });
  cpSync(join(bindings, "engram_ffiFFI.h"), join(headers, "engram_ffiFFI.h"));
  writeFileSync(
    join(headers, "module.modulemap"),
    'module engram_ffiFFI {\n  header "engram_ffiFFI.h"\n  export *\n}\n',
  );
  args.push("-library", lib, "-headers", headers);
}
args.push("-output", out);
run("xcodebuild", args);

// The Swift half of the bindings, compiled into whichever target uses the
// framework.
cpSync(join(bindings, "engram_ffi.swift"), join(iosDir, "Generated", "EngramCore.swift"));
console.log("EngramCore.xcframework + Generated/EngramCore.swift ready");
