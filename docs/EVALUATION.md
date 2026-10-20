# Evaluation standards and benchmark protocol

*Written 20 Oct 2026, before the first labels exist. This is the contract every model, threshold, prompt or
pipeline change is measured against. PLAN.md principle 2: no detector or prompt ships without a score on the
golden set; every model swap is a post.*

## 1. Principles

1. **Same frames, always.** Comparisons are only valid on an identical frozen frame set. Sets are immutable once
   written; a new set gets a new date and both are kept.
2. **Labels are data with provenance.** Every label row says who made it (model id or `human:vlad`), when, and
   from what batch. AI labels and human labels are different columns, never merged silently.
3. **One number is never enough.** Every run reports the full table in §4; a headline metric is quoted only with
   its slice and its confidence interval.
4. **Report the operating point.** Thresholds are chosen on a validation slice and reported at fixed targets
   (§4.3); "it has higher mAP" is not a shipping argument on its own.
5. **Reproducible from the repo.** A result file names the set, the labels file, the model package hash, the
   commit, the machine and the command. Anyone with the mini can re-run it.
6. **Evidence over narrative** (the 16–19 Oct lesson): results are JSON files written by the benchmark, quoted
   from, never retyped.

## 2. Datasets: named, versioned, registered

**Every dataset has an id of the form `<kind>-<name>-v<N>`** and a row in the registry `evals/DATASETS.md`
(append-only). Nothing is evaluated against "the frames" or "the labels"; results name the dataset ids they used.

| Kind | Id pattern | What it is | Versioning rule |
|---|---|---|---|
| `frames` | `frames-<name>-vN` | an immutable set of images + `frames.jsonl` | a new version whenever membership changes (v2 may extend v1; v1 stays and stays scorable) |
| `labels` | `labels-<name>-<labeler>-vN` | annotations over exactly one `frames` dataset | new version on any label edit, schema change or relabel; the file keeps the frames id it covers |
| `preds` | `preds-<frames id>-<model>-<sha8>` | one model's output over one frames dataset | not hand-versioned: identified by the model package sha256; re-running the same model on the same frames must reproduce it |
| `events` (Phase 3) | `events-<name>-vN` | event rows and sequences with human verdicts | as `frames` |

Each dataset directory carries a `dataset.json` with: `id`, `kind`, `version`, `created`, `parent` (the frames id
for labels/preds, the previous version for extensions), `n`, `sha256` of the data file(s), `source` (query,
seed, window), `host`, `commit`. The registry row repeats id, created, n, parent and the sha256 so a dataset can
be verified against the registry.

### 2.1 The Hub is the dataset remote (like GitHub for code)

Every dataset is pushed to the Hugging Face Hub, versions as git tags, the same way code goes to `origin main`:

- One Hub dataset repo per family: `vladlenfedosov/ranch-frames` holds every `frames-*` version with its images,
  `frames.jsonl`, `dataset.json`, `manifest.json`, the `predictions.*.jsonl` produced on it and `images/`; labels
  go into the same repo under `labels/` because they are meaningless without the frames. Layout:
  `frames-ranch-v1/{frames.jsonl,dataset.json,manifest.json,predictions.*.jsonl,README.md,images/<camera>/*.jpg}`,
  `labels/labels-ranch-claude-v1.jsonl`, …
- A dataset is *registered* only once it is on the Hub: the registry row's last column is the Hub URL and the
  tag. `make dataset-push ID=frames-ranch-v1 DIR=evals/baseline/2026-10-20` uploads the directory (images
  included) and creates the tag `frames-ranch-v1`; re-running it is a no-op for unchanged files.
- **Private by default.** The frames show the house, the cars and whoever walks by. Flipping the repo to public
  is a one-line settings change once the frames are reviewed for faces and plates; Post 1 can link to it then.
- The dataset card (`README.md` in the dataset directory) is written with the data and uploaded with it:
  what the frames are, how they were picked, the label schema, the privacy note, the license.
- Tooling: `hf` CLI (`huggingface_hub`, installed on the mini by Ansible as a `uv` tool). The write token lives on
  the mini in `~/.config/ranch/hf.env` (mode 600, like the other device secrets), never in the repo and never
  on the laptop. `make dataset-push` runs the upload over SSH on the mini, where the images already are; the
  JSONL comes from the deployed working-tree copy. Images land under `<id>/images/<camera>/`.

