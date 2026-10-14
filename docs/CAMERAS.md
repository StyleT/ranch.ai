# Camera inventory

*Taken from the Wyze app "Firmware Update" screen on 14 Oct 2026, 19:14. Model is inferred from the firmware
line: 4.36.x = Cam v3 (`HL_CAM3`), 4.52.x = Cam v4 (`HL_CAM4`), 4.58.x = Cam v3 Pro (`HL_CAM3P`).*

| Camera (Wyze name) | Model | Firmware | App status 14 Oct | Points at | In scope |
|---|---|---|---|---|---|
| Back Yard Cam | Cam v4 | 4.52.17.26 | up to date | TBD | ? |
| Wash Stall | Cam v4 | 4.52.17.26 | up to date | wash stall (barn) | yes |
| Donkey Cam | Cam v4 | 4.52.17.26 | up to date | TBD (donkey paddock?) | yes |
| Mops Cam | Cam v3 Pro | 4.58.17.21 | up to date | TBD | yes |
| Front Porch Cam | Cam v3 | 4.36.17.21 | up to date | house front porch | no (person/vehicle only) |
| Living Room Cam | Cam v4 | 4.52.9.3415 (4.52.17.26 available) | status unknown | house interior | no |
| Tractor Cam | Cam v4 | 4.52.17.26 | status unknown | TBD | ? |
| Back Pasture Cam | Cam v4 | 4.52.17.26 | status unknown | back pasture | yes |

"Status unknown" in the app usually means the camera was offline or unreachable when the screen loaded. Living
Room Cam is also one firmware behind; it is not a ranch camera so leave it. Tractor Cam and Back Pasture Cam
need a reachability check (power, Wi-Fi) before the 48 h seed recording.

`Points at` and `In scope` are to be confirmed by Vlad. The event classes in `docs/PLAN.md` §4.4 need, at
minimum, one pasture view (horse count, horse down), one gate view and one trough view.

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

1. Wyze Developer API ID and key, written to `~/.config/ranch/wyze.env` on the mini.
2. The `Points at` column above.
3. Power/Wi-Fi check on Tractor Cam and Back Pasture Cam.
