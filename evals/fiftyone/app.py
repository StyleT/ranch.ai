"""Open the FiftyOne App on a dataset, bursts grouped as sequences.

  uv run python app.py --name frames-ranch-bursts-v1            # a local dataset (after import_jsonl.py or hub.py load)
  uv run python app.py --repo ranch-frames-bursts-v1 [--revision claude-v1]   # load from the Hub first

Bursts: the dataset is one image sample per frame; `group_by("burst_id", order_by="seq")` shows one card per burst in
the grid and the burst's frames in order in the modal. Scoring always runs on the flat dataset, not this view.
"""
import argparse
import os

import fiftyone as fo

PORT = int(os.environ.get("FIFTYONE_DEFAULT_APP_PORT", "5151"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name"); ap.add_argument("--repo"); ap.add_argument("--revision"); ap.add_argument("--flat", action="store_true")
    a = ap.parse_args()
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
    view = ds if a.flat or "burst_id" not in ds.get_field_schema() else ds.group_by("burst_id", order_by="seq")
    print(f"{ds.name}: {len(ds)} samples, fields {[f for f in ds.get_field_schema() if f.startswith(('gt_', 'pred_'))]} -> http://localhost:{PORT}")
    session = fo.launch_app(view, port=PORT)
    session.wait()


if __name__ == "__main__":
    main()
