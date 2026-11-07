"""Stage 1 of the labeling: pre-label every frame of a clip frames set (frames-ranch-clips-v1) with the qualified local
model. Writes predictions.<model>.jsonl beside frames.jsonl with clip_id / frame_idx / t_s copied from each frame row,
plus one clip-level row per clip ({"clip_id", "classes": [...]}, no detections) listing the classes seen in any frame.
Resumable: frames already in the output are skipped, so a run survives a sleep or a crash.

  uv run prelabel.py --model qwen3vl|rexomni --set <repo>/evals/baseline/2026-11-06-1fps [--limit-clips N] [--server-model <hf id>] [--weights bf16|awq]
  uv run prelabel.py --review-sample --set ... [--per-cell 10]   # 7 cameras x day/night x N frames for the human check
"""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

from common import Timer, load_image, local_image, peak_rss_mb, rows


def review_sample(set_dir: Path, per_cell: int, seed: int = 20261106) -> None:
    frames = rows(set_dir / "frames.jsonl")
    cells: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in frames:
        cells[(f["camera"], f["period"])].append(f)
    rnd = random.Random(seed)
    picked = []
    for key in sorted(cells):
        pool = cells[key]
        rnd.shuffle(pool)
        picked.extend(pool[:per_cell])
    out = set_dir / "prelabel-review-sample.jsonl"
    out.write_text("".join(json.dumps({"frame_id": f["frame_id"], "clip_id": f["clip_id"], "frame_idx": f["frame_idx"], "path": f["path"], "camera": f["camera"], "period": f["period"]}) + "\n" for f in picked))
    print(json.dumps({"sample": str(out), "frames": len(picked), "cells": len(cells), "per_cell": per_cell, "seed": seed}))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["qwen3vl", "rexomni", "florence", "moondream"])
    ap.add_argument("--set", required=True)
    ap.add_argument("--limit-clips", type=int)
    ap.add_argument("--threshold", type=float)
    ap.add_argument("--server-model", help="qwen3vl: the Hugging Face id mlx_vlm.server was started with")
    ap.add_argument("--weights", choices=["bf16", "awq"], help="rexomni: the checkpoint")
    ap.add_argument("--review-sample", action="store_true")
    ap.add_argument("--per-cell", type=int, default=10)
    a = ap.parse_args()
    set_dir = Path(a.set).resolve()
    if a.review_sample:
        review_sample(set_dir, a.per_cell)
        return
    if not a.model:
        raise SystemExit("--model is required")
    from models import make

    frames = rows(set_dir / "frames.jsonl")
    if a.limit_clips:
        keep = sorted({f["clip_id"] for f in frames})[: a.limit_clips]
        frames = [f for f in frames if f["clip_id"] in keep]
    kw = {"threshold": a.threshold} if (a.model == "moondream" and a.threshold is not None) else {}
    if a.model == "qwen3vl" and a.server_model:
        kw["server_model"] = a.server_model
    if a.model == "rexomni" and a.weights:
        kw["weights"] = a.weights
    model = make(a.model, **kw)
    name = model.name + model.variant
    out_path = set_dir / f"predictions.{a.model}{model.variant}.jsonl"
    done: dict[int, dict] = {}
    if out_path.exists():
        for r in rows(out_path):
            if "detections" in r:
                done[r["frame_id"]] = r
    todo = [f for f in frames if f["frame_id"] not in done]
    print(f"{len(done)} frames already labeled, {len(todo)} to go", flush=True)
    ms: list[float] = []
    with out_path.open("a") as out:
        for i, f in enumerate(todo):
            img = load_image(local_image(set_dir, f))
            with Timer() as t:
                dets = model.detect(img)
            ms.append(t.ms)
            row = {"frame_id": f["frame_id"], "clip_id": f["clip_id"], "frame_idx": f["frame_idx"], "t_s": f["t_s"], "path": f["path"], "camera": f["camera"], "ts": f.get("ts"), "model": name, "ms": round(t.ms, 1), "detections": dets}
            if not done and i == 0:
                row["provenance"] = {"prompts": model.prompts, "input_long_edge": 1280, "settings": kw}
            out.write(json.dumps(row) + "\n")
            out.flush()
            done[f["frame_id"]] = row
            if (i + 1) % 50 == 0 or i + 1 == len(todo):
                print(f"{i + 1}/{len(todo)} frames, {statistics.median(ms) / 1000:.2f} s/frame p50", flush=True)
    model.close()
    # Clip-level rows: rewritten every run from the frame rows, so they are never stale.
    frame_rows = [r for r in rows(out_path) if "detections" in r]
    classes: dict[int, set[str]] = defaultdict(set)
    for r in frame_rows:
        classes[r["clip_id"]].update(d["kind"] for d in r["detections"])
    clip_rows = [{"clip_id": c, "model": name, "classes": sorted(classes[c])} for c in sorted({r["clip_id"] for r in frame_rows})]
    out_path.write_text("".join(json.dumps(r) + "\n" for r in frame_rows + clip_rows))
    print(json.dumps({"model": name, "frames": len(frame_rows), "clips": len(clip_rows), "out": str(out_path), "s_per_frame_p50": round(statistics.median(ms) / 1000, 2) if ms else None, "peak_rss_mb": peak_rss_mb()}))


if __name__ == "__main__":
    main()
