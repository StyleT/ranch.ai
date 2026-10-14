# Handoff — state as of 14 Oct 2026, 19:10 ET

## Where things stand
Phase 0 (headless, reproducible Mac mini) is **complete and closed**. Phase 1 (camera ingest + detector) has
**not started**; it is blocked on inputs from Vlad listed at the end. The erase-and-reprovision timing run was
skipped by decision; convergence proof stands in for it.

Repo: this directory (`~/job_hunt_2026/projects/ranch`), 9 commits on `main`, no remote yet.
Canonical plan: `docs/PLAN.md`. A mirror copy exists at `../horse-watch/PLAN.md`; keep `docs/PLAN.md` as the
source of truth and copy over it if you edit.

## The machine
| Item | Value |
|---|---|
| Hardware | Mac mini M2, 8 GB, internal disk size not yet checked |
| OS | macOS 27.0.1 (26A434) |
| Names | ComputerName/HostName/LocalHostName `ranch-ai`; Tailscale `ranch-ai.tail6d04cd.ts.net`, 100.72.239.2, tailnet StyleT@github |
| User | `ranch`, uid 501, admin, password in Vlad's password manager, FileVault off, auto-login off |
| Access | `ssh ranch` (Tailscale) / `ssh ranch-lan` (LAN); laptop key `~/.ssh/id_ed25519`; sshd keys-only; `sudo -n` works |
| Installed | Xcode CLT (python 3.9.6), Homebrew 7.0.9, git, jq, ffmpeg, mosquitto (installed, not started), tailscale, fnm + Node 24, uv |
| Daemons | `com.ranch.tailscaled`, `com.ranch.caffeinate`, `com.ranch.quiet-audiomxd` (all `/Library/LaunchDaemons`, logs `/var/log/ranch-*.log`) |
| Measured headless, 10 min uptime | load 1.30, 91% memory free, 0 swap, ~212 processes, reboot→SSH 25–28 s |

## Operating it
```
make provision   # apply; must end changed=0 on the second run
make check       # drift report, changes nothing
make verify      # after a reboot: asserts no console user, no noisy agents, audiomxd paused
make snapshot    # infra/snapshots/<date>/ ; commit the result
make bootstrap   # only on a freshly erased mini (Xcode CLT + Homebrew), see infra/MANUAL.md
```
Reboot: `ssh ranch 'sudo -n reboot'`, back in ~30 s. Screen Sharing shows the login window; log out after use.

## Gotchas learned the hard way (all encoded in the playbook)
1. **Auto-login defeats everything.** With a GUI session up, the 21 "disabled" Apple agents (mediaanalysisd,
   imagent, visualintelligenced, Siri/intelligence/spotlight daemons) start anyway and push load to 30–40 at boot.
   No session → none of them exist. `quiet` role tolerates the absent `gui/501` domain.
2. **audiomxd + configd spin headless** (~75% + ~40% CPU) on macOS 27.0.1 with no console user: an audio-routing
   XPC loop waiting for `audioaccessoryd`, which needs a user session. `launchctl disable system/com.apple.audiomxd`
   is accepted and then ignored (SIP); Bluetooth off didn't help; `kill`/restart didn't help. Fix: the
   `com.ranch.quiet-audiomxd` daemon SIGSTOPs it while nobody is logged in and SIGCONTs it when someone is.
   Re-test after every macOS update.
3. **Full Disk Access.** `tmutil disable` and writing `com.apple.TimeMachine` fail over SSH. We only verify no
   Time Machine destination exists.
4. **`sudo brew services` fails as root** (no Homebrew API cache for root). We ship our own LaunchDaemon plists.
5. **`launchctl bootstrap` right after `bootout`** returns `5: Input/output error`. Handlers use
   `kickstart -k` when loaded, `bootstrap` otherwise.
6. **Ansible specifics:** `-e strict_quiet=true` arrives as a string → cast with `| bool`; `command` tasks are
   skipped in `--check` unless `check_mode: false`; `launchctl print-disabled` prints `"label" => disabled`
   (parse with `regex_findall`); `brew bundle check` needs `--no-upgrade` or an outdated formula counts as
   drift; `softwareupdated` rewrites `AutomaticCheckEnabled` at boot, so it is unmanaged.
