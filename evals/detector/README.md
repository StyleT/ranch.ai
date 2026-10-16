# Detector benchmark

Raw runs are JSON files from `apps/detector/src/bench.ts`, one per date. Recall against the golden set is
added once `evals/golden/labels.claude.jsonl` exists (Phase 1) and again against human labels (Phase 1b).

## Latency, 15 Oct 2026 (night frames, 40 per model, Mac mini M2 8 GB, macOS 27.0.1)

Native Core ML through Vision, one image at a time, boxes at threshold 0.3. `ane` = `.cpuAndNeuralEngine`,
`gpu` = `.cpuAndGPU`, `cpu` = `.cpuOnly`. RSS is the runner process holding the model.

| Model | Input | Compute | p50 ms | p95 ms | fps | RSS MB |
|---|---|---|---|---|---|---|
| YOLO11n (COCO, NMS folded in) | 640 | ane | 8.0 | 14.7 | 115 | 51 |
| | | gpu | 14.1 | 20.5 | 65 | 70 |
| | | cpu | 17.7 | 18.4 | 57 | 61 |
| YOLO11s | 640 | ane | 18.5 | 25.1 | 57 | 51 |
| | | gpu | 24.6 | 27.8 | 42 | 84 |
| | | cpu | 31.2 | 31.9 | 32 | 80 |
| RF-DETR Nano fp16 | 384 | ane | 31.0 | 32.2 | 32 | 47 |
| | | gpu | 36.2 | 36.7 | 28 | 157 |
| | | cpu | 41.1 | 41.7 | 24 | 94 |
| RF-DETR Nano fp32 | 384 | ane | 47.3 | 48.9 | 20 | 163 | 
| | | gpu | 25.9 | 26.5 | 39 | 206 |
| | | cpu | 46.9 | 47.4 | 21 | 152 |

**RF-DETR fp32 with `.cpuAndNeuralEngine` is wrong, not just slow.** On a frame with two cars it returns 298 of
300 queries with every class logit exactly 0 (sigmoid 0.5), on all 91 classes. The same package on `.cpuOnly`
or `.cpuAndGPU` returns the two cars at 0.95+. The fp16 package on the ANE is also correct. Roboflow's docs say
fp32 "never reaches the ANE"; in practice Core ML partitions the graph, something in the fp32 path lands on
the ANE anyway, and the result is silently zeroed. Treat RF-DETR fp32 as GPU-only and never ship a compute
unit setting without a sanity frame. Found 15 Oct, repo commit a2faf6d.

Export notes: YOLO via `ultralytics` `export(format="coreml", nms=True, half=True)`; RF-DETR via
`apps/detector/export/export_rfdetr.py` (image input, ImageNet normalization folded in, `LWDETR.export()`
mode, `torch.export(strict=False).run_decompositions({})`, coremltools 9.0, iOS16 target). First load compiles
the package in-process: 80 to 170 ms, cached as `.mlmodelc`.
