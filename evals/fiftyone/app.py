"""Open the FiftyOne App on a dataset.

  uv run python app.py --name frames-ranch-bursts-v1            # a local dataset (after import_jsonl.py or hub.py load)
  uv run python app.py --repo ranch-frames-bursts-v1 [--revision claude-v1-grouped]   # load from the Hub first

A grouped dataset (bursts since 1 Nov: one group per burst, image slices "0".."3") is launched as is: the grid shows
the head slice, the modal the burst's slices, and the Annotate tab edits each slice. --mode browse/annotate/flat only
apply to an older flat dataset (one image sample per frame): browse = `group_by("burst_id", order_by="seq")`,
annotate = sorted by (burst_id, seq) so every sample is editable, flat = as is.
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
    if ds.media_type == "group":
        # a grouped dataset (one group per burst, image slices "0".."3"): the grid shows the default slice (the head),
        # the modal shows the burst's slices together, and the Annotate tab works on each slice
        ds.group_slice = "0"; view = ds   # the dataset itself, not a view: the modal's group carousel needs the group context
        n = len(ds.select_group_slices(media_type="image"))
    elif a.mode == "browse" and "burst_id" in ds.get_field_schema():
        view = ds.group_by("burst_id", order_by="seq"); n = len(ds)          # a flat dataset: browse as sequences (not annotatable)
    elif a.mode == "annotate" and "burst_id" in ds.get_field_schema():
        view = ds.sort_by(F("burst_id") * 1000 + F("seq")); n = len(ds)       # flat, bursts consecutive, every sample editable
    else:
        view = ds.view(); n = len(ds)
    print(f"{ds.name}: {n} samples ({ds.media_type}), mode {a.mode}, fields {[f for f in ds.get_field_schema() if f.startswith(('gt_', 'pred_'))]} -> http://localhost:{PORT}")
    session = fo.launch_app(view, port=PORT)
    session.wait()


if __name__ == "__main__":
    main()
