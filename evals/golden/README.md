# Golden set

Phase 1 label set for the detector benchmark (PLAN.md Phase 1 and 1b).

| File | What | In git |
|---|---|---|
| `frames.jsonl` | the picked frames: path, source path on the mini, camera, UTC ts, day/night | yes |
| `frames/<camera>/*.jpg` | the frames themselves, copied from the seed recorder | no (30 MB; regenerate with `select.ts`) |
| `labels.claude.jsonl` | Claude's labels, one row per frame: `boxes[]` (label, normalized x/y/w/h, posture, kind), the full structured `label`, usage and cost | yes |
| `labels.human.jsonl` | Vlad's blind labels, same `boxes[]` shape (Phase 1b) | yes |
| `batches/<id>.json` | Batch API bookkeeping | no |

Box format everywhere: normalized to the image, origin top-left, `x,y` = corner, `w,h` = size. Labels use COCO
names where one exists (`horse`, `person`, `car`, `truck`, `dog`); donkeys are kept as `kind: donkey` but scored
as `horse` because neither COCO detector has a donkey class. That mapping is itself a Post 1b finding.

## How it was made

```
# on the mini (frames live there)
ranch_app=/usr/local/ranch/app
node $ranch_app/evals/label/select.ts --n 100 --out $ranch_app/evals/golden   # stratified by camera x day/night, seeded
# on the laptop, with ANTHROPIC_API_KEY set; frames rsynced into evals/golden/frames/
node evals/label/claude.ts estimate                                     # tokens and cost per frame
node evals/label/claude.ts submit                                       # Batch API, claude-opus-5-5, structured output
node evals/label/claude.ts collect --batch <id>                         # → labels.claude.jsonl
# benchmark, on the mini
node apps/detector/src/bench.ts --labels evals/golden/labels.claude.jsonl --model /usr/local/ranch/models/yolo11n.mlpackage ... --compute ane,gpu,cpu
```
