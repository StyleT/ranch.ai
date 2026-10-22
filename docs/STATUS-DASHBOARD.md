# Status dashboard (`apps/status`, `com.ranch.status`)

*Plan written 15 Oct 2026, before implementation; built the same evening (`apps/status`, `com.ranch.status`). One page on the mini that replaces the `ssh ranch '...'`
one-liners used to track the Phase 1 pipeline.*

## What it is

One Node 24 process (`node:http` only, no framework, no bundler), serving one HTML page with a little inline
script. Port 5090 on `0.0.0.0`, but **LAN-only since 22 Oct**: a pf anchor (`/etc/pf.anchors/com.ranch`, managed
by `roles/services`, `tailscale_blocked_ports`) refuses the port on the node's Tailscale addresses, and
`com.ranch.pf` re-enables pf at boot. So `http://ranch-ai.local:5090` works on the ranch LAN and
`ranch-ai.tail6d04cd.ts.net:5090` is refused; verification from the laptop goes through `ssh ranch curl
127.0.0.1:5090/...`. No auth yet; the bridge UI (5080) and go2rtc (1984) are still open on the tailnet.

## Data sources (all already on the box)

| Source | How | Used for |
|---|---|---|
| SQLite `/usr/local/ranch/var/ranch-events.sqlite` | `@ranch/events` `EventStore` (WAL, read-only queries) | frames per camera per minute, latest frame per camera and its age, detections by label last hour, horse count last minute, latest events with verdicts |
| MQTT on loopback | `@ranch/bus` `connectBus`, subscribe `ranch/#` | live ticker, retained `ranch/status/ingest` and `ranch/status/detector` (pid, RSS, processed, dropped) |
| Bridge API `:5080/api/cameras` | `fetch`, cached 60 s | camera model, firmware, IP. Its `state: streaming` is not liveness |
| launchd | `sudo -n launchctl list` (passwordless sudo), every 15 s | pid and last exit status per `com.ranch.*` daemon |
| unified log (`log show --last 5m --predicate 'process == "logger"'`, attributed by logger pid) | every 30 s | last log line per daemon |
| `/usr/local/ranch/media/seed/<camera>/` | `readdir` count, every 60 s | seed recorder progress |
| `df -g /` | every 60 s | free disk |
| Latest kept frame file | path from the `frames` table, served as `image/jpeg` | per-camera thumbnail, no go2rtc load |

Liveness per camera = a kept frame in the last 60 s (ingest floor is 10 s). Offline cameras show their last frame
age in hours instead.

## Endpoints

- `GET /` the page
- `GET /api/status` one JSON document with everything the page renders (daemons, cameras, labels, counts, disk, seed, events)
- `GET /api/frame/<camera>` latest kept frame file (`Cache-Control: no-store`)
- `GET /api/events` server-sent events: every MQTT message on `ranch/#` as `{topic, payload}`, plus a `status` event every 15 s so the page refreshes without reloading

## Page layout (one screen, phone-friendly, dark)

1. Header: hostname, uptime, load, free disk, seed window progress.
2. Daemons table: name, pid, last exit, RSS/processed where the retained MQTT status has it, last log line.
3. Camera cards (grid): thumbnail, online/offline badge, last frame age, frames/min (last 10 min), horse count
   (last minute), model and firmware.
4. Detections by label, last hour, as a small bar list.
5. Latest events (empty until Phase 2) with verdicts.
6. Live ticker: last 30 MQTT messages, newest first.

## Memory budget

Target under 80 MB RSS: Node baseline plus `node:sqlite` plus the MQTT client. No sharp, no image processing;
thumbnails are the JPEGs the sampler already wrote. Status JSON is computed on demand with a 5 s cache so a
refreshing phone does not hammer SQLite.

## Out of scope (deliberately)