Current datasets:

| Id | What | Where |
|---|---|---|
| `frames-ranch-v1` | 300 frames, seeded 20261020, stratified camera × day/night from the 7-day pool of kept frames | Hub: `vladlenfedosov/ranch-frames` tag `frames-ranch-v1` (private); repo: `evals/baseline/2026-10-20/`; images on the mini `/usr/local/ranch/media/baseline/2026-10-20/` (never pruned), laptop copy git-ignored |
| `preds-frames-ranch-v1-<model>-<sha8>` | yolo11n, yolo11s, rfdetr-nano fp16/fp32 at threshold 0.05 | same directory, `predictions.<model>.jsonl` |
| `labels-ranch-claude-v1` | *planned*: Claude on 100 frames of `frames-ranch-v1` | `evals/golden/labels-ranch-claude-v1.jsonl` |
| `labels-ranch-vlad-v1` | *planned, Phase 1b*: human, same 100 frames, blind | `evals/golden/labels-ranch-vlad-v1.jsonl` |

**Stratification.** Camera × day/night (day = 07:00–17:59 local) is the minimum. From Phase 3 on, also event
class and "hard" slices: night IR at distance, rain/fog, the lens-cobweb frames, cameras with poor signal.
Frames per bucket are reported with every result so an empty bucket is visible.

**Label schema** (`evals/label/schema.ts`): boxes normalized to the image, origin top-left, `x,y,w,h` in 0..1;
`animals[]` with `kind` (horse, donkey, dog, cat, deer, coyote, bird, other) and `posture` (standing, grazing,
walking, lying_sternal, lying_flat, unknown); `people[]`, `vehicles[]` (car, truck, tractor, atv, trailer,
other); `gate {visible, state}`, `trough {visible, level}`; free-text `notes`. Each row carries `labeler`,
`labeled_at`, `batch_id`, `frame_id`, `path`, `camera`, `ts`, `period`.

**Class mapping for COCO detectors** (zero-shot models only know COCO): donkey → `horse`; tractor, atv,
trailer → `truck`; everything else by name. The mapping is part of the result file so a fine-tuned model with
real `donkey`/`tractor` classes can be scored both ways.

**Splits.** Nothing is trained on anything yet. When fine-tuning starts: train/val/test split by *time and
camera* (whole days held out, never random frames from the same minute), test = a golden set that is never
trained on and never used to pick thresholds. `frames-ranch-v1` and its labels are test data from day one.

## 3. What gets evaluated

| Tier | Unit | Ground truth |
|---|---|---|
| 1 detector (Core ML) | boxes per frame | golden boxes |
| 1 counter | horse count per frame, per minute | count of golden horse boxes |
| 2 VLM (Phase 2) | structured JSON per frame or crop | golden posture / gate / trough fields |
| 3 escalation (Phase 2) | Claude verdict per event | human verdict on the event |
| events (Phase 2–3) | event rows with type and time | human verdicts (`events.verdict`) and the event set |
| digest (Phase 3) | nightly text | LLM judge calibrated on 50 human-scored items |
| labeling itself (Phase 1b) | AI labels | human labels on the same frames |

## 4. Metrics and how they are computed

### 4.1 Detection (tier 1)
- Matching: per class, predictions sorted by confidence, greedy one-to-one match to golden boxes at IoU ≥ 0.5
  (also reported at 0.3 for the small-at-distance case). Unmatched prediction = FP, unmatched golden = FN.
- Per class and per slice: precision, recall, F1 at the operating threshold; AP (area under the PR curve from
  the 0.05-threshold predictions); **false positives per frame (FPPF)** for the interest classes and for *all*
  classes (the "bench" problem is an all-classes number).
- Horse count: MAE and the share of frames with the exact count, per camera.
- Latency p50/p95 and runner RSS on the Neural Engine, as already measured in `evals/detector/README.md`.

### 4.2 Confidence intervals
300 frames is small. Every headline number carries a 95 % bootstrap interval over frames (1,000 resamples).
Two runs differ only if their intervals do not overlap or a paired bootstrap of the difference excludes zero.
With ~50 golden horse boxes, recall differences under ~10 points will not be resolvable; say so rather than
rank.

