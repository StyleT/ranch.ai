#!/bin/bash
# The recorder: the ONLY process that consumes a live camera stream (docs/CAMERA-ARCHITECTURE.md).
#
# One ffmpeg per camera holds ONE persistent connection to go2rtc's LOCAL RTSP and writes two things from it:
#   1. a rolling JPEG buffer, one frame per H.264 keyframe, <RECORDER_DIR>/<cam>/<UTC ts>.jpg (sampler, detector,
#      thumbnails read this; kept RECORDER_BUFFER_MIN minutes);
#   2. a rolling HLS stream, <RECORDER_LIVE_DIR>/<cam>/index.m3u8 + init.mp4 + seg*.m4s: video copied (no transcode),
#      audio PCM 8 kHz -> AAC, ~RECORDER_HLS_LIST x RECORDER_HLS_SEG_S seconds kept. The dashboard's live view plays
#      these files (docs/WEB-DASHBOARD.md); any number of viewers costs the camera nothing.
# Because its consumer never drops, go2rtc keeps the camera session up; that is what stops the reconnection churn that
# overloaded the cameras (go2rtc dials a camera on consumer-attach and drops it at zero consumers). Every other
# process reads these files; nothing else touches go2rtc or a camera.
set -u
: "${RECORDER_CAMERAS:?space-separated stream names}"
RECORDER_DIR="${RECORDER_DIR:-/usr/local/ranch/media/buffer}"
RECORDER_LIVE_DIR="${RECORDER_LIVE_DIR:-/usr/local/ranch/media/live}"
RECORDER_JPEG_Q="${RECORDER_JPEG_Q:-4}"          # ffmpeg -q:v (2=best .. 31=worst); 4 ~= the old grab quality
RECORDER_BUFFER_MIN="${RECORDER_BUFFER_MIN:-5}"  # keep this many minutes of frames per camera
RECORDER_MIN_FREE_GB="${RECORDER_MIN_FREE_GB:-20}"
RECORDER_HLS_SEG_S="${RECORDER_HLS_SEG_S:-1}"    # HLS segment length; latency ~= 2-3 segments
RECORDER_HLS_LIST="${RECORDER_HLS_LIST:-8}"      # segments kept in the playlist (~8 s)
RECORDER_AUDIO="${RECORDER_AUDIO:-1}"            # 1 = AAC audio in the HLS output, 0 = video only
RECORDER_TRANSCODE="${RECORDER_TRANSCODE:-1}"    # 1 = re-encode video on the Apple media engine with a fixed 1 s GOP (see below), 0 = copy the camera's H.264
RECORDER_HLS_BITRATE="${RECORDER_HLS_BITRATE:-2000k}"
RECORDER_STALL_S="${RECORDER_STALL_S:-45}"        # no playlist write for this long while ffmpeg runs = a hung dial or dead feed: re-attach
RTSP="${RTSP_BASE:-rtsp://127.0.0.1:8554}"
log() { echo "$(date -u '+%FT%TZ') $*"; }
free_gb() { df -g "$RECORDER_DIR" | awk 'NR==2{print $4}'; }

