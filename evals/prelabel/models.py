"""The two local pre-labelers behind one interface: `Labeler.detect(image) -> list[box_row]`.

Moondream 3.1 9B-A2B through Photon (Metal on Apple silicon; weights from Hugging Face on first run; no API key for a
base model): one presence `query` naming the taxonomy classes, then one `detect` per class the answer names. Boxes
carry no confidence (written as 1.0); the model's own detect threshold (0.30 by default) is the operating point.
Florence-2 Large through transformers (native class, MPS fp16): one `<CAPTION_TO_PHRASE_GROUNDING>` call with every
class phrase; boxes carry no confidence either.
"""
import json
import re

from PIL import Image

from common import CLASSES, box_row, scoring_label

PRESENCE_QUESTION = (
    "Which of these are visible in this image: " + ", ".join(CLASSES) + "? "
    "Answer with a JSON array of the visible names, or [] if none."
)
FLORENCE_TASK = "<CAPTION_TO_PHRASE_GROUNDING>"
FLORENCE_PHRASES = " ".join(f"{c}." for c in CLASSES)


class Moondream:
    name = "moondream3.1-9B-A2B"

    def __init__(self, max_objects: int = 20, threshold: float | None = None):
        import moondream as md

        # Photon's engine (kestrel) compares torch devices by identity and PyTorch reports MPS tensors on `mps:0` while a
        # bare "mps" resolves to an unindexed device (m87-labs/moondream#391: "preallocated k_scale_tensor must be a
        # device FP32 scalar"); asking for the indexed device keeps the pool, the runtime and the tensors equal.
        import torch

        # The "generated" decode path (the CUDA megakernel) asks torch.cuda for device properties, so MPS runs the
        # native decode path.
        opts = {"device": "mps:0", "decode_path": "native"} if torch.backends.mps.is_available() else {}
        self.model = md.vl(local=True, model="moondream3.1-9B-A2B", **opts)
        self.max_objects = max_objects
        self.threshold = threshold
        self.variant = f"@t{threshold}" if threshold is not None else ""
        self.prompts = {"presence": PRESENCE_QUESTION, "detect": "<class name>"}

    def present(self, enc) -> list[str]:
        ans = self.model.query(enc, PRESENCE_QUESTION, reasoning=False, settings={"temperature": 0, "max_tokens": 64})["answer"]
        m = re.search(r"\[.*?\]", ans, re.S)
        try:
            names = json.loads(m.group()) if m else []
        except ValueError:
            names = []
        return [n for n in CLASSES if n in {str(v).strip().lower() for v in names}]

    def detect(self, image: Image.Image, classes: list[str] | None = None) -> list[dict]:
        enc = self.model.encode_image(image)
        out = []
        settings = {"max_objects": self.max_objects}
        if self.threshold is not None:
            settings["threshold"] = self.threshold
        for kind in classes if classes is not None else self.present(enc):
            for o in self.model.detect(enc, kind, settings=settings)["objects"]:
                b = box_row(scoring_label(kind), kind, o["x_min"], o["y_min"], o["x_max"], o["y_max"])
                if b:
                    out.append(b)
        return out

    def close(self):
        close = getattr(self.model, "close", None)
        if close:
            close()


class Florence:
    name = "florence-2-large"

    def __init__(self, task: str = FLORENCE_TASK):
        import torch
        from transformers import AutoProcessor, Florence2ForConditionalGeneration

        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        ckpt = "florence-community/Florence-2-large"
        self.model = Florence2ForConditionalGeneration.from_pretrained(ckpt, dtype=torch.float16).to(self.device).eval()
        self.processor = AutoProcessor.from_pretrained(ckpt)
        self.task = task
        self.variant = "" if task == FLORENCE_TASK else "@ovd"
        self.prompts = {"task": task, "text": FLORENCE_PHRASES}
        ip = getattr(self.processor, "image_processor", None)
        size = getattr(ip, "size", None) or getattr(ip, "crop_size", None)
        self.input_size = {k: int(v) for k, v in dict(size).items()} if size else None  # a SizeDict; JSON wants a dict

    def detect(self, image: Image.Image, classes: list[str] | None = None) -> list[dict]:
        inputs = self.processor(text=self.task + FLORENCE_PHRASES, images=image, return_tensors="pt").to(self.device)
        inputs["pixel_values"] = inputs["pixel_values"].to(self.torch.float16)
        with self.torch.no_grad():
            ids = self.model.generate(**inputs, max_new_tokens=1024, num_beams=3, do_sample=False)
        text = self.processor.batch_decode(ids, skip_special_tokens=False)[0]
        parsed = self.processor.post_process_generation(text, task=self.task, image_size=image.size)[self.task]
        w, h = image.size
        out = []
        for (x1, y1, x2, y2), phrase in zip(parsed.get("bboxes", []), parsed.get("labels", [])):
            kind = next((c for c in CLASSES if c in str(phrase).lower()), None)
            if kind is None:
                continue
            b = box_row(scoring_label(kind), kind, x1 / w, y1 / h, x2 / w, y2 / h)
            if b:
                out.append(b)
        return out

    def close(self):
        pass


def make(name: str, **kw):
    if name == "moondream":
        return Moondream(**kw)
    if name == "florence":
        return Florence(**kw)
    raise SystemExit(f"unknown model {name}")
