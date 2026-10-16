#!/bin/bash
# Seed dataset recorder (com.ranch.seed-recorder, runs as ranch). One ffmpeg per camera pulls only keyframes
# (-skip_frame nokey; Wyze sends an I-frame every 2 s) from the bridge's RTSP and writes one JPEG every
# SEED_INTERVAL seconds to SEED_DIR/<camera>/<UTC timestamp>.jpg. Each puller is restarted a minute after it
# exits, so an offline camera joins on its own when it comes back. Writing pauses while free disk is below
# SEED_MIN_FREE_GB. Measured 15 Oct: ~3 % of a core and 80–110 MB per camera.
set -u
: "${SEED_CAMERAS:?space-separated stream names}"
SEED_DIR="${SEED_DIR:-/usr/local/ranch/media/seed}"
SEED_INTERVAL="${SEED_INTERVAL:-10}"
SEED_JPEG_Q="${SEED_JPEG_Q:-4}"
SEED_MIN_FREE_GB="${SEED_MIN_FREE_GB:-40}"
RTSP="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
log() { echo "$(date -u '+%FT%TZ') $*"; }

free_gb() { df -g "$SEED_DIR" | awk 'NR==2{print $4}'; }

pull() {
  local cam=$1 dir="$SEED_DIR/$1"
  mkdir -p "$dir"
  while true; do
    if [ "$(free_gb)" -lt "$SEED_MIN_FREE_GB" ]; then
      log "$cam: free disk $(free_gb) GB < $SEED_MIN_FREE_GB GB, paused"
      sleep 600; continue
    fi
    log "$cam: start"
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 -skip_frame nokey \
      -i "$RTSP/$cam" -vf "fps=1/$SEED_INTERVAL" -q:v "$SEED_JPEG_Q" \
      -f image2 -strftime 1 "$dir/%Y-%m-%dT%H-%M-%SZ.jpg" 2>&1 | sed "s/^/$cam: ffmpeg: /"
    log "$cam: exited, retry in 60 s"
    sleep 60
  done
}

export TZ=UTC
trap 'kill 0' EXIT INT TERM
for cam in $SEED_CAMERAS; do pull "$cam" & done
wait
