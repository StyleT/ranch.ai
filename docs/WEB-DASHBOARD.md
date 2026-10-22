# Web dashboard (`apps/web`, `com.ranch.web`)

*Plan approved 22 Oct 2026 (`~/.claude/plans/…bubbly-puddle.md` in the session; summarized here). Built the same day
through milestone 3. Replaces the hand-written pages of `apps/status` once the cut-over (milestone 4) moves it to
port 5090.*

## What it is

A Next.js 16 app (React 19, TypeScript, Tailwind 4, TanStack Query 5) that is both the frontend and a
backend-for-frontend: route handlers under `/api/ui/*` compose UI-shaped documents by calling the status daemon
server-to-server over loopback, validated at the boundary against `packages/contracts` (zod schemas of every
daemon response; the daemon's `Status` `satisfies` them). The Next process holds no SQLite, no MQTT and no native
modules: one shared upstream SSE connection is fanned out to browsers (`/api/ui/live`), frames are proxied from the
daemon (which resizes with sharp), camera streams are proxied from go2rtc over HTTP only (fMP4, HLS, MJPEG, JPEG;
MSE/WebRTC need WebSocket upgrades a route handler cannot do) with a cap of two concurrent streams, abort
propagation so leaving the page drops the go2rtc consumer, and MJPEG only for cameras in `RANCH_KEEPALIVE_EXCLUDE`.

```
browser (LAN) ──:5090 (after M4; :5092 loopback until then)──> com.ranch.web   Next standalone
                                   │ loopback
                                   ├──> com.ranch.status  :5090 today, 127.0.0.1:5091 after M4   JSON + SSE + frames + taxonomy + bench
                                   └──> go2rtc            127.0.0.1:1984
```

## Pages

| Route | Content |
|---|---|
| `/` | health strip, derived alerts (camera offline, daemon down, detector stale, taxonomy drift, disk, burst throttling, no frames), camera cards with live thumbnails and the equine count, activity feed (bursts/tracks, live over SSE), detections per camera × label with raw-label tooltips, events placeholder |
| `/cameras/[name]` | live stream (always on while visible; HLS on Safari, fMP4 elsewhere, MJPEG fallback; paused when hidden), online timeline and equine count chart over 1h/6h/24h/7d, motion and network signal, recent bursts, and the detections browser locked to the camera |
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
- M3 (22 Oct): all six pages, built and running on the mini's loopback port 5092 (not yet on 5090).
- Next: M4 cut-over (status daemon to 127.0.0.1:5091, web to 5090, old pages removed, docs); M5 Playwright e2e,
  axe, bundle, manifest; M6 agentic e2e with `claude -p` + Playwright MCP over the subscription.
