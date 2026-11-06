# Dataset registry (append-only)

Rules: docs/EVALUATION.md §2. Verify a dataset by comparing its `dataset.json` sha256 with this table.

## FiftyOne-native store on the Hub (from 1 Nov 2026)

Datasets live on the Hub in FiftyOne's native format, one private repo per frames set, pushed and loaded with
`fiftyone.utils.huggingface` (`evals/fiftyone/README.md`). Label variants and model predictions are fields on the
same samples; versions are Hub revisions named by tags. The rows below map dataset ids to repo + revision; the JSONL
rows further down remain the record of what the TypeScript tools on the mini produced and were imported.

| frames set | Hub repo (private) | revision tag | fields at that revision | samples | round trip |
|---|---|---|---|---|---|
| frames-ranch-bursts-v1 | `vladlenfedosov/ranch-frames-bursts-v1` | `claude-v1` | `gt_claude` (= labels-ranch-bursts-claude-v1, 236 boxes), `pred_yolo26s` (248), `pred_yolo11n` (237) | 156 (50 bursts) | 1 Nov: `hub.py load --revision claude-v1` → `hub.py check`: 0 differences over every field and detection attribute |
| frames-ranch-bursts-v1 | same | `claude-v1-grouped` | same fields; the dataset is grouped (group field `burst`, one image slice per frame named by `seq`) so the Annotate tab edits per slice; supersedes `claude-v1` (flat), which stays as the record of the first push | 156 (50 bursts) | 1 Nov |
| frames-ranch-bursts-v1 | same | `revised-vlad-v1` | adds `gt_vlad`: Vlad's revision of `gt_claude` in the App (first push 1 Nov; see the git history of this row for the diff when it is scored) | 156 (50 bursts) | 1 Nov: tag listed by `hub.py ls`; not yet loaded back and checked |
| clips-ranch-v1 | `vladlenfedosov/ranch-clips-v1` | `clips-v1` | no label fields yet; the 260 mp4s under `data/` with `clip_id`, `camera`, `period`, `start_ts`, `duration_s`, `stopped`, `preroll_s`, `mini_path` (video dataset, one sample per clip) | 260 clips | pushed at Hub sha `b1beae8475`, 266 files; `hub.py load --revision clips-v1` → 260 samples, every clip's camera, period, duration and frame count equal to the local set, 0 differences |

## JSONL datasets (produced on the mini; imported into FiftyOne)

