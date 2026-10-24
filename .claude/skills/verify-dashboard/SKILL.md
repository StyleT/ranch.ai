---
name: verify-dashboard
description: End-to-end verification of the ranch dashboard (apps/web on :5090) and its live camera view against the real mini, over the tailnet, in a real browser. Use before saying a dashboard, live-view, camera, recorder, go2rtc, status-daemon, netprobe or pf change "works"; after every provision that touched them; and whenever the user reports that a page is broken, stale, slow or lying. Gives the layers in order, the exact commands, what each layer cannot see, and how to report. Built from the incidents where green checks shipped broken pages.
---

# Verify the dashboard end to end

**Rule: verify what the viewer experiences, on the path the viewer uses, and report the measurement, not a proxy.**
Every dashboard bug that reached the user (17–23 Oct 2026) passed checks that measured something *next to* the thing
that mattered: file write times, frame counts, HTTP 200s, fixture media, the LAN instead of the tailnet, or a badge
the code computed from those same proxies. Green fixture tests plus a green soak are not "it works".

## What slipped past, and why

| Incident | What was green | What it actually measured | What caught it |
|---|---|---|---|
| Label overlay wrong on the status page (20 Oct) | API returned label boxes; `node --check` on the inline JS | the API and the syntax, not the rendered page | the user looking at the page |
| "Moving only" filter showed 0 frames (22 Oct) | unit tests with synthetic motion | synthetic data | SQL over real frames + the measured noise distribution of quiet vs moving cameras |
| mops_cam "fixed and verified", dead minutes later (20–22 Oct) | 10-min soak, frames per camera | frames from cameras that were already up; far too short for an hours-scale failure | go2rtc `start producer` lines per camera per hour (2,912/day vs ~10), ping over days |
| Opening the live view crashed the status daemon (22–23 Oct) | Playwright 52 passed, agentic 6/6, health green | fixture MJPEG; launchd KeepAlive restarted the daemon in ~1 s, so health stayed green | `launchctl print system/com.ranch.status` → `runs = 11`, then 16 SIGBUS reports in `/Library/Logs/DiagnosticReports` |
| "It's not even a video stream" (23 Oct) | "398 frames in 10 min, zero errors" | delivery without errors: 0.66 fps is a slideshow | the user |
| Phone could not reach :5090 (23 Oct) | every check over the LAN or an ssh tunnel | the wrong network path (a tunnel bypasses pf) | curl to the MagicDNS name from a tailnet client |
| Picture frozen minutes behind under "LIVE · 0.0 s" (23 Oct) | the badge, the soak, `e2e-chaos`, the agentic oracle, Playwright 76 passed | playlist/file write time: "the file is fresh; its contents are stale" | screenshot of the camera's burned-in clock (OSD) vs the wall clock, then the same comparison hop by hop (go2rtc real-time; recorder output 43→100 s behind) → hardware encoder saturation |
| The mini silently ran the old MJPEG player again (23 Oct) | `make check` drift was read as noise | nothing looked at what was served | the probe reading `data-mode=buffer-mjpeg` (prevention: the `version-management` skill) |
| Checks wrong after the architecture changed (23 Oct) | owners check: "2 violations" for legitimate WebRTC viewers; soak failing on deliberately idle HLS; the agentic `live-video` oracle failing a correct "LIVE" because it still read the HLS playlist age (null once WebRTC is primary); `declare -A` on the mini's bash 3.2 | assumptions of the previous design | re-reading every check when the design changes; running scripts on the mini; running the agentic layer instead of skipping it |
| `make logs-last` returned nothing (until 23 Oct) | "no errors in the log" | an empty result: zsh's builtin `log` shadowed `/usr/bin/log` over ssh | proving the query returns lines at all |

The pattern: when the user reports a symptom that the checks didn't show, **the checks are wrong**. Find what they
measure versus what the user sees *before* touching code (root cause needs evidence: logs and measurements).

## The layers, in order

Each layer catches what the previous one cannot. Run all that apply to the change (matrix below).

