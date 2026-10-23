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

- **go2rtc** is the Wyze client (native `wyze://` TUTK source, or the bridge's WebRTC fallback). It holds exactly one
  session (one producer) per camera and multiplexes it to every consumer.
- **`com.ranch.recorder`** (`infra/bin/recorder.sh`) runs two ffmpeg roles per camera, both reading go2rtc's **local**
  RTSP (so both share the one producer): an always-on keyframe-only `pull_jpeg` into a rolling few-minute JPEG buffer
  at `<media>/buffer/<cam>/`, and an on-demand `pull_hls` that transcodes to fMP4 HLS at `<media>/live/<cam>/` only
  while a viewer is watching (a fresh `.demand` marker). Because the JPEG pull never drops, go2rtc never tears the
  producer down, so the HLS encoder and browser WebRTC viewers attach to a producer that is already held.
- **The sampler** (`apps/ingest`) reads the newest buffered JPEG per camera, does change detection, and writes
  kept frames. It never calls go2rtc or a camera. **The detector and status daemon** read frames from disk.
- **The web dashboard** (`apps/web`) live view is the one browser-facing go2rtc consumer: **WebRTC/WHEP** is the
  primary transport (sub-second, native H.264, no transcode — the web app proxies the SDP to go2rtc on loopback and
  the media flows browser↔go2rtc on the tailnet), with the recorder's on-demand HLS as the fallback. Both share the
  producer the JPEG pull holds, so a viewer attaching or detaching never makes go2rtc dial the camera. Camera
  thumbnails remain the newest buffered frame (`/api/buffer/<cam>`).

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
- go2rtc binds API and RTSP to 127.0.0.1; pf refuses 5080, 1984 and 8554 on every interface but lo0
  (`loopback_only_ports`). The WebRTC media port **8889 is the exception: tailnet-only** (its own pf section accepts
  TCP+UDP from Tailscale clients, refuses it elsewhere), because the browser consumes the camera over WebRTC directly;
  go2rtc advertises the mini's tailnet address as its only ICE candidate and the signalling is proxied through the web
  app on loopback. The bridge's metrics page moved to the dashboard's `/system`; its UI is reachable through
  `make tunnel`. `log.api: trace` for a day (go2rtc logs `[api] METHOD URL remote` only at trace; `debug` logged nothing
  in 3 min of netprobe polling) to derive `api.allow_paths` (follow-up):
  `make logs-last H=24 | grep -oE '\[api\] [A-Z]+ /api[^ ]*' | sort | uniq -c`.
- The rule is measured: `infra/bin/camera-owners.sh` (`make camera-owners`, and a task in `roles/services` that is
  fatal under `make verify`) asserts go2rtc's API and RTSP listen on loopback only, every `:8554` client is an ffmpeg
  in the recorder's process group, each stream has at most two recorder consumers (jpeg + hls — browser WebRTC viewers
  share the producer and are listed, not capped), no connection to a loopback-only port (8554, 1984) has a non-loopback
  peer (8889 is tailnet-reachable by design), and only the recorder writes under the buffer.
