#!/bin/bash
# Adversarial-network kill-test v2 for the Engram Finder drive.
# v1 lesson: never killall fileproviderd mid-test (unmounts the domain
# and you measure the re-mount, not the network); kill only the
# extension process so sessions are fresh but the mount stays. Paths
# are never echoed; a stat miss re-resolves by size.
set -u
DRIVE="$HOME/Library/CloudStorage/EngramStore-EngramStore"
HOST="${ENGRAM_HOST:?set ENGRAM_HOST to the deployment hostname, e.g. vault.example.com}"
WIFI_DEV=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
WIFI_SVC="Wi-Fi"
NC_PID=""

restore() {
  networksetup -setsecurewebproxystate "$WIFI_SVC" off 2>/dev/null
  [ -n "$WIFI_DEV" ] && networksetup -setairportpower "$WIFI_DEV" on 2>/dev/null
  [ -n "$NC_PID" ] && kill "$NC_PID" 2>/dev/null
}
trap restore EXIT

find_target() {
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    local blocks size
    blocks=$(stat -f %b "$f" 2>/dev/null) || continue
    size=$(stat -f %z "$f" 2>/dev/null) || continue
    if [ "${blocks:-1}" -eq 0 ] && [ "${size:-0}" -gt 10000 ]; then
      printf '%s\n' "$f"; return 0
    fi
  done < <(find "$DRIVE" -maxdepth 2 -type f 2>/dev/null)
  return 1
}

TARGET=$(find_target) || { echo "VERDICT: SKIP - no dataless file over 10KB"; exit 0; }
EXPECTED=$(stat -f %z "$TARGET")
echo "target: a dataless file of $EXPECTED bytes"

fresh_extension() { pkill -x EngramFilesMac 2>/dev/null; sleep 3; }
blocks_of() { stat -f %b "$TARGET" 2>/dev/null || echo "gone"; }

# --- Phase B: connection accepted, then silence (the killer case) ---
nc -lk 127.0.0.1 9999 >/dev/null 2>&1 &
NC_PID=$!
networksetup -setsecurewebproxy "$WIFI_SVC" 127.0.0.1 9999
fresh_extension
t0=$(date +%s)
cat "$TARGET" >/dev/null 2>&1 &
CAT=$!
STALL_RESULT="hung"
for i in $(seq 1 100); do
  kill -0 $CAT 2>/dev/null || { STALL_RESULT="ended"; break; }
  sleep 1
done
t1=$(date +%s)
kill $CAT 2>/dev/null
networksetup -setsecurewebproxystate "$WIFI_SVC" off
kill "$NC_PID" 2>/dev/null; NC_PID=""
B_BLOCKS=$(blocks_of)
echo "phase-stall: $STALL_RESULT after $((t1-t0))s, blocks-on-disk=$B_BLOCKS"

# --- Phase A: hard offline ---
networksetup -setairportpower "$WIFI_DEV" off
sleep 2
t0=$(date +%s)
cat "$TARGET" >/dev/null 2>&1 &
CAT=$!
OFF_RESULT="hung"
for i in $(seq 1 40); do
  kill -0 $CAT 2>/dev/null || { OFF_RESULT="ended"; break; }
  sleep 1
done
t1=$(date +%s)
kill $CAT 2>/dev/null
A_BLOCKS=$(blocks_of)
echo "phase-offline: $OFF_RESULT after $((t1-t0))s, blocks-on-disk=$A_BLOCKS"
networksetup -setairportpower "$WIFI_DEV" on

# --- Recovery: patient, with retries ---
for i in $(seq 1 30); do
  ping -c1 -t2 "$HOST" >/dev/null 2>&1 && break
  sleep 2
done
GOT=0
for attempt in 1 2 3; do
  GOT=$(cat "$TARGET" 2>/dev/null | wc -c | tr -d ' ')
  [ "$GOT" -eq "$EXPECTED" ] && break
  sleep 15
done
ENTRIES=$(ls "$DRIVE" 2>/dev/null | wc -l | tr -d ' ')
echo "recovery: read $GOT of $EXPECTED bytes (attempt $attempt), drive entries=$ENTRIES"

if [ "$STALL_RESULT" = "ended" ] && [ "$OFF_RESULT" = "ended" ] \
  && [ "$B_BLOCKS" = "0" ] && [ "$A_BLOCKS" = "0" ] \
  && [ "$GOT" -eq "$EXPECTED" ] && [ "$ENTRIES" -gt 0 ]; then
  echo "VERDICT: PASS"
else
  echo "VERDICT: EXAMINE - see lines above"
fi
