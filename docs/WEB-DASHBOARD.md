# Web dashboard (`apps/web`, `com.ranch.web`)

*Plan approved 22 Oct 2026 (`~/.claude/plans/…bubbly-puddle.md` in the session; summarized here). Built the same day
through milestone 3. Replaces the hand-written pages of `apps/status` once the cut-over (milestone 4) moves it to
port 5090.*

## What it is

A Next.js 16 app (React 19, TypeScript, Tailwind 4, TanStack Query 5) that is both the frontend and a
backend-for-frontend: route handlers under `/api/ui/*` compose UI-shaped documents by calling the status daemon
server-to-server over loopback, validated at the boundary against `packages/contracts` (zod schemas of every
daemon response; the daemon's `Status` `satisfies` them). The Next process holds no SQLite, no MQTT and no native
modules: one shared upstream SSE connection is fanned out to browsers (`/api/ui/live`), and every image is proxied
from the daemon (which resizes with sharp). **The dashboard never touches go2rtc or a camera**
(`docs/CAMERA-ARCHITECTURE.md`): thumbnails are the newest frame of the recorder's rolling buffer, and the "live"
view on a camera page is an MJPEG the daemon assembles from that buffer as the recorder fills it (~1 frame / 2 s),
capped at four concurrent viewers, closed when the page is hidden or left.

```
browser (tailnet) ──:5090──> com.ranch.web   Next standalone (pf accepts 5090 only from Tailscale clients; the LAN is refused, 23 Oct)
                              │ loopback
                              └──> com.ranch.status  127.0.0.1:5091   JSON + SSE + frames + buffer MJPEG + taxonomy + bench
                                        └──> SQLite, MQTT, launchctl, log show, <media>/buffer/<cam>/ (written by com.ranch.recorder)
```

## Pages

`/system` also carries the Wyze bridge's metrics (bridge state, per-camera state, Wyze API call counters) via the
daemon's `/api/bridge`: the bridge's own UI on 5080 is loopback-only since 23 Oct because opening it attached a go2rtc
consumer per camera. Reach that UI with `make tunnel` → `http://127.0.0.1:5080` (Prometheus text at `/metrics.prom`).


| Route | Content |
|---|---|
| `/` | health strip, derived alerts (camera offline, daemon down, detector stale, taxonomy drift, disk, burst throttling, no frames), camera cards with live thumbnails and the equine count, activity feed (bursts/tracks, live over SSE), detections per camera × label with raw-label tooltips, events placeholder |
| `/cameras/[name]` | live view from the recorder buffer (MJPEG, ~0.5 fps, always on while visible, paused when hidden), online timeline and equine count chart over 1h/6h/24h/7d, motion, network and buffer signal, recent bursts, and the detections browser locked to the camera |
| `/detections` | the frames browser: live frames or a baseline set with any model's or labels' overlay, filters in the URL (canonical), infinite paging, box overlays with raw-label captions and motion arrows, burst cards with hover playback, full-screen viewer with ←/→ ↑/↓ Space Esc, swipe and long-press on touch |
| `/taxonomy` | the editor: draft in session storage, validate, score with the gate table (active vs draft, per-class deltas), apply with the write token, history with load-as-draft and revert, drift banner |
| `/system` | daemons with RSS, exit, parsed retained status (nested motion and netprobe tables), last log line; load, disk, totals; network probe per camera; wifi; pausable MQTT ticker |
| `/evals`, `/evals/[file]` | leaderboard parsed from `evals/LEADERBOARD.md` (prod marked), result files with per-slice per-class metrics, datasets from `evals/DATASETS.md` |

Phone: bottom tab bar, cards and accordions. Tablet: icon rail. Desktop: sidebar. Dark by default, system-aware,
light theme with validated contrast. `data-testid` vocabulary in `src/lib/testids.ts` with ids from data; state as
`data-state`, `data-connection`, `data-dirty`, `data-gate`, `data-loaded`; every timestamp a `<time dateTime>`.

## Live data

One `EventSource('/api/ui/live')` per app (`features/live/LiveProvider`). `status` events invalidate the home
query, `frame` events bump thumbnails, `tracks` feed the activity feed and invalidate lists (throttled). The 16 Oct
lessons are a pure state machine (`features/live/connection.ts`): poll every 30 s regardless, reopen after 45 s of
silence, refresh on `visibilitychange`, `pageshow` and `online`; the badge shows live / reconnecting / stale / offline.

## Build and deployment

`next build` runs **on the mini** (`roles/app`, task "Web app built") when `apps/web` (minus tests), `packages/` or
the lockfile changed, judged by a content hash stamped in `/usr/local/ranch/var/build/web.sha256`; `WOULD BUILD`
in check mode; standalone output served by `com.ranch.web` (`infra/launchd/com.ranch.web.plist.j2`) with
`PORT`/`HOSTNAME`, daemon and go2rtc URLs, `RANCH_APP_DIR`, stream cap and keep-alive exclusions from group_vars.
`npm ci` on the mini keeps dev dependencies (Next needs TypeScript and Tailwind to build). `.next` and test outputs
are excluded from the rsync so the mini's build survives `--delete`.

Measured 22 Oct on the mini: build ~60 s; server 100 MB RSS idle, 171 MB after rendering every page; home 92 ms,
camera page 104 ms, taxonomy 30 ms (server render). Status daemon ~150 MB alongside.

## Working on it

```
make web-dev          # next dev on the laptop against the mini's daemon and go2rtc over an ssh tunnel
npm -w apps/web test  # vitest: unit (overlay geometry, swipe, url state, draft reducer, gate table) + BFF integration with MSW over recorded fixtures
make fixtures-record  # re-record daemon fixtures (validated against the contracts, redacted); review the diff, commit
make contract-test    # live daemon vs packages/contracts
make web-health       # RSS and daemon reachability of com.ranch.web
```
Root `npm run typecheck` and `npm test` chain the web app. Lint: `npm -w apps/web run lint`.

## Status

- M1 (22 Oct): daemon endpoints `/api/ping`, `/api/counts/series`, `/api/frames/series`, `/api/tracks`,
  `/api/frames/<id>`, per-daemon `rss_mb`, `packages/contracts`.
- M2 (22 Oct): scaffold, BFF, fixtures, integration tests.
- M3 (22 Oct): all six pages, built and running on the mini's loopback port 5092.
- Regroup (22 Oct, after the camera-architecture merge): the web app reads the recorder buffer through the daemon;
  go2rtc removed from it; `seed` fields became `buffer` fields in the status contract.
- M4 (22 Oct): cut-over. Status daemon on 127.0.0.1:5091 (API only, HTML pages deleted), web app on 5090.
- M5 (22 Oct): deterministic e2e and hardening, below.
- M6 (22 Oct): agentic e2e, below.
- 23 Oct: live-view crash fixed (Incidents, below); the Wyze bridge's metrics page moved to `/system`; bridge UI and
  go2rtc ports loopback-only; player retry backoff.
- 23 Oct, later: 5090 is **tailnet-only** (Vlad: the dashboard is for the phone and laptop over Tailscale, never for the
  shared Wi-Fi). pf passes 5090 only from `100.64.0.0/10` / `fd7a:115c:a1e0::/48` to the node's tailnet addresses and
  refuses it on every other interface; loopback stays open for `ssh -L`. The agentic e2e `live` target uses the MagicDNS name.

## Incidents

**23 Oct, live view crashed the status daemon.** 16 `SIGBUS` crash reports in two days (`/Library/Logs/DiagnosticReports/node-*.ips`,
"FS pagein error", libvips worker in `jpeg_read_scanlines`), each 2–17 s after a buffer stream opened: `sharp(path)`
memory-mapped the buffer JPEG that ffmpeg was still writing. The player's fixed 10 s retry re-crashed the daemon for as
long as the page stayed open; each crash took the API, SSE and MQTT down for ~1 s. Fix: the daemon reads every JPEG into
memory before sharp (`apps/status/src/jpeg.ts`), the recorder writes atomically, the player backs off 10 → 60 s. The
full timeline, including why the camera drops were not the dashboard's doing, is in docs/CAMERA-ARCHITECTURE.md.
Measured after the fix (10-minute soak, one viewer, 300 thumbnail requests at 5/s): 398 live frames delivered, 300/300
thumbnails 200, crash reports 25 → 25, daemon restarts 0, web socket errors 0, daemon RSS 175 → 205 MB.

## Agentic e2e (M6)

`make e2e-ai [TARGET=tunnel|live|fixtures] [MODEL=haiku|sonnet|opus] [TASK=name]` has Claude operate the real UI
through a browser and checks its answers against the daemon API. It runs **Claude Code headless on the user's
subscription**, not an API key: `apps/web/e2e/ai/run.ts` invokes `claude -p` per task with `--strict-mcp-config`
and a pinned `@playwright/mcp` server (headless, isolated profile, origin restricted to the dashboard), built-in
tools removed, an allowlist of browser tools (no `browser_evaluate`), `--permission-mode dontAsk`,
`--max-turns`, `--max-budget-usd 0.50`, `--no-session-persistence`, a rubric appended to the system prompt
(`e2e/ai/rubric.md`), and `--json-schema` for a structured answer. The run happens from a neutral temp cwd with
`ANTHROPIC_API_KEY` unset. Targets: `tunnel` (default: the browser reaches the mini's 5090 through an ssh tunnel,
so it works anywhere), `live` (http://ranch-ai.tail6d04cd.ts.net:5090 over the tailnet), `fixtures` (the fixture daemon + a local build, no ranch).

Tasks (`e2e/ai/tasks.ts`) and their oracles (`e2e/ai/oracle.ts`, code over `@ranch/contracts`, evaluated before
and after the run because live data moves): camera with the most horse detections in the last hour; donkey_cam's
current equine count; the offline cameras; the daemon using the most memory; the newest moving person (camera and
time); and, with Sonnet, change the coco person threshold to 0.7 in the taxonomy draft, score it and report the
gate (no token, so it cannot apply). Reports go to `e2e/ai/runs/<ts>.json` (git-ignored).

First results, 22 Oct: fixtures 6/6 and live (tunnel) 6/6 after two oracle fixes; haiku tasks take 4–8 turns and
10–25 s each at a ~$0.002–0.005 client-side cost estimate, the Sonnet taxonomy task 9–11 turns and 30–50 s at
~$0.12–0.15; usage counts against the subscription's windows. Lessons: the oracle must mirror the page's own query
(the label filter applies to the head frame, "moving" to the whole burst); the set judge extracts camera names from
free text because the model sometimes answers in a sentence instead of the structured field. Private use only:
the Agent SDK terms do not allow offering claude.ai login to third parties.

## End-to-end tests (M5)

`make e2e` (or `npm -w apps/web run e2e`) runs Playwright against a local standalone build and the fixture daemon
(`apps/web/test/fixture-server.ts`: the recorded fixtures, images, an SSE stream with scripted MQTT, the buffer
endpoints, taxonomy writes that need `x-ranch-token: test-token` and keep per-version contents, and a
`?scenario=sse-stall` stream for the watchdog test). Projects: iPhone 13, iPad Mini, desktop Chromium. Specs:
home (cards, online states, offline alerts, live badge, card → camera page), detections (filters → URL, deep link
opens the viewer on a burst member, keyboard navigation, baseline sets), phone gestures (swipe advances, bottom
tabs), taxonomy (edit → validate → score → gate table → apply refused without a token, applied with it → new
active version → revert), system (daemons, parsed ingest status, probe table), evals (prod row, result file),
axe on every page (no serious or critical violations; colour contrast checked separately), and the reconnect
watchdog (after 45 s of silence the client reopens the stream). 22 Oct: 52 passed, 2 skipped (touch tests on
desktop), ~20 s, two consecutive runs clean.

Hardening: detection overlay colours re-chosen with the dataviz palette validator (CVD separation ≥ 8.6 ΔE
deutan, normal-vision ≥ 17, contrast ≥ 3:1): horse `#34c47f`, person `#f28c3a`, vehicle `#3f8fe6`, gold
`#c9ccd4` dashed, other `#d9ab30`; they sit on photos and are theme-independent. Home-screen install: manifest
with 192/512 px icons and an Apple touch icon. Client JavaScript after build: 867 kB across all chunks (the
shared runtime chunk 229 kB); no per-route first-load figure is printed by Next 16's build, so the number to
watch is the total. Lighthouse was not run (no tool on the laptop); axe covers accessibility.

## Rollback

The API never changed shape across the cut-over, so rolling back is a provision: revert the cut-over commits (or
check out the commit before them), add `com.ranch.web` to `ranch_daemons_retired` in that revert, `make provision`.
The status plist renders 5090/0.0.0.0 again and is rebootstrapped; the old pages come back with the tree; the
retired task boots out `com.ranch.web` and deletes its plist. `apps/web/.next` on the mini is excluded from the rsync
delete, so finish with `ssh ranch rm -rf /usr/local/ranch/app/apps/web/.next`.
