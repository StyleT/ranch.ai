# Camera inventory

*Taken from the Wyze app "Firmware Update" screen on 14 Oct 2026, 19:14. Model is inferred from the firmware
line: 4.36.x = Cam v3 (`HL_CAM3`), 4.52.x = Cam v4 (`HL_CAM4`), 4.58.x = Cam v3 Pro (`HL_CAM3P`).*

| Camera (Wyze name) | Stream name | Model | Firmware | LAN IP | 14 Oct 19:43 | What the frame shows | In scope |
|---|---|---|---|---|---|---|---|
| Back Yard Cam | `back_yard_cam` | Cam v4 | 4.52.17.26 | 192.168.1.204 | streaming 2560×1440 @ 20 fps | gravel parking, two cars, shed, lawn, fence line at right | person / vehicle only |
| Wash Stall | `wash_stall` | Cam v4 | 4.52.17.26 | 192.168.1.149 | streaming 2560×1440 @ 15 fps | barn interior, rubber mats, tools (IR) | horse down / person, when a horse is in |
| Donkey Cam | `donkey_cam` | Cam v4 | 4.52.17.26 | 192.168.1.126 | streaming 2560×1440 @ 15 fps | stall / shelter interior from above, hose, bedding, feed area (IR) | yes (posture, trough) |
| Mops Cam | `mops_cam` | Cam v3 Pro | 4.58.17.21 | 192.168.1.233 | streaming 2560×1440 @ 15 fps | stall interior, rails, rope, hay net; very dark IR | yes, but night IR is poor |
| Front Porch Cam | `front_porch_cam` | Cam v3 | 4.36.17.21 | 192.168.1.105 | streaming 1920×1080 @ 15 fps | **paddock with metal gate, fence line, two animals at a hay feeder** | yes: gate_open, horse count |
| Living Room Cam | `living_room_cam` | Cam v4 | 4.52.9.3415 | 192.168.1.109 | **offline** (no ARP entry) | house interior | no |
| Tractor Cam | `tractor_cam` | Cam v4 | 4.52.17.26 | 192.168.1.110 | **offline** (no ARP entry) | TBD | ? |
| Back Pasture Cam | `back_pasture_cam` | Cam v4 | 4.52.17.26 | 192.168.1.124 | **offline** (no ARP entry) | TBD, presumably the back pasture | yes |

The three cameras the app listed as "status unknown" are the three with no ARP entry on the LAN from the mini:
they are powered off or off Wi-Fi, not a bridge problem. The bridge logs `connect failed: discovery timeout`
for them and go2rtc answers 404 on their RTSP paths until they come back. Tractor Cam and Back Pasture Cam need
power / Wi-Fi before the 48 h seed recording; Living Room Cam is not a ranch camera and can stay off.

Frame descriptions are from one night (IR) frame each; Vlad to confirm the "In scope" column. The event
classes in `docs/PLAN.md` §4.4 need one pasture view (horse count, horse down), one gate view and one trough
view. Front Porch Cam already gives the gate and a count view; Back Pasture Cam is expected to be the main
pasture view once it is back.

**Bridge measured 14 Oct, 5 cameras attached, no consumers:** wyze-bridge 25 MB RSS, go2rtc 27 MB, mosquitto
4 MB, CPU idle, load 1.44, 91 % memory free. All five cameras came up over TUTK on the LAN, including the v4s on
4.52.17.26, so the WebRTC fallback was not needed (`protocol: tutk` in the log). Streams: `rtsp://ranch-ai:8554/<stream name>`;
one JPEG: `http://ranch-ai:1984/api/frame.jpeg?src=<stream name>`; bridge UI on port 5080. All of these are
open to the LAN and the tailnet with no auth (Phase 1 trade-off; add `STREAM_AUTH` before anything else joins the LAN).

Eight cameras total: six Cam v4, one Cam v3 Pro, one Cam v3. No Battery Cam Pro, no Floodlight Pro, no
OG, no Pan, so nothing needs the Gwell sidecar.

## Bridge decision (14 Oct 2026)

**IDisposable/docker-wyze-bridge** (the Go rewrite on top of go2rtc), chosen by Vlad. Reasons that hold for
this inventory:

- Cam v4 firmware from early 2025 onward disables TUTK. The fork (4.5.0+) retries TUTK five times and then
  promotes the camera to WebRTC for the session; `MODEL_OVERRIDES=HL_CAM4:is_webrtc=true` skips the retries.
  Our v4s are on 4.52.17.26, newer than anything in the upstream bug threads, so plan for the WebRTC path.
- Cam v3 Pro (`HL_CAM3P`) and Cam v3 (`HL_CAM3`) stay on TUTK. The upstream breakage reports for v3 were on
  4.36.13 and 4.36.14 and were traced to TUTK relay timeouts; our v3 is on 4.36.17.21. Running natively on
  the mini puts the bridge on the camera LAN with no Docker NAT, which was the workaround that fixed most of
  those reports.
- Pure Go, no cgo, no Python. `go.mod` pulls only paho MQTT, zerolog, yaml and a sunrise library. The bridge
  spawns go2rtc as a managed sidecar and looks for it at `/usr/local/bin/go2rtc`, `/usr/bin/go2rtc`, then
  `PATH`. The fork's DEVELOPER.md documents the Apple Silicon path: `go build ./cmd/wyze-bridge` plus the
  `go2rtc_darwin_arm64` release binary (pinned at 1.9.14 in its Dockerfile). ffmpeg (already in the
  Brewfile) is used for JPEG snapshots.
- Config is environment variables only; state and the generated `go2rtc.yaml` go in `STATE_DIR`. Required:
  `WYZE_EMAIL`, `WYZE_PASSWORD`, `WYZE_API_ID`, `WYZE_API_KEY` (`WYZE_TOTP_KEY` if 2FA). These live on the mini
  in `~/.config/ranch/wyze.env`, mode 600, never in the repo.
- Ports: RTSP 8554, HLS 8888, WebRTC 8889 and 8189/udp, go2rtc API 1984, bridge web UI 5080. Streams are
  `rtsp://ranch-ai:8554/<camera_name>` with spaces replaced by underscores (`back_pasture_cam`).

The mini is on the ranch LAN at 192.168.1.173 (router 192.168.1.1). The cameras must be on the same L2
network for TUTK LAN mode and for WebRTC ICE to go direct.

## Still needed from Vlad

1. ~~Wyze Developer API ID and key~~ done 14 Oct (`~/.config/ranch/wyze.env`, mode 600, password stored as `md5:` hash).
2. ~~Confirm the "In scope" column~~ 15 Oct: all cameras except Living Room are in scope. Trough camera TBD once
   Back Pasture and Tractor are back and their views are known.
3. Power / Wi-Fi on Tractor Cam and Back Pasture Cam (Vlad, later; the bridge picks them up automatically).

## Incident, 15–16 Oct: five streams dead for 12 h while the bridge reported "streaming"

At 23:24 ET on 15 Oct the TUTK sessions of all five attached cameras (Back Yard, Wash Stall, Donkey, Mops, Front
Porch) stopped delivering, within the same second. Cause on the camera or Wi-Fi side unknown; the bridge logged
nothing, `error_count` stayed 0 and `/api/cameras` kept saying `streaming` until the bridge was restarted at 12:11 ET
on 16 Oct. Meanwhile go2rtc kept each dead producer alive and every new consumer attached to it and hung: the seed
recorder's ffmpeg timed out and reconnected once a minute, the sampler's `frame.jpeg` grabs timed out every
backoff, and by noon each stream had 624 leaked consumers and the two newly powered cameras were the only ones
delivering. The status page was right the whole time (five offline, two online); the stale-page fix from the
morning was a separate, real, bug.

Recovery: `sudo launchctl kickstart -k system/com.ranch.wyze-bridge`; all eight cameras re-attached in 60 s.

Fix: a stall watchdog in `apps/ingest`. A camera with no successful grab for 180 s gets its go2rtc stream deleted
and re-created from the bridge's `go2rtc.yaml` (`DELETE /api/streams?src=<cam>` then `PUT /api/streams?name=<cam>&src=<wyze://…>`),
at most once per 5 min. That drops the dead producer and the leaked consumers for that camera only; the
others keep streaming. Reset counts are in `ranch/status/ingest` (`resets`) and on the status page. A camera
that is really off just gets a fresh idle stream.