### 4.3 Operating points
Reported for every detector run, chosen on the validation slice (or, until there is one, stated as chosen on
the test set and flagged as optimistic):
- **R@FPPF≤0.1**: horse recall when all-class false positives are at most 0.1 per frame.
- **R@P90**: horse recall at 90 % horse precision.
- **Count-exact@threshold**: share of frames with the exact horse count at the chosen threshold.

### 4.4 Later tiers (defined now so the result files have the fields)
- VLM fields: accuracy per field; JSON-valid rate; latency and memory; agreement with Claude on the same frames.
- Events: precision/recall per event class against verdicts; time from first frame to event; alert precision
  for the two paging classes (`horse_down_prolonged`, `person_present`).
- Digest: judge score 1–5 with the human calibration set's agreement (Spearman) reported next to it.
- Labeling (1b): per-class precision/recall of AI boxes against human boxes at IoU 0.5, mean IoU of matched
  boxes, field agreement for posture/gate/trough, and **whether the detector ranking changes** when scored on
  human instead of AI labels.

## 5. The benchmark run

```
node apps/detector/src/bench.ts --frames evals/baseline/<date>/frames.jsonl --labels evals/golden/labels-<name>-<labeler>-vN.jsonl \
  --model /usr/local/ranch/models/<m>.mlpackage [...] --compute ane --threshold 0.05 --out evals/results/<date>-<tag>.json
```
`bench.ts` is extended to produce §4.1–4.3 (per-slice metrics, AP, FPPF, bootstrap CIs, operating points)
and to read predictions files (`--predictions evals/baseline/<date>/predictions.<model>.jsonl`) so a set can
be re-scored without re-running the model. A result file records: the frames and labels dataset ids and their sha256, model
package sha256, class mapping, commit, macOS and go2rtc/bridge versions, host, command line, timestamp.

**Approaches, not just models.** Anything that changes what tier 1 sees or outputs is a run with a `tag`: input
resolution (640 vs 1280 letterbox vs tiles), SD vs HD source, class filter, threshold, temporal smoothing of
counts, VLM-on-crop second opinion, fine-tuned weights. Same frames, same table.

## 6. Leaderboard and gates

`evals/LEADERBOARD.md` is append-only: one row per result file with date, tag, model, frames id, labels id, R@FPPF≤0.1
with CI, AP(horse), FPPF(all), count-exact, p50 ms, RSS, link to the JSON. The current production model is marked.

A change ships to tier 1 only if, on the same set and labels: horse R@FPPF≤0.1 does not drop (paired bootstrap),
FPPF(all) does not rise, and night-slice horse recall does not drop. From Phase 3 this gate runs in CI on the
mini's self-hosted runner and fails the PR.

## 7. Label production and review

1. **Now (Phase 1):** Claude (`claude-opus-5-5`, Batch API, structured outputs) labels 100 of `frames-ranch-v1`
   → `labels-ranch-claude-v1`,
   balanced over camera × period. These are the only labels until Post 1. Every row keeps the raw structured
   output so the schema can evolve without relabeling.
2. **Phase 1b:** Vlad labels the same 100 blind, in a small local page that shows the frame without boxes.
   Disagreements are reviewed together; the review protocol for Phase 3 (full review vs spot checks per class)
   is decided from the agreement numbers. → `labels-ranch-vlad-v1`.
3. **Phase 3:** 300–500 frames, Claude first pass, human review per the protocol; stored as
   `labels.human.<date>.jsonl`, with the AI pass kept beside it.

## 8. What is deliberately not measured yet
Tracking across frames, re-identification of individual horses, and anything on the SD sub-stream. They get a
section here when they get a tier.

## 9. Next actions
1. Extend `bench.ts` per §5 (slices, AP, FPPF, bootstrap, operating points, `--predictions`).
2. Create `evals/LEADERBOARD.md`; row 0 = the four zero-shot models on `frames-ranch-v1` once labels exist.
3. Run the Claude labeling batch on 100 frames (`evals/label/claude.ts --n 100`), ~$1.60.
4. Score all four models; write Post 1's table from the JSON.
