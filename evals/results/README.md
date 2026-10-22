# Benchmark results

One JSON per run, written by `apps/detector/src/bench.ts`; rows summarized in `evals/LEADERBOARD.md`. Each file
records the frames and labels dataset ids with sha256, the class mapping, threshold, IoU, commit, host and
the exact command.

## 2026-10-20-zero-shot.json (and -iou03)

Four zero-shot models on the 100 Claude-labeled frames of `frames-ranch-v1`, threshold 0.25, IoU 0.5 (0.3 in the
second file, identical recall). Headline: horse recall 0.26–0.35 with 95 % intervals spanning 0.09–0.57; the
YOLOs have perfect horse precision but 0.7–0.8 false boxes of other classes per frame, RF-DETR finds a few more
horses (AP 0.42) at ~2 false boxes per frame. By slice: day recall 0.09–0.27 (11 gold, mostly donkeys), night
0.42–0.50 (12 gold). Horses by camera in the labeled set: front_porch 8, mops 7, donkey 6, back_yard 1,
wash_stall 1, back_pasture 0, tractor 0.

What every model misses (12 of 23): the seven large daytime donkeys on donkey_cam and front_porch (COCO has no
donkey class and does not generalize `horse` to them), three animals narrower than 120 px, and one night frame
where the horse fills the picture. That list is the Post 1 "what went wrong" and the first argument for a
fine-tune with a `donkey` class.

## 2026-10-20-zero-shot-labelconf05.json and -quadruped.json

Same predictions, two scoring variants after the smoke verification of the labels (LEADERBOARD.md notes):
`--min-label-conf 0.5` keeps the 20 horse-class boxes Claude was at least half sure of (drops three hedged
ones); `--merge-pred-classes cow=horse,sheep=horse` additionally scores any large-quadruped prediction as a
horse. Recall 0.30–0.40 → 0.55–0.60; AP 0.30–0.48 → 0.55–0.65. The gap between the two is class confusion: COCO
models see donkeys as cows. The gap from 0.60 to 1.0 is real misses: animals under 100 px at night, a horse under a
blanket ("bed"), a frame-filling horse ("bottle").

## 2026-10-20-revised-labelconf05.json and -quadruped.json

Same two variants against `labels-ranch-claude-revised-vlad-v1` (Claude's labels after Vlad removed the five cat
boxes). Horse metrics identical to the `labelconf05` runs; this is now the reference. Per-class table in
LEADERBOARD.md notes: the models are solid on cars, over-eager on people at night, blind to tractors as trucks.

## 2026-10-21-filter-v1.json

The production configuration (`--taxonomy coco`): mapping and per-label thresholds from `packages/taxonomy`,
reference labels at conf ≥ 0.5. Per class for yolo11n: car 28/28 (2 FP), horse 11/20 (2 FP), dog 1/1 (1 FP),
person 4/5 but 20 FP, truck 0/14 (tractors), other 0/10. FPPF(all) 0.27, of which 0.20 is `person`.

## 2026-10-22-zero-shot-yolo26.json, -filter-v1-yolo26.json, -latency-yolo26.json

YOLO26n/s added to both scoring forms and a fresh 300-frame latency run for the four YOLOs. See LEADERBOARD.md
notes (yolo26s becomes prod; gate fails on the single dog box).
