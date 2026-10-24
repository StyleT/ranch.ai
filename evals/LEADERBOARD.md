# Leaderboard (append-only)

Protocol: `docs/EVALUATION.md`. One row per result file in `evals/results/`. CI = 95 % bootstrap over frames.
`prod` marks what `com.ranch.detector` runs.

| date | tag | model | frames | labels | R@FPPF≤0.1 | horse recall @0.25 (95 % CI) | AP horse | FPPF all @0.25 | count-exact | p50 ms | RSS MB | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-20 | zero-shot | yolo11n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.00 @– | R 0.26 [0.09–0.50] | 0.26 | 0.81 | 0.85 | 8.0 | 51 | `2026-10-20-zero-shot.json` (prod until 21 Oct) |
| 2026-10-20 | zero-shot | yolo11s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.00 @– | R 0.35 [0.17–0.56] | 0.35 | 0.73 | 0.87 | 18.5 | 51 | `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.17 @0.8 | R 0.35 [0.15–0.57] | 0.42 | 1.93 | 0.84 | 31.0 | 47 | `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.17 @0.8 | R 0.35 [0.15–0.57] | 0.41 | 2.04 | 0.85 | 25.9 | 206 | `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot-labelconf05 | yolo11n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, labels conf ≥ 0.5 (20 gold) | 0.00 @– | R 0.30 [0.10–0.53] | 0.30 | 0.81 | 0.86 | | | `2026-10-20-zero-shot-labelconf05.json` |
| 2026-10-20 | zero-shot-labelconf05 | yolo11s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, labels conf ≥ 0.5 (20 gold) | 0.00 @– | R 0.40 [0.19–0.62] | 0.40 | 0.73 | 0.88 | | | `2026-10-20-zero-shot-labelconf05.json` |
| 2026-10-20 | zero-shot-labelconf05 | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, labels conf ≥ 0.5 (20 gold) | 0.20 @0.8 | R 0.40 [0.18–0.62] | 0.48 | 1.93 | 0.85 | | | `2026-10-20-zero-shot-labelconf05.json` |
| 2026-10-20 | zero-shot-labelconf05 | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, labels conf ≥ 0.5 (20 gold) | 0.20 @0.8 | R 0.40 [0.18–0.62] | 0.46 | 2.04 | 0.86 | | | `2026-10-20-zero-shot-labelconf05.json` |
| 2026-10-20 | zero-shot-labelconf05-quadruped | yolo11n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, as above + cow/sheep predictions counted as horse | 0.00 @– | R 0.55 [0.32–0.80] | 0.55 | 0.76 | 0.89 | | | `2026-10-20-zero-shot-labelconf05-quadruped.json` |
| 2026-10-20 | zero-shot-labelconf05-quadruped | yolo11s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, as above + cow/sheep predictions counted as horse | 0.00 @– | R 0.60 [0.38–0.83] | 0.59 | 0.69 | 0.88 | | | `2026-10-20-zero-shot-labelconf05-quadruped.json` |
| 2026-10-20 | zero-shot-labelconf05-quadruped | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, as above + cow/sheep predictions counted as horse | 0.35 @0.65 | R 0.60 [0.38–0.82] | 0.65 | 1.89 | 0.85 | | | `2026-10-20-zero-shot-labelconf05-quadruped.json` |
| 2026-10-20 | zero-shot-labelconf05-quadruped | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1, as above + cow/sheep predictions counted as horse | 0.30 @0.8 | R 0.60 [0.38–0.82] | 0.63 | 2.00 | 0.86 | | | `2026-10-20-zero-shot-labelconf05-quadruped.json` |
| 2026-10-20 | revised-labelconf05 | yolo11n | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 (20 gold) | 0.00 @– | R 0.30 [0.10–0.53] | 0.30 | 0.81 | 0.86 | | | `2026-10-20-revised-labelconf05.json` |
| 2026-10-20 | revised-labelconf05 | yolo11s | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 (20 gold) | 0.00 @– | R 0.40 [0.19–0.62] | 0.40 | 0.73 | 0.88 | | | `2026-10-20-revised-labelconf05.json` |
| 2026-10-20 | revised-labelconf05 | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 (20 gold) | 0.20 @0.8 | R 0.40 [0.18–0.62] | 0.48 | 1.93 | 0.85 | | | `2026-10-20-revised-labelconf05.json` |
| 2026-10-20 | revised-labelconf05 | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 (20 gold) | 0.20 @0.8 | R 0.40 [0.18–0.62] | 0.46 | 2.04 | 0.86 | | | `2026-10-20-revised-labelconf05.json` |
| 2026-10-20 | revised-labelconf05-quadruped | yolo11n | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 + cow/sheep → horse | 0.00 @– | R 0.55 [0.32–0.80] | 0.55 | 0.76 | 0.89 | | | `2026-10-20-revised-labelconf05-quadruped.json` |
| 2026-10-20 | revised-labelconf05-quadruped | yolo11s | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 + cow/sheep → horse | 0.00 @– | R 0.60 [0.38–0.83] | 0.59 | 0.69 | 0.88 | | | `2026-10-20-revised-labelconf05-quadruped.json` |
| 2026-10-20 | revised-labelconf05-quadruped | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 + cow/sheep → horse | 0.35 @0.65 | R 0.60 [0.38–0.82] | 0.65 | 1.89 | 0.85 | | | `2026-10-20-revised-labelconf05-quadruped.json` |
| 2026-10-20 | revised-labelconf05-quadruped | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | **labels-ranch-claude-revised-vlad-v1**, conf ≥ 0.5 + cow/sheep → horse | 0.30 @0.8 | R 0.60 [0.38–0.82] | 0.63 | 2.00 | 0.86 | | | `2026-10-20-revised-labelconf05-quadruped.json` |
| 2026-10-21 | **filter-v1** (taxonomy coco mapping + per-label thresholds) | yolo11n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.00 @– | R 0.55 [0.32–0.80] | 0.55 | 0.27 | 0.89 | | | `2026-10-21-filter-v1.json` (prod 21–22 Oct) |
| 2026-10-21 | **filter-v1** (taxonomy coco mapping + per-label thresholds) | yolo11s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.40 @0.85 | R 0.60 [0.38–0.83] | 0.59 | 0.17 | 0.88 | | | `2026-10-21-filter-v1.json` |
| 2026-10-21 | **filter-v1** (taxonomy coco mapping + per-label thresholds) | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.45 @0.5 | R 0.60 [0.38–0.82] | 0.65 | 0.18 | 0.85 | | | `2026-10-21-filter-v1.json` |
| 2026-10-22 | zero-shot | yolo26n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.00 @– | R 0.35 [0.15–0.56] | 0.35 | 0.63 | 0.87 | 0.0 |  | `2026-10-22-zero-shot-yolo26.json` |
| 2026-10-22 | zero-shot | yolo26s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.00 @– | R 0.40 [0.18–0.62] | 0.40 | 0.64 | 0.88 | 0.0 |  | `2026-10-22-zero-shot-yolo26.json` |
| 2026-10-22 | filter-v1 (taxonomy coco) | yolo26n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.00 @– | R 0.40 [0.19–0.64] | 0.40 | 0.19 | 0.88 | 0.0 |  | `2026-10-22-filter-v1-yolo26.json` |
| 2026-10-22 | filter-v1 (taxonomy coco) | yolo26s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-revised-vlad-v1, conf ≥ 0.5 | 0.55 @0.75 | R 0.60 [0.36–0.82] | 0.60 | 0.14 | 0.91 | 0.0 |  | **prod** `2026-10-22-filter-v1-yolo26.json` |
| 2026-10-24 | **bursts-none** (head frame as emitted: the no-bursts baseline) | yolo26s | frames-ranch-bursts-v1 (50 heads of 156) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.20 @0.95 | R 0.50 [0.14–0.86] | 0.50 | 0.12 | 0.92 | | | `2026-10-24-bursts-none.json` |
| 2026-10-24 | bursts-drop-still | yolo26s | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.40 @0.7 | R 0.40 [0.00–0.78] | 0.40 | 0.06 | 0.90 | | | `2026-10-24-bursts-drop-still.json` |
| 2026-10-24 | bursts-require-stable | yolo26s | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.10 @0.7 | R 0.10 [0.00–0.38] | 0.10 | 0.08 | 0.86 | | | `2026-10-24-bursts-require-stable.json` |
| 2026-10-24 | bursts-drop-still-person | yolo26s | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.20 @0.95 | R 0.50 [0.14–0.86] | 0.50 | 0.12 | 0.92 | | | `2026-10-24-bursts-drop-still-person.json` |
| 2026-10-24 | bursts-none | yolo11n | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.00 @– | R 0.30 [0.00–0.71] | 0.25 | 0.24 | 0.88 | | | `2026-10-24-bursts-none.json` |
| 2026-10-24 | bursts-drop-still | yolo11n | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.00 @– | R 0.20 [0.00–0.55] | 0.17 | 0.24 | 0.86 | | | `2026-10-24-bursts-drop-still.json` |
| 2026-10-24 | bursts-require-stable | yolo11n | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.10 @0.55 | R 0.10 [0.00–0.38] | 0.10 | 0.00 | 0.86 | | | `2026-10-24-bursts-require-stable.json` |
| 2026-10-24 | bursts-drop-still-person | yolo11n | frames-ranch-bursts-v1 (50 heads) | labels-ranch-bursts-claude-v1, conf ≥ 0.5 | 0.00 @– | R 0.30 [0.00–0.71] | 0.25 | 0.24 | 0.88 | | | `2026-10-24-bursts-drop-still-person.json` |

Notes 2026-10-20: 23 horse-class gold boxes (14 horses + 9 donkeys mapped to horse) in the 100 labeled frames; intervals are wide, as EVALUATION.md §4.2 warns. 12 of the 23 are missed by every model at 0.25: all seven large daytime donkeys (356–489 px wide), three animals under 120 px, one frame-filling night horse. IoU 0.3 changes nothing: misses are misses, not misplaced boxes. No model meets the FPPF ≤ 0.1 budget at any threshold except RF-DETR at 0.8 (recall 0.17).

Smoke verification of the labels, 20 Oct (42 labeled frames rendered with Claude's boxes and yolo11s's, 11 inspected
by eye): every horse-class box with labeler confidence ≥ 0.7 was a real horse or donkey, including all six large
daytime donkeys on donkey_cam. The weak spots are the 12 of 32 animal boxes Claude gave confidence 0.25–0.45: the
same dark patch at the lower-left edge of front_porch_cam is boxed as a "walking cat" in four different frames,
and three "other/unknown" boxes sit on faint blobs Claude's own notes call "possibly a shadow". Hence the
`labelconf05` variants, which drop those. Of the 12 universal horse misses, six were detected as `cow` or `dog`
(class confusion, not blindness), which the `quadruped` variant quantifies: counting cow and sheep as horse lifts
recall from 0.30–0.40 to 0.55–0.60.

Human revision, 20 Oct: Vlad reviewed the labels in the frame browser and removed every cat box (all shadows or a
static patch); everything else accepted → `labels-ranch-claude-revised-vlad-v1`, the reference labels from now on.
Horse numbers are unchanged by the revision (no horse box was touched). Per class on the revised set, yolo11s at
0.25: car recall 1.00 (28/28, 4 FP), person recall 1.00 with precision 0.42 (7 FP: night horses called person),
horse 8/20, truck 0/14 (the tractors), the 10 "other" boxes never matched.

filter-v1, 21 Oct: the production detector now applies the taxonomy mapping (docs/TAXONOMY.md): unmapped COCO
classes dropped, cow/sheep counted as horse at 0.50, person at 0.60, per-label thresholds elsewhere. Against the
reference labels, yolo11n goes from FPPF(all) 0.81 / horse recall 0.30 to 0.27 / 0.55 with no regression on any
class, so it ships (relative gate). The absolute 0.1 false-positive budget is still not met by any zero-shot
model: the remaining false boxes are `person` on yolo11n (20 in 100 frames) and they are confidence-insensitive
(14 survive at 0.98), so no threshold reaches them. They sit on a static object in the back yard by day and on
horses at night. yolo11s makes a quarter as many (7, 6 at 0.98) with higher horse recall at +10 ms per frame;
that swap is the next row to decide, with the fine-tune question.

YOLO26, 22 Oct (`docs/MODEL-YOLO26.md`): yolo26n/yolo26s exported with the same NMS pipeline, same runner. Latency
on the ANE over 300 frames (this run; the 15 Oct table used 40 night frames): yolo11n 18.2 ms p50, yolo11s 22.6,
yolo26n 17.5, yolo26s 22.6; RSS 53–54 MB for all. Under the production taxonomy, yolo26s vs yolo11n: horse recall
0.55 → 0.60, horse precision 0.85 → 0.92, FPPF(all) 0.27 → 0.14, person precision 0.17 → 0.38 at recall 1.00,
count-exact 0.89 → 0.91, day/night horse recall 0.50/0.60 → 0.50/0.70; yolo26s is the first model to reach the
0.1 false-positive budget with usable recall (R@FPPF≤0.1 = 0.55 at threshold 0.75). **Relative gate: FAIL on one
class**, dog 1/1 → 0/1 (a single gold box; both models also put one false dog on a donkey). Swapped to production
on Vlad's instruction with that recorded; yolo26n is not better than yolo11n (horse 0.40, person 2/5).

Bursts vs no-bursts, 24 Oct (`evals/results/README.md`, `docs/EVALUATION.md` §4.1): a different dataset
(`frames-ranch-bursts-v1`, 50 whole bursts) and labels made one burst per request, so these rows are not comparable
with the rows above, only with each other. `bursts-none` scores the head frame exactly as a single-frame pipeline
would emit it; the other policies remove detector tracks by their within-burst motion. **Within-burst stillness is not
a precision signal.** yolo26s on the 50 heads: `none` person P 0.95 R 0.87 (tp 20, fp 1), horse P 1.00 R 0.50, car
R 1.00; `drop-still` removes **no** false positive (fp stays 1) and deletes 5 real people, 19 of 20 real parked cars and a
standing horse (person R 0.65, car R 0.05, horse R 0.40); `require-stable` keeps only tracks seen twice and loses
most of everything (person R 0.35, horse R 0.10); `drop-still-person` = the person losses of `drop-still` with the cars
spared. All 156 frames, same shape with tighter intervals: person 0.88/0.85 → 0.87/0.67 under `drop-still` (fp 9 → 8),
horse R 0.49 [0.31–0.68] → 0.37 [0.20–0.55]. yolo11n: `require-stable` does remove all 9 of its person false positives
(P 0.65 → 1.00) at recall 0.74 → 0.26. The FPPF improvements under the policies come from deleting real objects, not
false ones. Ten gold horses on heads: the horse intervals are 70 points wide and resolve nothing; person (23 heads, 79
all) and car (20 / 76) carry the result. Sampling caveat: the pick stratifies by camera, so front_porch — where the
production fixture is read as `person` and `horse` across 18 bursts — holds 9 of 50 bursts and none of its sampled
heads carries that box above threshold for yolo26s; a per-camera fixture map is the untested follow-up. The mechanism
(`moving-agreement.ts`): labeled movers shift a median 0.148 of the frame per burst while a person is 0.03–0.07 wide,
and the tracker's IoU ≥ 0.3 gate cannot follow that, so 20 of 67 labeled objects got one-frame tracks and the `moving`
flag caught 3 of 8 movers it did track — the policies delete real objects because the tracks are fragments.
