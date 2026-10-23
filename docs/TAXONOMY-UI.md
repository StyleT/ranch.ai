# Plan: taxonomy on the dashboard, editable, measured before it applies

*Written 22 Oct 2026 for review before implementation. Scope: the status page reflects the taxonomy (classes,
subclasses, model mappings, raw labels), and the taxonomy can be changed from the dashboard without losing git as
the system of record or the EVALUATION.md gate.*

## 1. The taxonomy becomes data

`packages/taxonomy` keeps the types, the validator (zod) and the helpers; the *values* move to
`packages/taxonomy/taxonomy.json` (classes, subclasses, attributes, scene fields, ignored, `LABEL_ORDER`,
`MODEL_MAPPINGS` with thresholds and notes, `SCORING_MAP`). The module loads a file given by `RANCH_TAXONOMY_FILE`
(default: the repo file) and exposes `loadTaxonomy()`; the existing helpers (`mapDetection`, `interestLabels`,
`thresholdFor`, `scoringLabel`, …) take the loaded object. Every consumer stays one import away. The labeling schema
enums are built from it at load time.

## 2. Versions, on the mini, in SQLite

Table `taxonomy_versions` (schema v4): `id`, `created`, `author` (`ui:<ip>` or `ansible`), `note`, `json`,
`parent_id`, `score_json` (the gate run, §4), `active` (exactly one row). The detector and the status daemon read
the active row at start and reload it on the retained MQTT message `ranch/taxonomy` (`{version_id}`), so a change
takes effect on the next frame with no restart. No active row → the repo file is inserted as version 1 by
whichever daemon starts first.

**Git stays the system of record.** `make taxonomy-pull` copies the active version into
`packages/taxonomy/taxonomy.json` on the laptop (plus its score file into `evals/results/`) for review and commit.
`make check` reports drift when the repo file differs from the active version. `make provision` inserts the repo
file as a new active version *only when it differs* (author `ansible`), so the repo wins on provision: pull and
commit UI edits before provisioning, or they are superseded. The dashboard shows a banner, "taxonomy v7 is not in
git", until that happens.

## 3. The page `/taxonomy`

- **Classes**: one card per class with its subclasses and attribute values; add subclass, remove unused subclass
  (refused when a mapping or a stored label uses it; stored labels are counted from `detections`).
- **Ignored**: the explicit never-boxed list.
- **Mappings**: one table per model family (today `coco`): raw label → class/subclass, threshold (number input),
  note; add row, delete row. The active family is marked; the detector's model name is shown next to it.
- **Order**: drag or up/down on the label order list.
- **Scoring map**: subclass → expressible label per family.
- **History**: version list with author, note, time, score summary; "revert" makes a copy of an old version
  active (never rewrites history).
- Edits accumulate in a draft (browser-side); "Score draft" and "Apply" act on the whole draft with a note.
  Invalid drafts (unknown subclass in a mapping, threshold outside 0..1, duplicate) are refused by the same
  validator the module uses.

## 4. Measured before it applies

