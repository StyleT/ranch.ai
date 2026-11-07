"""The local pre-labelers behind one interface: `Labeler.detect(image) -> list[box_row]`.

None of them returns a confidence; boxes are written at 1.0.
Qwen3-VL (an MLX build behind `mlx_vlm.server`, the tier-2 harness's server): one grounding request per frame naming the
taxonomy classes, answered under a JSON schema of `{label, bbox_2d}` objects in Qwen3-VL's relative 0..1000 coordinates;
no confidence either.
Rex-Omni (IDEA-Research, Qwen2.5-VL-3B fine-tuned for detection, bf16 or the AWQ checkpoint dequantized) through
transformers on MPS: one detection request naming the classes, the answer's 1,000-bin coordinate tokens parsed to boxes.
Florence-2 Large through transformers (native class, MPS fp16): one `<CAPTION_TO_PHRASE_GROUNDING>` call with every
class phrase.
Moondream 3.1 9B-A2B through Photon stays as the record of its triage: its engine decodes garbage on Apple silicon and
the wrapper refuses to bench on it.
"""
import base64
import io
import json
import re
from pathlib import Path

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

        # Photon's engine (kestrel 0.9.1, pinned by moondream 2.6.1) runs correctly on CUDA only. On Apple silicon,
        # as shipped, it fails its own device identity check (m87-labs/moondream#391: the KV pool resolves to "mps",
        # its scale tensors report "mps:0"); with device="mps:0" the default decode planner asks torch.cuda for device
        # properties; with decode_path="native" it loads, and then decodes garbage for moondream2 and 3.1 alike
        # (one-token captions, repeated words, detect() empty on the first call and different boxes on the second;
        # unchanged by an explicit fp16 dtype or by turning the prefix cache off). The CPU path dispatches to CUDA
        # layernorm kernels. Not torch's fault: on this Mac (macOS 26.7, torch 2.14) F.linear and torch.mv on MPS match
        # the CPU within rounding at every row count from 1 to 64 in fp16 / bf16 / fp32, and routing them through an
        # explicit matmul before the engine starts leaves the garbage byte-identical; the fault is in the engine's own
        # Metal kernels. The settings below are the only ones that load; the self-check after them refuses to run a
        # bench on garbage and lifts itself when an upstream release decodes correctly.
        import torch

        opts = {"device": "mps:0", "decode_path": "native"} if torch.backends.mps.is_available() else {}
        self.model = md.vl(local=True, model="moondream3.1-9B-A2B", **opts)
        self._self_check()
        self.max_objects = max_objects
        self.threshold = threshold
        self.variant = f"@t{threshold}" if threshold is not None else ""
        self.prompts = {"presence": PRESENCE_QUESTION, "detect": "<class name>"}

    def _self_check(self) -> None:
        """One caption of a flat grey image must come back as words, not a single token: the engine's broken Apple
        silicon decode gives '' or 'A' here while the CUDA path gives a sentence."""
        probe = Image.new("RGB", (448, 448), (128, 128, 128))
        caption = self.model.caption(self.model.encode_image(probe), length="short")["caption"].strip()
        if len(caption.split()) < 3:
            raise SystemExit(
                f"moondream3.1 through Photon decodes garbage on this machine (probe caption {caption!r}); see the note in "
                "models.py and m87-labs/moondream#391. Not a usable pre-labeler here until the engine's Apple silicon "
                "path is fixed upstream."
            )

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


QWEN_PROMPT = (
    "This is a frame from a ranch security camera. Find every " + ", ".join(CLASSES) + " in the image. "
    "Answer with JSON only: {\"objects\": [{\"label\": <one of those names>, \"bbox_2d\": [x1, y1, x2, y2]}]}, "
    "coordinates relative to the image in the range 0 to 1000, one tight box per object, nothing for shadows, "
    "reflections or parts of the scene. {\"objects\": []} if none of them is visible."
)
QWEN_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "enum": CLASSES},
                    "bbox_2d": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000}, "minItems": 4, "maxItems": 4},
                },
                "required": ["label", "bbox_2d"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objects"],
    "additionalProperties": False,
}


