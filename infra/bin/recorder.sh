#!/bin/bash
# The recorder: the ONLY process group that consumes a live camera stream (docs/CAMERA-ARCHITECTURE.md).
#
# Two ffmpeg roles per camera, both reading the SAME go2rtc RTSP (go2rtc shares one producer to both, so this is still
# one camera connection; camera-owners.sh checks every :8554 socket belongs to the recorder, not that there is exactly
# one):
#   - jpeg (always on): decode keyframes only -> rolling JPEG buffer <RECORDER_DIR>/<cam>/<UTC ts>.jpg (sampler,
#     detector, thumbnails). Because this consumer never drops, go2rtc keeps the camera session up at all times: no
#     reconnection churn, whatever the viewers do.
#   - hls (on demand): runs ONLY while a camera is being watched. Software-decodes (robust to the lossy TUTK H.264,
#     conceals corruption where the hardware decoder hard-fails), scales to RECORDER_LIVE_HEIGHT, hardware-encodes with a
#     keyframe every segment, writes <RECORDER_LIVE_DIR>/<cam>/. The daemon touches <live>/<cam>/.demand on every
#     playlist request; this starts the encoder within a couple of seconds and stops it when the marker goes stale.
#
# On-demand HLS, 23 Oct: re-encoding all seven cameras at once saturated the M2's single video-encode engine, so each
# encoder's output queue grew without bound and the picture ran minutes behind while files stayed fresh (root cause
# measured hop by hop: camera, go2rtc and the decoder are all real-time; only the encoder fell behind under 7x load).
# Watched-only, normally 0-1 encoders run and the pipeline is real-time (0 s at the recorder, ~2-3 s glass-to-glass).
set -u
: "${RECORDER_CAMERAS:?space-separated stream names}"
RECORDER_DIR="${RECORDER_DIR:-/usr/local/ranch/media/buffer}"
RECORDER_LIVE_DIR="${RECORDER_LIVE_DIR:-/usr/local/ranch/media/live}"
RECORDER_RING_DIR="${RECORDER_RING_DIR:-/usr/local/ranch/media/ring}"
# Clip ring (1 Nov, docs/CLIPS.md): the always-on ffmpeg also stream-copies the camera's H.264 into short MPEG-TS segments
# so ingest can cut a motion clip after the fact without a second camera consumer or any decode. A copied segment can only
# cut on a keyframe, so with a 2 s target every segment is exactly one GOP (2-18 s on these cameras) and its name is the
# keyframe's UTC second, the same as the JPEG's. 3 min of ring covers pre-roll 5 s + a 60 s clip + 8 s quiet + one GOP, twice.
RING_SEG_S=2
RING_MIN=3
RECORDER_JPEG_Q="${RECORDER_JPEG_Q:-4}"
RECORDER_BUFFER_MIN="${RECORDER_BUFFER_MIN:-5}"
RECORDER_MIN_FREE_GB="${RECORDER_MIN_FREE_GB:-20}"
RECORDER_HLS_SEG_S="${RECORDER_HLS_SEG_S:-1}"
RECORDER_HLS_LIST="${RECORDER_HLS_LIST:-8}"
RECORDER_AUDIO="${RECORDER_AUDIO:-1}"
RECORDER_HLS_BITRATE="${RECORDER_HLS_BITRATE:-2000k}"
RECORDER_LIVE_HEIGHT="${RECORDER_LIVE_HEIGHT:-720}"
RECORDER_DEMAND_TTL="${RECORDER_DEMAND_TTL:-20}"
RECORDER_STALL_S="${RECORDER_STALL_S:-45}"
LIVE_ATTACH_MAX_RING_S="${LIVE_ATTACH_MAX_RING_S:-15}"   # a live consumer may attach only while the ring got packets this recently
RTSP="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
log() { echo "$(date -u '+%FT%TZ') $*"; }
free_gb() { df -g "$RECORDER_DIR" | awk 'NR==2{print $4}'; }
# Packet age: the ring's stream copy writes every packet, so its newest segment's mtime says "video is arriving" whatever
# the keyframe interval (some cameras send one keyframe per 40-52 s; the one-per-keyframe JPEGs would read as a stall).
# Counted from this ffmpeg's start at the earliest ($2): a reconnect after a stall finds only old segments, and judging
# those would kill the new ffmpeg before its dial completes, a redial loop.
newest_ring_age() { local d=$1 since=$2 f m; f=$(ls -t "$d"/*.ts 2>/dev/null | head -1); m=$since; [ -n "$f" ] && m=$(stat -f %m "$f"); [ "$m" -lt "$since" ] && m=$since; echo $(( $(date +%s) - m )); }
want_live() { local m=$1; [ -f "$m" ] && [ $(( $(date +%s) - $(stat -f %m "$m") )) -lt "$RECORDER_DEMAND_TTL" ]; }
# mtime of the newest ring segment, 0 when there is none
ring_mtime() { local f; f=$(ls -t "$1"/*.ts 2>/dev/null | head -1); [ -n "$f" ] && stat -f %m "$f" || echo 0; }

# Dial discipline (docs/CAMERA-ARCHITECTURE.md, NFR-3/4): every attach to a camera with no held producer is a camera
# dial, and a camera waking from a reboot (about 4 min) must not be hammered. The first redial after any drop is within
# 15 s; consecutive failures wait 30 s, then 60 s, and stay at 60 s. A camera reappearing on the LAN (netprobe's file
# <lan>/<cam> going from empty to an address) is dialled within 15 s of that, whatever the schedule says.
RECORDER_LAN_DIR="${RECORDER_LAN_DIR:-/usr/local/ranch/var/lan}"
REDIAL_OK_S="${REDIAL_OK_S:-60}"   # a run counts as a success only after this many seconds of packets
redial_delay() { case $1 in 0|1) echo 15;; 2) echo 30;; *) echo 60;; esac; }
lan_of() { [ -f "$RECORDER_LAN_DIR/$1" ] && cat "$RECORDER_LAN_DIR/$1" 2>/dev/null || echo "?"; }
# Sleep $2 s in 5 s slices; if the camera's LAN file goes from empty to an address, cut the remaining wait to 15 s.
# A missing or unreadable file ("?") never shortens or lengthens the wait.
redial_wait() {
  local cam=$1 remaining=$2 before now
  before=$(lan_of "$cam")
  while [ "$remaining" -gt 0 ]; do
    sleep $(( remaining < 5 ? remaining : 5 )); remaining=$(( remaining - 5 ))
    now=$(lan_of "$cam")
    if [ -z "$before" ] && [ -n "$now" ] && [ "$now" != "?" ] && [ "$remaining" -gt 15 ]; then
      log "$cam: back on the LAN at $now, redialling within 15 s"; remaining=15
    fi
    before=$now
  done
}

# Always-on JPEG buffer: decode keyframes only (light, real-time). Holds the go2rtc producer up so cameras never churn.
# One JPEG per decoded keyframe (-fps_mode passthrough): image2 is a constant-frame-rate output, which padded each
# keyframe to the stream's 20 fps, ~20 full-size JPEG encodes per second per camera, nearly all copies (a 62 s replay:
# 33 keyframes, 117 JPEGs, 84 duplicates). Seven of those ran below real time, fell minutes behind, stopped reading
# go2rtc and were dropped at its 60 s read deadline, while the copies kept every file-time freshness check green.
# Without padding, a file exists only when a keyframe arrived, so every reader's file age is the picture's age.
pull_jpeg() {
  local cam=$1 dir="$RECORDER_DIR/$1" ring="$RECORDER_RING_DIR/$1" errf failures=0 t0 rc delay pipe ffpid first_pkt stalled
  mkdir -p "$dir" "$ring"; errf=$(mktemp -t "recorder-jpeg-$1")
  while true; do
    if [ "$(free_gb)" -lt "$RECORDER_MIN_FREE_GB" ]; then log "$cam: free disk $(free_gb) GB < $RECORDER_MIN_FREE_GB GB, paused"; sleep 120; continue; fi
    t0=$(date +%s); first_pkt=0; stalled=0; log "$cam: start (jpeg)"
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 -use_wallclock_as_timestamps 1 -skip_frame nokey \
      -i "$RTSP/$cam" -map 0:v -q:v "$RECORDER_JPEG_Q" -fps_mode passthrough -f image2 -strftime 1 -atomic_writing 1 "$dir/%Y-%m-%dT%H-%M-%SZ.jpg" \
      -map 0:v -c:v copy -an -f segment -segment_format mpegts -segment_time "$RING_SEG_S" -reset_timestamps 1 -strftime 1 "$ring/%Y-%m-%dT%H-%M-%SZ.ts" 2>&1 \
      | { last=""; while IFS= read -r l; do echo "$cam: ffmpeg: $l"; last=$l; done; printf '%s' "$last" > "$errf"; } &
    pipe=$!
    # Stall watchdog: go2rtc's wyze dial can hang with no error; re-attaching made it redial within 5 s (23 Oct).
    while kill -0 "$pipe" 2>/dev/null; do
      sleep 10
      # the first packet of this run (a ring segment written after it started) starts the success clock
      [ "$first_pkt" -eq 0 ] && [ "$(ring_mtime "$ring")" -ge "$t0" ] && first_pkt=$(date +%s)
      if [ "$(newest_ring_age "$ring" "$t0")" -ge "$RECORDER_STALL_S" ] && kill -0 "$pipe" 2>/dev/null; then
        ffpid=$(pgrep -f "ffmpeg .*-skip_frame nokey .*${RTSP}/${cam}[[:space:]]" | head -1)
        log "$cam: no packets for >= $RECORDER_STALL_S s (hung dial or dead feed), re-attaching (killing ffmpeg ${ffpid:-?})"
        [ -n "$ffpid" ] && { kill -TERM "$ffpid" 2>/dev/null; sleep 3; kill -KILL "$ffpid" 2>/dev/null; }
        stalled=1
        break
      fi
    done
    wait "$pipe"; rc=$?
    # success = packets flowed for REDIAL_OK_S and the run did not end in a stall; a run that merely lasted long does not count
    if [ "$stalled" -eq 0 ] && [ "$first_pkt" -gt 0 ] && [ $(( $(date +%s) - first_pkt )) -ge "$REDIAL_OK_S" ]; then failures=0; fi
    failures=$((failures + 1))
    delay=$(redial_delay "$failures")
    log "$cam: rtsp ended (jpeg, exit $rc: $(cut -c1-120 < "$errf")), reconnect in $delay s (failures $failures, lan $(lan_of "$cam" | sed 's/^$/none/'))"
    redial_wait "$cam" "$delay"
  done
}

# On-demand HLS: a controller that starts one transcoder ffmpeg while the camera is watched and stops it otherwise. It
# starts only while the jpeg role holds the producer (ring packets within LIVE_ATTACH_MAX_RING_S), so its RTSP open
# shares that session and never dials the camera (NFR-1). Without that gate a stale .demand on a camera with no session
# restarted the encoder every ~7 s, each start a dial: 69 failed dials at mops_cam in 20 min while it was waking.
# A run that writes no segment is a failure and the next start waits 15 / 30 / 60 s (the jpeg role's schedule).
pull_hls() {
  local cam=$1 live="$RECORDER_LIVE_DIR/$1" demand="$RECORDER_LIVE_DIR/$1/.demand" ring="$RECORDER_RING_DIR/$1" errf run pipe ffpid audio failures=0 gated=0 delay
  mkdir -p "$live"; errf=$(mktemp -t "recorder-hls-$1")
  if [ "$RECORDER_AUDIO" = "1" ]; then audio=(-map '0:a?' -c:a aac -ar 8000 -ac 1 -b:a 24k); else audio=(-an); fi
  while true; do
    if ! want_live "$demand"; then sleep 2; continue; fi
    if [ "$(newest_ring_age "$ring" 0)" -gt "$LIVE_ATTACH_MAX_RING_S" ]; then
      [ "$gated" -eq 0 ] && log "$cam: viewer waiting, no held session (ring stale), live encoder not started"
      gated=1; sleep 2; continue
    fi
    gated=0
    run=$(date +%s)
    find "$live" -type f ! -name '.demand' -delete 2>/dev/null   # fresh playlist; new init so a restart never mixes with old segments
    log "$cam: live encoder start"
    # software decode (conceals corruption), scale, format=yuv420p (the hardware encoder rejects the decoder's full-range
    # yuvj420p), hardware-encode with a keyframe every segment, 1 fps JPEG skipped here (the jpeg role owns the buffer).
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 -use_wallclock_as_timestamps 1 \
      -i "$RTSP/$cam" -filter_complex "[0:v]scale=-2:${RECORDER_LIVE_HEIGHT},format=yuv420p[enc]" \
      -map "[enc]" -c:v h264_videotoolbox -b:v "$RECORDER_HLS_BITRATE" -maxrate "$RECORDER_HLS_BITRATE" -bufsize 4000k -g 20 -force_key_frames "expr:gte(t,n_forced*${RECORDER_HLS_SEG_S})" -realtime 1 "${audio[@]}" \
        -f hls -hls_time "$RECORDER_HLS_SEG_S" -hls_list_size "$RECORDER_HLS_LIST" -hls_segment_type fmp4 \
        -hls_fmp4_init_filename "init-$run.mp4" -hls_segment_filename "$live/seg$run-%06d.m4s" \
        -hls_flags delete_segments+temp_file+omit_endlist "$live/index.m3u8" 2>&1 \
      | { last=""; while IFS= read -r l; do echo "$cam: hls: $l"; last=$l; done; printf '%s' "$last" > "$errf"; } &
    pipe=$!
    while kill -0 "$pipe" 2>/dev/null; do
      sleep 3
      if ! want_live "$demand"; then
        ffpid=$(pgrep -f "ffmpeg .*scale=-2:${RECORDER_LIVE_HEIGHT}.*${RTSP}/${cam}[[:space:]]" | head -1)
        log "$cam: viewer left, stopping live encoder (killing ffmpeg ${ffpid:-?})"
        [ -n "$ffpid" ] && { kill -TERM "$ffpid" 2>/dev/null; sleep 2; kill -KILL "$ffpid" 2>/dev/null; }
        break
      fi
      if [ $(( $(date +%s) - $(stat -f %m "$live/index.m3u8" 2>/dev/null || echo "$run") )) -ge "$RECORDER_STALL_S" ] && kill -0 "$pipe" 2>/dev/null; then
        ffpid=$(pgrep -f "ffmpeg .*scale=-2:${RECORDER_LIVE_HEIGHT}.*${RTSP}/${cam}[[:space:]]" | head -1)
        log "$cam: live encoder wrote no segment for >= $RECORDER_STALL_S s, restarting (killing ffmpeg ${ffpid:-?})"
        [ -n "$ffpid" ] && { kill -TERM "$ffpid" 2>/dev/null; sleep 2; kill -KILL "$ffpid" 2>/dev/null; }
        break
      fi
    done
    wait "$pipe"
    # a run that wrote a segment resets the schedule; one that wrote none (a failed or hung attach) backs off
    if ls "$live"/seg"$run"-*.m4s >/dev/null 2>&1; then failures=0; else failures=$((failures + 1)); fi
    find "$live" -type f ! -name '.demand' -delete 2>/dev/null   # leave no stale playlist once the encoder stops
    [ "$(tail -c 200 "$errf" 2>/dev/null)" ] && log "$cam: live encoder ended ($(cut -c1-120 < "$errf"))"
    if [ "$failures" -gt 0 ]; then
      delay=$(redial_delay "$failures"); log "$cam: live encoder wrote nothing, next start in $delay s (failures $failures)"; sleep "$delay"
    else
      sleep 1
    fi
  done
}

prune() {
  while true; do
    find "$RECORDER_DIR" -type f -name '*.jpg' -mmin +"$RECORDER_BUFFER_MIN" -delete 2>/dev/null
    find "$RECORDER_DIR" -type f -name '*.jpg.tmp' -mmin +1 -delete 2>/dev/null
    find "$RECORDER_LIVE_DIR" -type f \( -name 'seg*.m4s' -o -name '*.tmp' \) -mmin +2 -delete 2>/dev/null
    find "$RECORDER_RING_DIR" -type f -name '*.ts' -mmin +"$RING_MIN" -delete 2>/dev/null
    sleep 60
  done
}

export TZ=UTC
stop_all() { trap - EXIT INT TERM; kill -TERM -- -$$ 2>/dev/null; sleep 3; kill -KILL -- -$$ 2>/dev/null; exit 0; }
trap stop_all EXIT INT TERM
stale=$(pgrep -f "ffmpeg .*${RTSP}/" || true)
if [ -n "$stale" ]; then log "killing stale ffmpeg of a previous recorder instance: $(echo "$stale" | tr '\n' ' ')"; echo "$stale" | xargs kill -KILL 2>/dev/null; sleep 1; fi
for cam in $RECORDER_CAMERAS; do pull_jpeg "$cam" & pull_hls "$cam" & done
prune &
wait