| id | kind | created | n | parent | sha256 (data file) | location | Hugging Face |
|---|---|---|---|---|---|---|---|
| frames-ranch-v1 | frames | 2026-10-20 | 300 | – | b3f7c87146018c03… (frames.jsonl) | `evals/baseline/2026-10-20/`, images `/usr/local/ranch/media/baseline/2026-10-20/` on ranch-ai | [vladlenfedosov/ranch-frames @ frames-ranch-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/frames-ranch-v1) (private) |
| preds-frames-ranch-v1-rfdetr-nano-float16-a786ba8a | preds | 2026-10-20 | 300 | frames-ranch-v1 | 9bf11026bf755bfd… | `evals/baseline/2026-10-20/predictions.rfdetr-nano-float16.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-rfdetr-nano-float32-b7d49936 | preds | 2026-10-20 | 300 | frames-ranch-v1 | 0918384dd5d60148… | `evals/baseline/2026-10-20/predictions.rfdetr-nano-float32.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-yolo11n-7edec780 | preds | 2026-10-20 | 300 | frames-ranch-v1 | af69ab7a90125bdf… | `evals/baseline/2026-10-20/predictions.yolo11n.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-v1-yolo11s-0b717c6c | preds | 2026-10-20 | 300 | frames-ranch-v1 | 58d26b97e4df8b96… | `evals/baseline/2026-10-20/predictions.yolo11s.jsonl` | same repo and tag, `predictions.*.jsonl` |
| labels-ranch-claude-v1 | labels | 2026-10-20 | 100 | frames-ranch-v1 | e7e0d99bef670c6c… | `evals/golden/labels-ranch-claude-v1.jsonl` (+ `.dataset.json`) | [tag labels-ranch-claude-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/labels-ranch-claude-v1) `labels/` |
| labels-ranch-claude-revised-vlad-v1 | labels | 2026-10-20 | 100 | labels-ranch-claude-v1 | 88fd9e2f3fd77486… | `evals/golden/labels-ranch-claude-revised-vlad-v1.jsonl` (+ `.dataset.json`) | [tag labels-ranch-claude-revised-vlad-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/labels-ranch-claude-revised-vlad-v1) `labels/` |
| preds-frames-ranch-v1-yolo26n-b4693414 | preds | 2026-10-22 | 300 | frames-ranch-v1 | 3a21179959c0fead… | `evals/baseline/2026-10-20/predictions.yolo26n.jsonl` | same repo, `frames-ranch-v1/predictions.yolo26n.jsonl` |
| preds-frames-ranch-v1-yolo26s-01e03dff | preds | 2026-10-22 | 300 | frames-ranch-v1 | 3df0ebecf96b8aac… | `evals/baseline/2026-10-20/predictions.yolo26s.jsonl` | same repo, `frames-ranch-v1/predictions.yolo26s.jsonl` |
| frames-ranch-bursts-v1 | frames | 2026-10-24 | 156 (50 bursts) | – | 85459ef56c287411… (frames.jsonl) | `evals/baseline/2026-10-24/`, images `/usr/local/ranch/media/baseline/2026-10-24/` on ranch-ai | [vladlenfedosov/ranch-frames @ frames-ranch-bursts-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/frames-ranch-bursts-v1) (private) |
| preds-frames-ranch-bursts-v1-rfdetr-nano-float16-a786ba8a | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | b296cf22bd3e3e4d… | `evals/baseline/2026-10-24/predictions.rfdetr-nano-float16.jsonl` | same repo and tag, `predictions.*.jsonl` |
| preds-frames-ranch-bursts-v1-rfdetr-nano-float32-b7d49936 | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | 4e24ad61dfb88b4f… | `evals/baseline/2026-10-24/predictions.rfdetr-nano-float32.jsonl` | same repo and tag |
| preds-frames-ranch-bursts-v1-yolo11n-7edec780 | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | 82bab32e4021ddbc… | `evals/baseline/2026-10-24/predictions.yolo11n.jsonl` | same repo and tag |
| preds-frames-ranch-bursts-v1-yolo11s-0b717c6c | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | ba32d48ec92c4502… | `evals/baseline/2026-10-24/predictions.yolo11s.jsonl` | same repo and tag |
| preds-frames-ranch-bursts-v1-yolo26n-b4693414 | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | 20e533b6d648f755… | `evals/baseline/2026-10-24/predictions.yolo26n.jsonl` | same repo and tag |
| preds-frames-ranch-bursts-v1-yolo26s-01e03dff | preds | 2026-10-24 | 156 | frames-ranch-bursts-v1 | 029af01153979b54… | `evals/baseline/2026-10-24/predictions.yolo26s.jsonl` | same repo and tag |
| labels-ranch-bursts-claude-v1 | labels | 2026-10-24 | 156 (50 bursts) | frames-ranch-bursts-v1 | e11bc8f1086efddd… | `evals/golden/labels-ranch-bursts-claude-v1.jsonl` | [tag labels-ranch-bursts-claude-v1](https://huggingface.co/datasets/vladlenfedosov/ranch-frames/tree/labels-ranch-bursts-claude-v1) `labels/` |
| clips-ranch-pool-v1 | clips | 2026-11-06 | 260 clips (18,024 sampled frames) | – | db101e9d4f941697… (clips.jsonl), 30790faf07b04a3b… (frames.jsonl) | `evals/baseline/2026-11-06/`, mp4s and frames `/usr/local/ranch/media/baseline/2026-11-06/` on ranch-ai | not pushed: the review pool, not a frozen set |
| clips-ranch-v1 | clips | 2026-11-06 | 260 clips (18,024 sampled frames) | clips-ranch-pool-v1 | db101e9d4f941697… (clips.jsonl), 30790faf07b04a3b… (frames.jsonl) | `evals/baseline/2026-11-06/` (the pool's files, frozen after review), media as the pool | `vladlenfedosov/ranch-clips-v1` (FiftyOne native, private), see the FiftyOne table |

Notes on `labels-ranch-claude-v1` (smoke-verified 20 Oct, see LEADERBOARD.md): reliable at labeler confidence ≥ 0.7;
boxes at 0.25–0.45 are hedged guesses on dark blobs and include a static patch on front_porch_cam boxed as a cat in
four frames. Score with `--min-label-conf 0.5` until the human labels (`labels-ranch-vlad-v1`) exist. The
`friendly` person kind is never set by Claude by design.

`labels-ranch-claude-revised-vlad-v1`: Vlad reviewed Claude's labels in the frame browser (20 Oct) and removed every cat box (5; shadows and a static patch); all other boxes accepted. This is the labels dataset to score against until `labels-ranch-vlad-v1` exists.

`clips-ranch-pool-v1`: the review pool for the clip set (docs/CLIPS.md, docs/EVALUATION.md §2). `snapshot.ts --clips 260
--since 4d`, seed 20261020, no predictions (`--models` at an empty directory; predictions are run on the frozen set,
not the pool): 260 of the 1,303 clips cut between 2 Nov and 6 Nov 01:00 UTC, stratified camera × day/night × duration
tercile (terciles at 22.6 s and 46.5 s), floor 6 per stratum then round-robin fill, so thin strata (tractor_cam 11
clips in the pool, back_yard night 18, mops day 9) are taken whole. A human reviews every clip in FiftyOne
(`evals/fiftyone/README.md`, "Reviewing a clip set"); the frozen `clips-ranch-v1` is picked from the same pool with
`--exclude-clips` when any clip is rejected. The mp4s on the mini expire 7 days after their trigger; the copies under
`media/baseline/` do not.

`clips-ranch-v1`: the pool after human review, every one of the 260 clips played in the App and kept, none rejected,
so the frozen set is the pool's files unchanged (same hashes; `dataset.json` carries the new id, the parent and the
review outcome). Labels and predictions name this id. Per camera: back_pasture 48, donkey 48, front_porch 45,
wash_stall 42, back_yard 35, mops 31, tractor 11; 123 day, 137 night; durations 6 to 63 s.

`frames-ranch-bursts-v1` (24 Oct): the first dataset of whole bursts, for the bursts-vs-no-bursts question
(docs/EVALUATION.md §3, §4.1 "Burst track policies"). `snapshot.ts --bursts 50 --since 7d`, seed 20261020: 50 burst
heads picked stratified camera × day/night from a pool of 519 bursts (22–24 Oct; front_porch held 55 % of the pool and
gets 9 of the 50), then every member of each burst — 156 frames, burst sizes 2: 19 · 3: 6 · 4: 25; per camera
back_yard 10, donkey 10, front_porch 9, wash_stall 8, back_pasture 7, tractor 5, mops 1. Rows carry `burst_id` and
`seq`; the head (seq 0) is the frame a single-frame pipeline would have emitted and is the primary scoring unit.
Predictions at threshold 0.05 from all six models (the same package hashes as on `frames-ranch-v1`). Labels:
`labels-ranch-bursts-claude-v1`, Claude with **one request per burst** — the members together, about a second apart,
told to use the sequence as evidence of what an object is (`claude.ts submit-bursts`; a single-frame batch,
`msgbatch_01CBNq9y41hnogJ7NcXKJRWh`, was cancelled unprocessed because a labeler that repeats the detector's mistake on
the same static blob would score a false positive as a hit). Two Batch submissions sat at zero progress (the burst
one, `msgbatch_01KktFfQdNz1j6u7ofy5M7tk`, for 5 min; Vlad's rule: switch after 5 min), both cancelled unprocessed; the
labels were produced synchronously (`claude.ts label-bursts`, 50 requests, 3 in flight, 3.5 min, **$3.08**). 156 rows,
236 boxes (222 at confidence ≥ 0.5): person 79, car 76, horse 40, dog 19, truck 14; heads only: person 23, car 20,
horse 11. Each row carries the burst's `objects[] {id, kind, moved}` — 21 of 24 people moved, 6 of 8 horses, 0 of 20
cars, 0 of 4 donkeys, 0 of 5 tractors — a motion ground truth (`apps/detector/src/moving-agreement.ts`).
