#!/bin/bash
# Who touches camera streams right now: the single-consumer rule (docs/CAMERA-ARCHITECTURE.md), measured instead of
# assumed. Prints one line per fact and exits 1 on any violation, so `make verify` fails and `make camera-owners`
# shows the culprit. Read-only: lsof on the kernel's socket/file tables and one GET of go2rtc's in-memory stream list
# (neither reaches a camera; measured 23 Oct: 20 polls of /api/streams changed no producer or consumer).
#
# Facts asserted:
#   1. go2rtc's API (1984) and RTSP (8554) listen on 127.0.0.1 only.
#   2. Every established client of :8554 is an ffmpeg in com.ranch.recorder's process group.
#   3. go2rtc reports at most two recorder consumers per stream (jpeg + hls); browser WebRTC viewers share the
#      one producer and are not camera dials, so they are listed but not capped.
#   4. No established connection to the loopback-only ports (1984, 8554) has a non-loopback peer. 8889 (WebRTC media)
#      is tailnet-reachable by design (pf allows it from the tailnet only), so its peers are expected to be remote.
#   5. Only the recorder's process group has files open under the buffer directory for writing.
set -u
GO2RTC=${GO2RTC_URL:-http://127.0.0.1:1984}
BUFFER=${RECORDER_DIR:-/usr/local/ranch/media/buffer}
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
violations=0
fail() { echo "VIOLATION: $*"; violations=$((violations + 1)); }

rec_pid=$($SUDO launchctl print system/com.ranch.recorder 2>/dev/null | awk '/^\tpid = /{print $3}')
[ -n "${rec_pid:-}" ] && echo "recorder pid $rec_pid (process group of every legitimate consumer)" || fail "com.ranch.recorder is not running"
in_recorder_group() { [ -n "${rec_pid:-}" ] && [ "$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')" = "$rec_pid" ]; }

# 1. listeners
listen=$($SUDO lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1, $2, $9}')
echo "$listen" | awk '$3 ~ /:(1984|8554|8889|5080)$/ {print "listen", $1, $3}'
bad=$(echo "$listen" | awk '$3 ~ /:(1984|8554)$/ && $3 !~ /^127\.0\.0\.1:/')
[ -n "$bad" ] && fail "go2rtc listens off loopback: $bad"

# 2 + 4. established connections on the go2rtc ports
est=$($SUDO lsof -nP -iTCP:8554 -iTCP:1984 -iTCP:8889 -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1 {print $1, $2, $9}')
while read -r cmd pid name; do
  [ -z "${name:-}" ] && continue
  peer=${name#*->}; local=${name%%->*}; lport=${local##*:}
  # 8554 (RTSP) and 1984 (API) are loopback-only by OS rule; a remote peer there is a violation. 8889 is the WebRTC
  # media port, tailnet-reachable by design, so remote peers there are expected and merely listed.
  case "$lport" in
    8554|1984) case "$peer" in 127.0.0.1:*|\[::1\]:*) ;; *) fail "non-loopback peer on loopback-only port $lport: $cmd[$pid] $name" ;; esac ;;
    8889) echo "webrtc media peer: $cmd[$pid] $name" ;;
  esac
  # the process whose peer is :8554 is the one that dialed go2rtc's RTSP; it must be a recorder ffmpeg
  case "$peer" in
    127.0.0.1:8554) if in_recorder_group "$pid"; then echo "rtsp consumer ok: $cmd[$pid] $local"; else fail "rtsp consumer outside the recorder: $cmd[$pid] $name"; fi ;;
  esac
done <<< "$est"

# 3. go2rtc consumers per stream
curl -s -m 4 "$GO2RTC/api/streams" | python3 -c '
import json,sys
d=json.load(sys.stdin); bad=0
for name,s in sorted(d.items()):
    allc=s.get("consumers") or []
    def fmt(c): return (c.get("format_name") or "")
    preload=[c for c in allc if fmt(c)=="preload"]           # go2rtc holding the session itself: not an external consumer
    webrtc=[c for c in allc if fmt(c).startswith("webrtc")]  # a browser viewer; shares the one producer, never dials the camera
    rec=[c for c in allc if c not in preload and c not in webrtc]   # the recorder rtsp consumers (jpeg + hls)
    prod=[p for p in (s.get("producers") or []) if p.get("remote_addr")]
    tag=(" +preload" if preload else "")+((" +webrtc=%d"%len(webrtc)) if webrtc else "")   # python 3.9 on the mini: no nested quotes inside f-strings
    # The recorder opens 1-2 rtsp consumers per camera: the always-on JPEG reader plus, while a viewer uses HLS, the
    # encoder. go2rtc shares one producer (one camera connection) to all of them, so this is never multiple camera
    # dials. Browser WebRTC viewers also share that producer and are unbounded, so they are listed, not capped. What
    # matters is one connected producer and that every :8554 socket is a recorder ffmpeg (the socket-ownership check).
    print(f"stream {name}: recorder_consumers={len(rec)}{tag} connected_producer={len(prod)>0}")
    if len(rec)>2: print(f"VIOLATION: {name} has {len(rec)} recorder consumers (expected <= 2: jpeg + hls)"); bad+=1
sys.exit(1 if bad else 0)' || violations=$((violations + 1))

# 5. writers under the buffer directory (shallow per camera dir; -F gives pid/command/access mode)
for d in "$BUFFER"/*/; do
  [ -d "$d" ] || continue
  $SUDO lsof -nP -F pca +d "$d" 2>/dev/null | awk '
    /^p/ {pid=substr($0,2)} /^c/ {cmd=substr($0,2)} /^a/ {if (substr($0,2) ~ /[wu]/) print pid, cmd}' | sort -u | while read -r pid cmd; do
    if in_recorder_group "$pid"; then echo "buffer writer ok: $cmd[$pid] $(basename "$d")"; else fail "buffer writer outside the recorder: $cmd[$pid] in $d"; fi
  done
done

if [ "$violations" -eq 0 ]; then echo "OK: only the recorder consumes camera streams"; exit 0; fi
echo "$violations violation(s)"; exit 1
