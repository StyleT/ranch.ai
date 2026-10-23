# ranch — instructions for Claude Code

Home AI for a horse ranch on an 8 GB Apple Silicon Mac mini (`ranch-ai`). Built as public content for
Substack/LinkedIn/X aimed at Staff/Principal AI-platform readers: every phase ends in a post with a
measured number and an architecture decision. Read `docs/HANDOFF.md` first, then `docs/PLAN.md`.

## Target machine
- Mac mini M2, 8 GB, macOS 27.0.1. User `ranch` (uid 501), key-only SSH, passwordless sudo.
- Reach it with `ssh ranch` (Tailscale MagicDNS `ranch-ai.tail6d04cd.ts.net`, 100.72.239.2) or
  `ssh ranch-lan` (`ranch-ai.local`) when on the ranch LAN. Both aliases live in the laptop's `~/.ssh/config`.
- Headless by design: **no auto-login, no GUI session, no Docker Desktop.** If you log in over Screen
  Sharing, log out afterwards; Apple's GUI agents ignore `launchctl disable` inside a session.
- macOS has no `timeout`, `sudo` needs a TTY for one-shot ssh commands (use `ssh -t` or rely on
  passwordless sudo with `sudo -n`).

## How work is done
- All configuration goes through Ansible in `infra/ansible/`; never hand-edit the mini and leave it.
  `make provision` (apply), `make check` (drift, `--check --diff`), `make verify` (post-reboot asserts),
  `make snapshot` (dump state to `infra/snapshots/<date>/`, commit it).
- A change is done when a second `make provision` reports `changed=0` and `make check` is clean.
- Read-only `command`/`shell` tasks carry `changed_when: false` **and** `check_mode: false`.
- **Every long-running process is a LaunchDaemon under launchd supervision (KeepAlive), never a child of another
  daemon and never a bare background process.** Logging is the OS's: each plist runs the program through
  `/bin/bash -c 'exec <cmd> 2>&1 | exec /usr/bin/logger -t ranch.<name> -p user.notice'`, so output lands in the
  unified log (`log show` / `log stream`, `make logs`, `make logs-last H=3`); retention and rotation are the
  system's, there are no log files and no custom rotation. launchd kills the whole process group on stop, so the
  pipe is safe. Template in `infra/launchd/<label>.plist.j2`, scripts in `infra/bin/`, registered in
  `roles/services/tasks/main.yml` (`ranch_daemons`). A changed plist is re-bootstrapped (kickstart would keep the
  old definition).
- Ports listed in `tailscale_blocked_ports` (group_vars) are refused on the Tailscale addresses by a pf anchor and are
  LAN-only (today: 5090, the dashboard). Ports in `loopback_only_ports` (5080 bridge, 1984/8554/8889 go2rtc) are refused
  on every interface but lo0: only processes on the mini may talk to go2rtc or the bridge, because a go2rtc consumer
  makes it dial a camera. Verify with `ssh ranch curl 127.0.0.1:<port>` and `make camera-owners`; `make tunnel` forwards
  5091 and 5080 to the laptop.
- The dashboard is `apps/web` (Next.js, `docs/WEB-DASHBOARD.md`) on 5090; `apps/status` is its JSON/SSE API on
  `127.0.0.1:5091` and serves no HTML. `make web-dev` runs the app on the laptop against the mini's API.
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

## Architecture rules (see docs/PLAN.md §4)
- TypeScript (Node 24 via fnm) for orchestration, agent, MCP tools, CLI. Python (`uv`) only for the MLX
  vision sidecar. MQTT (Mosquitto) + SQLite/sqlite-vec as the spine. Claude API models: `claude-opus-5-5`
  for escalation/labeling, `claude-haiku-5-5` as judge. Frigate is a benchmark, never the runtime.
- Memory budget is the constraint: one ~3 GB VLM resident, nothing else large. Measure before adding.
- Local by default, cloud by exception; events not streams; one MCP tool surface; OTel on every stage.
- **Cameras: one owner, consumers read disk (docs/CAMERA-ARCHITECTURE.md).** Exactly one service holds a
  connection to each camera; `com.ranch.recorder` is the single live-stream consumer and writes a rolling disk
  buffer at `<media>/buffer/<cam>/`. Every other process (sampler, detector, status) reads that buffer and NEVER
  calls go2rtc or a camera. Prefer the local TUTK/LAN path; keep the bridge's WebRTC fallback. Never `DELETE`/
  recreate a go2rtc stream from our code. This exists because go2rtc dials a camera on consumer-attach and drops
  it at zero consumers, so dynamic/multiple consumers churn camera handshakes and overload the cameras (22 Oct).
  Readers never memory-map a buffer file (`apps/status/src/jpeg.ts`: read into a Buffer, then sharp); the recorder
  writes atomically. The rule is measured, not assumed: `make camera-owners` / `make verify` fail on any other consumer.
