#!/bin/bash
# Fault-injection e2e for the camera path, on the mini (make e2e-chaos [CAM=] [DURATION=] [MODE=stop|udp]). Software
# only, never touches a camera. Exit 1 on any failed assertion. Needs sudo for pfctl (passwordless on the mini).
#
# MODE=stop (default, deterministic): SIGSTOP the camera's ffmpeg. Frames stop at once: exactly the symptom of a hung
#   go2rtc dial or a dead feed as the rest of the system sees it (playlist not written). Asserts:
#     1. netprobe reports the camera not connected within DETECT_MAX s (frames are the truth: FRESH_S + one probe)
#     2. the recorder's stall watchdog logs "no frames for … re-attaching" within WATCHDOG_MAX s (TERM, then KILL: a
#        stopped process only dies from the KILL, which is what the watchdog does)
#     3. the supervisor writes a rung-0 "down" row for the camera
#     4. the camera is connected again within RECOVER_MAX s and the playlist is fresh
#     5. camera-owners.sh still OK
# MODE=udp (experiment, informational): a pf rule in the child anchor com.ranch/chaos drops UDP from the camera's IP.
#   Measured 23 Oct: the drop counter grows for ~40 s and then stops while frames keep flowing: the TUTK session relays
#   around a LAN block, so this does not reproduce a dead session; timings are printed, only steps 3-5 are asserted.
set -u
CAM=${1:-back_yard_cam}; DURATION=${2:-90}; MODE=${3:-${MODE:-stop}}
DETECT_MAX=${DETECT_MAX:-60}; WATCHDOG_MAX=${WATCHDOG_MAX:-90}; RECOVER_MAX=${RECOVER_MAX:-120}
STATUS=${RANCH_STATUS_URL:-http://127.0.0.1:5091}
fail=0; t_start=$(date +%s); ffpid=""
say() { echo "$(date -u '+%FT%TZ') $*"; }
state() { curl -s -m 5 "$STATUS/api/status" | python3 -c "import json,sys; d=json.load(sys.stdin); c=[x for x in d['cameras'] if x['name']=='$CAM']; print(c[0].get('connected') if c else 'missing')"; }
cleanup() { sudo -n pfctl -a com.ranch/chaos -F all >/dev/null 2>&1; [ -n "$ffpid" ] && kill -CONT "$ffpid" 2>/dev/null; true; }
trap cleanup EXIT
must() { if [ "$MODE" = "udp" ] && [ "$1" -le 2 ]; then say "info $1 (udp mode, not asserted): $2"; else say "FAIL $1: $2"; fail=1; fi; }

[ "$(state)" = "True" ] || { say "precondition failed: $CAM is not connected now ($(state)); pick another camera"; exit 1; }
if [ "$MODE" = "udp" ]; then
  ip=$(curl -s -m 5 http://127.0.0.1:5080/api/cameras | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((c['ip'] for c in d if c.get('name')=='$CAM'), ''))")
  [ -n "$ip" ] || { say "no IP for $CAM in the bridge"; exit 1; }
  say "chaos(udp): dropping UDP from $CAM ($ip) for $DURATION s"
  echo "block drop in quick inet proto udp from $ip to any" | sudo -n pfctl -a com.ranch/chaos -f - 2>/dev/null || { say "pfctl failed"; exit 1; }
  sudo -n pfctl -a com.ranch/chaos -sr 2>/dev/null | grep -q "$ip" || { say "pfctl: the rule is not in the anchor"; exit 1; }
else
  ffpid=$(pgrep -f "ffmpeg .*rtsp://127.0.0.1:8554/${CAM}[[:space:]]" | head -1)
  [ -n "$ffpid" ] || { say "no recorder ffmpeg for $CAM"; exit 1; }
  say "chaos(stop): SIGSTOP the recorder's ffmpeg for $CAM (pid $ffpid) for up to $DURATION s"
  kill -STOP "$ffpid"
fi
t_block=$(date +%s)

# 1. detection
while [ "$(state)" = "True" ] && [ $(( $(date +%s) - t_block )) -lt "$DETECT_MAX" ]; do sleep 5; done
t_detect=$(( $(date +%s) - t_block ))
if [ "$(state)" = "True" ]; then must 1 "still reported connected after $DETECT_MAX s"; else say "ok 1: netprobe reported the camera not connected after $t_detect s"; fi

# 2. the recorder reacted (watchdog re-attach, or ffmpeg's own exit)
n=0
while [ $(( $(date +%s) - t_block )) -lt "$WATCHDOG_MAX" ]; do
  n=$(sudo -n log show --start "$(date -r "$t_block" '+%Y-%m-%d %H:%M:%S')" --predicate "process == \"logger\" AND (eventMessage CONTAINS \"$CAM: no frames for\" OR eventMessage CONTAINS \"$CAM: rtsp ended\")" --style compact 2>/dev/null | grep -cE "re-attaching|rtsp ended")
  [ "$n" -ge 1 ] && break; sleep 10
done
t_wd=$(( $(date +%s) - t_block ))
if [ "$n" -ge 1 ]; then say "ok 2: recorder reconnect loop ran ($n line(s)) within $t_wd s"; else must 2 "no recorder reconnect logged within $WATCHDOG_MAX s"; fi

# 3. supervisor row (give it two ticks)
sleep 30
rows=$(curl -s -m 5 "$STATUS/api/remediation?since=15m&camera=$CAM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for r in d if r['action']=='down'))")
if [ "${rows:-0}" -ge 1 ]; then say "ok 3: supervisor recorded the outage (rung 0 rows in 15 min: $rows)"; else say "FAIL 3: no supervisor 'down' row for $CAM"; fail=1; fi

# hold the fault for the requested duration, then remove it
remaining=$(( DURATION - ( $(date +%s) - t_block ) )); [ "$remaining" -gt 0 ] && sleep "$remaining"
if [ "$MODE" = "udp" ]; then drops=$(sudo -n pfctl -a com.ranch/chaos -vsr 2>/dev/null | grep -oE 'Packets: [0-9]+' | head -1); say "chaos: rule removed (${drops:-no counter})"; else say "chaos: fault removed (ffmpeg $ffpid $(kill -0 "$ffpid" 2>/dev/null && echo 'still alive -> CONT' || echo 'already replaced by the watchdog'))"; fi
cleanup; ffpid=""; t_unblock=$(date +%s)

# 4. recovery
while [ "$(state)" != "True" ] && [ $(( $(date +%s) - t_unblock )) -lt "$RECOVER_MAX" ]; do sleep 5; done
t_rec=$(( $(date +%s) - t_unblock ))
if [ "$(state)" = "True" ]; then say "ok 4: camera connected again $t_rec s after the fault was removed"; else say "FAIL 4: not connected $RECOVER_MAX s after the fault was removed"; fail=1; fi
sleep 15; age=$(( $(date +%s) - $(stat -f %m "/usr/local/ranch/media/live/$CAM/index.m3u8" 2>/dev/null || echo 0) ))
if [ "$age" -le 10 ]; then say "ok 4b: live playlist fresh (${age} s)"; else say "FAIL 4b: live playlist age ${age} s"; fail=1; fi
outcome=$(curl -s -m 5 "$STATUS/api/remediation?since=15m&camera=$CAM" | python3 -c "import json,sys; d=json.load(sys.stdin); r=[x for x in d if x['action']=='down']; print(r[0]['outcome'], r[0]['recovered_after_s']) if r else print('none')")
say "supervisor outcome for the newest outage row: $outcome"

# 5. owners
if /usr/local/ranch/bin/camera-owners.sh | tail -1 | grep -q "^OK"; then say "ok 5: single-consumer rule holds"; else say "FAIL 5: camera-owners.sh reports violations"; fail=1; fi
say "summary: mode=$MODE detect=${t_detect}s recorder_reaction=${t_wd}s recover=${t_rec}s total=$(( $(date +%s) - t_start ))s result=$([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
