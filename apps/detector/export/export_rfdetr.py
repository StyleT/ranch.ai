"""Export RF-DETR (COCO-pretrained) to CoreML with an *image* input and ImageNet normalization folded in, so the
Swift runner can feed it through Vision like YOLO. rfdetr's own exporter emits a float tensor input instead.
Outputs: dets (1, Q, 4) normalized cx,cy,w,h and labels (1, Q, C) logits; the runner applies sigmoid + top-k.
Usage: uv run export_rfdetr.py [nano|small|medium] [float16|float32]  → rfdetr-<size>-<precision>.mlpackage
                                                                        + rfdetr-<size>-<precision>.labels.json
"""
import json
import sys
from copy import deepcopy

import coremltools as ct
import torch
import torch.nn as nn
from rfdetr import RFDETRMedium, RFDETRNano, RFDETRSmall
from rfdetr.assets.coco_classes import COCO_CLASSES
from rfdetr.export._coreml.torch_ops import ensure_coreml_torch_op_patches
from rfdetr.export.prepare import prepare_export_graph

size = sys.argv[1] if len(sys.argv) > 1 else "nano"
precision = sys.argv[2] if len(sys.argv) > 2 else "float16"
cls = {"nano": RFDETRNano, "small": RFDETRSmall, "medium": RFDETRMedium}[size]

m = cls()
res = m.model.resolution
inner = deepcopy(m.model.model).cpu()
graph = prepare_export_graph(inner, m.model_config, shape=(res, res), device="cpu")


class Wrapped(nn.Module):
    """Takes RGB in 0..1 (CoreML ImageType scale=1/255) and applies ImageNet normalization before the detector."""

    def __init__(self, det: nn.Module, means, stds):
        super().__init__()
        self.det = det
        self.register_buffer("mean", torch.tensor(means).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(stds).view(1, 3, 1, 1))

    def forward(self, x):
        out = self.det((x - self.mean) / self.std)
        if isinstance(out, dict):  # LWDETR returns {"pred_logits", "pred_boxes", ...}; export order is (dets, labels)
            return out["pred_boxes"], out["pred_logits"]
        return out


wrapped = Wrapped(graph.model, m.means, m.stds).eval()
example = graph.input_tensors
with torch.no_grad():
    outs = wrapped(example)
print("outputs:", [tuple(o.shape) for o in outs], "names:", graph.output_names, "resolution:", res)

prec = ct.precision.FLOAT16 if precision == "float16" else ct.precision.FLOAT32
inputs = [ct.ImageType(name="image", shape=tuple(example.shape), scale=1 / 255.0, color_layout=ct.colorlayout.RGB)]
outputs = [ct.TensorType(name=n) for n in graph.output_names]
# Same recipe as rfdetr's own CoreMLExporter: non-strict torch.export, decomposed to the ATen dialect, with
# rfdetr's patches to coremltools' torch op registry (bool masks, bitwise ops) applied first.
ensure_coreml_torch_op_patches()
ep = torch.export.export(wrapped, (example,), strict=False).run_decompositions({})
ml = ct.convert(ep, convert_to="mlprogram", inputs=inputs, outputs=outputs,
                minimum_deployment_target=ct.target.iOS16, compute_precision=prec)
print("converted via torch.export")

name = f"rfdetr-{size}-{precision}"
ml.short_description = f"RF-DETR {size} COCO, {res}px, {precision}, image input with ImageNet normalization folded in"
ml.save(f"{name}.mlpackage")
labels = [COCO_CLASSES.get(i, f"class_{i}") for i in range(max(COCO_CLASSES) + 1)]
with open(f"{name}.labels.json", "w") as f:
    json.dump(labels, f)
print("saved", f"{name}.mlpackage", "classes:", len(labels))