0. **The right code is running.** `make check` → `changed=0` (otherwise you are testing something else). Served
   web build vs your checkout (empty diff = current):
   ```
   served=$(curl -s http://ranch-ai.tail6d04cd.ts.net:5090/api/ui/system | python3 -c 'import json,sys;print(json.load(sys.stdin)["web"]["build"]["commit"])')
   git diff --stat $served HEAD -- apps/web packages package-lock.json ':!apps/web/test' ':!apps/web/e2e'
   ```
1. **Static.** `npm run typecheck && npm test` (in a fresh worktree run `npm install` first, or tsc resolves
   `@ranch/*` from another checkout). Run everything, not a subset.
2. **Deterministic browser (fixtures).** `make web-build && make e2e`: UI logic, state machines, iPhone/iPad/desktop
   layouts, axe. **Blind to:** real media, WebRTC (no go2rtc in fixtures, so only the HLS fallback runs), encoder load,
   files being written while read, crashes, network paths. Never the last layer for a live-view change.
3. **Real page, real path: `make live-probe [CAMS=a,b]`.** For each camera, Chrome over the tailnet: the player's
   `data-mode`/`data-transport`/badge, decoded size, `currentTime` advancing over 4 s (rate ≈ 1.0), the daemon's
   `connected` beside it, and a PNG of the frame with the wall time. Verdicts: `LIVE`, `not live (honest)`, `FAIL:…`,
   `UNVERIFIED: harness error`. Then **open each PNG and read the OSD clock against `wall`**: that difference is the
   glass-to-glass latency. Rate 1.0 alone proves nothing about latency (a stream 6 minutes behind also advances at
   1×). Requirement: moving video, ≤ 3 s, on every connected camera. Baseline 23 Oct 20:06: six cameras on WebRTC,
   OSD within ~1 s of wall; mops_cam disconnected and honestly not live.
4. **Single camera owner while someone watches.** With a page open (or during the probe): `make camera-owners` →
   `OK`; per stream `recorder_consumers` ≤ 2 (+ `webrtc=N` viewers, fine); no `pull_hls` encoder without a fresh
   `.demand` marker.
5. **Crashes and restarts, counted before and after.** KeepAlive hides crashes, so count them:
   ```
   ssh ranch 'ls /Library/Logs/DiagnosticReports | grep -c "^node-"'
   ssh ranch 'for d in status web recorder netprobe camsup; do printf "%s " $d; sudo -n launchctl print system/com.ranch.$d | grep -m1 "runs ="; done'
   make logs-last H=1 | grep -iE 'error|UND_ERR|SIGBUS|failed' | tail
   make logs-of D=status H=1            # one daemon's current run; or: make logs-last | grep '"svc":"camsup"'
   ```
   `runs =` accumulates across deploys: every provision that restarts app daemons adds one. A count is a lead, not a
   verdict. Compare before and after the test window, and align stop times with sibling daemons: on 23 Oct camsup's
   `runs = 11` lined up to the minute with ingest and detector stopping (deploy restarts), not crashes:
   `sudo -n /usr/bin/log show --last 12h --style compact --predicate 'process == "launchd" AND eventMessage CONTAINS "service inactive: com.ranch.<d>"'`.
6. **Soak.** `make verify-live MINUTES=30`: JPEG-buffer liveness per connected camera, the on-demand transcode
   invariant, crash count, web socket errors, owners. Availability claims need hours or days of netprobe data
   (`/api/availability`, the `/system` table), never one soak.
7. **Faults** (recorder, supervisor, watchdog or recovery changes). `make e2e-chaos [CAM=back_yard_cam] [MODE=stop]`
   asserts detection, re-attach, the supervisor's row and recovery.
8. **Agentic.** `make e2e-ai TARGET=live [MODEL=haiku] [TASK=live-video]`: runs `claude -p` on the subscription, with
   haiku tasks at about $0.002–0.006 each. Use `TARGET=live`: the default `tunnel` target goes through ssh to
   127.0.0.1 and skips pf and the tailnet. Oracles compute the expected answer from facts; an oracle that trusts a
   proxy (file freshness) inherits the proxy's blind spot.