"Score draft" runs `bench.ts --taxonomy <family>` on the mini against the current reference datasets
(`frames-ranch-v1` × the newest `labels-*` registered as reference in `evals/DATASETS.md`), using the stored
prediction files, so it takes ~2 s and no model runs. The page shows the EVALUATION.md §6 gate table for the draft
beside the active version: horse R@FPPF≤0.1, horse recall with CI, AP, FPPF(all), count-exact, per-class
precision/recall, day/night split. "Apply" is enabled either way, but a draft that fails the relative gate (any
class's recall or precision drops, or FPPF(all) rises) applies with a visible "gate failed" flag on the version;
the flag follows the version into git via `taxonomy-pull`. Every version's score is stored, so the history is a
leaderboard of taxonomy changes.

## 5. Main page and frame browser

- Detections per camera: columns are the active taxonomy's labels in `LABEL_ORDER`; a cell shows the count and,
  on hover or tap, the raw-label breakdown ("horse 7: horse 4, cow 3"). A "classes" link opens `/taxonomy`.
- Daemons: the detector row shows the model, family, taxonomy version and the kept/raw box ratio from its status
  message.
- Camera cards: the per-minute count label reads "equine" when the family's horse label includes cow/sheep
  mappings (derived, not hard-coded).
- `/frames`: the label filter is a dropdown of taxonomy labels; a box's caption shows the raw label when it
  differs ("horse ← cow 0.71"); the labels overlay shows class/subclass as before.

## 6. Security and limits

:5090 was LAN-only from 22 Oct and is tailnet-only since 23 Oct (pf accepts it only from Tailscale clients), still
without auth of its own; the page can change what the detector counts, so a write needs more than "is on the tailnet". Minimum in this step: `RANCH_STATUS_WRITE_TOKEN` (on the mini in
`~/.config/ranch/status.env`), required as a header for every write endpoint; the page asks for it once and keeps
it in session storage. Reads stay open. The token is the same mechanism the later MCP surface will use.

## 7. Out of scope

Event classes and alert policy (Phase 2), per-camera suppression of static objects (its own leaderboard row),
editing labels datasets from the UI (Phase 1b has its own page), user accounts.

## 8. Order of work

1. Taxonomy as data + validator + loader; consumers switched; tests (loader rejects invalid files; helpers
   unchanged on the repo file). No behaviour change.
2. `taxonomy_versions` (schema v4), MQTT reload in the detector and status daemon, `make taxonomy-pull`,
   drift in `make check`, provision inserts on difference.
3. `/taxonomy` page with draft, validate, score, apply, history; write token.
4. Main page and frame browser changes.
5. A deliberate test: change the person threshold on the page, score, apply, see the detector row report the new
   version within a minute, pull, commit.

## 22 Oct, later: the editor moved to the Next.js app (`apps/web`, `/taxonomy` on :5090); the daemon keeps the API

## As built, 22 Oct

- `packages/taxonomy/taxonomy.json` is the data; `src/index.ts` validates (zod, with cross-checks that name the path)
  and loads it (`RANCH_TAXONOMY_FILE` overrides the repo file, which is how the benchmark scores a draft);
  `src/store.ts` activates the SQLite version and reloads on `ranch/taxonomy`; `src/cli.ts sync|export|status`.
  A subclass name may repeat across classes ("other" in animal and vehicle); within a class names are unique.
- Schema v4 `taxonomy_versions`; the detector and the status daemon load the active row at start and on the
  retained MQTT message; the detector's status message carries `taxonomy_version`.
- `/taxonomy`: classes, ignored, mappings per family (add family, add/remove rows, class/subclass, threshold,
  note), label order, scoring map, history with "load as draft" and "revert to". Validate; Score draft
  (`bench.ts --taxonomy` on the reference datasets with stored predictions, ~0.3 s, gate table active vs draft
  with per-class deltas); Apply (new version, note, gate flag, immediate reload); Discard. Writes need
  `x-ranch-token` = `RANCH_STATUS_WRITE_TOKEN` from `~/.config/ranch/status.env` on the mini (generated by
  Ansible, mode 600, never in the repo; `ssh ranch cat ~/.config/ranch/status.env`). Removing a subclass whose
  label the taxonomy has stored is refused server-side.
- Main page: taxonomy link, drift banner, per-camera cells carry the raw-label breakdown as a tooltip (◦ marks a
  cell with mapped raw classes), the camera count says "equine" when cow/sheep map to horse. Frame browser:
  label dropdown from the taxonomy, captions "horse ← cow 0.71".
- Git: `make taxonomy-pull` writes the active version to the repo file (canonical key order) and its score to
  `evals/results/taxonomy-v<id>.json`; `make check` shows "Taxonomy from the repo file is the active version"
  as changed when they differ; `make provision` inserts the repo file as a new version (author `ansible`) only
  when it differs.
- Step-5 test passed end to end (person threshold 0.6 → 0.9 as v2, gate pass, detector reloaded in < 1 min,
  check reported drift, pull worked); then reverted to v1's content as v3 so production keeps the reviewed
  thresholds. The versions table on the mini keeps all three.
