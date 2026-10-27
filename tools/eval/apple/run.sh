#!/usr/bin/env bash
# Scores Apple's on-device model on the eval set and writes
# apps/web/src/intel/eval/scores.json. Mac only, with Apple Intelligence on.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
cd "$here"
swift build -c release
# The constants Vite injects into the app build.
defines=()
for name in __APP_VERSION__ __GLINER_ORT_BASE__ __OCR_BASE__ __ORT_BASE__ __ZXING_BASE__; do
  defines+=("--define:$name=\"eval\"")
done
"$root/apps/web/node_modules/.bin/esbuild" driver.ts --bundle --platform=node --format=esm \
  "${defines[@]}" --outfile=.build/driver.mjs --log-level=warning
node .build/driver.mjs "$here/.build/release/EvalApple" "$root/apps/web/src/intel/eval/scores.json"
