"""Export an Ultralytics YOLO detector (COCO-pretrained) to CoreML for the Swift runner (apps/detector/swift/main.swift).

Two heads, two packages (docs/MODEL-YOLO26.md):
  default   Apple's NMS pipeline folded in: Vision returns VNRecognizedObjectObservation, square imgsz, no decoding.
  --e2e     YOLO26's NMS-free one-to-one head: a single `detections` output (1, max_det, 6) = x1 y1 x2 y2 score class
            in pixels of the network input, score already final; the runner decodes it. imgsz may be rectangular
            (H,W) to match the cameras' 16:9 without padding; max_det bounds the TopK baked into the graph.
Usage:
  uv run export_yolo.py yolo26s                       -> yolo26s.mlpackage (NMS pipeline, 640, fp16)
  uv run export_yolo.py yolo26s --e2e --imgsz 384,640  -> yolo26s-e2e-384x640.mlpackage + .labels.json
  options: --imgsz 640 | H,W   --max-det 100   --quantize 16|8
"""
import argparse
import json
import shutil
from pathlib import Path

import coremltools as ct
from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("model", nargs="?", default="yolo11n")
ap.add_argument("legacy_imgsz", nargs="?", help="old calling convention: a square size as the second argument")
ap.add_argument("--e2e", action="store_true", help="NMS-free end-to-end head (YOLO26)")
ap.add_argument("--imgsz", default=None, help="640 or H,W (rectangular; --e2e only)")
ap.add_argument("--max-det", type=int, default=100, help="--e2e: TopK size baked into the graph")
ap.add_argument("--quantize", type=int, default=16, help="16 = FP16 (what the ANE computes in), 8 = palettized weights")
a = ap.parse_args()

name = f"yolo11{a.model}" if a.model in ("n", "s", "m") else a.model  # old calling convention
imgsz_arg = a.imgsz or a.legacy_imgsz or "640"
imgsz = [int(v) for v in imgsz_arg.split(",")]
if len(imgsz) == 1:
    imgsz = imgsz[0]
here = Path(__file__).parent
model = YOLO(str(here / f"{name}.pt"))

if not a.e2e:
    if not isinstance(imgsz, int):
        raise SystemExit("the NMS pipeline export takes a square imgsz")
    out = model.export(format="coreml", nms=True, imgsz=imgsz, quantize=a.quantize)
    print("exported", out)
    raise SystemExit(0)

h, w = (imgsz, imgsz) if isinstance(imgsz, int) else imgsz
# ultralytics writes <stem of the .pt>.mlpackage, which for yolo26s.pt is the NMS package's name: export from a
# copy of the checkpoint under the e2e name so nothing is overwritten.
stem = f"{name}-e2e-{h}x{w}"
tmp_pt = here / f"{stem}.pt"
shutil.copyfile(here / f"{name}.pt", tmp_pt)
try:
    out = Path(YOLO(str(tmp_pt)).export(format="coreml", nms=False, imgsz=[h, w], quantize=a.quantize, max_det=a.max_det))
finally:
    tmp_pt.unlink(missing_ok=True)
target = here / f"{stem}.mlpackage"
assert out.resolve() == target.resolve(), (out, target)

# Name the single output `detections`, check the metadata, write the class sidecar the runner reads.
ml = ct.models.MLModel(str(target), skip_model_load=True)
spec = ml.get_spec()
outputs = list(spec.description.output)
assert len(outputs) == 1, [o.name for o in outputs]
old = outputs[0].name
if old != "detections":
    ct.utils.rename_feature(spec, old, "detections")
meta = dict(ml.user_defined_metadata)
assert meta.get("end2end") == "True", meta
ml2 = ct.models.MLModel(spec, weights_dir=ml.weights_dir, skip_model_load=True)
ml2.user_defined_metadata.update(meta)
ml2.user_defined_metadata["input_hw"] = f"{h}x{w}"
ml2.user_defined_metadata["max_det"] = str(a.max_det)
tmp = target.with_suffix(".tmp.mlpackage")
if tmp.exists():
    shutil.rmtree(tmp)
ml2.save(str(tmp))
shutil.rmtree(target)
tmp.rename(target)
(here / f"{name}-e2e-{h}x{w}.labels.json").write_text(json.dumps([model.names[i] for i in range(len(model.names))]) + "\n")

spec = ct.models.MLModel(str(target), skip_model_load=True).get_spec()
inp = spec.description.input[0]
o = spec.description.output[0]
print(
    json.dumps(
        {
            "exported": str(target),
            "input": {"name": inp.name, "type": inp.type.WhichOneof("Type"), "h": inp.type.imageType.height, "w": inp.type.imageType.width},
            "output": {"name": o.name, "shape": list(o.type.multiArrayType.shape)},
            "end2end": meta.get("end2end"),
            "max_det": a.max_det,
            "quantize": a.quantize,
        }
    )
)
