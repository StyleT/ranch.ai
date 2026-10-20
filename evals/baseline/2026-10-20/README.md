---
license: cc-by-nc-4.0
pretty_name: ranch frames v1
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

# frames-ranch-v1

300 still frames from seven Wyze cameras on a small horse ranch (6× Cam v4 at 2560×1440, 1× Cam v3 Pro at
2560×1440, 1× Cam v3 at 1920×1080), picked on 20 Oct 2026 from a 7-day pool of ~20,000 kept frames: seed
20261020, stratified by camera × day/night (21–22 per bucket). Roughly half are night infrared.

Files: `images/<camera>/<utc-timestamp>.jpg`; `frames.jsonl` (one row per image: path on the capture machine, source frame id, camera, UTC timestamp, day/night, why the frame
was kept), `dataset.json` (id, sha256, provenance), `manifest.json` and `predictions.<model>.jsonl`: zero-shot
output of yolo11n, yolo11s and RF-DETR Nano (fp16 on the Neural Engine, fp32 on the GPU) at threshold 0.05,
boxes normalized to the image with origin top-left. Labels, when they exist, live under `labels/` in this repo
and name this dataset id.

This is the evaluation set for the public build log at https://github.com/StyleT/ranch.ai
(`docs/EVALUATION.md` there is the protocol). It is test data: nothing is trained on it.

Privacy: frames show a private property, vehicles and occasionally people. The repo is private until reviewed.
