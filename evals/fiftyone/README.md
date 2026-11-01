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

## Commands (from the repo root)

```
make fiftyone-install                                   # uv sync
make frames-pull DATE=2026-10-24                        # images from the mini -> evals/baseline/2026-10-24/frames/
make fiftyone-import SET=evals/baseline/2026-10-24 LABELS=evals/golden/labels-ranch-bursts-claude-v1.jsonl:gt_claude MODELS=yolo26s,yolo11n
make fiftyone NAME=frames-ranch-bursts-v1               # the App, bursts grouped as sequences
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
0.06 is expected), mapped through the taxonomy only when scoring. A burst is browsed with
`group_by("burst_id", order_by="seq")`: the grid shows one card per burst, the modal pages through its frames
(1 / 2 / 3 …) with the Explore and Annotate tabs beside the image (verified on 1.22.1, 1 Nov). Scoring runs on the
flat dataset.

## Store of truth

The Hub repo (`vladlenfedosov/ranch-frames-<set>`, private) in FiftyOne's native format is the store; each push is a
commit and `--tag` names it, so `load --revision <tag>` reproduces that state. Label variants and model predictions
are fields on the same samples, not separate files. The JSONL in `evals/` is what the TypeScript tools on the mini
produce (`snapshot.ts`, `claude.ts`) and is imported one way; the human revision of a label field is pushed as a new
revision, never edited in place.