class Qwen3VL:
    """A Qwen3-VL Instruct build served by mlx_vlm.server (`make vlm-serve MODEL=<hf id>`); `temperature 0` so a run is
    one operating point. `name` carries the build (`qwen3vl-8b-4bit`), so each build is its own predictions file."""

    def __init__(self, server_model: str = "mlx-community/Qwen3-VL-8B-Instruct-4bit", server: str = "http://localhost:8080/v1", max_tokens: int = 512):
        from openai import OpenAI

        self.client = OpenAI(base_url=server, api_key="not-needed")
        self.server_model = server_model
        m = re.search(r"-(\d+B)-Instruct-(\d+bit)", server_model)
        self.variant = f"-{m.group(1).lower()}-{m.group(2)}" if m else "-" + server_model.split("/")[-1].lower()
        self.name = "qwen3vl"
        self.max_tokens = max_tokens
        self.prompts = {"grounding": QWEN_PROMPT, "schema": QWEN_SCHEMA, "server_model": server_model, "temperature": 0, "max_tokens": max_tokens}
        self.invalid = 0  # answers that were not the schema's JSON (a refusal, a cut-off at max_tokens, a server error)

    def detect(self, image: Image.Image, classes: list[str] | None = None) -> list[dict]:
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=90)
        url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        try:
            resp = self.client.chat.completions.create(
                model=self.server_model,
                messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}}, {"type": "text", "text": QWEN_PROMPT}]}],
                response_format={"type": "json_schema", "json_schema": {"name": "Grounding", "strict": True, "schema": QWEN_SCHEMA}},
                temperature=0,
                max_tokens=self.max_tokens,
            )
            objects = json.loads(resp.choices[0].message.content)["objects"]
        except Exception as e:  # a bad answer is an empty frame in the row, not a crash of the run
            self.invalid += 1
            print(f"qwen3vl: invalid answer ({str(e)[:120]})", flush=True)
            return []
        out = []
        for o in objects:
            kind, bb = o.get("label"), o.get("bbox_2d")
            if kind not in CLASSES or not isinstance(bb, list) or len(bb) != 4:
                continue
            x1, y1, x2, y2 = (float(v) / 1000 for v in bb)
            b = box_row(scoring_label(kind), kind, x1, y1, x2, y2)
            if b:
                out.append(b)
        return out

    def close(self):
        pass


REX_REPOS = {"bf16": "IDEA-Research/Rex-Omni", "awq": "IDEA-Research/Rex-Omni-AWQ"}
REX_SYSTEM = "You are a helpful assistant"
REX_PROMPT = "Detect {categories}. Output the bounding box coordinates in [x0, y0, x1, y1] format."
REX_ANSWER = re.compile(r"<\|object_ref_start\|>(.*?)<\|object_ref_end\|><\|box_start\|>(.*?)<\|box_end\|>", re.S)
REX_BIN = re.compile(r"<(\d+)>")
AWQ_REVERSE_ORDER = [0, 4, 1, 5, 2, 6, 3, 7]  # AutoAWQ's gemm packing order of eight 4-bit values in one int32