- Measured after the provision (23 Oct, 10:45–11:05 EDT): a 10-minute live view through the web app delivered 398
  frames, 300 thumbnail requests at 5/s all answered 200, node crash reports stayed at 25 and `com.ranch.status`
  runs at 38 (before the fix: 9 crashes in the 60 min a camera page was open), zero `UND_ERR_SOCKET` in the web log,
  daemon RSS 175 → 205 MB with one viewer. `camera-owners.sh`: go2rtc listens on 127.0.0.1 only, one consumer per
  stream, all of them recorder ffmpeg. From the laptop, 5080/1984/8554 refused over the tailnet (curl exit 7)
  and unreachable over the LAN (exit 28), 5090 still 200 (this measurement predates WebRTC; 8889 was refused then and
  is now tailnet-only by design — see above). go2rtc `[api]` trace lines appear (49 `GET
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

## 23 Oct, night: availability is measured, the bridge's blind fallback is off, go2rtc preload on trial

- **Availability from facts.** netprobe writes every sample (15 s per camera: go2rtc session held, ping, consumers)
  to SQLite `camera_probe` (7 days kept). The daemon derives `connected` and a `state` per camera for `/api/status`
  (`connected` = frames flowing to disk within 10 s, `degraded` = session up but no frames, `down` = no session,
  `unknown` = no probe yet) and `/api/availability` (24 h percentage, outages with p50/p90/longest, `down_since`,
  15-min buckets). The camera page shows the strip and the numbers; `/system` shows the fleet table. These are the
  before/after numbers for the supervisor (baseline, 23 Oct 24 h: 10–92 % per camera, see the plan).
- **Bridge fallback off.** `TUTK_FALLBACK_THRESHOLD=0`: Wyze's cloud answers "camera does not use WebRTC streaming" for
  this fleet, and the bridge's health check counts a configured-but-dead producer as alive anyway (`len(Producers) > 0`,
  `internal/go2rtcmgr/apiclient.go`). Reported upstream (docs/upstream). The bridge's per-camera `state` on `/system`
  is bridge-reported; trust netprobe's `connected` next to it.
- **go2rtc `preload` trial: not viable as deployed.** `go2rtc_preload_cameras: [donkey_cam]` attached go2rtc's own
  consumer at start (14:22:15), but the bridge registers every stream with DELETE + PUT 26 s later (14:22:41,
  `connecting camera to go2rtc`), which recreates the stream object and drops the preload consumer: `/api/preload`
  still lists it, the stream's consumers show only the recorder's `rtsp`. Preload would have to be re-applied after
  every bridge (re)start, and it also cannot cure a hung dial (donkey_cam hung with the preload "attached"). Left in
  the config until the next go2rtc change (allow_paths), then removed; the watchdog below is the fix that worked.

## 23 Oct, night: the long outages are hung dials, and a watchdog cures them

After the evening restarts four cameras (tractor, wash_stall, back_pasture, donkey) sat "down" for 11+ minutes with
these facts: one `start producer` each, no `stop producer`, no go2rtc error, one recorder attempt, the camera
answering ping 100 %, the recorder's ffmpeg alive with an **established RTSP socket to go2rtc**, go2rtc's producer with
**no remote address and zero consumers**. That is a wyze dial hung inside go2rtc with no timeout, and ffmpeg blocked in
the RTSP handshake behind it: no error ever fires, so the reconnect loop never runs. The same shape (3 producer starts
in 24 h, 10 % availability) was tractor_cam's day. Experiment: SIGTERM the stuck ffmpeg; the recorder re-attached 2 s
later and go2rtc connected the camera **within 5 s**, four cameras out of four.

Fix (in the recorder, no new consumer, no go2rtc API call): a stall watchdog. While ffmpeg runs, if the camera's HLS
playlist has not been written for `RECORDER_STALL_S` (45 s), kill that ffmpeg; the reconnect loop re-attaches and
go2rtc dials again. This is the supervisor plan's "rung 1", placed where the fact is cheapest to see. The supervisor
keeps the escalations (camera reboot via the Wyze cloud, go2rtc restart) for the cases the watchdog does not cure
(e.g. mops_cam: `discovery timeout` while the camera does not answer ping).

## 23 Oct, night: the camera supervisor (`com.ranch.camsup`, apps/camsup)

Reads facts only (netprobe's retained snapshot, the recorder's playlist age); never opens a stream, never calls go2rtc's
API. Every decision is a row in SQLite `remediation` with its outcome (`/api/remediation`; camera page and `/system`
show the ledger; the home page alerts on actions in flight), so the post can show what each rung recovered.

What "connected" means from here on: **frames are arriving** (the recorder's playlist for the camera was written in the
last 15 s) or go2rtc holds a session. Frames are the ground truth because go2rtc's stream list can lie: when the bridge
re-registers a stream (DELETE + PUT, at every bridge start) the recorder's ffmpeg keeps consuming the orphaned old
stream object while the new one shows no producer and no consumers (23 Oct, back_yard and tractor: playlist age 1 s,
`consumers: []`, netprobe "down"). That orphan also holds a camera session the new object will duplicate on the next
attach, hence rung 1 below. netprobe records both (`connected`, `session_visible`, `frames_fresh`).

| rung | where | condition | action | limits |
|---|---|---|---|---|
| 1 | recorder watchdog | no playlist write for 45 s while ffmpeg runs (hung dial, dead feed) | kill that ffmpeg, re-attach | every 45 s |
| 1 | supervisor | frames flowing but go2rtc shows no consumer for two ticks (orphaned stream object) | re-attach that ffmpeg (`pkill` by camera); never dry-run gated, it only restarts our own process | 1 per camera per 2 min |
| 2 | supervisor | down ≥ `camsup_reboot_after_s` (600) and the camera answers ping (≥ 50 % of the last 8 probes) | camera reboot through the Wyze cloud: MQTT `wyzebridge/<cam>/power/set` = `restart` (the bridge runs `RunAction(restart)`) | 1 per camera per 30 min, 2 per hour fleet-wide |
| 3 | supervisor | ≥ 3 cameras down ≥ 900 s after a reboot each | `launchctl kickstart -k system/com.ranch.go2rtc` (every camera redials once) | 1 per hour |
| 4 | supervisor | down ≥ 600 s and not answering ping | ledger row + alert only: the camera is off the network, nothing on the mini can help | once per outage |

Rows other than the outage note are judged `not_recovered` after 10 min without recovery; recovery closes every open
row for the camera with the seconds it took. `camsup_dry_run: true` (the default for the first day) records decisions
without acting; the ladder itself is a pure module with tests (`apps/camsup/src/ladder.ts`).

**Proof: `make e2e-chaos [CAM=back_yard_cam] [DURATION=90] [MODE=stop|udp]`** (`infra/bin/e2e-chaos.sh`, on the
mini, software only). `stop` (default): SIGSTOP the camera's ffmpeg, so frames stop at once, the symptom the rest of
the system sees for a hung dial or a dead feed. Asserts from logs and APIs: netprobe reports the camera not connected
within 60 s; the recorder watchdog re-attaches within 90 s (a stopped process only dies from the watchdog's KILL); the
supervisor writes the rung-0 row; after the fault is removed the camera is connected within 120 s and the playlist is
fresh; `camera-owners.sh` still OK. `udp`: a pf rule in the child anchor `com.ranch/chaos` drops UDP from the camera's
IP. Measured 23 Oct: the drop counter grows for ~40 s (6,812 packets) and then stops while frames keep flowing and
go2rtc still shows the LAN address: the TUTK session relays around a LAN block, so `udp` does not reproduce a dead
session and only reports timings. (First runs also found the chaos anchor was never evaluated: a child anchor must be
named by its parent, hence `anchor "chaos"` in the managed ruleset.)

Measured 23 Oct 19:35 UTC, `make e2e-chaos CAM=back_yard_cam DURATION=90 MODE=stop`: not-connected reported after
21 s, recorder watchdog re-attached at 54 s, supervisor rung-0 row written, camera connected again 0 s after the fault
window (the watchdog had already replaced the stopped ffmpeg), playlist fresh, owners OK: **PASS**. The supervisor's
ledger row closed as `recovered` after 30 s. The `udp` experiment the same evening: 95 s to detection and no recorder
reaction because frames never stopped (TUTK relayed around the LAN block after ~40 s); recovery 26 s after the rule
was removed.

## 23 Oct, late: the live view froze; root cause and the on-demand rewrite

The milestone-1 live view (re-encode every camera to HLS with 1 s keyframes) looked frozen and ran minutes behind while
the files stayed fresh. Root cause, measured hop by hop (burned-in camera clock vs file write time, all under the live
load): the camera scene reaches go2rtc in real-time (0-1 s); the H.264 decoder, hardware or software, keeps real-time
(24 of 25 frames distinct); only the **hardware H.264 encoder** falls behind. Seven 1440p streams re-encoded at once on
the M2's single video-encode engine ran the pipeline at ~0.15-0.44x real-time, so each encoder's output queue grew
without bound (16 s, then 100 s a minute later, then minutes). The three "live" badges never caught it because they
timed the playlist *file*, not the *picture*.

Fix: **transcode on demand, two ffmpeg roles per camera** (both read the same go2rtc RTSP; go2rtc shares one producer,
so this is still one camera connection and `camera-owners.sh` allows up to two recorder consumers):
- **jpeg (always on)**: decode keyframes only -> the rolling JPEG buffer. Light, real-time, and it holds the go2rtc
  producer up at all times, so starting or stopping the live encoder never re-dials the camera.
- **hls (only while watched)**: software-decode (conceals the lossy TUTK corruption where the hardware decoder
  hard-fails), scale to 720p, `format=yuv420p` (the hardware encoder rejects the decoder's full-range yuvj420p),
  hardware-encode with a keyframe every segment. The daemon touches `<live>/<cam>/.demand` on every playlist request;
  the recorder runs the encoder while that marker is fresh and stops it otherwise.

Normally zero or one encoder runs, so the pipeline is real-time: measured 0 s at the recorder output, **~4 s
glass-to-glass** in the browser over HLS. "connected" is now the JPEG buffer's freshness (always written), not the
on-demand playlist. The ~4 s is the standard-HLS floor: the protocol's hold-back is 3x the target duration (>= 3 s)
plus a segment, independent of hls.js tuning.

**WebRTC is the primary transport now (23 Oct), HLS the fallback.** The browser consumes the camera over go2rtc's
WHEP: native H.264, no transcode, measured sub-second end-to-end through the dashboard (`transport=webrtc`,
`mode=live`, 2560×1440, picture advancing). The web app proxies the SDP offer to go2rtc on loopback
(`/api/ui/webrtc/<cam>` → `bff/webrtc.ts`) and returns the answer; go2rtc advertises the mini's tailnet address as its
only ICE candidate (`filters.candidates: []`, no STUN) so the media flows browser↔go2rtc directly on the tailnet
(8889, tailnet-only via pf). A WebRTC consumer shares the producer the recorder's JPEG pull already holds, so it adds
no camera connection — verified by `camera-owners.sh` with a live viewer (`recorder_consumers=1 +webrtc=N`, no
violation). The StreamPlayer tries WebRTC first and falls back to the on-demand HLS if it does not connect within 6 s,
so the ~4 s HLS path above is still the safety net.

## Operating notes

- A camera is "online" when its buffer has a frame newer than `RANCH_STALE_S` (30 s). Staleness means the
  recorder isn't getting frames (camera down / reconnecting) — the sampler waits, it does not touch the camera.
- Diagnose reachability at layer 3 with `netprobe` ping % and `connected` (producer has a remote address), not by
  frame count (retention deletes near-identical stall frames) and not by `producer` (true for any configured source).
  Churn health check: fleet go2rtc producer-starts/hour should be ~one per camera per restart.
- `make camera-owners` lists every consumer of every stream and fails on anything that is not the recorder.
- Config: `ranch_cameras` (the fleet), `recorder_buffer_min`, `recorder_jpeg_q`, `recorder_min_free_gb`
  (group_vars); `RANCH_BUFFER`, `RANCH_STALE_S`, `RANCH_GRAB_S` (sampler).
