# Leaderboard (append-only)

Protocol: `docs/EVALUATION.md`. One row per result file in `evals/results/`. CI = 95 % bootstrap over frames.
`prod` marks what `com.ranch.detector` runs.

| date | tag | model | frames | labels | R@FPPF≤0.1 | horse recall @0.25 (95 % CI) | AP horse | FPPF all @0.25 | count-exact | p50 ms | RSS MB | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-20 | zero-shot | yolo11n | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.00 @– | R 0.26 [0.09–0.50] | 0.26 | 0.81 | 0.85 | 8.0 | 51 | **prod** `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot | yolo11s | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.00 @– | R 0.35 [0.17–0.56] | 0.35 | 0.73 | 0.87 | 18.5 | 51 | `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot | rfdetr-nano-float16 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.17 @0.8 | R 0.35 [0.15–0.57] | 0.42 | 1.93 | 0.84 | 31.0 | 47 | `2026-10-20-zero-shot.json` |
| 2026-10-20 | zero-shot | rfdetr-nano-float32 | frames-ranch-v1 (100 labeled) | labels-ranch-claude-v1 | 0.17 @0.8 | R 0.35 [0.15–0.57] | 0.41 | 2.04 | 0.85 | 25.9 | 206 | `2026-10-20-zero-shot.json` |

Notes 2026-10-20: 23 horse-class gold boxes (14 horses + 9 donkeys mapped to horse) in the 100 labeled frames; intervals are wide, as EVALUATION.md §4.2 warns. 12 of the 23 are missed by every model at 0.25: all seven large daytime donkeys (356–489 px wide), three animals under 120 px, one frame-filling night horse. IoU 0.3 changes nothing: misses are misses, not misplaced boxes. No model meets the FPPF ≤ 0.1 budget at any threshold except RF-DETR at 0.8 (recall 0.17).
