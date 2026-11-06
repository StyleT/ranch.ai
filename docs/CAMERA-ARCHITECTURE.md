# Camera architecture: one producer per camera, a recorder that keeps up, everything else reads disk

Exactly one go2rtc producer holds each camera, and one always-on recorder process per camera is its steady consumer.
Every other part of the system reads what the recorder writes to disk and never causes a camera connection. The local
path (TUTK over the LAN) is preferred; the bridge's WebRTC fallback stays available.

```
camera --(1 LOCAL TUTK/LAN session)--> go2rtc --(RTSP on loopback)--> recorder ffmpeg --+--> JPEG buffer  <media>/buffer/<cam>/
                                          |                                             +--> ring         <media>/ring/<cam>/
                                          +--(WebRTC, tailnet)--> browser live view
sampler / detector / status / supervisor  <------ read the buffer and the ring, never go2rtc or a camera
```

## How it works

- **go2rtc** is the Wyze client: a native `wyze://` TUTK source per camera, registered by the Wyze bridge. It holds
  one session (producer) per camera and multiplexes it to every consumer. Its API (1984) and RTSP (8554) listen on
  127.0.0.1 only; its WebRTC media port (8889) accepts Tailscale clients only.
- **The recorder** (`com.ranch.recorder`, `infra/bin/recorder.sh`) runs one always-on ffmpeg per camera reading
  go2rtc's local RTSP, with two outputs:
  - the **JPEG buffer**: keyframes only are decoded, one JPEG per keyframe (`-fps_mode passthrough`), named by UTC
    second, written atomically (temp file + rename), kept `recorder_buffer_min` minutes;
  - the **ring**: a stream copy of the H.264 into one-GOP MPEG-TS segments, kept 3 minutes, from which ingest cuts
    motion clips (`docs/CLIPS.md`).

  A second, on-demand ffmpeg transcodes HLS for the live view's fallback, only while a viewer's `.demand` marker is
  fresh.
- **Disk readers.** The sampler (`apps/ingest`) reads the newest buffer JPEG per camera and cuts clips from the ring;
  the detector reads sampled frames; the status daemon serves thumbnails and status. Readers load a JPEG into memory
  before decoding it (`apps/status/src/jpeg.ts`) and never memory-map a file that may still be growing.
- **Live view** (`apps/web`): WebRTC/WHEP straight from go2rtc (signalling proxied by the web app on loopback,
  media on the tailnet), with the on-demand HLS as fallback. A viewer shares the producer the recorder already holds,
  so attaching or detaching never dials a camera.

Two measures of a camera, used for different questions:

| measure | source | answers |
|---|---|---|
| packet age | newest ring segment's mtime (the stream copy writes every packet) | is video arriving? Liveness: `connected`, the recorder watchdog, the soak, the clips indicator |
| picture age | newest buffer JPEG (one per keyframe) | how old is the newest picture? Thumbnails, the sampler |

## Why

