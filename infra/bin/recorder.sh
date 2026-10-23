#!/bin/bash
# com.ranch.recorder — the single owner of each camera's live stream (docs/CAMERA-ARCHITECTURE.md).
#
# One ffmpeg per camera holds ONE persistent connection to go2rtc's LOCAL RTSP and writes a rolling few-minute
# JPEG buffer to RECORDER_DIR/<camera>/<UTC ts>.jpg. Keyframe-only (-skip_frame nokey; Wyze sends an I-frame
# every ~2 s) keeps CPU low (~3 %/camera, measured 15 Oct for the same pattern) and gives ~1 frame / 2 s.
#
# This is the ONLY process that consumes a live camera stream. Because its consumer never drops, go2rtc keeps
# exactly one local TUTK (or WebRTC-fallback) session per camera and never tears the producer down — which is
# what stops the reconnection churn that overloaded the cameras (go2rtc dials a camera on consumer-attach and
# drops it at zero consumers; the bridge then re-handshakes a camera whose producer count is 0). Every downstream
# consumer (sampler, detector, status) reads these buffered files; nothing else touches go2rtc or a camera.
set -u
: "${RECORDER_CAMERAS:?space-separated stream names}"
RECORDER_DIR="${RECORDER_DIR:-/usr/local/ranch/media/buffer}"
RECORDER_JPEG_Q="${RECORDER_JPEG_Q:-4}"          # ffmpeg -q:v (2=best .. 31=worst); 4 ~= the old grab quality
RECORDER_BUFFER_MIN="${RECORDER_BUFFER_MIN:-5}"  # keep this many minutes of frames per camera
RECORDER_MIN_FREE_GB="${RECORDER_MIN_FREE_GB:-20}"
RTSP="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
log() { echo "$(date -u '+%FT%TZ') $*"; }
free_gb() { df -g "$RECORDER_DIR" | awk 'NR==2{print $4}'; }

# One persistent ffmpeg per camera. ffmpeg exits only if the local RTSP drops (go2rtc restart, or the camera's
# producer genuinely dies); we wait 30 s and reconnect. We never DELETE or re-handshake a camera from here.
pull() {
  local cam=$1 dir="$RECORDER_DIR/$1" errf
  mkdir -p "$dir"; errf=$(mktemp -t "recorder-$1")
  while true; do
    if [ "$(free_gb)" -lt "$RECORDER_MIN_FREE_GB" ]; then
      log "$cam: free disk $(free_gb) GB < $RECORDER_MIN_FREE_GB GB, paused"
      sleep 120; continue
    fi
    log "$cam: start"
    # -atomic_writing: each JPEG is written as <name>.jpg.tmp and renamed into place, so a reader (the status daemon's
    # sharp/libvips, which memory-maps its input) can never open a half-written file. Without it the daemon died 16
    # times on 22-23 Oct with SIGBUS "FS pagein error" inside jpeg_read_scanlines (docs/CAMERA-ARCHITECTURE.md).
    # ffmpeg's stderr is relayed line by line; the last line and the exit status are logged once per drop so the
    # reasons (decode errors, 404 while go2rtc has no producer, timeout) are countable without the decode noise.
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 -skip_frame nokey \
      -i "$RTSP/$cam" -q:v "$RECORDER_JPEG_Q" \
      -f image2 -strftime 1 -atomic_writing 1 "$dir/%Y-%m-%dT%H-%M-%SZ.jpg" 2>&1 \
      | { last=""; while IFS= read -r l; do echo "$cam: ffmpeg: $l"; last=$l; done; printf '%s' "$last" > "$errf"; }
    rc=${PIPESTATUS[0]}
    log "$cam: rtsp ended (exit $rc: $(cut -c1-160 < "$errf")), reconnect in 30 s"
    sleep 30
  done
}

# Rolling buffer: drop frames older than RECORDER_BUFFER_MIN minutes, every minute.
prune() {
  while true; do
    find "$RECORDER_DIR" -type f -name '*.jpg' -mmin +"$RECORDER_BUFFER_MIN" -delete 2>/dev/null
    find "$RECORDER_DIR" -type f -name '*.jpg.tmp' -mmin +1 -delete 2>/dev/null   # leftovers of an ffmpeg killed mid-write
    sleep 60
  done
}

export TZ=UTC
trap 'kill 0' EXIT INT TERM
for cam in $RECORDER_CAMERAS; do pull "$cam" & done
prune &
wait
