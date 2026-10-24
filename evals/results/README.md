# Benchmark results

One JSON per run, written by `apps/detector/src/bench.ts`; rows summarized in `evals/LEADERBOARD.md`. Each file
records the frames and labels dataset ids with sha256, the class mapping, threshold, IoU, commit, host and
the exact command.

## 2026-10-20-zero-shot.json (and -iou03)

Four zero-shot models on the 100 Claude-labeled frames of `frames-ranch-v1`, threshold 0.25, IoU 0.5 (0.3 in the
second file, identical recall). Headline: horse recall 0.26–0.35 with 95 % intervals spanning 0.09–0.57; the
YOLOs have perfect horse precision but 0.7–0.8 false boxes of other classes per frame, RF-DETR finds a few more
horses (AP 0.42) at ~2 false boxes per frame. By slice: day recall 0.09–0.27 (11 gold, mostly donkeys), night
0.42–0.50 (12 gold). Horses by camera in the labeled set: front_porch 8, mops 7, donkey 6, back_yard 1,
wash_stall 1, back_pasture 0, tractor 0.

What every model misses (12 of 23): the seven large daytime donkeys on donkey_cam and front_porch (COCO has no
donkey class and does not generalize `horse` to them), three animals narrower than 120 px, and one night frame
where the horse fills the picture. That list is the Post 1 "what went wrong" and the first argument for a
fine-tune with a `donkey` class.

## 2026-10-20-zero-shot-labelconf05.json and -quadruped.json

Same predictions, two scoring variants after the smoke verification of the labels (LEADERBOARD.md notes):
`--min-label-conf 0.5` keeps the 20 horse-class boxes Claude was at least half sure of (drops three hedged
ones); `--merge-pred-classes cow=horse,sheep=horse` additionally scores any large-quadruped prediction as a
horse. Recall 0.30–0.40 → 0.55–0.60; AP 0.30–0.48 → 0.55–0.65. The gap between the two is class confusion: COCO
models see donkeys as cows. The gap from 0.60 to 1.0 is real misses: animals under 100 px at night, a horse under a
blanket ("bed"), a frame-filling horse ("bottle").

## 2026-10-20-revised-labelconf05.json and -quadruped.json

Same two variants against `labels-ranch-claude-revised-vlad-v1` (Claude's labels after Vlad removed the five cat
boxes). Horse metrics identical to the `labelconf05` runs; this is now the reference. Per-class table in
LEADERBOARD.md notes: the models are solid on cars, over-eager on people at night, blind to tractors as trucks.

## 2026-10-21-filter-v1.json

The production configuration (`--taxonomy coco`): mapping and per-label thresholds from `packages/taxonomy`,
reference labels at conf ≥ 0.5. Per class for yolo11n: car 28/28 (2 FP), horse 11/20 (2 FP), dog 1/1 (1 FP),
person 4/5 but 20 FP, truck 0/14 (tractors), other 0/10. FPPF(all) 0.27, of which 0.20 is `person`.

## 2026-10-22-zero-shot-yolo26.json, -filter-v1-yolo26.json, -latency-yolo26.json

YOLO26n/s added to both scoring forms and a fresh 300-frame latency run for the four YOLOs. See LEADERBOARD.md
notes (yolo26s becomes prod; gate fails on the single dog box).

## 2026-10-24-bursts-*.json: bursts vs no-bursts on `frames-ranch-bursts-v1`

The question (docs/MODEL-YOLO26.md Part B; EVALUATION.md §4.1 "Burst track policies"): on the same head frame, does a
burst with track association change precision and recall versus the single frame the pipeline would have emitted?
Dataset: 50 whole bursts, 156 frames (DATASETS.md), labelled **one burst per request** so the labeler sees the members
together: a single still cannot tell a solid thing from IR noise or a fixture, and a labeler that repeats the
detector's mistake on the same static blob would score its false positive as a hit (Vlad, 24 Oct). The labels also
say, per object, whether it moved across the burst. Policies: `none` (the head as emitted — the no-bursts baseline),
`drop-still` (remove tracks seen ≥ 2 that moved < 2 % of the frame), `require-stable` (keep only tracks seen ≥ 2),
`drop-still-person`. Heads-only is the primary slice; `score_all_frames` in each file scores every member too.

**Before any label, two facts from the data itself.**

*What the policies remove* (`bench.ts --bursts --policy <p>` without `--labels`; yolo26s, head boxes above the
production threshold): `drop-still` removes 20 of 22 back_yard `car` boxes (parked cars), 1 of 5 front_porch `horse`
(standing), 4 of 7 wash_stall `person`, 1 of 4 donkey_cam `person`; `require-stable` removes 4 of 5 front_porch
`horse` and all 10 back_yard `person` boxes, because each appears in one frame of its burst. yolo11n shows the same
shape (20/20 cars, 8/8 back_yard and 8/8 front_porch persons under `require-stable`). So "still for one to four
seconds" also describes parked cars, standing horses and a person bent over a feed bag; the labels decide how much of
what each policy removes was real.

