# Zero-shot baseline sets

One directory per snapshot date. `frames.jsonl` is the frozen frame set (stratified by camera × day/night from
the live `frames` table, fixed seed); `predictions.<model>.jsonl` is what each Core ML model in
`/usr/local/ranch/models` produced on those exact frames at threshold 0.05 (so any threshold can be swept later);
`manifest.json` has the model package hashes, mean latency and the pick parameters. The images stay on the mini
under `/usr/local/ranch/media/baseline/<date>/` and are never pruned.

How it was made and how to redo it: `node evals/baseline/snapshot.ts --n 300` on the mini from `/usr/local/ranch/app`;
then rsync `evals/baseline/<date>/` back into the laptop checkout and commit. To look at the pictures on the laptop:
`rsync -a ranch:/usr/local/ranch/media/baseline/<date>/ evals/baseline/<date>/frames/` (git-ignored, ~72 MB per set).

Use: the Claude labeling pick (Phase 1) is drawn from this set; the benchmark (`apps/detector/src/bench.ts
--labels … --frames evals/baseline/<date>/frames.jsonl`) scores these predictions; any later model, threshold,
class filter or fine-tune is re-run on the same frames and diffed against this snapshot.
