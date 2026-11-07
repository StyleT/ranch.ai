# Plan: AI-first labels for the clip eval set

This file is the current state of the work: what exists, what is decided, what remains and in which order. History is
in the appendix and in git. Implements `docs/PLAN.md` §6, Phase 3: the golden set and its labels.

## Why

The clip set `clips-ranch-v1` (260 human-reviewed motion clips, 18,024 sampled frames) has no labels. Labeling every
frame with Opus 5.5 would cost about $134; the plan is to label AI-first at 1 fps with a local pre-labeler feeding a
cheaper cloud model, and to escalate only disagreements. Each step ends with a measured number.

## Where things stand

- `clips-ranch-v1` is frozen and pushed (`vladlenfedosov/ranch-clips-v1`, revision `clips-v1`); local copy in
  `evals/baseline/2026-11-06/`.
- `evals/label/claude.ts` labels bursts with Opus 5.5 through the Batch API (heavy per-frame schema, ~$0.019 per frame
  measured).
- `evals/fiftyone/` imports frames and `labels-*.jsonl` into fields; the App runs on :5151.
- No pre-labeler exists; no 1 fps image dataset exists.

## Decisions in force

- Labels are AI-first at 1 fps: a local model pre-labels if it passes the bench gate, Haiku 5.5 verifies, Opus 5.5 only
  on disagreements, then a human corrects in FiftyOne.
- The bench gate for a local pre-labeler: horse and person recall >= 0.8 by day and >= 0.6 at night at IoU 0.5,
  precision >= 0.7, <= 5 s per frame on the laptop. Candidates: Moondream 3.1 and Florence-2 Large.
- `clips-ranch-v1` is immutable; corrections are new label revisions.

## Remaining work, in order

### 1. `docs/CLIPS.md` Measured section

Replace the "Open: clips/day" bullet with the measured rates from the soak. Checker passes; one commit.

### 2. Local pre-labeling bench

`evals/prelabel/bench.py --model {moondream,florence}` over the 50 acceptance images, scored through `bench.ts`;
per-class recall and precision day/night, seconds per frame, peak RSS. Apply the gate; rows in `evals/DATASETS.md`.

### 3. The 1 fps image dataset

ffmpeg decode of every kept clip at 1 fps into a FiftyOne image dataset grouped by clip, registered as
`frames-ranch-clips-v1` (parent `clips-ranch-v1`), pushed.

### 4. Pre-labels on the kept clips

`prelabel.py` with the model step 2 chose, over `clips-ranch-v1`; `gt_<model>` field in FiftyOne; a
`labels-clips-ranch-v1-<model>-v1.jsonl` row. Skipped if step 2 chose no pre-labeler.

### 5. Haiku verification and the human pass

`evals/label/clips.ts` with the lean schema, Haiku 5.5 over all kept clips with the pre-labels as candidates;
acceptance-set agreement against `labels-ranch-claude-revised-vlad-v1`; the human pass in FiftyOne; `revised`
revision pushed.

Dependencies: 1, 2 and 3 can run now; 4 needs 2 and 3; 5 needs 4 (or 3 if no pre-labeler).

## Verification

- Every label file has a `DATASETS.md` row with sha256; `hub.py check` between local and pushed revisions.
- Acceptance-set agreement recorded per model before the human pass starts.

## Open questions

- Whether tractor_cam's 11 clips stay a stratum or fold into "other".

## Appendix: how it got here

- Clip set cut, reviewed and frozen (f6b0a60 to 2cd2d9f): 260 clips, 0 rejected.