def dequantize_awq(src: str, dst: str) -> str:
    """Rex-Omni-AWQ as a plain bf16 checkpoint under dst (once): the 4-bit gemm weights unpacked and rebuilt as
    (q - zero) * scale per group of 128 inputs, everything else copied, quantization_config dropped from config.json.
    The AWQ kernels (autoawq, vLLM) are CUDA-only, so on the Mac the AWQ checkpoint's weights run this way: the same
    numbers it computes with, at the bf16 model's memory and speed."""
    import shutil
    from pathlib import Path

    import torch
    from safetensors.torch import load_file, save_file

    src_dir, dst_dir = Path(src), Path(dst)
    if (dst_dir / "model.safetensors").exists():
        return str(dst_dir)
    dst_dir.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((src_dir / "config.json").read_text())
    q = cfg.pop("quantization_config")
    assert q["quant_method"] == "awq" and q["version"] == "gemm" and q["bits"] == 4, q
    group = q["group_size"]
    cfg["torch_dtype"] = "bfloat16"
    cfg.pop("use_cache", None)
    (dst_dir / "config.json").write_text(json.dumps(cfg, indent=2))
    for f in src_dir.iterdir():
        if f.suffix == ".json" and f.name != "config.json" or f.suffix in (".txt", ".jinja", ".model"):
            shutil.copy(f, dst_dir / f.name)
    tensors = {}
    for f in sorted(src_dir.glob("*.safetensors")):
        tensors.update(load_file(str(f)))
    out = {}
    shifts = torch.arange(0, 32, 4, dtype=torch.int32)
    for k, v in tensors.items():
        if k.endswith(".qweight"):
            base = k[: -len(".qweight")]
            qweight, qzeros, scales = v, tensors[base + ".qzeros"], tensors[base + ".scales"]  # [in, out/8] int32, [in/g, out/8] int32, [in/g, out] fp16
            def unpack(t):
                u = (t.unsqueeze(-1) >> shifts) & 0xF  # [rows, out/8, 8]
                return u[..., AWQ_REVERSE_ORDER].reshape(t.shape[0], -1)  # [rows, out]
            w = unpack(qweight).to(torch.float32)
            z = unpack(qzeros).to(torch.float32).repeat_interleave(group, dim=0)[: w.shape[0]]
            s = scales.to(torch.float32).repeat_interleave(group, dim=0)[: w.shape[0]]
            out[base + ".weight"] = ((w - z) * s).T.contiguous().to(torch.bfloat16)  # Linear wants [out, in]
        elif k.endswith(".qzeros") or k.endswith(".scales"):
            continue
        else:
            out[k] = v.to(torch.bfloat16) if v.is_floating_point() else v
    save_file(out, str(dst_dir / "model.safetensors"), metadata={"format": "pt"})
    return str(dst_dir)


def rex_tokenizer_dir(bf16_dir: str, awq_dir: str, dst: str) -> str:
    """A processor directory whose tokenizer puts the 1,000 coordinate bins where the model was trained with them.
    Rex-Omni repurposes the last 1,000 entries of Qwen2.5's vocabulary (ids 150643 to 151642) as <0> to <999>; the
    bf16 repository says so in tokenizer_config.json (added_tokens_decoder) but ships no tokenizer.json, and both the
    slow and the fast tokenizer of transformers 5 append the bins as new ids instead, pushing <|image_pad|> past the
    embedding table (the AWQ repository's tokenizer.json has the same shifted ids). Built once: the AWQ tokenizer.json's
    pipeline with the bins written into the BPE vocabulary at their ids (the merges producing the displaced tokens
    dropped) and every added token at the id of the bf16 added_tokens_decoder."""
    import shutil
    from pathlib import Path

    src, awq, out = Path(bf16_dir), Path(awq_dir), Path(dst)
    if (out / "tokenizer.json").exists():
        return str(out)
    out.mkdir(parents=True, exist_ok=True)
    tc = json.loads((src / "tokenizer_config.json").read_text())
    ids = {v["content"]: int(k) for k, v in tc.pop("added_tokens_decoder").items()}
    tj = json.loads((awq / "tokenizer.json").read_text())
    vocab = tj["model"]["vocab"]
    displaced = {t for t, i in vocab.items() if i in set(ids.values())}
    for t in displaced:
        del vocab[t]
    for content, i in ids.items():
        if i < len(vocab) + len(displaced):  # a bin inside the original vocabulary; the specials sit past it
            vocab[content] = i
    merges = tj["model"]["merges"]
    pairs = [(m.split(" ") if isinstance(m, str) else m) for m in merges]
    kept = [m for m, (a, b) in zip(merges, pairs) if a in vocab and b in vocab and a + b in vocab]
    tj["model"]["merges"] = kept
    for a in tj["added_tokens"]:
        a["id"] = ids[a["content"]]
    tj["added_tokens"].sort(key=lambda a: a["id"])
    (out / "tokenizer.json").write_text(json.dumps(tj, ensure_ascii=False))
    (out / "tokenizer_config.json").write_text(json.dumps(tc, indent=2, ensure_ascii=False))
    for name in ("preprocessor_config.json", "chat_template.json", "special_tokens_map.json", "generation_config.json"):
        if (src / name).exists():
            shutil.copy(src / name, out / name)
    return str(out)


