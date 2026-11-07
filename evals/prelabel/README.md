# Local pre-labeling (stage 1 of the labels)

Laptop-only tooling (uv project; the mini never runs it). A local model draws the first boxes on the clip frames so
the paid labeler verifies candidates instead of labeling from scratch (docs/EVALUATION.md §7). The candidates behind
one interface (`models.py`):

| | Qwen3-VL Instruct (MLX) | Rex-Omni (bf16, and the AWQ checkpoint dequantized) |
|---|---|---|
| runtime | `mlx_vlm.server` from `evals/vlm` (`make vlm-serve MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit`), OpenAI-compatible; `--server-model` names the build, so each build is its own predictions file (`qwen3vl-4b-3bit`) | transformers `Qwen2_5_VLForConditionalGeneration` on MPS bf16 with SDPA; `--weights bf16` loads `IDEA-Research/Rex-Omni`, `--weights awq` dequantizes `IDEA-Research/Rex-Omni-AWQ` once to a bf16 copy under `~/.cache/ranch/` (the AWQ kernels are CUDA-only) |
| calls per frame | one grounding request naming the twelve classes, answered under a JSON schema of `{label, bbox_2d}` objects (Qwen3-VL grounds in relative 0..1000 coordinates), `temperature 0`, `max_tokens 512` | one detection request with the repository's prompt (`Detect <classes>. Output the bounding box coordinates in [x0, y0, x1, y1] format.`), greedy with `repetition_penalty 1.05`; the answer's `<x0><y0><x1><y1>` bin tokens map by `/ 999` |
| confidence | none: boxes are written at 1.0 | none |
| input | the frame at 1280 px on the long edge (the clip sampler's width) as a JPEG data URL; the processor's smart resize picks the tokens | the same frame; the Qwen2.5-VL processor at the repository's `min_pixels` / `max_pixels` keeps 1280x720 as is |

Rex-Omni's `rex_omni` package pins flash-attn and vLLM and does not install on macOS, so `models.py` carries its prompt,
decoding settings and answer parser. Its tokenizer needs a fix on transformers 5: the 1,000 coordinate bins are the last
1,000 entries of Qwen2.5's vocabulary (ids 150643 to 151642, `tokenizer_config.json`), but the shipped files make
transformers append them as new ids and push `<|image_pad|>` past the embedding table; `rex_tokenizer_dir()` writes a
`tokenizer.json` with the bins at their trained ids under `~/.cache/ranch/rex-omni-tokenizer/`, and the wrapper asserts
the ids at load.

`Florence-2 Large` (phrase grounding, three phantom boxes per frame on the acceptance set) and `Moondream 3.1` (Photon's
engine decodes garbage on Apple silicon, m87-labs/moondream#391) stay in `models.py` as the record of their runs; the
wrapper refuses to bench Moondream.

Boxes are written in the detector's `predictions.<model>.jsonl` row shape with `label` already the scoring class
(donkey → horse, tractor / atv / delivery_vehicle → truck) and `kind` the taxonomy name, so `apps/detector/src/bench.ts`
scores a pre-label file with `--predictions` and no `--taxonomy`, and `make fiftyone-import ... MODELS=florence` loads
it as `pred_florence`.

```
make prelabel-install                                   # uv sync
make vlm-serve MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit            # in another shell, for qwen3vl
make prelabel-bench MODEL=qwen3vl SERVER_MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit SET=evals/baseline/2026-10-20 LABELS=evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl
make prelabel-bench MODEL=rexomni WEIGHTS=awq SET=evals/baseline/2026-10-20 LABELS=evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl
node apps/detector/src/bench.ts --frames evals/baseline/2026-10-20/frames.jsonl --labels evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl \
  --predictions evals/baseline/2026-10-20/predictions.rexomni-awq.jsonl --min-label-conf 0.5 --iou 0.5 --tag prelabel-bench --out evals/results/2026-10-20-prelabel-bench-rexomni.json
make prelabel-run MODEL=qwen3vl SET=evals/baseline/2026-11-06-1fps      # resumable; clip-level rows rewritten at the end
make prelabel-sample SET=evals/baseline/2026-11-06-1fps                 # 7 cameras x day/night x 10 frames for the human check
```

The gate a model has to pass on the acceptance frames, and the human review of its failures, are in the working plan
and recorded with the result in `evals/DATASETS.md`.
