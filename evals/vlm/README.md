# Tier-2 harness: the local vision-language model on the escalation set

The tier-2 model is called on an escalation, never on every frame (docs/PLAN.md). This directory runs a candidate
behind `mlx_vlm.server` (OpenAI-compatible, `json_schema` structured outputs with `strict: true`) and sends it the
registered escalation set; `evals/escalate/` builds that set from the golden labels and a tier-1 predictions file and
scores the answers.

```
make vlm-install
make vlm-serve MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit          # one shell: the server on :8080
make vlm-run MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit ESC=evals/baseline/<set>/escalations-<m>/escalations.jsonl [PROMPT=v1] [LIMIT=20]
node --experimental-strip-types evals/escalate/score.ts --set evals/baseline/<set>/escalations-<m> --vlm predictions.vlm.Qwen3-VL-4B-Instruct-3bit@v1.jsonl \
  [--frames ... --labels ... --predictions ...] --out evals/results/<date>-tier2.json
```

Every request carries two images (the crop around the escalated box at native resolution, and the same crop from the
previous 1 fps frame) and the prompt `prompts/<version>.md` with the camera, the detector's label and confidence and
the taxonomy's allowed values filled in; the answer is constrained to one schema (`present`, `kind`, `posture`,
`gate`, `trough`, `confidence`), `temperature 0`, `max_tokens 128`. The prompt file's sha is in every row, so a prompt
change is a new run, never a silent edit. Accuracy rows can be produced on the laptop (same MLX weights); latency and
RSS rows only count from the mini with the detector resident.

Escalation request types (`evals/escalate/build.ts`): `verify` (a tier-1 box in the confidence band between its
per-label taxonomy threshold and `--hi`, with the golden TP / FP verdict), `attributes` (a gold animal box the
detector matched, with gold `kind` and `posture`), `scene` (a frame where the gold marks a gate or trough visible).
`score.ts` reports the shares of TPs kept and FPs rejected, kind and posture accuracy with confusions (and the
lying-vs-upright pair), scene accuracy, the JSON-valid rate, latency percentiles and RSS, and, given the frames,
labels and tier-1 predictions, tier-1 horse `R@FPPF<=0.1` and FPPF before and after the VLM's rejections.
