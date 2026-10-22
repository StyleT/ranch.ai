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

## Operating notes

- A camera is "online" when its buffer has a frame newer than `RANCH_STALE_S` (30 s). Staleness means the
  recorder isn't getting frames (camera down / reconnecting) — the sampler waits, it does not touch the camera.
- Diagnose reachability at layer 3 with `netprobe` ping %, not by frame count (retention deletes near-identical
  stall frames). Churn health check: fleet go2rtc producer-starts/hour should be ~one per camera per restart.
- Config: `ranch_cameras` (the fleet), `recorder_buffer_min`, `recorder_jpeg_q`, `recorder_min_free_gb`
  (group_vars); `RANCH_BUFFER`, `RANCH_STALE_S`, `RANCH_GRAB_S` (sampler).
