# Label sets

One JSONL per label set, one row per labeled frame, named `labels-<name>-<labeler>-vN.jsonl` with a
`.dataset.json` sidecar (id, parent, frames dataset, n, sha256, provenance). A set covers exactly one frames set
(`evals/baseline/<date>/`); any edit is a new version, never an edit in place. Rows and ids are listed in
`evals/DATASETS.md`; the naming rule is `docs/EVALUATION.md` §2.

| File | Frames set | What |
|---|---|---|
| `labels-ranch-claude-v1.jsonl` | `frames-ranch-v1` | Claude's first pass on 100 frames (superseded for scoring, kept for provenance) |
| `labels-ranch-claude-revised-vlad-v1.jsonl` | `frames-ranch-v1` | the above after Vlad's review; the scoring reference for `frames-ranch-v1` |
| `labels-ranch-bursts-claude-v1.jsonl` | `frames-ranch-bursts-v1` | Claude on 50 whole bursts (156 frames), one request per burst, with per-burst object ids and a `moved` verdict |

Box format everywhere: normalized to the image, origin top-left, `x,y` = corner, `w,h` = size. `label` is the COCO
scoring class (`horse`, `person`, `car`, `truck`, ...); the taxonomy subclass (`donkey`, `tractor`, ...) is `kind`.
Produced by `evals/label/claude.ts`; `batches/` (git-ignored) holds Batch API bookkeeping.
