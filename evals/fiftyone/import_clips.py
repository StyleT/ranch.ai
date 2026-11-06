"""Import a clip set (evals/baseline/snapshot.ts --clips) into a FiftyOne video dataset for review.

One video sample per clip with the clip's fields; the App plays the mp4 and the reviewer tags each sample in the
sidebar: `keep`, or `reject:<reason>` (empty, still, insect, lighting, shake, other), optionally `note:<text>` as a
tag. `review_tags.py` writes the tags back into the set directory for `snapshot.ts --exclude-clips`.

  uv run python import_clips.py --set <repo>/evals/baseline/2026-11-06 [--overwrite]

Paths in clips.jsonl are the mini's; the mp4s are expected under <set>/frames/clips/<camera>/<file> (make frames-pull).
"""
import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import fiftyone as fo

from import_jsonl import rows, sha16


def local_clip(set_dir: Path, row: dict) -> Path:
    p = set_dir / "frames" / "clips" / row["camera"] / Path(row["path"]).name
    if not p.exists():
        raise SystemExit(f"missing clip {p} (run: make frames-pull DATE={set_dir.name})")
    return p


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True, help="evals/baseline/<date> directory (absolute path)")
    ap.add_argument("--name", help="FiftyOne dataset name (default: the clip set id)")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()

    set_dir = Path(a.set).resolve()
    ds_json = json.loads((set_dir / "dataset.json").read_text())
    if ds_json.get("kind") != "clips":
        raise SystemExit(f"{set_dir} is a {ds_json.get('kind')} set, not clips")
    name = a.name or ds_json["id"]
    clips = rows(set_dir / "clips.jsonl")

    if fo.dataset_exists(name):
        if not a.overwrite:
            raise SystemExit(f"dataset {name} exists; pass --overwrite")
        fo.delete_dataset(name)
    ds = fo.Dataset(name, persistent=True)
    samples = []
    for c in clips:
        s = fo.Sample(filepath=str(local_clip(set_dir, c)))
        s["clip_id"] = c["clip_id"]; s["camera"] = c["camera"]; s["period"] = c["period"]
        s["start_ts"] = datetime.fromisoformat(c["start_ts"].replace("Z", "+00:00")).astimezone(timezone.utc)
        s["duration_s"] = c["duration_s"]; s["stopped"] = c["stopped"]; s["preroll_s"] = c["preroll_s"]
        s["mini_path"] = c["source"]
        samples.append(s)
    ds.add_samples(samples)
    ds.compute_metadata()

    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=set_dir).stdout.strip() or None
    ds.info = {"clips_dataset": ds_json["id"], "clips_sha16": sha16(set_dir / "clips.jsonl"), "clips_source": ds_json.get("source"),
               "imported_at": datetime.now(timezone.utc).isoformat(), "repo_commit": commit}
    ds.save()
    print(json.dumps({"dataset": name, "media_type": ds.media_type, "samples": len(ds), "cameras": ds.count_values("camera"),
                      "period": ds.count_values("period")}))


if __name__ == "__main__":
    main()
