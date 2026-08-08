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

const targets = [
  { triple: "aarch64-apple-ios", slice: "device" },
  { triple: "aarch64-apple-ios-sim", slice: "simulator" },
];

for (const { triple } of targets) {
  run("cargo", ["build", "-p", "engram-ffi", "--release", "--target", triple], repo);
}

rmSync(staging, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });

// Bindings are generated from the built library so they always match it.
const deviceLib = join(repo, "target", targets[0].triple, "release", "libengram_ffi.a");
const bindings = join(staging, "bindings");
run(
  "cargo",
  [
    "run", "-p", "engram-ffi", "--bin", "uniffi-bindgen", "--",
    "generate", "--library", deviceLib, "--language", "swift", "--out-dir", bindings,
  ],
  repo,
);

// One headers directory per slice: the FFI header plus a module map that
// names the module the generated Swift expects to import.
const args = ["-create-xcframework"];
for (const { triple, slice } of targets) {
  const headers = join(staging, slice, "Headers");
  mkdirSync(headers, { recursive: true });
  cpSync(join(bindings, "engram_ffiFFI.h"), join(headers, "engram_ffiFFI.h"));
  writeFileSync(
    join(headers, "module.modulemap"),
    'module engram_ffiFFI {\n  header "engram_ffiFFI.h"\n  export *\n}\n',
  );
  args.push("-library", join(repo, "target", triple, "release", "libengram_ffi.a"), "-headers", headers);
}
args.push("-output", out);
run("xcodebuild", args);

// The Swift half of the bindings, compiled into whichever target uses the
// framework.
cpSync(join(bindings, "engram_ffi.swift"), join(iosDir, "Generated", "EngramCore.swift"));
console.log("EngramCore.xcframework + Generated/EngramCore.swift ready");