# One persistent ffmpeg per camera. ffmpeg exits only if the local RTSP drops (go2rtc restart, or the camera's
# producer genuinely dies). Reconnect: 2, 5, 10 s for a stream that was up (fast resume), then 30 s, then 60 s after
# ten short-lived attempts (a camera that is unreachable; every attempt makes go2rtc dial it, so back off). The
# counter resets after a run of at least 60 s. We never DELETE or re-handshake a camera from here.
pull() {
  local cam=$1 dir="$RECORDER_DIR/$1" live="$RECORDER_LIVE_DIR/$1" errf attempt=0 t0 run rc delay audio input graph vmap jmap pipe last_write ffpid
  mkdir -p "$dir" "$live"; errf=$(mktemp -t "recorder-$1")
  if [ "$RECORDER_AUDIO" = "1" ]; then audio=(-map '0:a?' -c:a aac -ar 8000 -ac 1 -b:a 24k); else audio=(-an); fi
  while true; do
    if [ "$(free_gb)" -lt "$RECORDER_MIN_FREE_GB" ]; then
      log "$cam: free disk $(free_gb) GB < $RECORDER_MIN_FREE_GB GB, paused"
      sleep 120; continue
    fi
    log "$cam: start"
    t0=$(date +%s); run=$t0
    # Every run gets its own init-<run>.mp4 and seg<run>-NNNNNN.m4s names and an empty directory: a re-encode restart
    # produces a new init segment, and a playlist that mixed old segments with the new init (ffmpeg's append_list) made
    # Chrome fail with DEMUXER_ERROR_COULD_NOT_PARSE on 23 Oct; reused names would also hit the browser's 60 s cache.
    find "$live" -type f -delete 2>/dev/null
    # Video: the cameras' keyframes come 2-18 s apart (measured 23 Oct), and an HLS segment can only start at a keyframe,
    # so copying the camera's H.264 gave 2-18 s segments and 20-50 s of player latency. The default therefore decodes
    # on the Apple media engine (VideoToolbox) and re-encodes with a keyframe every second (hardware too), which costs
    # less CPU than today's software keyframe decode and makes 1 s segments; RECORDER_TRANSCODE=0 restores the copy.
    # No PROGRAM-DATE-TIME: ffmpeg anchors it at muxer start and lets it drift (measured 23 Oct: 15-70 s off, even
    # negative), which would mislead hls.js's latency controller. The player measures latency from the playlist's write
    # age (x-live-age-s) plus the playhead's distance to the buffered edge instead.
    # -atomic_writing / temp_file: every JPEG, segment and playlist is written to a temporary name and renamed, so a
    # reader can never open a half-written file. Without it the status daemon died 16 times on 22-23 Oct with SIGBUS
    # "FS pagein error" inside jpeg_read_scanlines (docs/CAMERA-ARCHITECTURE.md). delete_segments keeps the disk at
    # list_size segments; each run starts a fresh playlist (see the per-run names above).
    # ffmpeg's stderr is relayed line by line; the last line and the exit status are logged once per drop.
    if [ "$RECORDER_TRANSCODE" = "1" ]; then
      # Zero-copy: decoded frames stay on the media engine for the encoder; only the 1 fps JPEG branch downloads frames.
      # Measured 23 Oct on a 1440p recording: ~0.32 CPU-s per media second and ~300 MB RSS, the same as today's
      # software keyframe-only decode; the naive CPU-frame path cost 0.58 CPU-s and 500 MB.
      input=(-use_wallclock_as_timestamps 1 -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld)
      graph=(-filter_complex "[0:v]split=2[enc][jpg];[jpg]fps=1,hwdownload,format=nv12[jpgout]")
      vmap=(-map "[enc]" -c:v h264_videotoolbox -b:v "$RECORDER_HLS_BITRATE" -maxrate "$RECORDER_HLS_BITRATE" -bufsize 4000k -g 20 -force_key_frames "expr:gte(t,n_forced*${RECORDER_HLS_SEG_S})" -realtime 1)
      jmap=(-map "[jpgout]" -q:v "$RECORDER_JPEG_Q")   # one JPEG per second from the decoded stream (was: one per camera keyframe)
    else
      input=(-use_wallclock_as_timestamps 1 -skip_frame nokey)   # -skip_frame nokey is a decoder option: it only affects the JPEG output
      graph=()
      vmap=(-map 0:v -c:v copy)
      jmap=(-map 0:v -q:v "$RECORDER_JPEG_Q")
    fi
    ffmpeg -nostdin -loglevel error -rtsp_transport tcp -timeout 10000000 "${input[@]}" \
      -i "$RTSP/$cam" "${graph[@]}" \
      "${vmap[@]}" "${audio[@]}" \
        -f hls -hls_time "$RECORDER_HLS_SEG_S" -hls_list_size "$RECORDER_HLS_LIST" -hls_segment_type fmp4 \
        -hls_fmp4_init_filename "init-$run.mp4" -hls_segment_filename "$live/seg$run-%06d.m4s" \
        -hls_flags delete_segments+temp_file+omit_endlist "$live/index.m3u8" \
      "${jmap[@]}" -f image2 -strftime 1 -atomic_writing 1 "$dir/%Y-%m-%dT%H-%M-%SZ.jpg" 2>&1 \
      | { last=""; while IFS= read -r l; do echo "$cam: ffmpeg: $l"; last=$l; done; printf '%s' "$last" > "$errf"; } &
    pipe=$!
    # Stall watchdog (23 Oct): go2rtc's wyze dial can hang with no error and no timeout, and ffmpeg then sits in the
    # RTSP handshake forever (tractor_cam: 11 min with an established socket, zero frames; four cameras at once after
    # a restart; the same state behind the 10-30 h outages). Re-attaching the consumer made go2rtc dial again and
    # connect within 5 s every time it was tried. So: no playlist write for RECORDER_STALL_S while ffmpeg runs -> kill it;
    # the reconnect loop below does the rest.
    while kill -0 "$pipe" 2>/dev/null; do
      sleep 10
      last_write=$(stat -f %m "$live/index.m3u8" 2>/dev/null || echo "$t0")
      if [ $(( $(date +%s) - last_write )) -ge "$RECORDER_STALL_S" ] && kill -0 "$pipe" 2>/dev/null; then
        ffpid=$(pgrep -f "ffmpeg .*${RTSP}/${cam}[[:space:]]" | head -1)
        log "$cam: no frames for $(( $(date +%s) - last_write )) s (hung dial or dead feed), re-attaching (killing ffmpeg ${ffpid:-?})"
        [ -n "$ffpid" ] && { kill -TERM "$ffpid" 2>/dev/null; sleep 3; kill -KILL "$ffpid" 2>/dev/null; }
        break
      fi
    done
    wait "$pipe"; rc=$?
    if [ $(( $(date +%s) - t0 )) -ge 60 ]; then attempt=0; fi
    case $attempt in 0) delay=2;; 1) delay=5;; 2) delay=10;; 3|4|5|6|7|8|9) delay=30;; *) delay=60;; esac
    attempt=$((attempt + 1))
    log "$cam: rtsp ended (exit $rc: $(cut -c1-160 < "$errf")), reconnect in $delay s (attempt $attempt)"
    sleep "$delay"
  done
}

