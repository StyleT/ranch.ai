#!/bin/bash
# Who dials the cameras, and how often (docs/CAMERA-ARCHITECTURE.md, NFR-1/3/11). Read-only: one `log show` over the
# window. A camera dial is go2rtc attaching a camera with no held producer: `[streams] start producer` (it started) or
# `WRN [rtsp] ... stream=<cam>` (it failed, logged when it gives up, ~5 s after the attach).
#
#   camera-dials.sh [--hours H] [--since 'YYYY-MM-DD HH:MM:SS'] [--until '...'] [--cam CAM] [--assert]
#
# Report: per camera and 10-min bucket, the triggers (jpeg = recorder jpeg role start, hls = live encoder start,
# webrtc = viewer offer, put = stream (re-)registration by the bridge/supervisor) and the dials (ok / fail), plus the
# most dials in any minute.
# --assert: attributes every dial to its trigger: a started dial to the nearest trigger in [t-6 s, t+1 s]; a failed
# dial to the trigger nearest t-5 s within [t-16 s, t-2 s] (DTLS failures can take ~14 s) (the attach that began it). Allowed triggers: jpeg, put,
# and any dial within 60 s of a go2rtc start (its preload). A dial attributed to hls or webrtc, or to nothing, is a
# violation of "only the recorder's jpeg role dials a camera"; each is printed and the script exits 1.
# Runs under the mini's /bin/bash 3.2 and the system log binary; parsing in python3 -I.
set -u
HOURS=1; SINCE=""; UNTIL=""; CAM=""; ASSERT=0
while [ $# -gt 0 ]; do
  case $1 in
    --hours) HOURS=$2; shift 2;;
    --since) SINCE=$2; shift 2;;
    --until) UNTIL=$2; shift 2;;
    --cam) CAM=$2; shift 2;;
    --assert) ASSERT=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$SINCE" ] || SINCE=$(date -v-"${HOURS}"H '+%Y-%m-%d %H:%M:%S')
[ -n "$UNTIL" ] || UNTIL=$(date '+%Y-%m-%d %H:%M:%S')
BRIDGE=${RANCH_BRIDGE_URL:-http://127.0.0.1:5080}
IPS=$(curl -s -m 5 "$BRIDGE/api/cameras" | /usr/bin/python3 -I -c 'import json,sys
try: print(" ".join("%s=%s" % (c["ip"], c["name"]) for c in json.load(sys.stdin)))
except Exception: pass')
PY=$(cat <<'PYEOF'
import sys, re, collections, datetime
ips = dict(kv.split("=", 1) for kv in sys.argv[1].split() if "=" in kv)
only, do_assert = sys.argv[2], sys.argv[3] == "1"
since = datetime.datetime.strptime(sys.argv[4], "%Y-%m-%d %H:%M:%S").timestamp()
ev = []  # (t, kind, cam)
starts = []
for line in sys.stdin:
    m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)", line)
    if not m:
        continue
    t = datetime.datetime.strptime(m.group(1)[:23], "%Y-%m-%d %H:%M:%S.%f").timestamp()
    if "INF [api] listen addr=" in line:
        starts.append(t); continue
    c = None; k = None
    if (m2 := re.search(r" ([a-z0-9_]+): start \(jpeg\)", line)): k, c = "jpeg", m2.group(1)
    elif (m2 := re.search(r" ([a-z0-9_]+): live encoder start", line)): k, c = "hls", m2.group(1)
    elif (m2 := re.search(r"POST /api/webrtc\?src=([a-z0-9_]+)", line)): k, c = "webrtc", m2.group(1)
    elif (m2 := re.search(r"PUT /api/streams\?name=([a-z0-9_]+)", line)): k, c = "put", m2.group(1)
    elif (m2 := re.search(r"start producer url=wyze://([\d.]+)", line)): k, c = "dial_ok", ips.get(m2.group(1), m2.group(1))
    elif (m2 := re.search(r"WRN \[rtsp\] error=.*stream=([a-z0-9_]+)", line)): k, c = "dial_fail", m2.group(1)
    if k and (not only or c == only):
        ev.append((t, k, c))
ev.sort()
TRIG = ("jpeg", "hls", "webrtc", "put")
cnt = collections.defaultdict(collections.Counter)
permin = collections.defaultdict(collections.Counter)
for t, k, c in ev:
    if t < since:
        continue
    b = datetime.datetime.fromtimestamp(t - t % 600).strftime("%H:%M")
    cnt[(c, b)][k] += 1
    if k.startswith("dial"):
        permin[c][int(t // 60)] += 1
cols = ("jpeg", "hls", "webrtc", "put", "dial_ok", "dial_fail")
print("%-17s %-5s " % ("camera", "10min") + " ".join(f"{x:>9s}" for x in cols))
for (c, b) in sorted(cnt):
    print(f"{c:17s} {b:5s} " + " ".join(f"{cnt[(c, b)][x]:9d}" for x in cols))
print("max dials/min: " + ", ".join(f"{c} {max(v.values())}" for c, v in sorted(permin.items())) if permin else "max dials/min: none")
if not do_assert:
    sys.exit(0)
viol = []
for t, k, c in ev:
    if not k.startswith("dial") or t < since:
        continue
    if any(0 <= t - s <= 60 for s in starts):
        continue  # go2rtc start: preload and every stream re-attach at once
    if k == "dial_ok":
        cands = [(abs(t - tt), kk) for tt, kk, cc in ev if cc == c and kk in TRIG and -6 <= tt - t <= 1]
    else:
        cands = [(abs((t - 5) - tt), kk) for tt, kk, cc in ev if cc == c and kk in TRIG and 2 <= t - tt <= 16]
    trig = min(cands)[1] if cands else None
    if trig not in ("jpeg", "put"):
        viol.append((t, c, k, trig or "none"))
for t, c, k, trig in viol:
    print(f"VIOLATION {datetime.datetime.fromtimestamp(t).strftime('%H:%M:%S')} {c} {k} triggered by {trig}")
print(f"assert: {len(viol)} violation(s) of the single-dialler rule")
sys.exit(1 if viol else 0)
PYEOF
)
/usr/bin/log show --start "$(date -j -v-15S -f '%Y-%m-%d %H:%M:%S' "$SINCE" '+%Y-%m-%d %H:%M:%S')" --end "$UNTIL" --style compact --predicate 'process == "logger" AND (eventMessage CONTAINS ": start (jpeg)" OR eventMessage CONTAINS ": live encoder start" OR eventMessage CONTAINS "POST /api/webrtc?src=" OR eventMessage CONTAINS "PUT /api/streams?name=" OR eventMessage CONTAINS "start producer url=" OR eventMessage CONTAINS "WRN [rtsp] error=" OR eventMessage CONTAINS "INF [api] listen addr=")' 2>/dev/null \
| /usr/bin/python3 -I -c "$PY" "$IPS" "$CAM" "$ASSERT" "$SINCE"
