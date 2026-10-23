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
RTSP="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
log() { echo "$(date -u '+%FT%TZ') $*"; }
free_gb() { df -g "$RECORDER_DIR" | awk 'NR==2{print $4}'; }
newest_jpeg_age() { local d=$1 f; f=$(ls -t "$d"/*.jpg 2>/dev/null | head -1); [ -n "$f" ] && echo $(( $(date +%s) - $(stat -f %m "$f") )) || echo 99999; }
want_live() { local m=$1; [ -f "$m" ] && [ $(( $(date +%s) - $(stat -f %m "$m") )) -lt "$RECORDER_DEMAND_TTL" ]; }

# Always-on JPEG buffer: decode keyframes only (light, real-time). Holds the go2rtc producer up so cameras never churn.
pull_jpeg() {
  local cam=$1 dir="$RECORDER_DIR/$1" errf attempt=0 t0 rc delay pipe ffpid
  mkdir -p "$dir"; errf=$(mktemp -t "recorder-jpeg-$1")
  while true; do
    if [ "$(free_gb)" -lt "$RECORDER_MIN_FREE_GB" ]; then log "$cam: free disk $(free_gb) GB < $RECORDER_MIN_FREE_GB GB, paused"; sleep 120; continue; fi
    t0=$(date +%s); log "$cam: start (jpeg)"
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 -use_wallclock_as_timestamps 1 -skip_frame nokey \
      -i "$RTSP/$cam" -map 0:v -q:v "$RECORDER_JPEG_Q" -f image2 -strftime 1 -atomic_writing 1 "$dir/%Y-%m-%dT%H-%M-%SZ.jpg" 2>&1 \
      | { last=""; while IFS= read -r l; do echo "$cam: ffmpeg: $l"; last=$l; done; printf '%s' "$last" > "$errf"; } &
    pipe=$!
    # Stall watchdog: go2rtc's wyze dial can hang with no error; re-attaching made it redial within 5 s (23 Oct).
    while kill -0 "$pipe" 2>/dev/null; do
      sleep 10
      if [ "$(newest_jpeg_age "$dir")" -ge "$RECORDER_STALL_S" ] && kill -0 "$pipe" 2>/dev/null; then
        ffpid=$(pgrep -f "ffmpeg .*-skip_frame nokey .*${RTSP}/${cam}[[:space:]]" | head -1)
        log "$cam: no frames for >= $RECORDER_STALL_S s (hung dial or dead feed), re-attaching (killing ffmpeg ${ffpid:-?})"
        [ -n "$ffpid" ] && { kill -TERM "$ffpid" 2>/dev/null; sleep 3; kill -KILL "$ffpid" 2>/dev/null; }
        break
      fi
    done
    wait "$pipe"; rc=$?
    if [ $(( $(date +%s) - t0 )) -ge 60 ]; then attempt=0; fi
    case $attempt in 0) delay=2;; 1) delay=5;; 2) delay=10;; 3|4|5|6|7|8|9) delay=30;; *) delay=60;; esac
    attempt=$((attempt + 1))
    log "$cam: rtsp ended (jpeg, exit $rc: $(cut -c1-120 < "$errf")), reconnect in $delay s"
    sleep "$delay"
  done
}

# On-demand HLS: a controller that starts one transcoder ffmpeg while the camera is watched and stops it otherwise. The
# always-on jpeg consumer keeps the producer up, so this transcoder's RTSP open succeeds at once and starting/stopping
# it never touches the camera.
pull_hls() {
  local cam=$1 live="$RECORDER_LIVE_DIR/$1" demand="$RECORDER_LIVE_DIR/$1/.demand" errf run pipe ffpid audio
  mkdir -p "$live"; errf=$(mktemp -t "recorder-hls-$1")
  if [ "$RECORDER_AUDIO" = "1" ]; then audio=(-map '0:a?' -c:a aac -ar 8000 -ac 1 -b:a 24k); else audio=(-an); fi
  while true; do
    if ! want_live "$demand"; then sleep 2; continue; fi
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
    find "$live" -type f ! -name '.demand' -delete 2>/dev/null   # leave no stale playlist once the encoder stops
    [ "$(tail -c 200 "$errf" 2>/dev/null)" ] && log "$cam: live encoder ended ($(cut -c1-120 < "$errf"))"
    sleep 1
  done
}

prune() {
  while true; do
    find "$RECORDER_DIR" -type f -name '*.jpg' -mmin +"$RECORDER_BUFFER_MIN" -delete 2>/dev/null
    find "$RECORDER_DIR" -type f -name '*.jpg.tmp' -mmin +1 -delete 2>/dev/null
    find "$RECORDER_LIVE_DIR" -type f \( -name 'seg*.m4s' -o -name '*.tmp' \) -mmin +2 -delete 2>/dev/null
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