Lesson for the plan: the bridge's camera `state` is the state of its own bookkeeping, not of the video. The
only liveness signal worth using is "a frame arrived recently", which is what the status page and the
watchdog use.

Live test, 16 Oct 12:34–12:55 ET: deleting the Wash Stall stream by hand was repaired by the bridge's HealthCheck
in ~10 s (it reconnects a camera whose stream has 0 producers; it never notices a producer that exists but sends
nothing, which is the failure above). Front Porch (the V3) stalled again at 12:31 ET on its own; the watchdog
fired at 12:48:55, the bridge logged "stream lost, will retry" 21 s later and "connected successfully", and the
camera still produced nothing: it answers ping but TUTK discovery times out, so this one is wedged on the camera
side and needs a power cycle. Two bugs found and fixed in the watchdog during the test: template-string escaping
ate the `\s` in the YAML lookup, and the bridge rewrites `go2rtc.yaml` on reconnect (mtime moved), so the
lookup can race it; the reset now deletes, waits up to 12 s for the bridge to re-add, and only then PUTs its own
copy.

Afternoon, 16 Oct: Wash Stall stalled again at 12:51 ET and most cameras dropped ICMP at the same time while the
router answered in 2 ms and the mini's own 5 GHz link was clean (-18 dBm, ~30 % channel busy, 10 Mbit/s in). The
cameras are 2.4 GHz only and the seed recorder plus the sampler kept seven HD streams open continuously, so the
working theory is 2.4 GHz airtime exhaustion at the camera end, with the go2rtc dead-producer bug turning each
dropout into a permanent one. Seed recorder stopped (16 h of data is enough). Next: measure per-camera signal in
the Wyze app, and sample from the SD sub-stream.

## Evidence pass, 16 Oct evening (what the logs prove, and what they do not)

Per-camera gap timeline from the `frames` table (gaps > 60 s) against the bridge log:

- **17:27:49 ET: go2rtc exited (`exit status 2`).** All seven cameras' frames stop in that second and stay
  stopped for 13,000 s. The bridge's health check logged `dial tcp 127.0.0.1:1984: connection refused` every
  30 s, 431 times, and never restarted its child. Recovery at 21:03 ET is my provision restarting the bridge.
  The seconds before the crash show `dtls: client handshake failed: context deadline exceeded` and discovery
  timeouts; the panic text itself was never captured. **Proven: the long outage was a go2rtc crash with no
  supervision.** Fixed structurally (go2rtc under launchd, own log). Not proven: why it crashed.
- **The 60–400 s gaps before and after** (dozens per hour, often several cameras within the same second,
  "empty" grab results at ~200 per 30 min) are not explained by any line in the old logs: go2rtc ran at `warn`,
  the bridge logged nothing per gap. Three hypotheses, all open: 2.4 GHz loss at the cameras; TUTK reconnect
  churn because every one-shot `frame.jpeg` grab starts and stops a producer (go2rtc debug now shows
  `start producer` / `stop producer` every few seconds per camera and `[OOO] ... reset` packet-order resets by
  the hundreds); go2rtc/wyze-source instability. **Instrumentation added to decide it:** go2rtc at `streams:
  debug` in its own rotated log, `com.ranch.netprobe` (per-camera producer/consumer state, ping, mini Wi-Fi
  RSSI/noise/rate every 15 s, retained on `ranch/status/netprobe`), and the sampler now logs gap edges
  (`grab failing` / `grab recovered` with error class and duration).
- A first experiment with a no-decode persistent RTSP consumer to keep one producer alive raced with the
  restarts of that same provision and is void; repeat it when the logs are quiet.

## Analysis, 19 Oct: two days of probe, sampler and go2rtc data (17 Oct 02:00Z → 19 Oct 23:59Z)

**Scale of the problem (frames table, gaps > 60 s):**

| Camera | gaps | time dark | longest gap | frames/day (target 8,640) |
|---|---|---|---|---|
| back_yard_cam | 152 | 9 % | 1.3 h | 3,500–4,100 |
| front_porch_cam | 368 | 27 % | 1.1 h | 2,800–4,400 |
| wash_stall | 631 | 30 % | 1.2 h | 2,100–2,900 |
| donkey_cam | 480 | 31 % | 1.4 h | 1,700–3,000 |
| tractor_cam | 584 | 37 % | 5.4 h | 1,300–2,800 |
| back_pasture_cam | 742 | 47 % | 5.4 h | 1,200–2,400 |
| mops_cam | 118 | 71 % | 24.1 h | 650 → 2 |

