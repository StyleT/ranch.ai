# Local pre-labeling (stage 1 of the labels)

Laptop-only tooling (uv project; the mini never runs it). A local model draws the first boxes on the clip frames so
the paid labeler verifies candidates instead of labeling from scratch (docs/EVALUATION.md §7). Two candidates behind
one interface (`models.py`):

| | Moondream 3.1 9B-A2B | Florence-2 Large |
|---|---|---|
| runtime | Photon (`moondream` package, Metal; weights from Hugging Face on first run; no API key for a base model; 24 GB+ of unified memory) | transformers native class, MPS fp16 (MIT, 0.77 B) |
| calls per frame | one presence `query` naming the taxonomy classes, then one `detect` per class the answer names | one `<CAPTION_TO_PHRASE_GROUNDING>` call with every class phrase |
| confidence | none: boxes are written at 1.0; the model's detect threshold (0.30 default, `--threshold`) is the operating point | none |
| input | the frame at 1280 px on the long edge (the clip sampler's width); the model tiles it itself | the same frame, squashed by the processor into its fixed square |

Boxes are written in the detector's `predictions.<model>.jsonl` row shape with `label` already the scoring class
(donkey → horse, tractor / atv / delivery_vehicle → truck) and `kind` the taxonomy name, so `apps/detector/src/bench.ts`
scores a pre-label file with `--predictions` and no `--taxonomy`, and `make fiftyone-import ... MODELS=moondream` loads
it as `pred_moondream`.

```
make prelabel-install                                   # uv sync
make prelabel-bench MODEL=moondream SET=evals/baseline/2026-10-20 LABELS=evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl
node apps/detector/src/bench.ts --frames evals/baseline/2026-10-20/frames.jsonl --labels evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl \
  --predictions evals/baseline/2026-10-20/predictions.moondream.jsonl --min-label-conf 0.5 --iou 0.5 --tag prelabel-bench --out evals/results/2026-10-20-prelabel-bench.json
make prelabel-run MODEL=moondream SET=evals/baseline/2026-11-06-1fps    # resumable; clip-level rows rewritten at the end
make prelabel-sample SET=evals/baseline/2026-11-06-1fps                 # 7 cameras x day/night x 10 frames for the human check
```

The gate a model has to pass on the acceptance frames, and the human review of its failures, are in the working plan
and recorded with the result in `evals/DATASETS.md`.
