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

**Change: a kept sample is a burst of K frames.** When the sampler decides to keep a frame it grabs K−1 more at
`RANCH_BURST_GAP_S` apart (defaults K=3, 1 s; the keep-alive consumer makes a grab ~1 s, so a burst is ~2 s of
motion) and stores them as one group: `frames.burst_id` (= the first frame's id) and `frames.seq` (0..K−1). The
head frame keeps the `change`/`floor` reason; members get reason `burst`. Retention treats a burst as a unit:
the head's decision applies to all members, so identical floor bursts vanish together and a burst with motion
stays whole.

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

**Cost.** 3× grabs only at keep time (~every 10 s per camera): ~2 grabs/s across 7 cameras, well inside what the
keep-alive streams deliver; detector at 8–20 ms per frame stays below 5 % of one core; storage grows only for
bursts with change or detections (retention). Memory unchanged.

**Dashboard.** `/frames` groups a burst into one card: the head frame with a filmstrip of the members, hover or
arrow keys step through them; boxes carry a motion arrow when `moving`; filter "moving only". `/api/frames`
returns bursts (head + members + detections with track fields).

**Not in this step.** Cross-burst tracking (identity over minutes), re-identification, the VLM tier itself.

## Order of work
A1–A6, then B: schema v5 → sampler → detector association → API/browser → retention test → provision → docs.
