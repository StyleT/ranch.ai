"""Import a baseline frames set (+ labels, + predictions) from the repo's JSONL into a FiftyOne dataset.

The JSONL files are what the TypeScript side writes on the mini (evals/baseline/snapshot.ts, evals/label/claude.ts);
FiftyOne is the store for review, sharing (Hub) and scoring. One image sample per frame; a burst is the samples that
share `burst_id`, browsed with `group_by("burst_id", order_by="seq")` (app.py).

  uv run python import_jsonl.py --set <repo>/evals/baseline/2026-10-24 \
      --labels <repo>/evals/golden/labels-ranch-bursts-claude-v1.jsonl:gt_claude --predictions yolo26s,yolo11n [--overwrite]

Paths in frames.jsonl are the mini's; images are expected under <set>/frames/<camera>/<file> (make frames-pull).
Gold detections carry kind, posture, look, confidence, object_id (Claude's per-burst id; `id` is reserved by FiftyOne),
index (its number, so the App colours one object consistently across the burst) and moved (from the burst's objects[]).
Prediction detections carry the raw label and confidence (the taxonomy mapping is applied at scoring time) plus
track/seen/dx/dy when the predictions file has them.
"""
import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import fiftyone as fo


def rows(path: Path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def sha16(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def local_image(set_dir: Path, row: dict) -> Path:
    p = set_dir / "frames" / row["camera"] / Path(row["path"]).name
    if not p.exists():
        raise SystemExit(f"missing image {p} (run: make frames-pull DATE={set_dir.name})")
    return p


def gold_detections(row: dict) -> fo.Detections:
    lab = row.get("label") or {}
    conf = {}
    for kind_key in ("animals", "people", "vehicles"):
        for g in lab.get(kind_key, []):
            key = (round(g["box"]["x"], 6), round(g["box"]["y"], 6), round(g["box"]["w"], 6), round(g["box"]["h"], 6))
            conf[key] = g.get("confidence")
    moved = {o["id"]: o.get("moved") for o in row.get("objects", [])}
    dets = []
    for b in row["boxes"]:
        key = (round(b["x"], 6), round(b["y"], 6), round(b["w"], 6), round(b["h"], 6))
        oid = b.get("id")
        m = re.search(r"\d+", oid or "")
        dets.append(fo.Detection(
            label=b["label"], bounding_box=[b["x"], b["y"], b["w"], b["h"]], confidence=conf.get(key),
            kind=b.get("kind"), posture=b.get("posture"), look=b.get("look"),
            object_id=oid, index=int(m.group()) if m else None, moved=moved.get(oid) if oid else None,
        ))
    return fo.Detections(detections=dets)


def pred_detections(dets: list[dict]) -> fo.Detections:
    out = []
    for d in dets:
        extra = {k: d[k] for k in ("track", "seen", "dx", "dy", "raw_label") if k in d}
        out.append(fo.Detection(label=d["label"], bounding_box=[d["x"], d["y"], d["w"], d["h"]], confidence=d.get("confidence"), **extra))
    return fo.Detections(detections=out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True, help="evals/baseline/<date> directory (absolute path)")
    ap.add_argument("--labels", action="append", default=[], help="<labels.jsonl>:<field>, repeatable")
    ap.add_argument("--predictions", default="", help="comma-separated model names (predictions.<model>.jsonl)")
    ap.add_argument("--name", help="FiftyOne dataset name (default: the frames dataset id)")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()

    set_dir = Path(a.set).resolve()
    ds_json = json.loads((set_dir / "dataset.json").read_text())
    manifest = json.loads((set_dir / "manifest.json").read_text())
    name = a.name or ds_json["id"]
    frames = rows(set_dir / "frames.jsonl")

    labels = {}
    for spec in a.labels:
        path, field = spec.rsplit(":", 1)
        labels[field] = {r["path"]: r for r in rows(Path(path))}
    preds = {}
    for model in [m for m in a.predictions.split(",") if m]:
        preds[model] = {r["path"]: r["detections"] for r in rows(set_dir / f"predictions.{model}.jsonl")}

    if fo.dataset_exists(name):
        if not a.overwrite:
            raise SystemExit(f"dataset {name} exists; pass --overwrite")
        fo.delete_dataset(name)
    ds = fo.Dataset(name, persistent=True)

    samples = []
    for r in frames:
        s = fo.Sample(filepath=str(local_image(set_dir, r)))
        s["camera"] = r["camera"]; s["period"] = r.get("period"); s["reason"] = r.get("reason")
        s["ts"] = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).astimezone(timezone.utc)
        s["frame_id"] = r.get("frame_id"); s["mini_path"] = r["path"]; s["source_path"] = r.get("source")
        s["burst_id"] = r.get("burst_id"); s["seq"] = r.get("seq"); s["head"] = (r.get("seq") in (None, 0))
        for field, by_path in labels.items():
            lr = by_path.get(r["path"])
            if lr is not None:
                s[field] = gold_detections(lr)
        for model, by_path in preds.items():
            if r["path"] in by_path:
                s[f"pred_{model}"] = pred_detections(by_path[r["path"]])
        samples.append(s)
    ds.add_samples(samples)
    ds.add_dynamic_sample_fields()   # declare kind/posture/object_id/moved/track/... so the App can filter on them
    ds.compute_metadata()

    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=set_dir).stdout.strip() or None
    ds.info = {
        "frames_dataset": ds_json["id"], "frames_sha16": sha16(set_dir / "frames.jsonl"), "frames_source": ds_json.get("source"),
        "labels": {field: {"file": str(Path(spec.rsplit(":", 1)[0]).name), "sha16": sha16(Path(spec.rsplit(":", 1)[0]))} for spec in a.labels for field in [spec.rsplit(":", 1)[1]]},
        "predictions": {m: {"model_sha256": (manifest.get("models", {}).get(m) or {}).get("sha256"), "sha16": sha16(set_dir / f"predictions.{m}.jsonl")} for m in preds},
        "imported_at": datetime.now(timezone.utc).isoformat(), "repo_commit": commit,
    }
    ds.save()

    summary = {"dataset": name, "samples": len(ds), "bursts": len(ds.distinct("burst_id")), "heads": ds.match({"head": True}).count() if "head" in ds.get_field_schema() else None}
    for field in labels:
        summary[field] = ds.count(f"{field}.detections")
    for m in preds:
        summary[f"pred_{m}"] = ds.count(f"pred_{m}.detections")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
