# iOS screen walk

A UI test that walks every screen of the real Engram Store app on an iOS
simulator and saves a screenshot of each: sign-in, the five tabs, search
with the keyboard up, results, previews, a folder, a file's menu, select
mode, the New sheet, everything under More, and landscape. Layout bugs a
desktop browser's phone emulation cannot show (the web view, the
keyboard, safe areas) show here.

1. Build the app for the simulator against a local server, so web fixes
   show without rebuilding the app:

   ```sh
   cd apps/desktop
   ENGRAM_APP_URL=http://localhost:3181 node scripts/instance-config.mjs
   node scripts/apple-core-build.mjs && node scripts/ios-project-fix.mjs
   env -u FORCE_COLOR pnpm exec tauri ios build --target aarch64-sim \
     --config src-tauri/tauri.instance.json
   ```

2. Install it on a booted simulator (the iPhone 16 Pro Max is 440 pt
   wide, the widest phone):

   ```sh
   xcrun simctl install <udid> "src-tauri/gen/apple/build/arm64-sim/Engram Store.app"
   ```

3. Run the walk with a test account on that server:

   ```sh
   cd apps/desktop/ios-screenwalk && xcodegen generate
   TEST_RUNNER_WALK_OUT=/tmp/walk TEST_RUNNER_WALK_EMAIL=you@example.com \
   TEST_RUNNER_WALK_PASSPHRASE='...' xcodebuild test -project ScreenWalk.xcodeproj \
     -scheme ScreenWalk -destination 'platform=iOS Simulator,id=<udid>'
   ```

Screenshots land in `WALK_OUT` in walk order, with `steps.txt` listing
every step and any control the walk could not reach.
