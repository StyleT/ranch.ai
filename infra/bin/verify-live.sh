#!/bin/bash
# Live-view soak on the mini (make verify-live [MINUTES=30]): every 10 s, for every camera the probe calls connected,
# the recorder's JPEG buffer must have a frame at most MAX_AGE s old. The buffer is the always-on, transport-agnostic
# liveness truth (it is what `connected` itself is derived from, and what WebRTC/HLS viewers both ride on top of); the
# on-demand HLS playlist is deliberately only fresh while someone is watching over HLS, so it is not what we soak.
# At the end it asserts: buffer stayed fresh, no new node crash reports, no web socket errors, the single-consumer rule
# holds, and the on-demand transcode invariant (NO pull_hls encoder runs unless a camera has a fresh .demand marker --
# a stuck encoder with no viewer is exactly the saturation the on-demand design removed). The steady-state JPEG-decode
# CPU is reported as a number and warned (not failed) over CPU_BUDGET: it is a pre-existing per-camera cost, not a
# transport regression. Runs under the mini's /bin/bash (3.2): no associative arrays, no bash-4 features.
# Prints the numbers; exit 1 on any failure.
set -u
MINUTES=${1:-30}; MAX_AGE=${MAX_AGE:-10}; CPU_BUDGET=${CPU_BUDGET:-120}; TTL=${RECORDER_DEMAND_TTL:-20}
STATUS=${RANCH_STATUS_URL:-http://127.0.0.1:5091}
say() { echo "$(date -u '+%FT%TZ') $*"; }
crash0=$(ls /Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c '^node-'); t0=$(date +%s); end=$(( t0 + MINUTES * 60 ))
ticks=0; stale=0; checked=0; worst=0
say "soak: $MINUTES min, buffer frame age <= $MAX_AGE s for connected cameras"
while [ "$(date +%s)" -lt "$end" ]; do
  while IFS=$'\t' read -r cam connected; do
    [ "$connected" = "True" ] || continue
    newest=$(ls -t "/usr/local/ranch/media/buffer/$cam/"*.jpg 2>/dev/null | head -1)
    age=$(( $(date +%s) - $(stat -f %m "$newest" 2>/dev/null || echo 0) ))
    checked=$((checked + 1)); [ "$age" -gt "$worst" ] && worst=$age
    [ "$age" -gt "$MAX_AGE" ] && stale=$((stale + 1))
  done < <(curl -s -m 5 "$STATUS/api/status" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['name'], c.get('connected'), sep='\t') for c in d['cameras']]")
  ticks=$((ticks + 1)); sleep 10
done
crash1=$(ls /Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c '^node-')
errs=$(sudo -n log show --start "$(date -r "$t0" '+%Y-%m-%d %H:%M:%S')" --predicate 'process == "logger" AND (eventMessage CONTAINS "UND_ERR" OR eventMessage CONTAINS "failed to pipe")' --style compact 2>/dev/null | grep -c -E "UND_ERR|failed to pipe")
# JPEG-decode CPU (always-on buffer pull) vs transcode CPU (on-demand HLS), kept apart on purpose.
jpeg_cpu=$(ps -axo pcpu=,command= | grep "ffmpeg" | grep "image2" | grep -v grep | awk '{c+=$1} END {printf "%.0f", c+0}')
hls_enc=$(pgrep -f "pull_hls" 2>/dev/null | wc -l | tr -d ' ')
# a .demand marker fresher than TTL means a browser is on the HLS fallback right now (status touches it per playlist GET)
watched=0; for m in /usr/local/ranch/media/live/*/.demand; do [ -f "$m" ] || continue; [ $(( $(date +%s) - $(stat -f %m "$m" 2>/dev/null || echo 0) )) -le "$TTL" ] && watched=$((watched + 1)); done
owners=$(/usr/local/ranch/bin/camera-owners.sh | tail -1)
fail=0
say "checks: $checked camera-ticks over $ticks ticks; stale (> $MAX_AGE s): $stale; worst age $worst s"
[ "$stale" -le $(( checked / 100 )) ] && say "ok: stale ticks within 1 %" || { say "FAIL: stale ticks $stale of $checked"; fail=1; }
[ "$crash1" -eq "$crash0" ] && say "ok: node crash reports unchanged ($crash1)" || { say "FAIL: node crash reports $crash0 -> $crash1"; fail=1; }
[ "${errs:-0}" -eq 0 ] && say "ok: no web socket errors" || { say "FAIL: $errs web socket errors"; fail=1; }
# the hard invariant: a transcode encoder may run only while a viewer is on HLS; otherwise it is a stuck encoder.
if [ "$hls_enc" -gt 0 ] && [ "$watched" -eq 0 ]; then say "FAIL: $hls_enc pull_hls encoder(s) running with no fresh .demand (stuck transcode)"; fail=1; else say "ok: on-demand transcode (pull_hls encoders=$hls_enc, cameras watched=$watched)"; fi
[ "${jpeg_cpu:-0}" -le "$CPU_BUDGET" ] && say "ok: recorder JPEG-decode CPU ${jpeg_cpu}% (budget $CPU_BUDGET%)" || say "WARN: recorder JPEG-decode CPU ${jpeg_cpu}% over budget $CPU_BUDGET% (pre-existing per-camera decode cost, not a transport regression)"
echo "$owners" | grep -q '^OK' && say "ok: $owners" || { say "FAIL: $owners"; fail=1; }
say "result=$([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
