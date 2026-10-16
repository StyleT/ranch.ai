# Handoff — state as of 14 Oct 2026, 19:50 ET

## Where things stand
Phase 0 (headless, reproducible Mac mini) is **complete and closed**. Phase 1 (camera ingest + detector) is
**in progress**: the Wyze bridge and Mosquitto run as LaunchDaemons (14 Oct), five of eight cameras stream over
RTSP on the mini, three are offline at the camera end. Details and per-camera table in `docs/CAMERAS.md`. The erase-and-reprovision timing run was
skipped by decision; convergence proof stands in for it.

Repo: this directory (`~/job_hunt_2026/projects/ranch`), pushed to `git@github.com:StyleT/ranch.ai.git` (`origin/main`) on 14 Oct.
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
| Daemons | `com.ranch.tailscaled`, `com.ranch.caffeinate`, `com.ranch.quiet-audiomxd`, `com.ranch.mosquitto`, `com.ranch.wyze-bridge` (all `/Library/LaunchDaemons`, logs `/var/log/ranch-*.log`) |
| Phase 1 paths | bridge binary + go2rtc in `/usr/local/ranch/bin`, source checkouts `/usr/local/ranch/src`, state `/usr/local/ranch/var`, media `/usr/local/ranch/media` (all owned by `ranch`) |
| Ports (LAN + tailnet, no auth) | RTSP 8554, go2rtc API 1984, bridge UI 5080, WebRTC 8889 + 8189/udp, HLS 8888; Mosquitto 1883 on loopback only |
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
10. **LaunchDaemons with `UserName`:** launchd opens `StandardOutPath` as that user, and `/var/log` is root 755,
    so the job dies with `spawn failed`, `last exit code = 78: EX_CONFIG` and no log. The services role touches
    `/var/log/ranch-<name>.log` owned by `ranch` before installing the plist.
11. **`brew info`/`brew bundle` need `/opt/homebrew/bin` on PATH** in non-interactive SSH; the playbook sets PATH
    explicitly. go2rtc is not in Homebrew; it is a pinned release zip with a sha256 in `group_vars`.

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
transformer detector on the Neural Engine" with an fps/memory/recall table (RF-DETR vs YOLO11), scored against
Claude-made labels. Then Phase 1b: human labels on the same frames, compare (Post 1b).
Cameras in scope (15 Oct): all except Living Room.

Order of work:
1. ~~Disk size~~ 245 GB, 200 GB free (14 Oct). SSD optional.
2. ~~Bridge~~ done 14 Oct: `roles/wyze_bridge` builds IDisposable/docker-wyze-bridge v4.5.0 with Homebrew go and
   installs go2rtc 1.9.14 (`go2rtc_mac_arm64.zip`); `com.ranch.wyze-bridge` runs as `ranch`, env from the plist,
   credentials sourced by `infra/bin/wyze-bridge.sh`. Converges to `changed=0`; `make check` clean.
3. ~~Mosquitto~~ done 14 Oct: `roles/mosquitto` + `com.ranch.mosquitto`, loopback 1883, anonymous, persistence in
   `/usr/local/ranch/var/mosquitto`. The bridge publishes under `wyzebridge/`.
4. 48 h of 1 fps keyframes per camera to disk as the seed dataset (ffmpeg from the RTSP streams, or the bridge's
   `SNAPSHOT_INTERVAL`; decide and measure CPU). Wait for Back Pasture Cam to come back first.
5. `packages/events` schema + SQLite migrations; `apps/ingest` sampler; `apps/detector` CoreML runner (native,
   outside any container — the ANE is unreachable from Docker).
6. Claude labels 100 seed frames first (`claude-opus-5-5`, structured outputs, Batch API) → `evals/golden/*.jsonl`
   with `labeler: claude`. Decided 15 Oct: AI labels are the Phase 1 ground truth, no human review yet.
7. Benchmark RF-DETR and YOLO11 CoreML against those labels; emit `horse_count` per camera per minute. Post 1.
8. Phase 1b: Vlad labels the same 100 frames blind; compare label agreement and whether the benchmark ranking
   changes when scored on human labels. Post 1b. See PLAN.md Phase 1.

**Blocked on Vlad:**
- Tractor Cam and Back Pasture Cam are off the LAN (no ARP entry); power / Wi-Fi at the camera end.
- Confirm the "In scope" column in `docs/CAMERAS.md`; which camera watches the trough.
- ~~Camera inventory~~, ~~Wyze API credentials~~, ~~SSD decision~~: all closed 14 Oct.

## Open threads
- ~~Push the repo to GitHub~~ done 14 Oct (`StyleT/ranch.ai`). Add a LICENSE (MIT) before Post 0.
- First unattended reboot with the audiomxd watchdog from cold has not been observed (it was deployed onto an
  already-paused daemon). `make verify` after the next reboot confirms it.
- Install Tailscale on Vlad's phone before Phase 2 (alert links).