Auth, write actions (verdict buttons come with Phase 2's phone flow), historical charts, Frigate-style
timelines, anything that opens camera streams. The page reads what the pipeline already produced.

## As built (15 Oct 2026)

URL: http://ranch-ai.tail6d04cd.ts.net:5090/ (tailnet) or http://ranch-ai.local:5090/ (ranch LAN).

| Panel | Shows | Source |
|---|---|---|
| Header | uptime, load, free/total disk, totals of frames/detections/events, seed frames and % of the 48 h window | `os`, `df -g /`, SQLite, seed dir, `SEED_START_EPOCH`/`SEED_HOURS` from the plist |
| Daemons | every `com.ranch.*`: pid or **down**, last exit code, the retained MQTT status (rss, processed, dropped) for ingest/detector, last log line | `sudo -n launchctl list`, `ranch/status/#`, unified log via `log show` |
| Cameras | thumbnail (latest kept frame), online/offline, last-frame age, frames/min over 10 min, horse count in the last 3 min, seed frame count, model/firmware/IP | `frames`, `camera_counts`, seed dir, bridge `/api/cameras` (cached 60 s) |
| Detections, last hour | label, count, mean confidence, bar | `detections` ⋈ `frames` |
| Events | latest 10 with tier and verdict (empty until Phase 2) | `events` |
| Live MQTT | last 30 messages on `ranch/#`, newest first; badge shows SSE state | `@ranch/bus` → SSE |

Endpoints: `GET /` page · `GET /api/status` JSON (5 s cache) · `GET /api/frame/<camera>` latest kept JPEG ·
`GET /api/events` SSE with `mqtt` events for every message and a `status` event every 15 s (keep-alive comment
every 20 s). Page refreshes from the `status` events, no reload.

Measured on first deploy: 123 MB RSS, idle CPU. Capping the V8 heap at 64 MB (`--max-old-space-size`) changed
nothing, so this is the Node 24 + `node:sqlite` + MQTT baseline, not page data; the 80 MB target was missed and the
number is noted in the memory budget (PLAN.md 4.3 "Node services" line).
Port 5090, `0.0.0.0`, no auth: the same trade-off as the bridge UI and go2rtc; add auth before anything untrusted
joins the LAN.

## Incident, 16 Oct: page never showed the two cameras coming online

Tractor Cam and Back Pasture Cam were powered on the morning of 16 Oct. The backend had them within about a
minute of the bridge's TUTK discovery succeeding (last `discovery timeout` 11:03:17 ET, first kept frames
11:04:23 ET, seed recorder 11:04:33 ET) and `/api/status` reported `online: true`. The open browser page did not.

Root cause: the page created one `EventSource` at load and from then on updated only from that stream. There was
no fallback polling, no watchdog and no visible "last updated" signal. A device that sleeps or a tab that goes to
the background can leave the SSE connection silently dead (Safari in particular never reopens it), so the page
freezes at its last render while still showing "live".

Fix (commit below): an "updated N s ago" badge ticking every 5 s and turning red past 45 s; `/api/status`
polled every 30 s regardless of the stream; the `EventSource` rebuilt when no status event arrived for 45 s;
`visibilitychange` and `pageshow` force a refresh and reconnect. The server was unchanged.

Not ruled out: a delay between camera power-on and TUTK discovery inside the bridge. The bridge retries
discovery on every consumer connect (the seed recorder reconnects every 60 s) and refreshes the Wyze camera list
every 30 min; nothing on the mini records when the cameras actually booted. If a long gap is ever observed
again, compare the Wyze app's "online since" with the first seed file timestamp.

Follow-up, same day: the "cameras still offline" report after the fix was correct and was a different fault. The five
original cameras had been dead inside go2rtc since 23:24 ET the night before (docs/CAMERAS.md, incident); only the two
newly powered ones were delivering. The page showed exactly that. The stall watchdog in the sampler is the fix.

## Added 19–20 Oct (docs/FRAMES-AND-BASELINE.md)

`/frames` frame browser with detection overlays, `/api/frames`, `/api/frame/<id>?w=` (sharp resize on the fly),
`/api/baseline`, `/api/baseline/<date>?model=&min_conf=&camera=`, `/api/baseline-frame/<date>/<camera>/<file>?w=`.
The main page's detections panel is per camera and links into the browser.

## Added 22 Oct (docs/TAXONOMY-UI.md)

`/taxonomy` editor; `GET /api/taxonomy`, `/api/taxonomy/versions[/<id>]`; `POST /api/taxonomy/validate|score`
(open) and `apply|revert` (need `x-ranch-token`). Main page shows the taxonomy version and a drift banner.

## Added 22 Oct (docs/MODEL-YOLO26.md part B)

`/frames` groups bursts into one card (hover to step through members; ↑/↓ in the viewer), draws motion arrows,
"moving only" filter (`/api/frames?moving=1`); `/api/frames` returns heads with `burst: [...]` members and
`track/seen/dx/dy` on detections.
