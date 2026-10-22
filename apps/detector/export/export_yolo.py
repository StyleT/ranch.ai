"""Export an Ultralytics YOLO detector (COCO-pretrained) to CoreML with Apple's NMS pipeline folded in, so Vision
returns VNRecognizedObjectObservation and the Swift runner needs no model-specific decoding.
Usage: uv run export_yolo.py <model> [imgsz]      e.g. yolo11n, yolo26s   -> <model>.mlpackage next to this file.
YOLO26 is NMS-free end to end; with nms=True ultralytics still wraps the one-to-many head in the NMS pipeline, which
keeps the runner contract identical across YOLO11 and YOLO26 (docs/MODEL-YOLO26.md).
"""
import sys
from ultralytics import YOLO

name = sys.argv[1] if len(sys.argv) > 1 else "yolo11n"
name = f"yolo11{name}" if name in ("n", "s", "m") else name   # old calling convention
imgsz = int(sys.argv[2]) if len(sys.argv) > 2 else 640
model = YOLO(f"{name}.pt")
out = model.export(format="coreml", nms=True, imgsz=imgsz, half=True)
print("exported", out)