*Where still boxes recur* (production DB, 22–24 Oct, 519 bursts; still = seen ≥ 2 and displacement < 2 %; centres
on a 0.05 grid):
```
sqlite3 -readonly ranch-events.sqlite "SELECT f.camera, d.label, ROUND((d.x+d.w/2)*20)/20, ROUND((d.y+d.h/2)*20)/20,
  COUNT(DISTINCT f.burst_id) bursts, COUNT(*) FROM detections d JOIN frames f ON f.id=d.frame_id
  WHERE d.seen>=2 AND (d.dx*d.dx+d.dy*d.dy)<0.0004 GROUP BY 1,2,3,4 HAVING bursts>=4 ORDER BY bursts DESC"
```
front_porch (0.55, 0.30): the same still box in **18 distinct bursts as `horse` (conf 0.83) and 18 as `person`
(conf 0.98)**, plus `person` at (0.55, 0.25) in 17 — one fixture read as two species (a crop of one of these frames
shows an empty dark patch; the real person in that frame stands elsewhere). But recurrence is not proof of a
fixture either: front_porch `horse` at (0.60, 0.30) and (0.60, 0.40) recur in 13 bursts each (horses stand at a
favourite spot), and wash_stall `person` at (0.60, 0.20) in 8 (a crop shows a real person at the feed bag, standing
still). The within-burst signal cannot separate these; whether cross-burst persistence can is a follow-up
measurement, not this one.

Sampling note: the pick stratifies bursts by camera × day/night, so front_porch holds 9 of the 50 bursts against
55 % of the pool, and none of the sampled porch heads carries the fixture's `person` box above threshold for yolo26s
(≈ 1.4 expected). The fixture's effect on `person` precision is therefore under-represented here.

**Scored (labels `labels-ranch-bursts-claude-v1`, conf ≥ 0.5; `--taxonomy coco`; one file per policy, both models).**
yolo26s, heads only (50 frames; gold person 23, car 20, horse 10):

| policy | person P / R (tp/fp/fn) | horse P / R [95 % CI] | car P / R | FPPF(all) | count-exact |
|---|---|---|---|---|---|
| none (no-bursts baseline) | 0.95 / 0.87 (20/1/3) | 1.00 / 0.50 [0.14–0.86] | 0.80 / 1.00 | 0.12 | 0.92 |
| drop-still | 0.94 / 0.65 (15/1/8) | 1.00 / 0.40 [0.00–0.78] | 0.33 / 0.05 | 0.06 | 0.90 |
| require-stable | 1.00 / 0.35 (8/0/15) | 1.00 / 0.10 [0.00–0.38] | 0.83 / 1.00 | 0.08 | 0.86 |
| drop-still-person | 0.94 / 0.65 (15/1/8) | 1.00 / 0.50 [0.14–0.86] | 0.80 / 1.00 | 0.12 | 0.92 |

All frames (156; gold person 79, car 76, horse 35): none person 0.88 / 0.85 (67/9/12), horse 0.81 / 0.49 [0.31–0.68],
car 0.86 / 1.00, FPPF 0.16; drop-still person 0.87 / 0.67 (53/8/26), horse 0.87 / 0.37 [0.20–0.55], car 0.38 / 0.04,
FPPF 0.10; require-stable person 0.97 / 0.41, horse 0.75 / 0.17. yolo11n, heads: none person 0.65 / 0.74 (17/9/6);
drop-still 0.59 / 0.57 (13/9/10); require-stable 1.00 / 0.26 (6/0/17); all frames none 0.79 / 0.72 (57/15/22),
require-stable 0.96 / 0.29 (23/1/56).

**Reading.** The hypothesis was that a box which is seen twice and does not move is a fixture. With labels that saw the
burst, it is not: `drop-still` removed zero of yolo26s's false positives and 5 real people, 19 real parked cars and a
standing horse. `require-stable` removed every one of yolo11n's nine false people — they are one-frame flickers — but
two thirds of the real ones with them. Every FPPF improvement under a policy is real objects deleted, not false ones.
The 1–4 s within-burst displacement therefore does not carry precision information for tier 1; what the bursts do
carry is a motion ground truth (`objects[].moved`) and a per-object motion signal for the event layer (a horse still
across many bursts, a person moving), which is where Phase 2 uses it. Ten gold horses on the heads make every horse
interval ~70 points wide; person and car carry the result. The untested follow-up is a per-camera fixture map from
cross-burst recurrence (the porch (0.55, 0.30) cell above), which this sample under-represents by construction.

**Why the policies fail: the tracker cannot follow a walking person** (`apps/detector/src/moving-agreement.ts`, the
detector's `moving` flag against the labeler's per-object `moved`; yolo26s, 67 labeled objects at conf ≥ 0.5):
17 objects had no detector track at all (5 horses, 5 trucks, 4 dogs, 3 people: misses); **20 had only one-frame
tracks** (13 of the 24 people); of the 30 with a stable track the flag agreed with the label on 24 (80 %), but caught
only 3 of the 8 that moved (5 moving objects flagged still; 1 parked car flagged moving). Labeled objects that moved
shifted a median **0.148 of the frame** across their burst (still ones: 0.000; only 6 of 34 movers shifted under
the 0.02 threshold), while a person on these cameras is 0.03–0.07 of the frame wide: the association gate — same
label, IoU ≥ 0.3 between consecutive 1-second frames — cannot follow anything that moves more than its own width per
second, so a walking person becomes a chain of one-frame tracks. Hence `require-stable` deletes the moving real
objects and `drop-still` deletes the still real ones. yolo11n: the same picture (23 unmatched, 16 one-frame, 86 %
agreement on 28). The threshold is not the problem; the gate is. A centre-distance gate scaled by box size, or a
motion prior, is the fix to evaluate next — on this same dataset, whose labels now say what moved.