class RexOmni:
    """IDEA-Research's Rex-Omni (Qwen2.5-VL-3B fine-tuned to emit detections as text, each coordinate one of 1,000 bin
    tokens) through transformers on MPS, with the repository's detection prompt, decoding settings and answer format
    reimplemented here: the `rex_omni` package pins flash-attn and vLLM and does not install on macOS. `--weights awq`
    runs the AWQ checkpoint dequantized (dequantize_awq)."""

    name = "rexomni"

    def __init__(self, weights: str = "bf16", max_new_tokens: int = 2048):
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        cache = Path.home() / ".cache/ranch"
        bf16_dir, awq_dir = snapshot_download(REX_REPOS["bf16"]), snapshot_download(REX_REPOS["awq"])
        path = bf16_dir if weights == "bf16" else dequantize_awq(awq_dir, str(cache / "rex-omni-awq-bf16"))
        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(path, dtype=torch.bfloat16, attn_implementation="sdpa").to(self.device).eval()
        # The checkpoint's preprocessor_config carries the repository's settings (min 16, max 2560 patches of 28 px),
        # so a 1280x720 frame is kept as is.
        tok_dir = rex_tokenizer_dir(bf16_dir, awq_dir, str(cache / "rex-omni-tokenizer"))
        self.processor = AutoProcessor.from_pretrained(tok_dir)
        tok = self.processor.tokenizer
        assert tok.convert_tokens_to_ids("<0>") == 150643 and tok.convert_tokens_to_ids("<|image_pad|>") == self.model.config.image_token_id, "Rex-Omni tokenizer ids"
        self.variant = "" if weights == "bf16" else "-awq"
        self.max_new_tokens = max_new_tokens
        self.prompts = {"system": REX_SYSTEM, "detection": REX_PROMPT, "weights": REX_REPOS[weights], "repetition_penalty": 1.05, "max_new_tokens": max_new_tokens}
        self.invalid = 0  # answers with no parsable box group at all

    def detect(self, image: Image.Image, classes: list[str] | None = None) -> list[dict]:
        cats = classes if classes is not None else CLASSES
        messages = [
            {"role": "system", "content": REX_SYSTEM},
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": REX_PROMPT.format(categories=", ".join(cats))}]},
        ]
        text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.processor(text=[text], images=[image], return_tensors="pt").to(self.device)
        with self.torch.no_grad():
            ids = self.model.generate(**inputs, max_new_tokens=self.max_new_tokens, do_sample=False, repetition_penalty=1.05, use_cache=True)
        answer = self.processor.batch_decode(ids[:, inputs["input_ids"].shape[1] :], skip_special_tokens=False)[0]
        out = []
        for cat, boxes in REX_ANSWER.findall(answer):
            kind = cat.strip().lower()
            if kind not in CLASSES:
                continue
            for group in boxes.split(","):
                bins = [int(b) for b in REX_BIN.findall(group)]
                if len(bins) != 4:
                    continue
                b = box_row(scoring_label(kind), kind, *(v / 999 for v in bins))
                if b:
                    out.append(b)
        if not out and "<|box_start|>" not in answer and answer.strip() not in ("", "<|im_end|>"):
            self.invalid += 1
        self.last_answer = answer
        return out

    def close(self):
        pass


def make(name: str, **kw):
    if name == "moondream":
        return Moondream(**kw)
    if name == "florence":
        return Florence(**kw)
    if name == "qwen3vl":
        return Qwen3VL(**kw)
    if name == "rexomni":
        return RexOmni(**kw)
    raise SystemExit(f"unknown model {name}")
