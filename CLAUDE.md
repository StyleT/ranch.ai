# ranch — instructions for Claude Code

Home AI for a horse ranch on an 8 GB Apple Silicon Mac mini (`ranch-ai`). Built as public content for
Substack/LinkedIn/X aimed at Staff/Principal AI-platform readers: every phase ends in a post with a
measured number and an architecture decision. Read `docs/HANDOFF.md` first, then `docs/PLAN.md`.

## How to approach work 
### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Target machine
- Mac mini M2, 8 GB, macOS 27.0.1. User `ranch` (uid 501), key-only SSH, passwordless sudo.
- Reach it with `ssh ranch` (Tailscale MagicDNS `ranch-ai.tail6d04cd.ts.net`, 100.72.239.2) or
  `ssh ranch-lan` (`ranch-ai.local`) when on the ranch LAN. Both aliases live in the laptop's `~/.ssh/config`.
- Headless by design: **no auto-login, no GUI session, no Docker Desktop.** If you log in over Screen
  Sharing, log out afterwards; Apple's GUI agents ignore `launchctl disable` inside a session.
- macOS has no `timeout`, `sudo` needs a TTY for one-shot ssh commands (use `ssh -t` or rely on
  passwordless sudo with `sudo -n`).

## How work is done
- **Always work on `main`, in this checkout. DO NOT USE WORKTREES.** No feature branches, no `.claude/worktrees/`,
  no `EnterWorktree`, unless Vlad asks for one by name. Edit, commit and provision from `main`; push to `origin main`.
  If a session finds itself inside a worktree, say so and move to the main checkout before touching anything.
  (Vlad, 1 Nov 2026, after a day's work landed on a worktree branch while the App, the mini and his terminal were on main.)
- **A plan is the current state of the work, never a ledger.** Two levels: the master plan `docs/PLAN.md` (the project,
  its phases and decisions; also a doc under writing-docs) and the piece plans Claude Code keeps while implementing one
  piece of it (`~/.claude/plans/<slug>.md`, named after the master-plan item they implement). Both hold what is known,
  what is decided and what remains, in order. A finished step is deleted and its result folded in as a fact; a changed
  decision is rewritten; history goes to the appendix at the end and nowhere else; when a piece lands, the master plan
  moves in the same session (during implementation: plan mode writes only the plan file and never touches the repo). `.claude/skills/plan-maintenance` is mandatory before creating or editing either (plan
  mode, after a step lands, after compaction, at session end); its checker runs on every write to a plan file
  (PostToolUse hook in `.claude/settings.json`) and on a staged `docs/PLAN.md` (pre-commit), and refuses a ledger.
- **A question is answered, never acted on.** When Vlad asks something ("why is X like this?", "am I right that...?",
  "how do I...?"), the deliverable is the answer: no edits, no scripts against the data, no commits, no fixes on the
  side. Answer, propose in one line if there is something to do, and wait for his decision. Work already running in the
  background continues; nothing new starts. Only an explicit request ("fix it", "do it", "revert") triggers action.
  (1 Nov 2026: a "why only truck?" question was answered with a rewritten schema and 27 relabeled boxes; all reverted.)
- All configuration goes through Ansible in `infra/ansible/`; never hand-edit the mini and leave it.
  `make provision` (apply), `make check` (drift, `--check --diff`), `make verify` (post-reboot asserts),
  `make snapshot` (dump state to `infra/snapshots/<date>/`, commit it).
- A change is done when a second `make provision` reports `changed=0` and `make check` is clean.
- `make provision` deploys the checkout it runs from (rsync over the mini). Provision from the main checkout after
  fast-forwarding it to origin/main; the playbook refuses a checkout missing origin/main commits. Flow, rollback and
  worktree cleanup: `.claude/skills/version-management`. Verifying the dashboard and live view (the layers, and why
  fixture tests and file freshness are not enough): `.claude/skills/verify-dashboard`.
- Read-only `command`/`shell` tasks carry `changed_when: false` **and** `check_mode: false`.
- **Every long-running process is a LaunchDaemon under launchd supervision (KeepAlive), never a child of another
  daemon and never a bare background process.** Logging is the OS's: each plist runs the program through
  `/bin/bash -c 'exec <cmd> 2>&1 | exec /usr/bin/logger -t ranch.<name> -p user.notice'`, so output lands in the
  unified log (`/usr/bin/log show` / `stream` on the mini, where zsh's builtin `log` shadows it; `make logs`,
  `make logs-last H=3`, `make logs-of D=<daemon>`); retention and rotation are the
  system's, there are no log files and no custom rotation. launchd kills the whole process group on stop, so the
  pipe is safe. Template in `infra/launchd/<label>.plist.j2`, scripts in `infra/bin/`, registered in
  `roles/services/tasks/main.yml` (`ranch_daemons`). A changed plist is re-bootstrapped (kickstart would keep the
  old definition).
- Ports listed in `tailscale_only_ports` (group_vars) are accepted by the pf anchor only from Tailscale clients on the
  node's tailnet addresses and refused on the ranch LAN (today: 5090, the dashboard: `http://ranch-ai.tail6d04cd.ts.net:5090`;
  `ranch-ai.local:5090` is refused). Ports in `loopback_only_ports` (5080 bridge, 1984 go2rtc API, 8554 go2rtc RTSP)
  are refused on every interface but lo0. The go2rtc **WebRTC media port 8889 is the exception: tailnet-only** (its own
  pf section, TCP+UDP from Tailscale clients only), because the browser consumes the camera over WebRTC directly; the
  signalling is still proxied through the web app to go2rtc on loopback. Verify loopback ports with
  `ssh ranch curl 127.0.0.1:<port>` and `make camera-owners`; `make tunnel` forwards 5091 and 5080 to the laptop.
