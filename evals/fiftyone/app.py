"""Open the FiftyOne App on a dataset, bursts grouped as sequences.

  uv run python app.py --name frames-ranch-bursts-v1            # a local dataset (after import_jsonl.py or hub.py load)
  uv run python app.py --repo ranch-frames-bursts-v1 [--revision claude-v1]   # load from the Hub first

Bursts: the dataset is one image sample per frame. --mode browse (default): `group_by("burst_id", order_by="seq")`,
one card per burst in the grid, the burst's frames in order in the modal. --mode annotate: the flat dataset sorted
by (burst_id, seq), because the App's Annotate tab only works on image samples, not on a grouped view ("This group
dataset has no slices that support annotation"); a burst's frames stay consecutive, so next/prev in the modal still
walks the sequence while every sample is editable. Scoring always runs on the flat dataset.
"""
import argparse
import os

import fiftyone as fo
from fiftyone import ViewField as F

PORT = int(os.environ.get("FIFTYONE_DEFAULT_APP_PORT", "5151"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name"); ap.add_argument("--repo"); ap.add_argument("--revision")
    ap.add_argument("--mode", choices=["browse", "annotate", "flat"], default="browse")
    ap.add_argument("--flat", action="store_true", help="same as --mode flat")
    a = ap.parse_args()
    if a.flat:
        a.mode = "flat"
    if a.repo:
        from hub import load_env
        import fiftyone.utils.huggingface as fouh
        load_env()
        owner = os.environ.get("RANCH_HF_OWNER", "vladlenfedosov")
        ds = fouh.load_from_hub(a.repo if "/" in a.repo else f"{owner}/{a.repo}", revision=a.revision, name=a.name, persistent=True, overwrite=False)
    elif a.name:
        ds = fo.load_dataset(a.name)
    else:
        raise SystemExit("--name or --repo is required")
    has_bursts = "burst_id" in ds.get_field_schema()
    if a.mode == "browse" and has_bursts:
        view = ds.group_by("burst_id", order_by="seq")
    elif a.mode == "annotate" and has_bursts:
        view = ds.sort_by(F("burst_id") * 1000 + F("seq"))   # whole bursts in sequence order, every sample an editable image
    else:
        view = ds.view()
    print(f"{ds.name}: {len(ds)} samples, mode {a.mode}, fields {[f for f in ds.get_field_schema() if f.startswith(('gt_', 'pred_'))]} -> http://localhost:{PORT}")
    session = fo.launch_app(view, port=PORT)
    session.wait()


if __name__ == "__main__":
    main()
