# Motion clips

A clip is one motion event on one camera as native-rate H.264 video, 5 s of pre-roll, ended when the scene has been
quiet for 8 s or at 60 s. It replaces the burst (2 to 4 keyframe JPEGs, docs/MODEL-YOLO26.md Part B) as the unit that
tiers 2/3 receive and as the eval set's unit (docs/EVALUATION.md). Decided 1 Nov 2026: the burst set was too sparse to
show motion and too small for narrow intervals.

## How it works

**Ring, owned by the recorder** (`infra/bin/recorder.sh`). The always-on `pull_jpeg` ffmpeg has a second output:
`-c copy` of the camera's H.264 into MPEG-TS segments under `<media>/ring/<cam>/`, `segment_time 2`. A copied segment
cuts only on a keyframe, so every segment is exactly one GOP and is named by its keyframe's UTC second, the same as
the JPEG beside it. The prune loop keeps 3 minutes. No new go2rtc consumer (`camera-owners.sh` still asserts <= 2),
no decode (the JPEG decoder keeps skipping non-key frames).

**Clips, owned by ingest** (`apps/ingest/src/clips.ts`, the pure decisions; `main.ts`, the clock and side effects).
Per camera, over the buffer keyframes' local-motion score ingest already computes (`blockMaxDiff` of consecutive
128x72 thumbnails):

| rule | value | why |
|---|---|---|
| open | score >= 0.08, outside a 10 s cooldown, >= 40 GB free | today's motion threshold and cooldown; clips stop before the recorder's 20 GB floor |
| continue | score >= 0.05 | today's burst-member threshold |
| close quiet | first keyframe 8 s after the last motion | four quiet keyframes; a horse pausing mid-walk rarely stands longer |
| close max | 60 s after the trigger | the eval's cap; longer motion becomes consecutive clips |
| close stale | no keyframe for 30 s | the camera is gone; keep what there is |
| pre-roll | the segment containing trigger - 5 s | keyframes every 2 s, so 5 s reaches the GOP before the trigger |
| sample | 2 fps, 1280 wide JPEGs | 7 cameras x 2 fps = 14 fps of the ANE's ~44; the runner scale-fills to 640 anyway |

While a clip is open the sampler reads every keyframe (1 s poll) instead of one per 5 s. On close, ingest concatenates
the segments (`ffmpeg -f concat -c copy -movflags +faststart`, written as `.tmp` then renamed) into
`<media>/clips/<cam>/<start>.mp4`, probes it, and extracts the sampled frames into `<media>/frames/<cam>/<date>/clip-<start>-NNNN.jpg`.
Each sampled frame is a `frames` row with `clip_id`, `seq` = index and `burst_id` = the first frame's id, so the
detector's burst close, retention, tracks and the dashboard's card work unchanged on "a burst of 30 members".
`ranch/clips/<cam>` carries the burst-close payload plus `clip_id, start_ts, end_ts, duration_s, preroll_s, stopped, path`.

**Data** (`packages/events/src/migrations.ts` v8): `clips(id, camera, trigger_ts, start_ts, end_ts, duration_s, fps,
width, height, path, bytes, stopped, preroll_s, expired_at)`; lifecycle derived: `end_ts` null = open, `path` null =
closed without media, `expired_at` = mp4 deleted at 7 days (the row stays). `frames.clip_id` links the samples.

**Detector**: subscribes `ranch/clips/+` with the burst handler; queue 600 (a closing clip publishes up to 120 frames
at once); a burst is abandoned after 300 s; the tracker keeps an unmatched track alive for 2 frames (`ASSOC_MAX_AGE`),
so a detector miss in one 2 fps sample no longer fragments a walking track.

## Measured, 1 Nov 2026 (R1, R2 first minutes)

- **Copy completeness (U1)**: every 2 s segment holds 30 frames at 15 fps, 40 at 20 fps, on all seven cameras: the
  copy output gets every packet while the JPEG output decodes keyframes only.
- **GOP (U2)**: 2 s on every camera (one 4 s and one 3 s segment in ~700). Pre-roll lands at exactly 5.0 s.
- **Ring cost**: the seven always-on ffmpegs 201 % CPU over a 10 s interval sample with the ring (233 % lifetime
  average before it); RSS 1794 MB after vs 1848 MB before; ring 148 MB at 3 min retention.
- **First clips**: seven in three minutes at night, 11 to 15 s each (`quiet`), 1.2 to 2.3 MB, 22 to 30 sampled frames,
  cut and sampled within 1 to 8 s of the close; the detector processed all 178 frames with 0 dropped and closed 7
  tracks; ingest RSS 211 MB.
- Open: clips/day per camera and bytes/day (R2c, 24 h), what the night clips contain (Part 3 step 0 decides whether the
  open threshold is right for IR), extraction CPU per clip-second (U3), detection parity at 1280 vs native (U4, R2d).

## Verifying

`make verify`, `make camera-owners` (writers under `ring/` and `buffer/` must be the recorder's), `make logs-of
D=ingest H=1` for `clip open` / `clip cut` / `clip failed`, `sqlite3 ... "select camera, stopped, count(*),
avg(duration_s), avg(preroll_s) from clips group by 1,2"`, the detector status's `dropped` staying 0.
