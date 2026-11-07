"""Tier-2 harness: send an escalation set through a vision-language model served by mlx-vlm (OpenAI-compatible,
json_schema structured outputs) and write one prediction row per request.

  uv run python -m mlx_vlm.server --model mlx-community/Qwen3-VL-4B-Instruct-3bit --port 8080     # in another shell
  uv run run.py --model mlx-community/Qwen3-VL-4B-Instruct-3bit --escalations <set>/escalations.jsonl --prompt v1 [--limit N]

Every request: two images (the crop, the previous frame's crop), the prompt from prompts/<version>.md with the request's
context filled in, response_format json_schema strict over SCHEMA, temperature 0, max_tokens 128. The row keeps the
answer, whether it parsed, the latency and the server's RSS sampled during the run. Writes
<set>/predictions.vlm.<model short name>@<prompt>.jsonl beside the escalation set.
"""
import argparse
import base64
import hashlib
import io
import json
import statistics
import subprocess
import time
from pathlib import Path

from openai import OpenAI
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
TAXONOMY = json.loads((REPO / "packages/taxonomy/taxonomy.json").read_text())
KINDS = [*TAXONOMY["classes"]["animal"]["subclasses"], *TAXONOMY["classes"]["vehicle"]["subclasses"], "person", "none"]
POSTURES = TAXONOMY["classes"]["animal"]["attribute"]["values"]
GATES = TAXONOMY["scene"]["gate"]
TROUGHS = TAXONOMY["scene"]["trough"]

SCHEMA = {
    "type": "object",
    "properties": {
        "present": {"type": "boolean"},
        "kind": {"type": "string", "enum": sorted(set(KINDS))},
        "posture": {"type": ["string", "null"], "enum": [*POSTURES, None]},
        "gate": {"type": ["string", "null"], "enum": [*GATES, None]},
        "trough": {"type": ["string", "null"], "enum": [*TROUGHS, None]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["present", "kind", "posture", "gate", "trough", "confidence"],
    "additionalProperties": False,
}

HINTS = {"horse": "horse or donkey", "person": "person", "truck": "vehicle", "car": "vehicle", "dog": "dog", "cat": "cat", "bird": "bird"}


def data_url(path: Path, max_side: int) -> str:
    """The image as a JPEG data URL, downscaled so its long edge is at most max_side: a 2560-wide frame costs the
    model thousands of image tokens and tens of seconds, and the crop is small anyway."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    if max(w, h) > max_side:
        s = max_side / max(w, h)
        img = img.resize((round(w * s), round(h * s)), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def rss_mb() -> int | None:
    """The largest resident set among the mlx_vlm.server processes (the uv wrapper is tiny; the server is its child)."""
    out = subprocess.run(["pgrep", "-f", "mlx_vlm.server"], capture_output=True, text=True).stdout.split()
    if not out:
        return None
    ps = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(out)], capture_output=True, text=True).stdout.split()
    return max((int(v) // 1024 for v in ps), default=None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--escalations", required=True)
    ap.add_argument("--prompt", default="v1")
    ap.add_argument("--server", default="http://localhost:8080/v1")
    ap.add_argument("--max-side", type=int, default=1024, help="downscale request images to this long edge")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--max-tokens", type=int, default=128)
    a = ap.parse_args()
    esc_path = Path(a.escalations).resolve()
    set_dir = esc_path.parent
    prompt_path = Path(__file__).parent / "prompts" / f"{a.prompt}.md"
    template = prompt_path.read_text()
    prompt_sha = hashlib.sha256(template.encode()).hexdigest()[:12]
    requests = [json.loads(l) for l in esc_path.read_text().splitlines() if l.strip()]
    if a.limit:
        requests = requests[: a.limit]
    short = a.model.split("/")[-1]
    out_path = set_dir / f"predictions.vlm.{short}@{a.prompt}.jsonl"
    client = OpenAI(base_url=a.server, api_key="not-needed")
    lat: list[float] = []
    valid = 0
    with out_path.open("w") as out:
        for i, r in enumerate(requests):
            ctx = r["context"]
            text = template.format(
                camera=ctx["camera"], label=ctx["label"], confidence=f"{ctx['confidence']:.2f}", label_hint=HINTS.get(ctx["label"], ctx["label"]),
                kinds=", ".join(k for k in KINDS if k != "none"), postures=", ".join(POSTURES), gates=", ".join(GATES), troughs=", ".join(TROUGHS),
            )
            content = [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": data_url(set_dir / r["crop"], a.max_side)}}]
            if r.get("prev_crop"):
                content.append({"type": "image_url", "image_url": {"url": data_url(set_dir / r["prev_crop"], a.max_side)}})
            t0 = time.perf_counter()
            answer, raw, err = None, None, None
            try:
                resp = client.chat.completions.create(
                    model=a.model,
                    messages=[{"role": "user", "content": content}],
                    response_format={"type": "json_schema", "json_schema": {"name": "Escalation", "strict": True, "schema": SCHEMA}},
                    temperature=0,
                    max_tokens=a.max_tokens,
                )
                raw = resp.choices[0].message.content
                answer = json.loads(raw)
                valid += 1
            except Exception as e:  # a refusal, a schema miss or a server error is a row, not a crash
                err = str(e)[:300]
            ms = (time.perf_counter() - t0) * 1000
            lat.append(ms)
            out.write(json.dumps({"id": r["id"], "type": r["type"], "model": a.model, "prompt": a.prompt, "prompt_sha": prompt_sha, "answer": answer, "raw": None if answer else raw, "error": err, "ms": round(ms, 1), "rss_mb": rss_mb(), "max_side": a.max_side}) + "\n")
            if (i + 1) % 20 == 0 or i + 1 == len(requests):
                print(f"{i + 1}/{len(requests)} requests, {statistics.median(lat):.0f} ms p50, {valid} valid", flush=True)
    lat.sort()
    print(json.dumps({"model": a.model, "prompt": a.prompt, "prompt_sha": prompt_sha, "max_side": a.max_side, "requests": len(requests), "json_valid_rate": round(valid / max(1, len(requests)), 3),
                      "ms_p50": round(lat[len(lat) // 2], 1) if lat else None, "ms_p95": round(lat[min(len(lat) - 1, int(0.95 * len(lat)))], 1) if lat else None, "out": str(out_path)}))


if __name__ == "__main__":
    main()
