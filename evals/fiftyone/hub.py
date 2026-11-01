"""The Hugging Face Hub as the dataset store, in FiftyOne's native format (fiftyone.utils.huggingface).

  uv run python hub.py push  --name frames-ranch-bursts-v1 --repo ranch-frames-bursts-v1 --tag claude-v1 [--fields gt_claude,pred_yolo26s]
  uv run python hub.py load  --repo ranch-frames-bursts-v1 [--revision claude-v1] [--name <local name>] [--overwrite]
  uv run python hub.py check --name frames-ranch-bursts-v1 --other frames-ranch-bursts-v1-rt   # scripted round-trip comparison

  uv run python hub.py ls    --repo ranch-frames-bursts-v1                                     # files, media, tags, privacy

HF_TOKEN comes from the environment or ~/.hf.env (RANCH_HF_ENV overrides); write access is needed for push. Repos are private.
A push is a Hub commit; --tag names it so load --revision <tag> reproduces that exact state.
"""
import argparse
import json
import os
from pathlib import Path

import fiftyone as fo
import fiftyone.utils.huggingface as fouh
from huggingface_hub import HfApi

OWNER = os.environ.get("RANCH_HF_OWNER", "vladlenfedosov")


def load_env(path: str | None = None) -> None:
    """HF_TOKEN from ~/.hf.env (RANCH_HF_ENV overrides) when not already in the environment; the file is never printed."""
    if os.environ.get("HF_TOKEN"):
        return
    p = Path(path or os.environ.get("RANCH_HF_ENV", "~/.hf.env")).expanduser()
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def ls(a) -> None:
    repo_id = a.repo if "/" in a.repo else f"{OWNER}/{a.repo}"
    api = HfApi(); info = api.dataset_info(repo_id)
    files = api.list_repo_files(repo_id, repo_type="dataset"); refs = api.list_repo_refs(repo_id, repo_type="dataset")
    print(json.dumps({"repo": repo_id, "private": info.private, "sha": info.sha[:10], "files": len(files), "media": sum(f.endswith(".jpg") for f in files),
                      "top_level": sorted({f.split("/")[0] for f in files}), "tags": [t.name for t in refs.tags], "branches": [b.name for b in refs.branches],
                      "hub_tags": [t for t in (info.tags or []) if not t.startswith("size")][:10]}))


def push(a) -> None:
    ds = fo.load_dataset(a.name)
    fields = [f for f in a.fields.split(",") if f] or [f for f in ds.get_field_schema() if f.startswith(("gt_", "pred_"))]
    fouh.push_to_hub(
        ds, a.repo, private=True, exist_ok=True, label_field=fields,
        tags=["fiftyone", "ranch"] + [t for t in a.tags.split(",") if t],
        description=a.description or f"{ds.info.get('frames_dataset', a.name)}: fields {', '.join(fields)}; {len(ds)} samples",
    )
    repo_id = f"{OWNER}/{a.repo}"
    if a.tag:
        HfApi().create_tag(repo_id, tag=a.tag, repo_type="dataset", exist_ok=True)
    print(json.dumps({"repo": repo_id, "fields": fields, "samples": len(ds), "tag": a.tag}))


def load(a) -> None:
    repo_id = a.repo if "/" in a.repo else f"{OWNER}/{a.repo}"
    ds = fouh.load_from_hub(repo_id, revision=a.revision, name=a.name, persistent=True, overwrite=a.overwrite)
    print(json.dumps({"repo": repo_id, "revision": a.revision, "dataset": ds.name, "samples": len(ds), "fields": sorted(ds.get_field_schema())}))


def check(a) -> None:
    """Field-by-field, attribute-by-attribute equality of two datasets keyed by (burst_id, seq, mini_path)."""
    x, y = fo.load_dataset(a.name), fo.load_dataset(a.other)
    key = lambda s: (s["burst_id"], s["seq"], s["mini_path"])   # noqa: E731
    bx = {key(s): s for s in x}; by = {key(s): s for s in y}
    diffs = []
    if set(bx) != set(by):
        diffs.append(f"sample keys differ: only_a={len(set(bx) - set(by))} only_b={len(set(by) - set(bx))}")
    sample_fields = [f for f in ("camera", "period", "frame_id", "burst_id", "seq", "head", "mini_path") if f in x.get_field_schema()]
    label_fields = [f for f in x.get_field_schema() if f.startswith(("gt_", "pred_"))]
    attrs = ("label", "bounding_box", "confidence", "kind", "posture", "look", "object_id", "index", "moved", "track", "seen", "dx", "dy", "raw_label")
    for k in sorted(set(bx) & set(by)):
        sa, sb = bx[k], by[k]
        for f in sample_fields:
            if sa[f] != sb[f]:
                diffs.append(f"{k} {f}: {sa[f]!r} != {sb[f]!r}")
        for f in label_fields:
            da = (sa[f].detections if sa[f] else []); db = (sb[f].detections if sb[f] else [])
            if len(da) != len(db):
                diffs.append(f"{k} {f}: {len(da)} vs {len(db)} detections"); continue
            for i, (p, q) in enumerate(zip(da, db)):
                for at in attrs:
                    va, vb = getattr(p, at, None) if hasattr(p, at) else p[at] if p.has_field(at) else None, getattr(q, at, None) if hasattr(q, at) else q[at] if q.has_field(at) else None
                    if va != vb:
                        diffs.append(f"{k} {f}[{i}].{at}: {va!r} != {vb!r}")
    print(json.dumps({"a": a.name, "b": a.other, "samples": len(bx), "label_fields": label_fields, "differences": len(diffs), "first": diffs[:10]}))
    raise SystemExit(1 if diffs else 0)


def main() -> None:
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push"); p.add_argument("--name", required=True); p.add_argument("--repo", required=True); p.add_argument("--tag"); p.add_argument("--fields", default=""); p.add_argument("--tags", default=""); p.add_argument("--description"); p.set_defaults(fn=push)
    l = sub.add_parser("load"); l.add_argument("--repo", required=True); l.add_argument("--revision"); l.add_argument("--name"); l.add_argument("--overwrite", action="store_true"); l.set_defaults(fn=load)
    c = sub.add_parser("check"); c.add_argument("--name", required=True); c.add_argument("--other", required=True); c.set_defaults(fn=check)
    s = sub.add_parser("ls"); s.add_argument("--repo", required=True); s.set_defaults(fn=ls)
    a = ap.parse_args(); load_env(); a.fn(a)


if __name__ == "__main__":
    main()