9. **What tooling cannot reach: the user's phone.** iOS Safari over Tailscale (WebRTC on iOS) is not exercised by
   any tool here. Ask the user to open a camera page and report the badge plus the OSD against their clock; until
   then, say it is unverified.

| Change touches | Layers |
|---|---|
| UI only (components, styles, copy) | 0 1 2, plus 3 on one camera |
| Player, BFF streaming routes, WebRTC/HLS | 0 1 2 3 (all cameras) 4 5, plus phone (9) |
| recorder, go2rtc, pf, netprobe, status daemon | 0 1 3 4 5 6, plus 7 if recovery is involved |
| supervisor, remediation, watchdog | 0 1 4 6 7 |
| Anything the user reported broken | reproduce it in 3 first, then fix, then the row above |

## Reporting

- Give numbers from this run, with the command that produced them: "tractor_cam OSD 20:05:12 at wall 20:05:12
  (WebRTC, `make live-probe`)". Never just "works" or "LIVE".
- A badge, flag or status the code computes is a claim, not evidence. Evidence is the picture (OSD/PNG), counters,
  logs and the kernel's socket tables.
- A harness failure is neither a pass nor a product failure. Report it as UNVERIFIED and fix the harness; don't wave
  a failed probe off as a "harness detail" without proving it (23 Oct: that "detail" was the downgraded mini).
- Say what was not verified and why (the phone; cameras that were offline; layers skipped).
- The bar is the user's requirement (≤ 3 s, moving, every connected camera), not a looser number from a plan.
- Report data that contradicts your summary. A table saying "1 consumer each" above output showing a 0 is a false
  report.

## When the architecture changes

Re-read every check against the new design before trusting it: `infra/bin/camera-owners.sh` (which consumers are
legitimate), `infra/bin/verify-live.sh` (which signal means "live"), `infra/bin/e2e-chaos.sh`, `apps/web/e2e/ai/tasks.ts`
oracles and goals, the fixture server and MSW handlers, and the player's state machine. A check written for HLS
fails or lies once WebRTC is primary.

## Environment gotchas (each cost time once)

- Playwright needs `channel: 'chrome'`: the bundled Chromium cannot decode H.264.
- Node ESM scripts that import `@playwright/test` must live under `apps/web/`. Write output to `apps/web/e2e/ai/runs/`
  (git-ignored, excluded from the deploy sync).
- A fresh worktree needs `npm install`, and `make web-build` before `make e2e`.
- The mini runs bash 3.2 (no `declare -A`, no `${v,,}`) and has no `timeout`; use `sudo -n`. Check scripts with
  `ssh ranch bash -n <file>`, which is where they run.
- The mini's login shell is zsh, and zsh has a builtin `log`. So `ssh ranch 'log show …'` fails
  ("zsh:log:1: too many arguments") and a grep over its output silently finds nothing. Always write `/usr/bin/log`
  (`sudo -n log` also works because sudo runs the binary). `make logs`/`logs-last` were broken this way until 23 Oct.
- The unified log does not keep `logger -t`'s tag, so `grep ranch.<daemon>` matches nothing. Filter by the JSON field
  `"svc":"<daemon>"`, by the daemon's logger pid (`make logs-of D=<daemon>`), or by launchd's own events.
- An empty result is not a clean result. Before trusting "no errors", prove the query returns *something* (drop the
  filter and see lines).
- CPU snapshots are spiky (190% and 6% minutes apart for the same ffmpeg). Sample repeatedly before concluding.
- `ls <buffer> | wc -l` counts the rolling buffer, not frames per minute. Retention can delete static frames, so frame
  counts lie for quiet cameras.
- zsh has no `PIPESTATUS`. Read exit codes directly.
- The badge and the mute button cover the camera OSD's seconds; `probe.mjs` hides them for the screenshot.
- Never open the Wyze bridge UI (:5080) to "check" anything: each visit attaches a go2rtc consumer per camera.
- The dashboard is tailnet-only: `ranch-ai.local:5090` is refused by design. Test via
  `http://ranch-ai.tail6d04cd.ts.net:5090`.
