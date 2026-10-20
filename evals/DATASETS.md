# Dataset registry (append-only)

Rules: docs/EVALUATION.md §2. Verify a dataset by comparing its `dataset.json` sha256 with this table.

| id | kind | created | n | parent | sha256 (data file) | location | Hugging Face |
|---|---|---|---|---|---|---|---|
| frames-ranch-v1 | frames | 2026-10-20 | 300 | – | b3f7c87146018c03… (frames.jsonl) | `evals/baseline/2026-10-20/`, images `/usr/local/ranch/media/baseline/2026-10-20/` on ranch-ai | [vladlenfedosov/ranch-frames @ frames-ranch-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/frames-ranch-v1) (private) |
| preds-frames-ranch-v1-rfdetr-nano-float16-a786ba8a | preds | 2026-10-20 | 300 | frames-ranch-v1 | 9bf11026bf755bfd… | `evals/baseline/2026-10-20/predictions.rfdetr-nano-float16.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-rfdetr-nano-float32-b7d49936 | preds | 2026-10-20 | 300 | frames-ranch-v1 | 0918384dd5d60148… | `evals/baseline/2026-10-20/predictions.rfdetr-nano-float32.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-yolo11n-7edec780 | preds | 2026-10-20 | 300 | frames-ranch-v1 | af69ab7a90125bdf… | `evals/baseline/2026-10-20/predictions.yolo11n.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-yolo11s-0b717c6c | preds | 2026-10-20 | 300 | frames-ranch-v1 | 58d26b97e4df8b96… | `evals/baseline/2026-10-20/predictions.yolo11s.jsonl` | same repo and tag, `predictions.*.jsonl` |
| labels-ranch-claude-v1 | labels | 2026-10-20 | 100 | frames-ranch-v1 | e7e0d99bef670c6c… | `evals/golden/labels-ranch-claude-v1.jsonl` (+ `.dataset.json`) | [tag labels-ranch-claude-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/labels-ranch-claude-v1) `labels/` |
