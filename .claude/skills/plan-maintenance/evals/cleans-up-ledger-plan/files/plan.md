# Plan: yolo26 NMS-free export and the runner decoder

## Context

Production detector is yolo26s on the Vision path (NMS). Decided 1 Nov: evaluate yolo26 NMS-free (end-to-end CoreML
export) on the frozen sets before any swap. Implements `docs/PLAN.md` §6, Phase 1: the detector benchmark.

## Findings (3 Nov, read-only)

- ultralytics 8.4.178 exports the one-to-one head with `nms=False`; output `(1, 300, 6)` = xyxy, score, class_id in
  pixels of the 640x640 input; metadata `end2end: True`.
- `half=True` is deprecated for `quantize=16`.
- The output name is auto-generated (previously assumed to be `detections`).

## Steps

1. [x] `export_yolo.py --e2e` writes `yolo26s-e2e.mlpackage` plus the labels sidecar — done 4 Nov (c41d9e0)
2. [x] Decoder in `main.swift` chosen from the model description (`vision` / `e2e` / `detr`) — done 4 Nov (7b22a10);
   `--decoder` debug override added
3. [ ] Laptop equivalence: `YOLO('yolo26s.pt').predict(nms=False, conf=0.05)` vs `MLModel.predict` on 5 frames
4. [ ] `snapshot.ts --existing evals/baseline/2026-10-20 --models-only yolo26s-e2e`, register the preds file
5. [ ] `bench.ts` side by side (`filter-v1-e2e`), gate per EVALUATION §6: horse R@FPPF<=0.1 does not drop, FPPF(all)
   does not rise, night horse recall does not drop, against `2026-10-22-filter-v1-yolo26.json`
6. ~~Swap production to e2e (`detector_model: yolo26s-e2e.mlpackage`)~~ — not until the gate passes

Update 4 Nov: the ANE fp16 top-k question is real: on 20 frames `--compute cpu` vs `--compute ane` differ on 3 boxes
near threshold. Compare on 300 frames before step 5.

## Steps, revised (5 Nov)

After the equivalence run showed 2 of 5 frames with a shifted operating point, step 3 becomes: 20 frames, both compute
units, a per-box diff table (same-class IoU > 0.7 pairs within an e2e frame should be near zero). Steps 4 and 5 are
unchanged. New step after 5: re-fit the per-label taxonomy thresholds on the same sets if the operating point moved.
The swap, if the gate passes: `detector_model` in `group_vars/ranch.yml`, provision twice, `make logs-of D=detector`
shows `decoder: e2e`; rollback is reverting `detector_model`.

## Verification

- Second `make provision` reports `changed=0`; `make logs-of D=detector` shows `decoder: e2e`; the status message
  carries the model name.

# Appendix — previous plan (2 Nov)

# Plan: yolo26 on the mini

## Context

yolo26s replaced yolo11n on 22 Oct (leaderboard: horse recall 0.30 -> 0.55 on the reference labels). STAL, ProgLoss
and MuSGD are training-time and automatic for yolo26 checkpoints; nothing in export or the runner "enables" them.

## Steps

1. Export with NMS (done 22 Oct)
2. Measure latency on the ANE: 300 frames, 41 ms median (done 23 Oct)
3. Decide on the e2e export -> superseded by the plan above
