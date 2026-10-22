# Plan: one class taxonomy, and a class filter + thresholds on the production detector

*Written 21 Oct 2026 for review before implementation. Scope: make classes and subclasses configurable in one
place, and use that place to stop the production detector from counting benches and bottles.*

## 1. Why one place

Class names are typed in five files today: the detector's count list (`apps/detector/src/main.ts`), the
benchmark's interest list (`apps/detector/src/score.ts`), the dashboard's label order (`apps/status/src/page.ts`),
the labeling schema (`evals/label/schema.ts`) and its COCO mapping (`toBoxes`), plus the scoring overrides passed
on the command line (`--merge-pred-classes cow=horse`). Adding `delivery_vehicle` touched three of them. The plan
is a single typed module, `packages/taxonomy`, that every consumer imports.

## 2. The taxonomy (`packages/taxonomy/src/index.ts`)

Three levels: **class** → **subclass** → optional **attribute** (posture for animals, state for the gate, level
for the trough). Subclasses are the labels humans use; classes are what the alert policy reasons about.

```
animal   : horse, donkey, dog, cat, deer, coyote, bird, other     posture: standing, grazing, drinking, walking, lying_sternal, lying_flat, unknown
person   : friendly, mailman, unknown                              look (free text)
vehicle  : car, truck, delivery_vehicle, tractor, atv, trailer, other
scene    : gate {open, closed, unknown}, trough {full, half, low, empty, unknown}, lighting {day, dusk, night_ir}
ignored  : insects, spiders (named so the rule is explicit, never boxed)
```

Adding a subclass later is one line in this file; the labeling schema, the detector filter, the scoring mapping
and the dashboard ordering are derived from it, and a unit test fails if a consumer still hard-codes a name.

## 3. Model mappings (same file)

Each detector family gets a mapping from *its* label space to a taxonomy subclass, with an explicit threshold
and a note on why. For the COCO zero-shot models:

| model label | → class/subclass | threshold | reason (from `evals/LEADERBOARD.md`) |
|---|---|---|---|
| horse | animal/horse | 0.25 | precision 1.00 at 0.25 (yolo); recall is the problem, not precision |
| cow, sheep | animal/horse | 0.50 | these are how COCO models see donkeys and dark horses; +0.20 recall; higher bar because "cow" also fires on blankets |
| dog | animal/dog | 0.40 | one gold dog; yolo put `dog` on a donkey at 0.74 |
| cat | animal/cat | 0.60 | no verified cat exists yet; keep only confident ones |
| bird | animal/bird | 0.50 | |
| bear, elephant, zebra, giraffe | animal/other | 0.50 | large-animal confusions worth seeing, not counting as horses |
| person | person/unknown | 0.60 | recall 1.00 at 0.25 with precision 0.42 (night horses as people); 0.60 keeps the real ones |
| car | vehicle/car | 0.25 | recall 1.00, precision 0.88 |
| truck, bus | vehicle/truck | 0.25 | tractors are never found as trucks (0/14), so this costs nothing today |
| motorcycle | vehicle/atv | 0.40 | |
| everything else | dropped | | bench, bottle, clock, airplane, train, toilet, suitcase: the night noise |

The reverse mapping, used only by the benchmark to score taxonomy labels against a COCO model, is derived from
the same table: donkey → horse; delivery_vehicle, tractor, atv, trailer → truck; every person subclass → person.
Thresholds are per model family and live next to the mapping, so a fine-tuned model with real `donkey` and
`tractor` outputs gets its own table and no code changes elsewhere.

**Counting and events** use classes and subclasses, never model labels: `horse_count` per minute = animals whose
subclass is horse (which, for COCO models, includes the cow/sheep mapping; the dashboard says "equine" for that
reason). Retention's "interest" set = every subclass the mapping can produce.

## 4. What changes in production

- `apps/detector`: after the runner returns raw boxes, apply the mapping and the per-label thresholds; store the
  mapped subclass as `label`, keep the model's original in a new `raw_label` column (schema v3) so confusions stay
  analyzable; drop everything unmapped before it reaches SQLite or MQTT. The runner itself keeps returning all
  classes at 0.05 for the benchmark.
- `apps/ingest` retention and `apps/status` ordering import the taxonomy instead of their lists.
- `apps/detector/src/bench.ts`: `--taxonomy <family>` applies the same mapping and thresholds the daemon uses, so
  the leaderboard scores exactly what production does; `--merge-pred-classes` goes away.
- `evals/label/schema.ts`: enums generated from the taxonomy; `toBoxes` uses the reverse mapping.

## 5. Measured before it ships (EVALUATION.md §6 gate, on `frames-ranch-v1` × `labels-ranch-claude-revised-vlad-v1`)

A leaderboard row tagged `filter-v1` for yolo11n (the production model) and yolo11s: horse R@FPPF≤0.1, AP, FPPF
all-classes, count-exact, and the per-class table. Expected from the existing runs: FPPF(all) from 0.8 to well
under 0.1 (the dropped classes were the noise), horse recall ~0.55 with the cow/sheep mapping, person precision up
from 0.42. If FPPF(all) is not under 0.1 the thresholds move, not the gate.

## 6. Out of scope here

Model swap (yolo11s costs 10 ms more per frame; decide with the fine-tune question), temporal smoothing of counts,
the VLM second opinion. Each is its own leaderboard row later.

## 7. Order of work

1. `packages/taxonomy` with tests (every consumer's names come from it; the reverse mapping is consistent).
2. Detector filter + `raw_label` migration; bench `--taxonomy`; ingest/status/schema consumers.
3. Score `filter-v1`, add the leaderboard row, provision, verify the dashboard counts for an hour.

## As built, 21 Oct

`packages/taxonomy` (classes, subclasses, attributes, scene fields, ignored, `MODEL_MAPPINGS.coco` with thresholds,
`SCORING_MAP`, `LABEL_ORDER`; tests guard consistency). Consumers: `apps/detector` (filter, `raw_label` kept,
schema v3), `apps/detector/src/bench.ts --taxonomy coco`, `apps/detector/src/score.ts` (per-label thresholds),
`apps/status` (order), `evals/label/schema.ts` (enums and reverse mapping). `RANCH_DETECTOR_FAMILY` selects the
mapping; the runner floor is 0.05 (`RANCH_DETECTOR_THRESHOLD`).

Gate result (`evals/LEADERBOARD.md`, filter-v1): shipped on the relative gate (no class regressed, FPPF(all)
0.81 → 0.27, horse recall 0.30 → 0.55). The absolute 0.1 budget is not reachable with thresholds because the
remaining false positives are confidence-insensitive `person` boxes; options are the yolo11s swap (0.17) or
suppressing static objects per camera, both separate rows.
