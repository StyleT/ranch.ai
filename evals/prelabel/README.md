# Local pre-labeling (stage 1 of the labels)

Laptop-only tooling (uv project; the mini never runs it). A local model draws the first boxes on the clip frames so
the paid labeler verifies candidates instead of labeling from scratch (docs/EVALUATION.md §7). Two candidates behind
one interface (`models.py`):

| | Florence-2 Large | Qwen3-VL Instruct (MLX) |
|---|---|---|
| runtime | transformers native class, MPS fp16 (MIT, 0.77 B) | `mlx_vlm.server` from `evals/vlm` (`make vlm-serve MODEL=mlx-community/Qwen3-VL-8B-Instruct-4bit`), OpenAI-compatible; `--server-model` names the build, so each build is its own predictions file (`qwen3vl-8b-4bit`, `qwen3vl-4b-3bit`) |
| calls per frame | one `<CAPTION_TO_PHRASE_GROUNDING>` call with every class phrase | one grounding request naming the twelve classes, answered under a JSON schema of `{label, bbox_2d}` objects (Qwen3-VL grounds in relative 0..1000 coordinates), `temperature 0`, `max_tokens 512` |
| confidence | none: boxes are written at 1.0 | none |
| input | the frame at 1280 px on the long edge (the clip sampler's width), squashed by the processor into its fixed square | the same frame as a JPEG data URL; the processor's smart resize picks the tokens |

`Moondream 3.1` stays in `models.py` as the record of its triage: Photon's engine decodes garbage on Apple silicon
(m87-labs/moondream#391), and the wrapper refuses to bench on it.

Boxes are written in the detector's `predictions.<model>.jsonl` row shape with `label` already the scoring class
(donkey → horse, tractor / atv / delivery_vehicle → truck) and `kind` the taxonomy name, so `apps/detector/src/bench.ts`
scores a pre-label file with `--predictions` and no `--taxonomy`, and `make fiftyone-import ... MODELS=florence` loads
it as `pred_florence`.

```
make prelabel-install                                   # uv sync
make vlm-serve MODEL=mlx-community/Qwen3-VL-8B-Instruct-4bit            # in another shell, for qwen3vl
make prelabel-bench MODEL=qwen3vl SERVER_MODEL=mlx-community/Qwen3-VL-8B-Instruct-4bit SET=evals/baseline/2026-10-20 LABELS=evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl
node apps/detector/src/bench.ts --frames evals/baseline/2026-10-20/frames.jsonl --labels evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl \
  --predictions evals/baseline/2026-10-20/predictions.qwen3vl-8b-4bit.jsonl --min-label-conf 0.5 --iou 0.5 --tag prelabel-bench --out evals/results/2026-10-20-prelabel-bench-qwen3vl.json
make prelabel-run MODEL=qwen3vl SET=evals/baseline/2026-11-06-1fps      # resumable; clip-level rows rewritten at the end
make prelabel-sample SET=evals/baseline/2026-11-06-1fps                 # 7 cameras x day/night x 10 frames for the human check
```

The gate a model has to pass on the acceptance frames, and the human review of its failures, are in the working plan
and recorded with the result in `evals/DATASETS.md`.