# Rolling buffers: drop JPEGs older than RECORDER_BUFFER_MIN minutes and HLS leftovers (segments or temp files an
# ffmpeg killed mid-write left behind; a live playlist never references anything older than ~list_size x seg_s).
prune() {
  while true; do
    find "$RECORDER_DIR" -type f -name '*.jpg' -mmin +"$RECORDER_BUFFER_MIN" -delete 2>/dev/null
    find "$RECORDER_DIR" -type f -name '*.jpg.tmp' -mmin +1 -delete 2>/dev/null
    find "$RECORDER_LIVE_DIR" -type f \( -name 'seg*.m4s' -o -name '*.tmp' \) -mmin +2 -delete 2>/dev/null   # never init-*.mp4: the current one is referenced for the whole run
    sleep 60
  done
}

export TZ=UTC
# Stop = the whole process group, twice: TERM lets ffmpeg finish its current segment and playlist rewrite, KILL catches
# anything still there 3 s later. On 23 Oct two ffmpeg of a previous instance outlived a TERM-only kill 0 and kept
# writing into the buffer; camera-owners.sh flagged them.
stop_all() { trap - EXIT INT TERM; kill -TERM -- -$$ 2>/dev/null; sleep 3; kill -KILL -- -$$ 2>/dev/null; exit 0; }
trap stop_all EXIT INT TERM
# Start = no other ffmpeg may be pulling our RTSP. launchd does not always deliver TERM to the old instance before it is
# gone (23 Oct: four ffmpeg of the previous instance survived two restarts in a row), and the single-consumer rule says
# any ffmpeg on go2rtc's RTSP that is not ours is a leftover of ours. Kill them before dialing.
stale=$(pgrep -f "ffmpeg .*${RTSP}/" || true)
if [ -n "$stale" ]; then log "killing stale ffmpeg of a previous recorder instance: $(echo "$stale" | tr '\n' ' ')"; echo "$stale" | xargs kill -KILL 2>/dev/null; sleep 1; fi
for cam in $RECORDER_CAMERAS; do pull "$cam" & done
prune &
wait
