# Plan: YOLO26s as the production detector, and bursts instead of single frames

*Written 22 Oct 2026, executed the same day (Vlad: "plan, then act autonomously"). Two changes: swap the tier-1
model to YOLO26s with the comparison on the leaderboard, and make the pipeline look at a few consecutive frames per
sample so movement is visible to the models.*

## Part A: YOLO26s

**What it is.** Ultralytics' YOLO26 (Sept 2025; `ultralytics` 8.4.178 is installed in `apps/detector/export`):
NMS-free end-to-end head, COCO mAP 40.9 (n) and 48.6 (s) against 39.5 / 47.0 for YOLO11n / YOLO11s, similar
parameter counts (2.4 M / 9.5 M). CoreML export is supported; with `nms=True` ultralytics wraps the one-to-many
head in Apple's NMS pipeline, so the Swift runner's contract (`VNRecognizedObjectObservation`) is unchanged and
no runner work is needed. The NMS-free head (`nms=False`) would need a new decoder; not now.

**Steps.**
1. `export_yolo.py` takes a model name; export `yolo26n` and `yolo26s` at 640, fp16, NMS pipeline. Both, so the
   production comparison is apples to apples (n vs n) as well as the requested s.
2. Provision syncs the packages to `/usr/local/ranch/models`.
3. Predictions on `frames-ranch-v1` at threshold 0.05 (`snapshot.ts --existing evals/baseline/2026-10-20 --models
   yolo26n,yolo26s`: no new pick, same 300 frames), registered as `preds-frames-ranch-v1-yolo26*-<sha8>` and pushed
   to the Hub.
4. Latency on the mini (`bench.ts --model … --compute ane`, 300 frames): p50, p95, RSS.
5. Score against `labels-ranch-claude-revised-vlad-v1` (conf ≥ 0.5) in both forms: zero-shot at 0.25 and
   `--taxonomy coco` (what production does). Leaderboard rows `zero-shot` and `filter-v1` for both sizes.
6. Swap: `detector_model: yolo26s.mlpackage`, provision, verify the detector's status message. The relative gate
   (EVALUATION.md §6) is reported next to it; Vlad asked for the swap, so a gate failure is recorded loudly rather
   than blocking, and the leaderboard marks the new `prod`.

## Part B: bursts, so movement is visible

**Today** the sampler grabs one JPEG per camera every 5 s and keeps it when the scene changed ≥ 4 % or 10 s passed;
the detector sees single frames. A static tractor and a standing person look the same to a per-frame model, and
a horse that is lying flat and one that is rolling look the same.

**Change: a sample that shows change becomes a burst; a still sample stays one frame.** (Vlad, 22 Oct: do not
over-capture stills that were already processed; capture actual motion; keep resource use under control.)

- *Trigger.* Only a `change` keep (thumbnail diff ≥ 4 % against the last kept frame) opens a burst. A `floor`
  keep (10 s passed, nothing moved) stays a single frame as today; it is the liveness and time-lapse signal and
  retention already removes identical ones.
- *Extension.* After the head, the sampler grabs again after `RANCH_BURST_GAP_S` (1 s). The grab is kept as a
  member only if it differs from the previous member by ≥ `RANCH_BURST_CHANGE` (1 %, lower than the trigger
  because consecutive-second motion is subtle); a still grab ends the burst. Hard cap `RANCH_BURST_MAX` (4
  frames). So a burst is as long as the motion, never longer, and a flash of change (one changed frame, then
  still) costs exactly one extra grab.
- *Cooldown.* `RANCH_BURST_COOLDOWN_S` (10 s) per camera: a camera cannot open a new burst until that long after
  the last one ended; change keeps in the cooldown are single frames.
- *Global budget.* A token bucket across cameras: `RANCH_BURST_BUDGET_PER_MIN` (60 member frames per minute, all
  cameras). When exhausted, bursts degrade to single frames and the sampler logs `burst throttled` once per
  minute; the retained `ranch/status/ingest` message carries `bursts`, `burst_frames`, `throttled` so the status
  page shows the spend. Worst case the detector sees 60 extra frames per minute (~1 fps at 20 ms each: 2 % of a
  core); typical nights are zero.
- *Storage.* `frames.burst_id` (= head id) and `frames.seq`; members get reason `burst`. Retention keeps or
  deletes a burst as a unit, by the head's decision.

**Detector: boxes become short tracks.** Every member is detected as today (mapped through the taxonomy). When
the last member arrives the detector associates boxes across the burst (same label, greedy IoU ≥ 0.3 between
consecutive frames) and writes per detection: `track` (local id within the burst), `seen` (frames the track
appears in), `dx`, `dy` (normalized displacement, first to last appearance). A box is **stable** when
`seen ≥ 2` and **moving** when `hypot(dx, dy) ≥ 0.02` (2 % of the frame; tunable). Published on
`ranch/bursts/<camera>` as `{burst_id, frames, tracks: [{label, raw_label, seen, dx, dy, moving, confidence}]}` for
the event layer; `ranch/counts` keeps counting per frame as before, max over the burst.

**What it buys.** Static false positives (the tractor "person") become `stable && !moving`, which per-camera
suppression can key on; animals in motion become `moving`; a horse down is `stable && !moving` on the ground over
successive bursts, which is exactly the `horse_down_prolonged` signal Phase 2 needs. Tier 2/3 get the burst, not
one frame: a VLM or Claude sees three frames 1 s apart and can tell rolling from lying flat.

**Cost.** Bounded by the budget above, not by camera count or activity. Memory unchanged.

**Dashboard.** `/frames` groups a burst into one card: the head frame with a filmstrip of the members, hover or
arrow keys step through them; boxes carry a motion arrow when `moving`; filter "moving only". `/api/frames`
returns bursts (head + members + detections with track fields).

**Not in this step.** Cross-burst tracking (identity over minutes), re-identification, the VLM tier itself.

## Order of work
A1–A6, then B: schema v5 → sampler → detector association → API/browser → retention test → provision → docs.

## Part A, as measured (22 Oct)

Rows in `evals/LEADERBOARD.md`. yolo26s under the production taxonomy: horse recall 0.60 (0.55 for yolo11n),
precision 0.92 (0.85), FPPF(all) 0.14 (0.27), person precision 0.38 at recall 1.00 (0.17 at 0.80), 22.6 ms p50 on
the ANE (18.2), RSS unchanged. First model to reach the 0.1 false-positive budget with usable horse recall (0.55
at threshold 0.75). The relative gate fails on one class: the single gold dog (1/1 → 0/1). Swapped to production
as instructed with that recorded. yolo26n is not an improvement on yolo11n.
