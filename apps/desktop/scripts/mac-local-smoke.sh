#!/bin/sh
# The Mac smoke for local mode on the generic debug build under the smoke
# identifier. Proves: the backend boots and serves the bundled client (a
# page load logged by the app), the port is reused on a second launch, the
# vault directory is part of the device's backups while the packs folder
# is excluded, and quitting stops the listener. Nothing touches the
# installed app's configuration directory.
set -u
APP="$1"                      # path to "Engram Store Smoke.app"
OUT="$2"                      # scratch directory for logs
BIN="$APP/Contents/MacOS/engram-store-desktop"
CONF="$HOME/Library/Application Support/com.harsharahul.engramstore.localsmoke"
VAULT="$CONF/vault"
mkdir -p "$OUT" "$CONF"
rm -rf "$VAULT" "$CONF/local-port"
printf '1' > "$CONF/local-mode"
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILED=1; }
FAILED=0

launch() {  # $1 = log name, $2 = seconds to wait; the process is killed afterwards
  env ENGRAM_WINDOW_CHROME_LOG=1 "$BIN" > "$OUT/$1.out" 2> "$OUT/$1.err" &
  PID=$!
  sleep "$2"
  kill -TERM $PID 2>/dev/null
  wait $PID 2>/dev/null
}

# 1. First launch: the backend chooses a port, serves the client, the page loads.
launch first 25
PORT=$(grep -o 'chose port [0-9]*' "$OUT/first.err" | head -1 | awk '{print $3}')
[ -n "$PORT" ] && pass "chose a port ($PORT)" || fail "no port chosen (see first.err)"
grep -q "local mode: page loaded http://127.0.0.1:$PORT/ in main" "$OUT/first.err" && pass "page loaded from the loopback origin" || fail "no page load logged"
[ -f "$VAULT/engramer.db" ] && pass "vault database created" || fail "no vault database"
[ "$(cat "$CONF/local-port" 2>/dev/null)" = "$PORT" ] && pass "port remembered" || fail "port file does not hold $PORT"

# 2. Backups: the vault is in, the packs folder is out.
if xattr -l "$VAULT" 2>/dev/null | grep -q "com_apple_backup_excludeItem"; then
  # The attribute exists on the vault only if an earlier build set it; it must now read false (cleared).
  xattr -p com.apple.metadata:com_apple_backup_excludeItem "$VAULT" 2>/dev/null | grep -qi "false\|^$" && pass "vault not excluded from backups (flag cleared)" || fail "vault still excluded from backups"
else
  pass "vault not excluded from backups (no exclusion attribute)"
fi
xattr -l "$VAULT/packs" 2>/dev/null | grep -q "com_apple_backup_excludeItem" && pass "packs folder excluded from backups" || fail "packs folder carries no exclusion attribute"

# 3. Second launch reuses the port.
launch second 15
grep -q "http://127.0.0.1:$PORT" "$OUT/second.err" && pass "port reused on the second launch" || fail "second launch did not reuse $PORT"

# 4. Quit through the application stops the listener.
env "$BIN" > "$OUT/quit.out" 2> "$OUT/quit.err" &
PID=$!
sleep 12
osascript -e 'tell application "Engram Store Smoke" to quit' >/dev/null 2>&1
sleep 4
if kill -0 $PID 2>/dev/null; then fail "process still running after quit"; kill -TERM $PID 2>/dev/null; else pass "quit ended the process"; fi
grep -q "local mode: stopped" "$OUT/quit.err" && pass "listener stopped on quit" || fail "no 'local mode: stopped' line"
(curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1) && fail "port still answers after quit" || pass "port no longer answers"

echo "RESULT: $([ $FAILED -eq 0 ] && echo ALL PASS || echo FAILURES)"
exit $FAILED
