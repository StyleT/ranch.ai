"""Export YOLO11 (COCO-pretrained) to CoreML with NMS folded in, so Vision returns VNRecognizedObjectObservation.
Usage: uv run export_yolo.py [n|s|m] [imgsz]   → yolo11<size>.mlpackage next to this file.
"""
import sys
from ultralytics import YOLO

size = sys.argv[1] if len(sys.argv) > 1 else "n"
imgsz = int(sys.argv[2]) if len(sys.argv) > 2 else 640
model = YOLO(f"yolo11{size}.pt")
out = model.export(format="coreml", nms=True, imgsz=imgsz, half=True)
print("exported", out)
