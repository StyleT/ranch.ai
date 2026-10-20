# Handoff — state as of 19 Oct 2026, 21:00 ET

## Where things stand
Phase 0 is closed. Phase 1 is **mid-way**: cameras stream through our own go2rtc + bridge daemons, the sampler
keeps frames every 10 s, yolo11n runs on the ANE, a status page and a network probe run, and all of it is under
launchd with unified logging. The last three days went to camera dropouts (docs/CAMERAS.md, "Analysis, 19 Oct"):
proven causes are a go2rtc panic in its Wyze DTLS code (now auto-restarted, draft report in docs/upstream/) and
per-grab TUTK session setup failing under 2.4 GHz loss (fixed 19 Oct by a persistent in-process consumer per
camera). mops_cam is effectively off the network (5 % ping success) and needs physical attention.

**Regroup, 19 Oct. Next, in order:**
1. Watch delivery for a day with the keep-alive on (`ranch frames --since 24h --json | …`, or the status page):
   target ≥ 300 frames per camera per hour. If the go2rtc panic recurs, count it; decide on the upstream report.
2. Phase 1 step 6: the frames are picked (`evals/baseline/2026-10-20/`, 300 frames, zero-shot predictions from
   all four models recorded). Run the Claude labeling batch on the first 100 of them (~$1.60; key on the mini):
   `node evals/label/claude.ts estimate|submit --frames evals/baseline/2026-10-20/frames.jsonl --n 100`. Then step 7: the recall benchmark. The detector
   evidence makes this urgent: yolo11n emits thousands of confident night false positives (bench, bottle,
   clock, airplane) per day; nothing downstream should trust tier 1 until the benchmark and a class filter exist.
3. Post 1 draft from the measured numbers, plus the dropout story as the "what went wrong" section.
4. Vlad: relocate mops_cam or its AP; report per-camera signal from the Wyze app. Consider the SD sub-stream
   for sampling if the 15 Mbit/s of continuous HD ever matters (today it does not: 5 GHz link is clean).

## The machine
| Item | Value |
|---|---|
| Hardware | Mac mini M2, 8 GB, internal disk size not yet checked |
| OS | macOS 27.0.1 (26A434) |
| Names | ComputerName/HostName/LocalHostName `ranch-ai`; Tailscale `ranch-ai.tail6d04cd.ts.net`, 100.72.239.2, tailnet StyleT@github |
| User | `ranch`, uid 501, admin, password in Vlad's password manager, FileVault off, auto-login off |
| Access | `ssh ranch` (Tailscale) / `ssh ranch-lan` (LAN); laptop key `~/.ssh/id_ed25519`; sshd keys-only; `sudo -n` works |
| Installed | Xcode CLT (python 3.9.6), Homebrew 7.0.9, git, jq, ffmpeg, mosquitto (installed, not started), tailscale, fnm + Node 24, uv |
| Daemons | `com.ranch.tailscaled`, `com.ranch.caffeinate`, `com.ranch.quiet-audiomxd`, `com.ranch.mosquitto`, `com.ranch.wyze-bridge`, `com.ranch.seed-recorder` (idle), `com.ranch.ingest`, `com.ranch.detector`, `com.ranch.netprobe`, `com.ranch.status` (all `/Library/LaunchDaemons`; output in the unified log via `logger`) |
| Status page | `com.ranch.status`, `apps/status`, port 5090 on all interfaces, no auth; ~1 Node process, `node:http` + SSE, reads SQLite/MQTT/launchd/logs/seed dir |
| App paths | tree `/usr/local/ranch/app` (rsync of the laptop checkout), models `/usr/local/ranch/models`, DB `/usr/local/ranch/var/ranch-events.sqlite`, frames `/usr/local/ranch/media/frames/<cam>/<date>/` |
| Phase 1 paths | bridge binary + go2rtc in `/usr/local/ranch/bin`, source checkouts `/usr/local/ranch/src`, state `/usr/local/ranch/var`, media `/usr/local/ranch/media` (all owned by `ranch`) |
| Ports (LAN + tailnet, no auth) | RTSP 8554, go2rtc API 1984, bridge UI 5080, status page 5090, WebRTC 8889 + 8189/udp, HLS 8888; Mosquitto 1883 on loopback only |
| Measured headless, 10 min uptime | load 1.30, 91% memory free, 0 swap, ~212 processes, reboot→SSH 25–28 s |

