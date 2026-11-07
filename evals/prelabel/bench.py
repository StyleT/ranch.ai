"""Run a local pre-labeler over a frames set and write its predictions file beside frames.jsonl, so bench.ts scores it
like any model's (`--predictions evals/baseline/<date>/predictions.<model>[@variant].jsonl`).

  uv run bench.py --model qwen3vl|rexomni|florence|moondream --set <repo>/evals/baseline/2026-10-20 [--limit N]
                  [--only-labeled <labels.jsonl>]   # the acceptance frames only: the rows of that labels file
                  [--server-model mlx-community/Qwen3-VL-4B-Instruct-3bit]   # qwen3vl: the build mlx_vlm.server is serving
                  [--weights bf16|awq]              # rexomni: the checkpoint

Prints seconds per frame (p50 / p95), peak RSS and the box count; the prompts and settings go into the file's first
row as provenance.
"""
import argparse
import json
import statistics
from pathlib import Path

from common import Timer, load_image, local_image, peak_rss_mb, rows
from models import make


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["qwen3vl", "rexomni", "florence", "moondream"])
    ap.add_argument("--set", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--threshold", type=float, help="moondream: the detect threshold (model default 0.30)")
    ap.add_argument("--task", default=None, help="florence: <CAPTION_TO_PHRASE_GROUNDING> (default) or <OPEN_VOCABULARY_DETECTION>")
    ap.add_argument("--server-model", help="qwen3vl: the Hugging Face id mlx_vlm.server was started with")
    ap.add_argument("--server", help="qwen3vl: the server's base URL (default http://localhost:8080/v1)")
    ap.add_argument("--weights", choices=["bf16", "awq"], help="rexomni: the checkpoint, IDEA-Research/Rex-Omni (bf16, default) or Rex-Omni-AWQ dequantized")
    ap.add_argument("--only-labeled", help="a labels.jsonl: run on its frames only")
    a = ap.parse_args()
    set_dir = Path(a.set).resolve()
    frames = rows(set_dir / "frames.jsonl")
    if a.only_labeled:
        labeled = {r["path"] for r in rows(Path(a.only_labeled))}
        frames = [f for f in frames if f["path"] in labeled]
    if a.limit:
        frames = frames[: a.limit]
    kw = {}
    if a.model == "moondream" and a.threshold is not None:
        kw["threshold"] = a.threshold
    if a.model == "florence" and a.task:
        kw["task"] = a.task
    if a.model == "qwen3vl":
        kw.update({k: v for k, v in (("server_model", a.server_model), ("server", a.server)) if v})
    if a.model == "rexomni" and a.weights:
        kw["weights"] = a.weights
    model = make(a.model, **kw)
    name = model.name + model.variant
    out_path = set_dir / f"predictions.{a.model}{model.variant}.jsonl"
    ms: list[float] = []
    n_boxes = 0
    with out_path.open("w") as out:
        for i, f in enumerate(frames):
            img = load_image(local_image(set_dir, f))
            with Timer() as t:
                dets = model.detect(img)
            ms.append(t.ms)
            n_boxes += len(dets)
            row = {"frame_id": f.get("frame_id"), "path": f["path"], "camera": f["camera"], "ts": f.get("ts"), "model": name, "ms": round(t.ms, 1), "detections": dets}
            if i == 0:
                row["provenance"] = {"prompts": model.prompts, "input_long_edge": 1280, "settings": kw, "input_size": getattr(model, "input_size", None)}
            out.write(json.dumps(row) + "\n")
            if (i + 1) % 10 == 0 or i + 1 == len(frames):
                print(f"{i + 1}/{len(frames)} frames, {n_boxes} boxes, {statistics.median(ms) / 1000:.2f} s/frame p50", flush=True)
    model.close()
    ms.sort()
    print(json.dumps({
        "model": name, "frames": len(frames), "boxes": n_boxes, "out": str(out_path.relative_to(Path.cwd().resolve())) if out_path.is_relative_to(Path.cwd().resolve()) else str(out_path),
        "s_per_frame_p50": round(ms[len(ms) // 2] / 1000, 2), "s_per_frame_p95": round(ms[min(len(ms) - 1, int(0.95 * len(ms)))] / 1000, 2), "peak_rss_mb": peak_rss_mb(),
        "invalid_answers": getattr(model, "invalid", None),
    }))


if __name__ == "__main__":
    main()
