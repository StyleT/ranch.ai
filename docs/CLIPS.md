# Motion clips

A clip is one motion event on one camera as native-rate H.264 video, 5 s of pre-roll, ended when the scene has been
quiet for 8 s or at 60 s. It replaces the burst (2 to 4 keyframe JPEGs, docs/MODEL-YOLO26.md Part B) as the unit that
tiers 2/3 receive and as the eval set's unit (docs/EVALUATION.md): the burst set was too sparse to show motion and too
small for narrow intervals.

## How it works

**Ring, owned by the recorder** (`infra/bin/recorder.sh`). The always-on `pull_jpeg` ffmpeg has a second output:
`-c copy` of the camera's H.264 into MPEG-TS segments under `<media>/ring/<cam>/`, `segment_time 2`. A copied segment
cuts only on a keyframe, so every segment is exactly one GOP and is named by its keyframe's UTC second, the same as
the JPEG beside it. The prune loop keeps 3 minutes. No new go2rtc consumer (`camera-owners.sh` still asserts <= 2),
no decode (the JPEG decoder keeps skipping non-key frames).

**Clips, owned by ingest** (`apps/ingest/src/clips.ts`, the metrics and the pure decisions; `main.ts`, the clock and
side effects). Per camera, over two numbers per buffer keyframe against the previous one, both from the 128x72
greyscale thumbnail's 8x8 blocks: `score` = the largest block mean difference (`blockMaxDiff`, something moved) and
`lit` = the share of blocks whose mean difference reaches 0.02 (`litFraction`, how much of the frame changed):

| rule | value | why |
|---|---|---|
| global | lit >= 0.5 | most blocks changed at once: a light switched or the exposure stepped, never an object; while idle it is logged, never a candidate; it drops a candidate and neither extends nor closes an open clip |
| candidate | score >= 0.08, not global, outside a 10 s cooldown, >= 40 GB free | the row is written at once with `trigger_score`; the sampler reads every keyframe from here on |
| confirm | 2 of the next 3 keyframes score >= 0.05 and are not global | one hot keyframe is not motion: an insect streak near an IR lens, a flick or a reference reset scores hot on the pair where it appears and the pair where it vanishes, then nothing; a walking animal keeps scoring. Confirmation opens the clip with the trigger as its start, so the pre-roll is unchanged (the ring holds 3 min) |
| drop | the window ends unconfirmed (`single`), a global keyframe (`global`), no keyframe for 30 s (`stale`) | the row keeps `dropped` and the score series; no cooldown follows a drop, so motion right after a transient opens normally |
| continue | score >= 0.05 | the burst-member threshold |
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

**Data** (`packages/events/src/migrations.ts` v8 and v9): `clips(id, camera, trigger_ts, start_ts, end_ts,
duration_s, fps, width, height, path, bytes, stopped, preroll_s, expired_at, trigger_score, scores, dropped)`;
lifecycle derived: `end_ts` null = open (candidate or clip), `dropped` set = never a clip, `path` null with `stopped`
set = closed without media, `expired_at` = mp4 deleted at 7 days (the row stays). `scores` is the JSON series
`[[seconds since the trigger, score, lit], ...]` from the trigger through the drop or close, so every candidate can
be triaged from the DB. `frames.clip_id` links the samples.

**Detector**: subscribes `ranch/clips/+` with the burst handler; queue 600 (a closing clip publishes up to 120 frames
at once); a burst is abandoned after 300 s; the tracker keeps an unmatched track alive for 2 frames (`ASSOC_MAX_AGE`),
so a detector miss in one 2 fps sample does not fragment a walking track.

## Dashboard

The status daemon serves `GET /api/clips?camera=&since=&limit=` (rows plus the detector's labels and the first sampled
frame id) and `GET /api/clip/<id>.mp4` with byte ranges (206, `Content-Range`, `Accept-Ranges: bytes`): Safari and iOS
refuse an mp4 whose server ignores Range, and every player seeks. A frame card whose head was sampled from a clip
carries `clip: {id, duration_s, stopped, labels}` and only every 4th member (the video is the way to watch it; a 60 s
clip has 120 sampled frames; `labels` are what the detector saw on any sampled frame). The web app proxies the file
(`/api/ui/clip/<id>`, Range and the 206 passed through), shows a play badge and the clip's labels on such cards, opens
the viewer on the video with the frames and boxes one tap away, and the "clips only" filter on `/detections` and the
camera page is the clip view (`/api/clips` serves the export and the fixture recorder, not a page).

## Why a clip needs persistence: the first night's clips

The first night under the trigger-opens rule cut 20 clips in 90 min, every one `quiet` at 11 to 18 s, 15 without a
detection and 5 whose detections were parked vehicles; none showed motion. Three sources, read from the kept frames
around each trigger and then from the clips' own keyframes with `evals/clips/replay.ts`:

- insect streaks near an IR lens (back_pasture_cam, most of them): a bright motion-blurred blob on one keyframe,
  whole-frame change 0.003 to 0.006, the block-max spike on one or two blocks; the pair where it appears and the pair
  where it vanishes both score hot, then nothing;
- global lighting changes: three cameras scoring 0.03 to 0.2 whole-frame in the same second, twice, 20 s apart
  (a light switched or the IR exposure stepped), 7 clips on 4 cameras in 25 s; `lit` 0.6 to 1.0;
- reference resets: every ingest or stream restart yields one keyframe compared with nothing or with a stale
  thumbnail; the sampler now drops its reference on `camera recovered`, and a restart scores 0.

Replay over those 20 clips (`node --experimental-strip-types evals/clips/replay.ts <mp4...>`): the old rule
(`--confirm-hot 0`) reproduces 14 cuts (the other 6 triggered against a reference up to 5 s old while idle, a pair
the clip's keyframes cannot replay); the persistence rule cuts 2, drops 15 as `single` and 2 as `global`. The two
it keeps are moths circling within a metre of the lens for 8 to 10 s: a bright blob that moves every keyframe, which is
persistent motion by any motion metric. They are the known residual; the stored score series of the next days' clips,
with daytime horse clips among them, is what a spatial-continuity feature would be designed and measured against.

## Measured (the ring's and the clips' first hour)

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
D=ingest H=1` for `clip candidate` / `clip confirmed` / `clip dropped` / `clip cut` / `clip failed` / `global change`,
`sqlite3 ... "select camera, dropped, stopped, count(*), round(avg(duration_s),1) from clips where trigger_ts >
datetime('now','-1 day') group by 1,2,3"` (expected: night `single` drops on the IR cameras at tens per night, `global`
rows sharing a second across cameras, cut clips with detections or visible motion), `select id, camera, trigger_score,
scores from clips where dropped is null order by id desc limit 5` to read a clip's series, the detector status's
`dropped` staying 0.
