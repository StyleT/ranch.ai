"""Shared pieces of the pre-labeler: the taxonomy classes, the scoring-class mapping, the input policy and the
predictions row shape (the same `predictions.<model>.jsonl` rows the detector writes, so bench.ts scores a pre-label
file like any model's)."""
import json
import time
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
TAXONOMY = json.loads((REPO / "packages/taxonomy/taxonomy.json").read_text())

# The names a model is asked for, in the taxonomy's order; insects and spiders (taxonomy `ignored`) are never asked.
CLASSES: list[str] = [c for c in TAXONOMY["label_order"] if c != "other"]

# `label` is the COCO scoring class bench.ts matches on (docs/EVALUATION.md: donkey -> horse, tractor / atv /
# delivery_vehicle -> truck, every person -> person); `kind` keeps the taxonomy name.
SCORING = {"donkey": "horse", "tractor": "truck", "atv": "truck", "delivery_vehicle": "truck", "trailer": "truck"}


def scoring_label(kind: str) -> str:
    return SCORING.get(kind, kind)


# Input policy: frames go in at 1280 px on the long edge, the clip sampler's width, so the bench on the 2560-wide
# acceptance frames sees what the clip frames will.
LONG_EDGE = 1280


def load_image(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    if max(w, h) > LONG_EDGE:
        s = LONG_EDGE / max(w, h)
        img = img.resize((round(w * s), round(h * s)), Image.BILINEAR)
    return img


def box_row(label: str, kind: str, x1: float, y1: float, x2: float, y2: float, confidence: float = 1.0) -> dict | None:
    """Normalized xyxy -> the predictions box {label, kind, confidence, x, y, w, h}; None when empty after clamping."""
    x1, y1, x2, y2 = (min(1.0, max(0.0, v)) for v in (x1, y1, x2, y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return {"label": label, "kind": kind, "confidence": round(float(confidence), 4), "x": round(x1, 5), "y": round(y1, 5), "w": round(x2 - x1, 5), "h": round(y2 - y1, 5)}


def rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def local_image(set_dir: Path, row: dict) -> Path:
    """A frames row's image on the laptop: a repo-relative path as is, else <set>/frames/<camera>/<basename>."""
    p = Path(row["path"])
    if not p.is_absolute() and (REPO / p).exists():
        return REPO / p
    q = set_dir / "frames" / row["camera"] / p.name
    if not q.exists():
        raise SystemExit(f"missing image {q} (run: make frames-pull DATE={set_dir.name})")
    return q


class Timer:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *_):
        self.ms = (time.perf_counter() - self.t0) * 1000


def peak_rss_mb() -> int:
    import resource

    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024))
