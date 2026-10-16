# Status dashboard (`apps/status`, `com.ranch.status`)

*Plan written 15 Oct 2026, before implementation. One page on the mini that replaces the `ssh ranch '...'`
one-liners used to track the Phase 1 pipeline.*

## What it is

One Node 24 process (`node:http` only, no framework, no bundler), serving one HTML page with a little inline
script. Port 5090 on `0.0.0.0`, reachable over Tailscale and the ranch LAN. No auth yet, same trade-off as the
bridge UI on 5080 and go2rtc on 1984; revisit before anything else joins the LAN.

## Data sources (all already on the box)

| Source | How | Used for |
|---|---|---|
| SQLite `/usr/local/ranch/var/ranch-events.sqlite` | `@ranch/events` `EventStore` (WAL, read-only queries) | frames per camera per minute, latest frame per camera and its age, detections by label last hour, horse count last minute, latest events with verdicts |
| MQTT on loopback | `@ranch/bus` `connectBus`, subscribe `ranch/#` | live ticker, retained `ranch/status/ingest` and `ranch/status/detector` (pid, RSS, processed, dropped) |
| Bridge API `:5080/api/cameras` | `fetch`, cached 60 s | camera model, firmware, IP. Its `state: streaming` is not liveness |
| launchd | `sudo -n launchctl list` (passwordless sudo), every 15 s | pid and last exit status per `com.ranch.*` daemon |
| `/var/log/ranch-<name>.log` | tail last line, every 15 s | last log line per daemon |
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
