# Camera architecture: one local owner, a disk buffer, consumers read disk

*Decided 22 Oct 2026 after a fleet-wide camera-disconnect investigation. This is the contract for how anything in
the system touches a camera. Supersedes the per-frame `frame.jpeg` grab + keepalive design.*

## The rule

**Exactly one service holds a connection to each camera. Every other consumer reads that service's buffered data
and never causes a camera connection.** And: **always prefer the local path.**

```
camera --(1 persistent LOCAL TUTK/LAN stream)--> go2rtc --(1 persistent RTSP consumer)--> recorder --> rolling disk buffer
                                                                                                            |
                        sampler / detector / status  <-------- read frames from <media>/buffer/<cam>/ ------+   (never touch go2rtc or a camera)
```

- **go2rtc** is the Wyze client (native `wyze://` TUTK source, or the bridge's WebRTC fallback). It holds one
  session per camera.
- **`com.ranch.recorder`** (`infra/bin/recorder.sh`) is the single live-stream consumer: one keyframe-only ffmpeg
  per camera pulling go2rtc's **local** RTSP into a rolling few-minute JPEG buffer at `<media>/buffer/<cam>/`.
  Because this consumer never drops, go2rtc never tears the producer down.
- **The sampler** (`apps/ingest`) reads the newest buffered JPEG per camera, does change detection, and writes
  kept frames. It never calls go2rtc or a camera. **The detector and status daemon** read frames from disk.
- **The web dashboard** (`apps/web`, 22 Oct) is a buffer reader too: camera thumbnails are the newest buffered
  frame (`/api/buffer/<cam>`) and the "live" view on a camera page is an MJPEG the status daemon assembles from
  the buffer as it fills (`/api/buffer/<cam>/stream`, ~1 frame / 2 s). The dashboard has no go2rtc URL at all.

## Why (the evidence)

go2rtc 1.9.14 dials a camera when a consumer attaches and **tears the session down when the consumer count hits
zero** (`AddConsumer`/`stopProducers`). Separately the bridge re-handshakes any TUTK camera whose go2rtc producer
count is 0 (health check every 30 s, `internal/camera/manager.go:376`). The old design held no single steady
consumer — a 5 s `frame.jpeg` grab plus a flapping keepalive plus a `DELETE`-based stall watchdog — so cameras
were dialed and dropped constantly. Measured 22 Oct over 24 h: healthy cameras ~10 producer-starts (= camera
handshakes); `mops_cam` **2912**, `back_pasture` 1585, `front_porch` 430. Each start is a full TUTK P2P + DTLS
handshake. This churn is what overloaded the weak cameras and knocked them off Wi-Fi. (Removing a camera's
keepalive made it *worse*: with no steady consumer every snapshot opened a fresh handshake.) Upstream reports the
same V3 Pro + bridge failure: [mrlt8/docker-wyze-bridge #733](https://github.com/mrlt8/docker-wyze-bridge/issues/733),
[#1240](https://github.com/mrlt8/docker-wyze-bridge/issues/1240), [#1544](https://github.com/mrlt8/docker-wyze-bridge/issues/1544).

The mini's own Wi-Fi was steady through every outage (RSSI −18); the problem was our churn, not the mini or RF.

## Decisions

1. **Single camera owner.** One service connects to each camera (today: go2rtc, kept warm by the one recorder
   consumer). No other code opens a camera or go2rtc live stream.
2. **Consumers read the disk buffer, never the camera.** Sampler, detector, status, and bursts read
   `<media>/buffer/<cam>/`. A consumer request must never reach a camera.
3. **One rolling disk buffer per camera.** The recorder writes ~1 frame / 2 s (keyframe-only, low CPU), kept
   `recorder_buffer_min` minutes. That buffer is the single source for everything downstream.
4. **Prefer local; keep the WebRTC fallback.** TUTK over the LAN is the preferred primary transport (confirmed
   LAN-direct: producer `remote_addr` is the camera's `192.168.1.x`). The bridge's automatic TUTK→WebRTC fallback
   (`TUTKFallbackThreshold` / `chronicErrorThreshold`) is kept and fully supported for cameras that cannot hold
   TUTK; WebRTC is never forced and never disabled. The recorder reads go2rtc RTSP regardless of source, so the
   design is transport-agnostic.
5. **Full resolution (HD) retained.** One HD stream per camera is within the camera's budget; no SD downgrade.
6. **No forced camera re-handshake from our code.** We never `DELETE`/recreate a go2rtc stream or otherwise force
   a camera to reconnect. go2rtc and the bridge own reconnection; the recorder just reconnects its own RTSP read
   with a 30 s backoff if the local stream ends.

## 23 Oct: what the data showed, and what changed

Triage of "the live view is unreliable" and "opening a camera page kills the camera" (facts from the mini's unified
log, `/Library/Logs/DiagnosticReports`, go2rtc's API and `lsof`; local time EDT).

**The live view failed because the status daemon crashed.** 16 node crash reports in two days, every one
`EXC_BAD_ACCESS (SIGBUS)`, subtype `FS pagein error: 22`, faulting thread "libvips worker" inside
`jpeg_read_scanlines` (sharp). Each followed a `buffer stream open` by 2–17 s, or a thumbnail request. Mechanism, each
step verified: ffmpeg wrote buffer JPEGs in place; `bufferNewestPath()` returned the file being written; `sharp(path)`
let libvips memory-map it; touching a mapped page past the current end of a growing file is SIGBUS, uncatchable in JS.
The player's fixed 10 s retry then crashed the daemon again (seven crashes in three minutes while one page stayed
open), and every crash also dropped the API, the SSE and the MQTT session for ~1 s.

**The camera drops were not caused by the dashboard.** The deployed tree had no code path from the web app or the
status daemon to go2rtc or a camera. Recorder reconnects began at 09:05, 25 minutes before the first dashboard client
connected (09:29:33); mops_cam stopped answering ping at 09:26, four minutes before its page was opened; cameras nobody
opened dropped in the same minutes. Every drop was preceded by h264 decode errors and TUTK `[OOO] … reset` floods, and
redials failed with `discovery timeout` (camera off the LAN). mops_cam came back at 00:xx both nights, the camera's own
restart (the mini has no reboot job; uptime 9 days). Host facts recorded for later: the mini is on Wi-Fi (same AP as the
cameras) and receives all six streams there; load average 42 with 50 % CPU idle; six ffmpeg at 55–60 % CPU each.

**Two real violations of the single-consumer rule were found.** (1) The Wyze bridge UI on `:5080` embeds a
`<video-rtc src="/ws?src=<cam>">` player and an `/api/snapshot/<cam>` poster for all eight cameras: one visit attaches
eight go2rtc consumers, including `living_room_cam`, which nothing else holds, so it is dialed on open and dropped on
close. (2) go2rtc listened on all interfaces (`*:1984`, `*:8554`, `*:8889`): any LAN or tailnet device could attach a
consumer and make go2rtc dial a camera. Also: netprobe's `producer` flag only meant "source configured" and read true
for a camera that had been off for ten hours; it now logs `connected` (producer has a remote address).

**Changes (one provision):**
- Recorder: `-atomic_writing 1` (temp file + rename; ffmpeg 9.0.2) and one `rtsp ended (exit N: <last line>)` line per drop.
- Status daemon: every JPEG is read into memory before sharp (`apps/status/src/jpeg.ts`); a half-written file is a
  caught error (stream tick skips it, single frame falls back to the previous file or answers 503 `frame_not_ready`).
- Player: retry 10 → 20 → 40 → 60 s, reset on a successful load.
- go2rtc binds API and RTSP to 127.0.0.1; pf refuses 5080, 1984, 8554 and 8889 on every interface but lo0
  (`loopback_only_ports`). The bridge's metrics page moved to the dashboard's `/system`; its UI is reachable through
  `make tunnel`. `log.api: trace` for a day (go2rtc logs `[api] METHOD URL remote` only at trace; `debug` logged nothing
  in 3 min of netprobe polling) to derive `api.allow_paths` (follow-up):
  `make logs-last H=24 | grep -oE '\[api\] [A-Z]+ /api[^ ]*' | sort | uniq -c`.
- The rule is measured: `infra/bin/camera-owners.sh` (`make camera-owners`, and a task in `roles/services` that is
  fatal under `make verify`) asserts go2rtc listens on loopback only, every `:8554` client is an ffmpeg in the
  recorder's process group, no stream has more than one consumer, no go2rtc port has a non-loopback peer, and only the
  recorder writes under the buffer.
- Measured after the provision (23 Oct, 10:45–11:05 EDT): a 10-minute live view through the web app delivered 398
  frames, 300 thumbnail requests at 5/s all answered 200, node crash reports stayed at 25 and `com.ranch.status`
  runs at 38 (before the fix: 9 crashes in the 60 min a camera page was open), zero `UND_ERR_SOCKET` in the web log,
  daemon RSS 175 → 205 MB with one viewer. `camera-owners.sh`: go2rtc listens on 127.0.0.1 only, one consumer per
  stream, all of them recorder ffmpeg. From the laptop, 5080/1984/8554/8889 refused over the tailnet (curl exit 7)
  and unreachable over the LAN (exit 28), 5090 still 200. go2rtc `[api]` trace lines appear (49 `GET
  /api/streams?src=…` + 4 `GET /api/streams` in 2 min: netprobe, status and the owners check).
- Still open, by design: go2rtc, the bridge and the recorder's redials are the only things that reach a camera; a
  go2rtc or recorder restart re-dials all seven cameras once. Step 2 (not done): run the recorder under its own uid and
  let pf accept RTSP on loopback only from that uid, after a spike confirms pf's `user` match on macOS 27.

## 23 Oct, later: the recorder's second output is the live view

The dashboard's live view used to be the daemon re-encoding buffer JPEGs into MJPEG (≤ 1 frame/s, no audio, frozen
picture under a LIVE badge when the camera dropped). Now the recorder's single ffmpeg per camera writes, from the same
connection, a rolling HLS stream next to the JPEGs: `<media>/live/<cam>/` (fMP4, 1 s segments, audio AAC 8 kHz,
`temp_file` + rename, a fresh playlist with per-run file names on every restart). The video is decoded and re-encoded on the Apple media engine
with a keyframe every second (the cameras' own keyframes are 2–18 s apart, which made copied segments 2–18 s long and
the player 20–50 s late); the 1 fps JPEG for the sampler comes from the same decoded frames. Measured on the mini,
7 cameras: the old software keyframe-only decode cost 194–215 % CPU and a load average of 42–65; the hardware pipeline
costs 15–22 % CPU, load average 2–3, RSS ~430 MB per ffmpeg (3.0 GB for seven, up from 2.1 GB; the media-engine
buffers; encoding the live view at 720p instead of 1440p is the lever if the VLM needs the memory). The daemon serves the files, the web app plays
them. Nothing new consumes a camera stream; `camera-owners.sh` still expects exactly one RTSP client per camera.
Reconnect after a drop: 2, 5, 10 s, then 30 s, then 60 s after ten short-lived attempts (a camera that is unreachable
gets fewer dials, not more). Stopping the recorder kills its whole process group twice (TERM, then KILL after 3 s),
and a starting recorder kills any ffmpeg still pulling go2rtc's RTSP: on 23 Oct ffmpeg of a previous instance survived
three restarts in a row (launchd does not always deliver TERM before the leader is gone) and kept consuming RTSP until
`camera-owners.sh` flagged them.

## Operating notes

- A camera is "online" when its buffer has a frame newer than `RANCH_STALE_S` (30 s). Staleness means the
  recorder isn't getting frames (camera down / reconnecting) — the sampler waits, it does not touch the camera.
- Diagnose reachability at layer 3 with `netprobe` ping % and `connected` (producer has a remote address), not by
  frame count (retention deletes near-identical stall frames) and not by `producer` (true for any configured source).
  Churn health check: fleet go2rtc producer-starts/hour should be ~one per camera per restart.
- `make camera-owners` lists every consumer of every stream and fails on anything that is not the recorder.
- Config: `ranch_cameras` (the fleet), `recorder_buffer_min`, `recorder_jpeg_q`, `recorder_min_free_gb`
  (group_vars); `RANCH_BUFFER`, `RANCH_STALE_S`, `RANCH_GRAB_S` (sampler).