7. **Bootstrap:** the CLT label on macOS 27 is `Command Line Tools for Xcode 27.0-27.0` (space, not hyphen).
   The mini has no python3 until CLT is installed, so Ansible cannot run before `infra/bootstrap.sh`.
8. **Apple Intelligence off** has no confirmed `defaults` key; it is a manual checklist item.
9. **Magic Keyboard at Setup Assistant** pairs instantly over a USB-C cable when Bluetooth pairing stalls.

## Decisions (why, in one line each)
- Ansible from the laptop over nix-darwin or shell: mature, idempotent, zero agent on the mini, low risk on a
  day-one macOS. Chosen by Vlad on 13 Oct.
- No GUI session, Tailscale as Homebrew `tailscaled` daemon: frees ~1 GB and kills the agent churn; see gotcha 1.
- No Docker Desktop (2 GB VM). The Wyze bridge is the IDisposable Go fork, built natively with `go build` plus the
  go2rtc darwin arm64 binary (no Python, no cgo); OrbStack capped at 1 GB only if a container is unavoidable.
- TypeScript orchestration, Python only for the MLX sidecar (MLX is Python-only; bounded Python exposure is itself
  content). MQTT + SQLite/sqlite-vec. Frigate as the benchmark, not the runtime (won't fit beside the VLM on 8 GB).
- Claude: `claude-opus-5-5` for tier-3 escalation and golden-set labeling (Batch API), `claude-haiku-5-5` as judge.
- Content-first: every phase ends in a post with one diagram, one table of measured numbers, one thing that went
  wrong. Post 0 material: the before/after table above, the auto-login finding, the audiomxd watchdog story.

## Phase 1 — what to build next (docs/PLAN.md §6)
Goal: Wyze streams → ffmpeg frame sampler → CoreML detector on the Neural Engine → events in SQLite, MQTT
`ranch/events/<camera>/<type>`, CLI `ranch events --since 24h`. Post 1: "Liberating Wyze cameras and running a
transformer detector on the Neural Engine" with an fps/memory/recall table (RF-DETR vs YOLO11).

Order of work:
1. Check the mini's disk size (`diskutil info /`) → decide SSD/retention.
2. Bridge: IDisposable/docker-wyze-bridge (Go, chosen 14 Oct; see `docs/CAMERAS.md`). Build with `go build`, run
   with the `go2rtc_darwin_arm64` binary as `com.ranch.wyze-bridge`; credentials from `~/.config/ranch/wyze.env`.
3. Start Mosquitto as `com.ranch.mosquitto` (Brewfile already has it).
4. 48 h of 1 fps keyframes per camera to disk as the seed dataset.
5. `packages/events` schema + SQLite migrations; `apps/ingest` sampler; `apps/detector` CoreML runner (native,
   outside any container — the ANE is unreachable from Docker).
6. Benchmark RF-DETR and YOLO11 CoreML on 100 hand-checked frames; emit `horse_count` per camera per minute.

**Blocked on Vlad:**
- ~~Wyze camera inventory~~ done 14 Oct: 6× Cam v4 (4.52.17.26), 1× Cam v3 Pro (4.58.17.21), 1× Cam v3
  (4.36.17.21), in `docs/CAMERAS.md`. Still missing: what each camera points at, and a reachability check on
  Tractor Cam and Back Pasture Cam (app showed "status unknown").
- Wyze Developer API ID + key, placed on the mini at `~/.config/ranch/wyze.env` (never in chat or the repo).
- Decision on the external SSD once disk size is known.

## Open threads
- Push the repo to GitHub (public, MIT) before Post 0; strip nothing, there are no secrets in it.
- First unattended reboot with the audiomxd watchdog from cold has not been observed (it was deployed onto an
  already-paused daemon). `make verify` after the next reboot confirms it.
- Install Tailscale on Vlad's phone before Phase 2 (alert links).
