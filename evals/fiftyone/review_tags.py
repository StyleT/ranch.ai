"""Write the reviewer's sample tags from a clip dataset back into the set directory.

  uv run python review_tags.py --name clips-ranch-pool-v1 --set <repo>/evals/baseline/2026-11-06

Writes <set>/review.jsonl (one row per clip: clip_id, camera, tags) and <set>/rejected-clips.txt (the ids of every
clip tagged reject:*), the file `snapshot.ts --exclude-clips` reads when the frozen set is picked.
"""
import argparse
import json
from collections import Counter
from pathlib import Path

import fiftyone as fo


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--set", required=True)
    a = ap.parse_args()
    ds = fo.load_dataset(a.name)
    set_dir = Path(a.set).resolve()
    out = []
    rejected = []
    for s in ds.select_fields(["clip_id", "camera", "tags"]):
        tags = sorted(s.tags)
        out.append({"clip_id": s["clip_id"], "camera": s["camera"], "tags": tags})
        if any(t.startswith("reject") for t in tags):
            rejected.append(s["clip_id"])
    out.sort(key=lambda r: r["clip_id"])
    (set_dir / "review.jsonl").write_text("".join(json.dumps(r) + "\n" for r in out))
    (set_dir / "rejected-clips.txt").write_text("".join(f"{i}\n" for i in sorted(rejected)))
    counts = Counter(t for r in out for t in r["tags"])
    print(json.dumps({"clips": len(out), "rejected": len(rejected), "untagged": sum(1 for r in out if not r["tags"]), "tags": dict(counts)}))


if __name__ == "__main__":
    main()
