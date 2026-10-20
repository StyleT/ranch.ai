# Frames, the frame browser, and the zero-shot baseline

*Plan written 19 Oct 2026 before implementation. Three asks: detections per camera on the dashboard; the
unsampled data (each frame with the boxes the detector produced on it) without storing a bazillion identical
images; a baseline dataset with no training, to compare against later.*

## Facts that shape the plan (19 Oct, after 3 days)

- 58,914 frames, 14 GB, 249 KB each. 98 % are `floor` frames (kept because 10 s passed, not because the scene
  changed: mean pixel difference < 4 %). At 7 cameras that is ~5 GB/day; 7-day retention would be ~35 GB of
  mostly identical night frames.
- 22,867 frames carry at least one detection of an "interest" class (horse, person, dog, cow, sheep, car, truck),
  most of them static false positives repeated frame after frame (a fence post as a "bench" every 10 s).
- Boxes are stored normalized in `detections`; nothing needs to be rendered or stored to show them.

## 1. Storage: keep what carries information, never a second copy of the same picture

Cadence does not change: the sampler still grabs every 5 s and keeps a frame at least every 10 s, and the
detector still sees every kept frame. What changes is what survives after an hour:

| Frame | Retention |
|---|---|
| `change` (scene changed ≥ 4 %) | 7 days |
| has detections that differ from the previous retained frame of that camera (new label, or a box that moved: IoU < 0.8) | 7 days |
| first `floor` frame of each camera per 10-minute bucket | 7 days (a time-lapse spine) |
| any other `floor` frame | deleted after 1 h (row and file) |

Expected: ~144 spine frames per camera per day plus motion, i.e. hundreds, not thousands, per camera. The hourly
prune in `apps/ingest` applies it with SQL plus a small IoU check. No thumbnails or annotated copies are ever
written: the browser draws boxes as SVG over the original, and resized variants are produced on the fly.
Baseline sets (section 3) live outside this tree and are never pruned.

## 2. Dashboard: per camera, and a frame browser

- Main page: "Detections, last hour" becomes a camera × label table (horse row first), each camera linking to its
  frames.
- New page `GET /frames`: filters for camera, time window, label, minimum confidence, reason, "only with
  detections"; newest first, paged. Each card: time, reason, change %, model, the detections. Clicking opens the
  frame at full width with every box drawn client-side from the normalized coordinates, label and confidence,
  and prev/next.
- API: `GET /api/frames?camera&since&until&label&min_conf&reason&with_detections&limit&before` (frames with their
  detections, JSON); `GET /api/frame/<id>?w=1280` (JPEG, resized on the fly with sharp, `no-store`); the existing
  `/api/frame/<camera>` (latest) stays.

## 3. Baseline dataset: zero-shot predictions on a frozen frame set

- `evals/baseline/snapshot.ts` picks N frames (default 300) stratified by camera × day/night from the `frames`
  table with a fixed seed, copies them to `/usr/local/ranch/media/baseline/<date>/<camera>/` (immutable), writes
  `frames.jsonl`, then runs every `*.mlpackage` in `/usr/local/ranch/models` through the Core ML runner on the ANE
  with threshold 0.05 and stores `predictions.<model>.jsonl` plus `manifest.json` (model sha256, go2rtc and bridge
  versions, date, machine). JSONL and manifest go into git under `evals/baseline/<date>/`; the images stay on the
  mini (~75 MB per set).
- The 100-frame Claude labeling pick is drawn from the baseline set, so labels and predictions share frames.
  Anything that changes later (threshold, class filter, model swap, fine-tune) is re-run on the same frames and
  diffed against this snapshot and against the labels.
- The frame browser can open a baseline set (`/frames?set=<date>`) and overlay any model's predictions.

## Order of work

1. Storage policy in the sampler (prune), applied to the existing 14 GB once, provisioned to `changed=0`.
2. Dashboard per-camera table, frame browser and APIs.
3. Baseline snapshot, run on the mini, JSONL committed.
Each step is its own commit.
