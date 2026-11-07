# Plan: labels and a yolo26 fine-tune for the clip eval set

This file is the current state of the work: what exists, what is decided, what remains and in which order. History is
in the appendix and in git. Implements `docs/PLAN.md` §6, Phase 3: the golden set, its labels and the eval harness.

## Why

`clips-ranch-v1` (260 human-reviewed clips, 18,024 sampled frames) has no labels, and the production detector
(yolo26s, Vision path) misses most far-fence animals at night. Labels first, then a scored fine-tune. Each step ends
with a measured number for the Phase 3 post.

## Where things stand

- `clips-ranch-v1` frozen and pushed; local copy `evals/baseline/2026-11-06/`.
- `frames-ranch-clips-v1`: the 1 fps image dataset from the kept clips, 15,900 frames, pushed.
- Moondream 3.1 pre-labels exist for every kept clip (`labels-clips-ranch-v1-moondream-v1.jsonl`, horse recall 0.86
  day / 0.71 night on the acceptance images).
- `evals/label/claude.ts` labels through the Batch API (submit / collect, the 5-minute stall rule); the lean schema in
  `schema.ts` is written but unused.

## Decisions in force

- Labels run through the Batch API at half price: Opus 5.5 labels every 1 fps frame with the lean schema, the Moondream
  pre-labels passed as candidates; a human corrects in FiftyOne afterwards.
- Cost basis (measured on bursts, heavy schema): ~2,050 input and ~440 output tokens per frame. At 15,900 frames with
  the lean schema (~150 output tokens): Opus ~$67 on Batch.
- Scoring resamples whole clips, not frames; the 1 fps slice is primary.
- The fine-tune trains on the human-revised field only, split by time and camera, never on `frames-ranch-v1`.

## Remaining work, in order

### 1. `evals/label/clips.ts`

Replace `claude.ts`: estimate / submit-clips / collect / label-clips on the Batch API with the lean schema; windows of
10 frames with the previous window's object table passed as text so ids carry; pre-labels as candidates.

### 2. Opus labeling run

Submit all kept clips on Batch; collect under the 5-minute stall rule (cancel and run synchronously if no progress);
acceptance-set agreement against `labels-ranch-claude-revised-vlad-v1`; cost recorded in `evals/DATASETS.md`.

### 3. Human pass

Review in FiftyOne on `frames-ranch-clips-v1`; `revised` revision pushed; `hub.py check` clean.

### 4. Scoring

`bench.ts` on the 1 fps slice per camera and day/night; `score.ts` `bootstrap()` resamples whole clips; LEADERBOARD and
DATASETS rows for yolo26s and yolo11n.

### 5. Fine-tune

`YOLO("yolo26s.pt").train(data="ranch.yaml", epochs=50, patience=20, imgsz=640, freeze=10)` on the revised labels;
`imgsz=960` as a second row; re-export, leaderboard row; swap only if the EVALUATION §6 gate passes.

Dependencies: 1 then 2 then 3 then 4 then 5.

## Verification

- Each label revision has a `DATASETS.md` row with sha256 and a recorded cost.
- No production swap without the §6 gate on the frozen sets; second provision `changed=0`.

## Open questions

- Whether tractor_cam's 11 clips stay a stratum or fold into "other".

## Appendix: how it got here

- Clip set cut, reviewed and frozen (f6b0a60 to 2cd2d9f): 260 clips, 0 rejected.
- Moondream chosen over Florence-2 on the acceptance bench (9a1f3c2); pre-labels landed (b7e4d21).
