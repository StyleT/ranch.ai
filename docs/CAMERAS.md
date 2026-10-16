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