## Operating it
```
make provision   # apply; must end changed=0 on the second run
make check       # drift report, changes nothing
make verify      # after a reboot: asserts no console user, no noisy agents, audiomxd paused
make snapshot    # infra/snapshots/<date>/ ; commit the result
make logs        # live tail of every daemon (unified log); make logs-last H=3 for the last 3 hours
# status page :5090 (cameras, daemons, detections per camera); :5090/frames browses kept frames with the boxes
# drawn on them, and any baseline set with any model's predictions (docs/FRAMES-AND-BASELINE.md)
make bootstrap   # only on a freshly erased mini (Xcode CLT + Homebrew), see infra/MANUAL.md
```
**Tracking the pipeline:** the status page at http://ranch-ai.tail6d04cd.ts.net:5090/ (`ranch-ai.local:5090` on the
LAN) replaces the ssh one-liners: daemon pids and last log lines, per-camera thumbnail / last-frame age / frames
per minute / horse count / online (= a kept frame in the last 60 s; the bridge's "streaming" is not liveness),
detections by label for the last hour, latest events, seed-recorder progress, free disk, and a live MQTT ticker over
server-sent events. JSON at `/api/status`, thumbnails at `/api/frame/<camera>`, stream at `/api/events`. No auth,
same trade-off as the bridge UI. Design note: `docs/STATUS-DASHBOARD.md`. The CLI (`ranch status|frames|counts|
cameras|events`) and `make logs` / `make logs-last H=3` (unified log) are the scripting path.
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
    the log file before installing the plist. Superseded 16 Oct: there are no log files any more (gotcha 19).
14. **go2rtc never drops a dead producer.** When a camera's TUTK session dies, the stream keeps its producer, new
    consumers attach and hang, consumers leak (624 after 12 h), and the bridge still reports `streaming`. The
    sampler's stall watchdog recreates the stream after 180 s without a frame (docs/CAMERAS.md incident, 16 Oct).
15. **`launchctl kickstart -k` restarts the definition launchd already holds.** A changed plist (new
    EnvironmentVariables, ProgramArguments) only takes effect after `bootout` + `bootstrap`. The seed recorder ran
    for 16 h without the 48 h window it was supposedly given. The services role now re-bootstraps daemons whose
    plist changed and kickstarts those whose script changed (16 Oct).
16. **The cameras' 2.4 GHz Wi-Fi is the scarce resource, not the mini.** Mini: 5 GHz, -18 dBm, 1200 Mbit/s link,
    channel ~30 % busy, 10 Mbit/s inbound with all seven HD streams open. Wyze cams are 2.4 GHz only; with seven
    continuous HD pulls (seed recorder + sampler) their TUTK sessions dropped in bunches (five at once on 15 Oct
    23:24, Front Porch and Wash Stall again on 16 Oct). Seed recorder stopped at 16 h; the sampler's one frame per
    10 s is the same data. Next lever: SD sub-stream for sampling, HD on demand. Signal per camera is in the
    Wyze app (Device Info), which is where the next measurement comes from.
17. **The bridge did not supervise its go2rtc child.** go2rtc exited with status 2 at 17:27:49 ET on 16 Oct (right
    after a DTLS handshake timeout), the bridge logged `connection refused` from its health check 431 times over
    3.6 h and never restarted it; its stderr (the panic) was not captured. go2rtc now runs as `com.ranch.go2rtc`
    (KeepAlive, own log at debug for `streams`), the bridge uses it through `GO2RTC_URL`.
18. **go2rtc writes API-added streams into its first `-config` file.** With one managed file that meant a
    template change on every provision and a restart loop. It now gets `-config state.yaml` (scratch, created
    once) followed by the managed `go2rtc.yaml`.
19. **Logs are the OS's.** Daemon stdout/stderr go through `logger` into the unified log; `logger -t` tags are
    *not* stored (verified 16 Oct), so attribute lines by the logger pid (`ps -axo pid,args | grep 'logger -t'`)
    or by content (`"svc":"ingest"`, bridge lines start with `{"level"`, go2rtc lines with a timestamp). ASL
    file modules in `/etc/asl` no longer receive logger output on macOS 27 (tested), and newsyslog cannot make a
    launchd-held file reopen, which is why files were dropped. Query: `sudo log show --last 1h --predicate
    'process == "logger"' --style compact`; JSON: `--style json`, field `eventMessage`.
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
4. ~~Seed dataset~~ recording since 15 Oct 20:32 ET: `com.ranch.seed-recorder` (`infra/bin/seed-recorder.sh`), one
   keyframe-only ffmpeg per camera, one native-resolution JPEG every 10 s into `/usr/local/ranch/media/seed/<cam>/`
   (UTC timestamps in the file names). 1 fps at 2K would have been ~50 GB per camera per 48 h, so 1/10 s it is
   (~5 GB per camera). Pauses below 40 GB free. Offline cameras are retried every minute and join on their own.
   Measured steady state: ~0.1 % CPU per puller, but 155–257 MB RSS each (2K H.264 decoder buffers); five pullers
   ≈ 1.1 GB. Tried on donkey_cam for 60 s (15 Oct): default 125 MB, `-threads 1` 111 MB, `-hwaccel videotoolbox`
   151 MB, both 134 MB; so no cheap fix, and RSS keeps growing for minutes after start. Fine for a temporary
   recorder, not for the Phase 1 sampler: that one should take frames from one short-lived process per sample
   (or the go2rtc `frame.jpeg` endpoint) rather than hold seven decoders open.
   **Stopped after 16 h (16 Oct 13:00 ET, `seed_hours: 16`)**: 7,434 frames, 3.2 GB, five cameras for the whole
   window and two for the last 2 h. The daemon idles; the sampler's frames table (`ranch frames`, 7-day retention)
   continues the dataset at the same cadence. See gotcha 16 for why.
5. ~~Code~~ done 15 Oct, all running as LaunchDaemons and converging in Ansible (`roles/app` rsyncs the working
   tree to `/usr/local/ranch/app`, runs `npm ci`, builds the Swift runner, syncs CoreML models):
   - `packages/events`: `node:sqlite` store, schema v1 (frames, detections, events, camera_counts), tests.
   - `packages/bus`: MQTT topics `ranch/frames|detections|counts|events|status`.
   - `apps/ingest` (`com.ranch.ingest`): one-shot go2rtc JPEG grabs every 5 s, kept on scene change or a 10 s
     floor, 7-day retention. ~195 MB RSS (node + sharp). go2rtc grabs take ~2 s each (next keyframe).
   - `apps/detector` (`com.ranch.detector`): Swift Core ML runner over stdin/stdout (Vision for YOLO's built-in
     NMS, own sigmoid/top-k decode for RF-DETR raw outputs), TS wrapper subscribes to frames, writes detections,
     publishes per-minute counts. yolo11n on the ANE: ~7 ms/frame, 62 MB. The 2 cars in the back yard are found
     at 0.93; horses at night not yet (expected at 640 px input; the benchmark decides).
   - `apps/cli`: `ranch events|frames|counts|verdict|cameras|status` (on the mini's PATH).
   - `apps/detector/export`: uv project on the laptop; `export_yolo.py` (n, s exported), `export_rfdetr.py`
     (image input with ImageNet normalization folded in, so Vision can feed it). Models are not in git; `make
     provision` syncs `*.mlpackage` + `*.labels.json` to `/usr/local/ranch/models`.
   - `evals/label`: `select.ts` (stratified pick), `claude.ts` (Batch API + structured outputs). Needs
     `ANTHROPIC_API_KEY` on the laptop; the mini has no key and does not need one for this.
6. Claude labels 100 seed frames first (`claude-opus-5-5`, structured outputs, Batch API) → `evals/golden/*.jsonl`
   with `labeler: claude`. Decided 15 Oct: AI labels are the Phase 1 ground truth, no human review yet.
7. Benchmark: latency/fps/RSS half **done 15 Oct** (`evals/detector/README.md`): yolo11n 8 ms, yolo11s 18 ms,
   RF-DETR nano fp16 31 ms on the ANE; RF-DETR fp32 + `.cpuAndNeuralEngine` returns all-zero logits (GPU/CPU
   fine). Recall half waits for the labels (step 6). `horse_count` per minute is already published by
   `com.ranch.detector` (yolo11n placeholder). Post 1.
8. Phase 1b: Vlad labels the same 100 frames blind; compare label agreement and whether the benchmark ranking
   changes when scored on human labels. Post 1b. See PLAN.md Phase 1.

**Blocked on Vlad:**
- ~~`ANTHROPIC_API_KEY`~~ placed 15 Oct on the **mini** at `~/.config/ranch/anthropic.env` (mode 600). The account
  has limited credits: estimate first (free), smoke-test on 2 frames, Batch API only. Labeling runs on the mini:
  `set -a; . ~/.config/ranch/anthropic.env; set +a; node evals/label/claude.ts ...` from `/usr/local/ranch/app`.
  Smoke test 15 Oct 22:10 ET (batch `msgbatch_01EUgqh7cC1KWFFQnjjkdcXR`, 2 frames, $0.031): schema-valid, car
  boxes within a few percent of the detectors', horse at the feeder found, gate/trough read. Real cost is ~1.5 ¢
  per frame (3.7k input tokens: image + system + output schema), so 100 frames ≈ $1.60.
  Day frames exist from the morning of 16 Oct onward, so the 100-frame pick should wait for one daylight cycle.
  **Next session, on the mini, from `/usr/local/ranch/app`:**
  ```
  N="/usr/local/ranch/bin/node --no-warnings=ExperimentalWarning"; set -a; . ~/.config/ranch/anthropic.env; set +a
  $N evals/label/select.ts --n 100 --out evals/golden            # check the day/night split it prints
  $N evals/label/claude.ts estimate && $N evals/label/claude.ts submit
  $N evals/label/claude.ts collect --batch <id>                   # → evals/golden/labels.claude.jsonl
  M=/usr/local/ranch/models; $N apps/detector/src/bench.ts --labels evals/golden/labels.claude.jsonl \
     --model $M/yolo11n.mlpackage --model $M/yolo11s.mlpackage --model $M/rfdetr-nano-float16.mlpackage \
     --compute ane --threshold 0.25 --out evals/detector/bench-recall-$(date +%F).json
  ```
  then rsync `evals/golden/{frames.jsonl,labels.claude.jsonl}` and the bench JSON back into the laptop checkout
  and commit (the tree on the mini is an rsync target, not a git clone).
- Tractor Cam and Back Pasture Cam are off the LAN (no ARP entry); power / Wi-Fi at the camera end.
- Confirm the "In scope" column in `docs/CAMERAS.md`; which camera watches the trough.
- ~~Camera inventory~~, ~~Wyze API credentials~~, ~~SSD decision~~: all closed 14 Oct.

## Open threads
- The services role's `reload launchd daemons` handler kickstarts every daemon in `ranch_daemons` when any plist or
  script changes, which restarts the bridge (and drops the streams for ~10 s) on unrelated changes. Make it per-item.
- ~~Push the repo to GitHub~~ done 14 Oct (`StyleT/ranch.ai`). Add a LICENSE (MIT) before Post 0.
- First unattended reboot with the audiomxd watchdog from cold has not been observed (it was deployed onto an
  already-paused daemon). `make verify` after the next reboot confirms it.
- Install Tailscale on Vlad's phone before Phase 2 (alert links).
