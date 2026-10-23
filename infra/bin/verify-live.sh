#!/bin/bash
# Live-view soak on the mini (make verify-live [MINUTES=30]): every 10 s, for every camera the probe calls connected,
# the recorder's HLS playlist must be at most MAX_AGE s old. At the end: no new node crash reports, no web socket errors,
# recorder CPU within budget, single-consumer rule OK. Prints the numbers; exit 1 on any failure.
set -u
MINUTES=${1:-30}; MAX_AGE=${MAX_AGE:-6}; CPU_BUDGET=${CPU_BUDGET:-80}
STATUS=${RANCH_STATUS_URL:-http://127.0.0.1:5091}
say() { echo "$(date -u '+%FT%TZ') $*"; }
crash0=$(ls /Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c '^node-'); t0=$(date +%s); end=$(( t0 + MINUTES * 60 ))
ticks=0; stale=0; checked=0; worst=0; declare -A stale_by
say "soak: $MINUTES min, playlist age <= $MAX_AGE s for connected cameras"
while [ "$(date +%s)" -lt "$end" ]; do
  while IFS=$'\t' read -r cam connected; do
    [ "$connected" = "True" ] || continue
    age=$(( $(date +%s) - $(stat -f %m "/usr/local/ranch/media/live/$cam/index.m3u8" 2>/dev/null || echo 0) ))
    checked=$((checked + 1)); [ "$age" -gt "$worst" ] && worst=$age
    if [ "$age" -gt "$MAX_AGE" ]; then stale=$((stale + 1)); stale_by[$cam]=$(( ${stale_by[$cam]:-0} + 1 )); fi
  done < <(curl -s -m 5 "$STATUS/api/status" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['name'], c.get('connected'), sep='\t') for c in d['cameras']]")
  ticks=$((ticks + 1)); sleep 10
done
crash1=$(ls /Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c '^node-')
errs=$(sudo -n log show --start "$(date -r "$t0" '+%Y-%m-%d %H:%M:%S')" --predicate 'process == "logger" AND (eventMessage CONTAINS "UND_ERR" OR eventMessage CONTAINS "failed to pipe")' --style compact 2>/dev/null | grep -c -E "UND_ERR|failed to pipe")
cpu=$(ps -axo pcpu=,command= | grep "ffmpeg.*rtsp" | grep -v grep | awk '{c+=$1} END {printf "%.0f", c}')
owners=$(/usr/local/ranch/bin/camera-owners.sh | tail -1)
fail=0
say "checks: $checked camera-ticks over $ticks ticks; stale (> $MAX_AGE s): $stale; worst age $worst s; per camera: $(for k in "${!stale_by[@]}"; do printf '%s=%s ' "$k" "${stale_by[$k]}"; done)"
[ "$stale" -le $(( checked / 100 )) ] && say "ok: stale ticks within 1 %" || { say "FAIL: stale ticks $stale of $checked"; fail=1; }
[ "$crash1" -eq "$crash0" ] && say "ok: node crash reports unchanged ($crash1)" || { say "FAIL: node crash reports $crash0 -> $crash1"; fail=1; }
[ "${errs:-0}" -eq 0 ] && say "ok: no web socket errors" || { say "FAIL: $errs web socket errors"; fail=1; }
[ "${cpu:-0}" -le "$CPU_BUDGET" ] && say "ok: recorder ffmpeg CPU ${cpu}% (budget $CPU_BUDGET%)" || { say "FAIL: recorder ffmpeg CPU ${cpu}%"; fail=1; }
echo "$owners" | grep -q '^OK' && say "ok: $owners" || { say "FAIL: $owners"; fail=1; }
say "result=$([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