**A camera session must be held, not churned.** go2rtc dials a camera when its first consumer attaches and tears the
session down when the consumer count reaches zero. Each dial is a full TUTK P2P and DTLS handshake. Without one
steady consumer, healthy cameras showed about 10 producer starts a day and the weak ones up to 2,912 (`mops_cam`),
1,585 (`back_pasture_cam`) and 430 (`front_porch_cam`), and that churn knocked the weak cameras off Wi-Fi while the
mini's own Wi-Fi stayed steady. Upstream reports the same failure with V3 Pro cameras behind the bridge:
[docker-wyze-bridge #733](https://github.com/mrlt8/docker-wyze-bridge/issues/733),
[#1240](https://github.com/mrlt8/docker-wyze-bridge/issues/1240),
[#1544](https://github.com/mrlt8/docker-wyze-bridge/issues/1544).

**The consumer must keep up with real time.** go2rtc's RTSP server gives a reading client a 60 s read deadline, and
ffmpeg sends its keepalive (OPTIONS; go2rtc advertises no GET_PARAMETER, `Session: …;timeout=60`) only after it has
read a packet. A recorder that falls behind stops reading, goes silent, and go2rtc drops it with
`[rtsp] handle error="read tcp …: i/o timeout"`, then stops the producer because no consumer is left. On the wire: a
handshake ending at hh:11:29, nothing more from ffmpeg, the drop at hh:12:30.

**One JPEG per keyframe, not per frame.** image2 is a constant-frame-rate output: without `-fps_mode passthrough`
ffmpeg padded each decoded keyframe to the stream's 20 fps and encoded every copy as a 2560×1440 JPEG. A 62 s replay
with the recorder's arguments decoded 33 keyframes and wrote 117 JPEGs (`dup_frames=84`); with passthrough, 33 and 0.
One such pipeline peaked at 24.8 encodes per second (`speed=1.24x`), so seven at once ran below real time. The
cameras' burned-in clocks showed buffer frames 1.5 to 55 minutes behind and growing while the live view was on time,
load average 61–84 on 8 cores, about 45 % CPU per recorder ffmpeg. With passthrough, over an hour: the same clocks
within a keyframe interval of real time at every reading, load average 1.4–2.0, 2–4 % CPU per ffmpeg, and no go2rtc
read-deadline drop, camera dial, watchdog kill or supervisor row.

**Freshness means new content, not a new file.** The padded output wrote a file every second whatever its content, so
every check that read a file's time (watchdog, probe, dashboard tiles) reported cameras live whose pictures were an
hour old. Keyframe intervals differ per camera: 2 s on most, 34–52 s on some (a 51.6 s ring segment on `tractor_cam`
with packets flowing throughout). So liveness reads the ring's packet age, and a stale-picture check never stands in
for it.

**A remedy that kills the only consumer re-dials the camera.** A supervisor rung that restarted the recorder's ffmpeg
whenever go2rtc listed no consumer for it fired about 2,600 times a day, and each kill dropped the consumer count to
zero, so go2rtc dropped and re-dialled the camera: 537 producer starts in 6 h against 38 before. The ladder has no such
rung; the recorder's own watchdog restarts only an ffmpeg that receives no packets.

**On-demand HLS.** Re-encoding seven 1440p streams at once saturated the M2's single video-encode engine: each
encoder's queue grew without bound and the live picture ran minutes behind. One encoder runs while someone watches
over HLS; normally none, since WebRTC needs no transcode.

**Atomic writes and read-into-memory.** A reader that memory-mapped a JPEG while ffmpeg was still writing it touched
pages past the end of the file and the status daemon died with SIGBUS (16 crash reports, all in libvips' JPEG
reader). The recorder writes a temp file and renames it; readers read the whole file into a buffer first.

**Loopback only.** Anything that can attach a go2rtc consumer can make it dial a camera. The bridge's own UI opens one
player per camera on load, and go2rtc once listened on every interface. pf refuses 5080, 1984 and 8554 on every
interface but lo0 (`loopback_only_ports`); `make tunnel` reaches them from the laptop.

**Preload is a trial, not the fix.** `go2rtc_preload_cameras` lets go2rtc hold a session with no external consumer;
it is set on `donkey_cam`. The bridge re-registers every stream (DELETE + PUT) when it starts, which drops a preload
consumer until go2rtc restarts, and preload does not cure a hung dial. A recorder that keeps real time holds the
session without it.

## Availability and the supervisor

netprobe samples every camera every 15 s into SQLite `camera_probe` (7 days): `connected` (the ring got packets in
the last `RANCH_FRESH_S`, 30 s), `session_visible` (go2rtc lists a live producer; it lags the truth by up to 90 s and
misses orphaned stream objects, so it is a fallback only), `consumers`, ping, `mac_seen_at`. It logs
`consumers dropped` with the recorder ffmpeg's pid, its socket state, the picture age and the packet age whenever
go2rtc loses a camera's last consumer. The status daemon derives `connected`/`online` from the same packet age and
serves `/api/availability`.

The supervisor (`com.ranch.camsup`, `apps/camsup`) reads those facts only, never opens a stream or calls go2rtc,
and writes every decision to SQLite `remediation` with its outcome:

| rung | where | condition | action | limits |
|---|---|---|---|---|
| watchdog | recorder | no ring packets for `RECORDER_STALL_S` (45 s), counted from this ffmpeg's start at the earliest | TERM, 3 s, KILL that ffmpeg; the reconnect loop re-attaches | every 10 s check |
| 0 | supervisor | not connected | outage row | one per outage |
| 1b | supervisor | down ≥ `camsup_stream_restart_after_s` (120), answers ping at the address the bridge dials | the bridge counts a configured source as alive and never reconnects a dead producer: stop/start that one stream over MQTT | once per outage |
| 1c | supervisor | go2rtc dials an address the camera's MAC is not at, and the bridge already holds the right one | stop/start that stream | 120 s between tries |
| 2 | supervisor | down ≥ `camsup_reboot_after_s` (600) and reachable for a reboot (answers ping, or its MAC is at another address the cloud does not know) | reboot through the Wyze cloud; a watcher then rediscovers until the bridge has the camera's address, then stop/starts the stream | 1 per camera per 30 min, 2 per 5 min fleet-wide |
| 2b | supervisor | off the LAN ≥ `camsup_blind_reboot_after_s` (3600) | one blind cloud reboot in case it rejoins | once per 6 h per camera |
| 3 | supervisor | ≥ 3 cameras down ≥ 900 s after a reboot each | restart go2rtc (every camera redials once) | 1 per hour |
| 4 | supervisor | down ≥ 600 s, no ping, MAC seen nowhere | alert only; `com.ranch.notify` posts it after an hour | once per outage |

Rows other than the outage note are judged `not_recovered` after 10 minutes without recovery; recovery closes every
open row with its duration. `camsup_dry_run` records decisions without acting. The ladder is a pure module with tests
(`apps/camsup/src/ladder.ts`).

## Where a camera really is

The bridge's address for a camera is the Wyze cloud's, the one the camera reported at its last boot. A DHCP re-lease
moves a camera while the cloud keeps the old address, so the bridge and go2rtc dial a dead address until the camera
reboots. netprobe sweeps the cameras' /24 every `netprobe_sweep_every` probes (and at once when a session drops),
reads the neighbor table and reports `mac_seen_at` and `address_moved`; rungs 1c and 2 act on it. The bridge
re-fetches the cloud list every `wyze_bridge_refresh_interval` (5 min).

## Notifications

`com.ranch.notify` posts fleet-down (≥ `notify_fleet_min` cameras down ≥ `notify_fleet_after_s`), a single camera
down ≥ `notify_camera_after_s`, the supervisor's reboots and go2rtc restarts, recoveries, and a daily line at
`notify_daily_utc_hour`, to an ntfy.sh topic named in `~/.config/ranch/notify.env` on the mini (mode 600, never in
the repo). Without that file it logs what it would have posted.

## Proof

`make e2e-chaos [CAM=back_yard_cam] [DURATION=90] [MODE=stop|udp]` (`infra/bin/e2e-chaos.sh`, on the mini, software
only). `stop` SIGSTOPs the camera's recorder ffmpeg, so packets stop at once, the symptom of a hung dial or a dead
feed. It asserts: netprobe reports the camera not connected within 60 s; the watchdog re-attaches within 90 s; the
supervisor writes the outage row; after the fault the camera is connected within 120 s and its ring is fresh;
`camera-owners.sh` passes. A run on `back_yard_cam`, `DURATION=90`: not connected after 32 s, watchdog at 54 s, outage row written, connected
again 0 s after the fault (the watchdog had already replaced the stopped ffmpeg), ring fresh, owners OK: PASS.
`udp` drops the camera's UDP in a pf child anchor and reports timings only: the TUTK
session relays around a LAN block after about 40 s, so it does not reproduce a dead session.

## Operating it

- `make camera-owners`: every consumer of every stream, and a failure on anything that is not the recorder (also
  fatal under `make verify`). It asserts loopback-only listeners, recorder-only :8554 clients, at most two recorder
  consumers per stream, no non-loopback peer on 1984/8554, and recorder-only writers under the buffer and the ring.
- `make verify-live [MINUTES=30]`: soak; every connected camera's ring stays fresh, no crash reports, the on-demand
  transcode invariant holds.
- `make logs-of D=recorder`, `D=netprobe`, `D=camsup`: the reasons behind a reconnect. go2rtc logs `[streams] start
  producer` per camera dial; producer starts per camera per hour near zero outside restarts is the churn health check.
- **Picture age, by the camera's own clock.** File times can lie; the burned-in clock cannot. Crop the bottom-right
  corner of each camera's newest buffer JPEG and compare it with the mini's clock: within one keyframe interval is
  healthy. The live view's clock against the browser's clock checks go2rtc and the camera the same way.
- The dashboard: Home's camera tiles and `clips 1h` tile, System's network probe, availability, clips pipeline and
  supervisor ledger.
- Config (`infra/ansible/group_vars/ranch.yml`): `ranch_cameras`, `recorder_buffer_min`, `recorder_jpeg_q`,
  `recorder_min_free_gb`, `recorder_live_height`, `recorder_demand_ttl`, `camsup_*`, `netprobe_sweep_every`,
  `notify_*`, `go2rtc_preload_cameras`, `loopback_only_ports`, `tailscale_only_ports`.

## Limits and open questions

- What tipped the recorder below real time on the day the lag began is not known: the duplicate encoding was older
  than the outages, and nothing was deployed in between. One JPEG per keyframe removes the margin problem whatever
  the trigger.
- Clip rules count keyframes (confirm on 2 of 3, close 8 s after motion). On the cameras with 34–52 s keyframe
  intervals that is coarse: a short walk can fit between two keyframes.
- The recorder runs as the `ranch` user like everything else; a separate uid would let pf accept RTSP on loopback from
  the recorder only.
- go2rtc's `api.allow_paths` is not set; the API's trace log lists the paths in use.
