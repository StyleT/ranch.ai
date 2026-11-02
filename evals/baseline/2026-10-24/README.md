---
license: cc-by-nc-4.0
pretty_name: ranch frames, bursts v1
task_categories:
  - object-detection
size_categories:
  - n<1K
tags:
  - horses
  - security-camera
  - infrared
  - wyze
---

# frames-ranch-bursts-v1

156 still frames in 50 bursts from six Wyze cameras on a small horse ranch, picked on 24 Oct 2026 from a 7-day pool
of 519 bursts: seed 20261020, burst heads stratified by camera × day/night, every member of each picked burst
included. A burst is 2 to 4 keyframes about 2 s apart, kept by the sampler while the scene kept changing
(`burst_id` = the head frame's id, `seq` = position in the burst).

Files: `frames.jsonl` (one row per frame: path on the capture machine, source frame id, camera, UTC timestamp,
day/night, why the frame was kept, `burst_id`, `seq`), `dataset.json` (id, sha256, provenance), `manifest.json`
and `predictions.<model>.jsonl`: zero-shot output of yolo11n, yolo11s, yolo26n, yolo26s and RF-DETR Nano
(fp16 on the Neural Engine, fp32 on the GPU) at threshold 0.05, boxes normalized to the image with origin top-left.
Labels: `evals/golden/labels-ranch-bursts-claude-v1.jsonl` in the repo; the FiftyOne-native copy with label
fields is the Hub repo `vladlenfedosov/ranch-frames-bursts-v1` (revisions `claude-v1-grouped`, `revised-vlad-v1`).

This is the evaluation set for the public build log at https://github.com/StyleT/ranch.ai
(`docs/EVALUATION.md` there is the protocol). It is test data: nothing is trained on it.

Privacy: frames show a private property, vehicles and occasionally people. The repo is private until reviewed.