**What each source says:**

- *Sampler edges:* 58,808 lines. Failure class is "empty" (go2rtc answered 200 with no frame) in 90 % of
  episodes, "timeout" in 10 %, "unreachable" only during the three go2rtc crashes. Episodes are short and
  constant: back_yard_cam recovered 5,367 times in two days, one failure every ~30 s even on the best camera.
  The watchdog reset streams 1,129 times (553 of them mops_cam).
- *Probe (107,493 lines):* ICMP success 34–59 % on the v4s, 74 % on the v3 (front porch), **5 % on mops_cam**;
  median RTT of answered pings 400–800 ms, p95 ~1.9 s, on a LAN. Slightly better at night (04–10Z) than by day.
  go2rtc held a producer object for every camera 99 % of the time, so "producer present" is not a liveness
  signal. The mini's own 5 GHz link never moved: RSSI −18 ±3 dBm, tx 1200 Mbit/s, over 3,642 samples. **The loss
  is on the cameras' 2.4 GHz side; the mini is not the bottleneck.**
- *go2rtc:* 7,829 `discovery timeout` and 1,623 `dtls handshake` failures per day. **Three panics**, identical
  trace, `pion/dtls (*Conn).Write` on a nil connection inside `tutk/dtls.(*DTLSConn).AVClientStart.func1`
  seconds after a DTLS handshake timeout (18 Oct 02:13, 15:41; 19 Oct 19:18). launchd restarted it each time
  within seconds; this is almost certainly the 16 Oct `exit status 2` too. Draft report: `docs/upstream/`.
  1.9.14 (Jan 2026) is the newest release and the first with the native Wyze source, so there is no fix to
  upgrade to.
- *Bridge:* no camera-level signal beyond "stream lost"/"connected" around our own resets.

**The decisive comparison.** The sampler's one-shot `frame.jpeg` grab starts a fresh TUTK session each time
(LAN discovery + DTLS handshake). On windows where the same five cameras were alive:

| Window | Consumers | frames/h: back_yard, donkey, front_porch, mops, wash_stall |
|---|---|---|
| 16 Oct 01:05–03:20Z | seed recorder holding RTSP open + sampler | 337, 320, 275, 276, 327 (target 360) |
| 19 Oct 01:05–03:20Z, night | sampler only | 204, 132, 226, 0, 114 |
| 19 Oct 15:00–17:15Z, day | sampler only | 99, 100, 65, 0, 112 |

Confirmed live (19 Oct 20:40 ET): with an in-process fMP4 consumer holding donkey_cam and wash_stall open,
10/10 grabs succeeded in 1.0–1.8 s; the two control cameras managed 6/10 and 9/10 in 3.4–8.5 s.

**Conclusion supported by the data:** the cameras' 2.4 GHz link is lossy, and under that loss the per-grab
session setup fails about half the time, while an established session mostly survives. The fix in the sampler
is one persistent consumer per camera (`RANCH_KEEPALIVE`, default on). It costs ~15 Mbit/s of continuous inbound
video on the mini's clean 5 GHz link, which the probe shows is not the constraint. Not fixed by this: mops_cam
(5 % ping success, effectively off the network: relocate the camera or the AP), and the go2rtc panic (fewer
sessions mean fewer chances; launchd covers the rest; report upstream).

**Detector, as a by-product:** yolo11n on night IR frames produces thousands of confident false positives per day
(bench 3,155, bottle 2,456, clock 1,066, airplane 660, train 311 on 19 Oct) against ~400 horse detections. The COCO
model is not usable on these scenes without the labeled benchmark and a class filter; Phase 1 step 6/7 is next.

**After the fix (19 Oct 20:12–20:22 ET, keep-alive on):** 46–59 frames per camera per 10 min against a target of
60 (back_yard 59, tractor 56, donkey 54, wash_stall 54, back_pasture 51, front_porch 46), zero `grab failing`
episodes in the window, go2rtc at 6 % CPU / 53 MB, ~5 Mbit/s inbound. mops_cam still off. One day of data will
tell whether this holds through daytime loss.
