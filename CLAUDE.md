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
- New always-on services are LaunchDaemons: template in `infra/launchd/<label>.plist.j2`, scripts in
  `infra/bin/`, registered in `roles/services/tasks/main.yml` (`ranch_daemons`). Logs go to `/var/log/ranch-*.log`.
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
