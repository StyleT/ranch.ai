# FiftyOne: review, sharing and scoring surface for the eval datasets

Open-source FiftyOne (Apache-2.0) on the laptop. It is the place to look at a frames set with its labels and
predictions, to revise labels in the App, to share a dataset through the Hugging Face Hub in FiftyOne's native format,
and (phase 2) to score models. Tooling only: nothing here runs on the mini, goes through Ansible, or is needed by the
daemons. Decision and research: `docs/EVALUATION.md` §2.1/§7, the 1 Nov plan.

## Layout and state

- `pyproject.toml` + `uv.lock`: a `uv` project like `apps/detector/export/`. `.venv/` is git-ignored and excluded
  from the deploy sync. Python 3.13 (`.python-version`): FiftyOne supports 3.10–3.13, not 3.14.
- FiftyOne's database (bundled MongoDB) and config live in `~/.fiftyone/`, outside the repo on purpose: the deploy
  rsyncs the repo tree to the mini. The App serves `http://localhost:5151`.
- Images: `frames.jsonl` paths are the mini's; the laptop copy is the git-ignored `evals/baseline/<date>/frames/`
  (`make frames-pull DATE=…`). After a `hub.py load`, FiftyOne fetches media from the Hub itself.
- Hub token for pushing and for loading private repos: `~/.hf.env` on the laptop (`HF_TOKEN=…`, mode 600; a token
  scoped to the dataset repos), never in the repo. The make targets source it.
- Uninstall: `rm -rf evals/fiftyone/.venv ~/.fiftyone`.
- The App outlives the terminal that started it only as orphans: `app.py` dies with the shell, its server keeps
  5151, and the bundled MongoDB stops when the last Python client exits, after which every query ends in
  `TypeError: Failed to fetch`. Launch the App from the session that will use it; a stale server must be killed before
  a new one can take 5151.

## Commands (from the repo root)

```
make fiftyone-install                                   # uv sync
make frames-pull DATE=2026-10-24                        # images from the mini -> evals/baseline/2026-10-24/frames/
make fiftyone-import SET=evals/baseline/2026-10-24 LABELS=evals/golden/labels-ranch-bursts-claude-v1.jsonl:gt_claude MODELS=yolo26s,yolo11n
make fiftyone NAME=frames-ranch-bursts-v1               # the App, bursts grouped as sequences (browse)
make fiftyone NAME=frames-ranch-bursts-v1 MODE=annotate # only for an older flat dataset; a grouped one ignores MODE
make fiftyone-push NAME=frames-ranch-bursts-v1 REPO=ranch-frames-bursts-v1 TAG=claude-v1
make fiftyone REPO=ranch-frames-bursts-v1 REV=claude-v1 # load that exact revision from the Hub, then the App
```

## Data model

One image sample per frame: `camera`, `period`, `ts`, `frame_id`, `burst_id`, `seq`, `head`, `mini_path`,
`source_path`. Label fields on the same sample: `gt_<labeler>` (e.g. `gt_claude`), `pred_<model>`. A gold detection
carries `kind`, `posture`, `look`, `confidence`, `object_id` (the labeler's per-burst id; FiftyOne reserves `id`),
`index` (its number, so the App colours one object consistently across a burst) and `moved` (the burst's verdict for
that object). A prediction carries the raw label and confidence, plus `track`, `seen`, `dx`, `dy` when the predictions
file has them (production tracker output); their labels are COCO's raw vocabulary at threshold 0.05 (a `giraffe` at
0.06 is expected), mapped through the taxonomy only when scoring.

**Bursts are a grouped dataset** (1 Nov, Vlad: annotation must work on bursts): group field `burst`, one group per
burst, one **image slice per frame named by `seq`** (`"0"` is the head, the default slice). The grid shows the head
of every burst, the modal shows the burst's slices together, and the Annotate tab edits each slice — a dynamic
`group_by` view, by contrast, has media type `group` with no slices and the App refuses to annotate it ("Only image
and 3D slices can be annotated"). Scoring selects slices: `select_group_slices("0")` = heads,
`select_group_slices(media_type="image")` = every frame; a grouped dataset iterates only its default slice, so every
count and comparison in these scripts goes through that flat selection. In the Annotate tab, "Import your dataset
schema" once to make the existing label fields and their attributes editable.

## Reviewing Claude's labels

1. Working copy, so the parent field stays as labeled:
   `uv run --directory evals/fiftyone python -c "import fiftyone as fo; fo.load_dataset('frames-ranch-bursts-v1').clone_sample_field('gt_claude','gt_vlad')"`
2. `make fiftyone NAME=frames-ranch-bursts-v1`; open a burst, Annotate tab → import the dataset schema → field
   `gt_vlad`: move/resize/delete/draw boxes, change labels, per slice; attributes (`kind`, `moved`, …) in the
   attribute editor if the schema exposes them, otherwise label tags (`wrong`, `moved`, `still`). Edits persist
   immediately, **but only when the label passes the schema's form validation** (verified 1 Nov from the database: a
   drag that fails validation moves the box on screen, logs `Form validation failed` in the browser console, sends no
   request, and MongoDB keeps the old box). The schema "Scan" caps each string attribute at ~23 distinct values and
   makes it a dropdown, so a free-text attribute (`look`, 46 values) or an enum with more values than the cap
   (`posture`, 5) fails on every label whose value was cut. Set those attributes to the Text input type in the schema
   editor, or patch the stored schema (dataset document, `label_schemas.<field>.attributes`: `component: "text"`,
   no `values`), then reload the App: the editor builds its form from the schema when it opens. Prove one edit from
   Python (`fo.load_dataset(...)`, read the detection's `bounding_box`) before annotating in earnest.
3. `make fiftyone-push NAME=frames-ranch-bursts-v1 REPO=ranch-frames-bursts-v1 TAG=revised-vlad-v1`, then the row in
   `evals/DATASETS.md`. The revision is scored in phase 2 (`evaluate.py`).

## Store of truth

The Hub repo (`vladlenfedosov/ranch-frames-<set>`, private) in FiftyOne's native format is the store; each push is a
commit and `--tag` names it, so `load --revision <tag>` reproduces that state. Label variants and model predictions
are fields on the same samples, not separate files. The JSONL in `evals/` is what the TypeScript tools on the mini
produce (`snapshot.ts`, `claude.ts`) and is imported one way; the human revision of a label field is pushed as a new
revision, never edited in place.