- The dashboard is `apps/web` (Next.js, `docs/WEB-DASHBOARD.md`) on 5090; `apps/status` is its JSON/SSE API on
  `127.0.0.1:5091` and serves no HTML. `make web-dev` runs the app on the laptop against the mini's API. The live view
  is **WebRTC from go2rtc** (sub-second, native H.264, no transcode): the browser gets the camera's own stream, with the
  recorder's on-demand HLS (`<media>/live/<cam>/`, served as files by the daemon) as the fallback when WebRTC does not
  connect. Both are go2rtc consumers that share the one producer the recorder already holds (below), never a second
  camera dial and never an MJPEG re-encode.
- Classes, subclasses and detector thresholds live in `packages/taxonomy/taxonomy.json` and nowhere else; the mini
  holds versions of it (editable on `:5090/taxonomy`). After a UI edit: `make taxonomy-pull`, commit. The repo file
  wins on provision.
- Ansible runs from the laptop: `~/.local/bin/ansible-playbook` (installed with `uv tool`).
  Target interpreter is `/usr/bin/python3` (3.9.6 from Xcode CLT).
- Secrets never enter the repo. Device credentials live on the mini in `~/.config/ranch/*.env` (mode 600);
  Ansible Vault for anything the playbook needs (`infra/ansible/.vault_pass` is git-ignored).
- Git is the system of record. Remote: `git@github.com:StyleT/ranch.ai.git` (`origin`, branch `main`). Commit every
  major change (code, infra role, doc or plan edit, snapshot) as its own commit with a message that says why, and
  push to `origin main` before starting the next piece of work. Never leave finished work uncommitted at the end of
  a session. The repo is public: no secrets, no credentials, no device tokens, ever.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (or the current model).
- ESLint (`curly: all` on every workspace; the web app adds its Next.js rules) and Prettier (120 columns, single quotes,
  code files only) run on staged files from the husky pre-commit hook via lint-staged; a commit that fails a non-fixable
  rule is refused. Whole tree: `npm run lint`, `npm run format` (check) and `npm run format:write`.
- Docs describe the system as it is and name no one: no dated entries, no "as built" ledgers, no people as actors;
  history is git. The rules and the checker are in `.claude/skills/writing-docs` (read it before touching `docs/`);
  the pre-commit hook runs the checker on staged `docs/*.md`, `npm run docs:check` runs it on all of them.

## Architecture rules (see docs/PLAN.md §4)
- TypeScript (Node 24 via fnm) for orchestration, agent, MCP tools, CLI. Python (`uv`) only for the MLX
  vision sidecar and for the laptop-only eval/dataset tooling (`evals/fiftyone`, FiftyOne; `apps/detector/export`),
  which never runs on the mini. MQTT (Mosquitto) + SQLite/sqlite-vec as the spine. Claude API models: `claude-opus-5-5`
  for escalation/labeling, `claude-haiku-5-5` as judge. Frigate is a benchmark, never the runtime.
- Memory budget is the constraint: one ~3 GB VLM resident, nothing else large. Measure before adding.
- Local by default, cloud by exception; events not streams; one MCP tool surface; OTel on every stage.
- **Cameras: one producer, consumers share it (docs/CAMERA-ARCHITECTURE.md).** go2rtc holds exactly one connection
  (one producer) to each camera and multiplexes it to every consumer. `com.ranch.recorder` runs an always-on
  keyframe-JPEG ffmpeg per camera that keeps that producer up and writes the rolling disk buffer at
  `<media>/buffer/<cam>/`; the same ffmpeg also stream-copies the H.264 into a 3-minute ring of one-GOP MPEG-TS segments at
  `<media>/ring/<cam>/`, from which ingest cuts motion clips (`docs/CLIPS.md`, 1 Nov); the sampler, detector and status read that buffer and NEVER call go2rtc or a camera. The
  browser live view is the one place that consumes go2rtc directly — WebRTC/WHEP, or on-demand HLS as fallback — but
  because the recorder's pull already holds the producer, a viewer attaching or detaching shares that producer and
  never makes go2rtc dial the camera. Prefer the local TUTK/LAN path; keep the bridge's WebRTC fallback. Never
  `DELETE`/recreate a go2rtc stream from our code. This matters because go2rtc dials a camera when a producer is first
  needed and drops it at zero consumers, so a producer that is NOT held open churns camera handshakes and overloads
  the weak cameras (22 Oct); the always-on recorder pull is what keeps it held.
  Readers never memory-map a buffer file (`apps/status/src/jpeg.ts`: read into a Buffer, then sharp); the recorder
  writes atomically. The rule is measured, not assumed: `make camera-owners` / `make verify` fail on any other consumer.
