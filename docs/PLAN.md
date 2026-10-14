# Horse Watch — project plan

*Drafted 13 Oct 2026. Phase 1 of the "Ranch Control Center" series. Content-first: every phase ends in a post.*

## 1. What we are building

A local-first vision system on an 8 GB Apple Silicon Mac mini that watches the Wyze cameras around the barn and pasture, detects events that matter to a horse owner (horse down for too long, horse missing from pasture, gate open, trough low, predator at night, person on property), writes a nightly digest, and answers questions about what happened. It escalates ambiguous or critical events to Claude, and everything it does is measured by an eval suite built from our own footage.

It is also a platform. The same bus, event store, tool layer and surfaces must later carry the tablet dashboard, the voice agent, the MrCool thermostat and the ER605 dual-WAN monitor without a rewrite.

**Why this is good content.** Most "local AI camera" posts are Frigate configs. Ours has three things they do not: a published precision/recall number on real footage, a hybrid local/cloud routing story with cost and latency per event, and an eval harness that catches regressions every time a model is swapped. That is the Staff/Principal AI-platform narrative, told through horses.

## 2. Principles

1. **Local by default, cloud by exception.** Frames never leave the ranch unless a tier-2 model is unsure or the event is critical. Degraded mode (both WANs down) still detects and records.
2. **Eval before feature.** No detector or prompt ships without a score on the golden set. Every model swap is a post.
3. **Events, not streams.** The system stores structured events with evidence frames. Video stays on disk for a few days; events live forever.
4. **One tool surface.** Every capability (snapshot, query events, set thermostat later) is an MCP tool. CLI, Claude, the tablet and the voice agent all go through the same tools.
5. **Observable by default.** Every pipeline stage emits OpenTelemetry spans. "What did the AI do and why" is a first-class query.
6. **8 GB is a feature.** The memory budget forces tiering and model swapping, which is the architecture lesson worth writing about.

## 3. Hardware and accounts

| Item | Status | Notes |
|---|---|---|
| Mac mini, Apple Silicon, 8 GB | have | Reset and run headless (section 5) |
| Wyze cameras | have | List models and firmware before Phase 1; see risk table |
| External SSD 1 TB (optional) | ~$60 | Clip retention; internal disk is probably 256 GB |
| Wyze Developer API ID + key | create (free) | Required by docker-wyze-bridge since 2024 |
| Anthropic API key | have | Budget guess: $10–30/month at steady state, more during labeling |
| Tailscale account | free tier | Remote access, no port forwarding on ER605 |
| Ansible on the laptop | install via `uv` | ansible-core + community.general; every config change to the mini goes through the playbook |
| ntfy.sh or Telegram bot | free | Phone alerts in Phase 2 |

## 4. Architecture

### 4.1 Layers

```
┌──────────────────────── Surfaces (grow over time) ────────────────────────┐
│ Phase 1-3: CLI + daily digest to phone                                     │
│ Phase 4: Claude agent (ask questions)        Later: tablet web UI, voice    │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │ MCP tools (ranch-tools server)
┌────────────────────────────────────▼──────────────────────────────────────┐
│ Agent + API layer (TypeScript, Node 24)                                    │
│  - ranch-tools MCP server: cameras.snapshot, events.query, events.explain  │
│  - digest writer, alert policy, escalation to Claude                        │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │ MQTT topics + SQLite
┌────────────────────────────────────▼──────────────────────────────────────┐
│ Perception pipeline                                                        │
│  Tier 0  frame sampler (ffmpeg, scene-change gate)           ~0 GB         │
│  Tier 1  detector on Apple Neural Engine (CoreML)            <0.5 GB       │
│  Tier 2  local VLM sidecar (Python, mlx-vlm / vllm-mlx)      ~3 GB         │
│  Tier 3  Claude (cloud) for ambiguous/critical + labeling    0 GB local    │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │ RTSP
┌────────────────────────────────────▼──────────────────────────────────────┐
│ Ingest: docker-wyze-bridge (native via uv, or OrbStack) → RTSP per camera  │
│ Later adapters: MrCool (Home Assistant), Omada API, weather (NWS)          │
└───────────────────────────────────────────────────────────────────────────┘
Infra: Mosquitto (MQTT), SQLite + sqlite-vec (events, embeddings),
       OpenTelemetry → hosted free tier (Langfuse or Braintrust), launchd
Config: Ansible playbook in infra/ansible, state snapshots in infra/snapshots
```

### 4.2 Why these choices

- **TypeScript for orchestration, Python only for inference.** TS is Vlad's strength and the Agent SDK, MCP SDK and Anthropic SDK are first-class there. MLX is Python-only, so the VLM runs as a small Python sidecar with an OpenAI-compatible HTTP endpoint (vllm-mlx or `mlx_vlm.server`). This also closes a job-hunt gap (Python) in a bounded way, which is itself a post.
- **MQTT, not a custom bus.** Home Assistant, Frigate and every tablet dashboard speak MQTT. When the thermostat and the tablet arrive they plug in without new plumbing.
- **SQLite + sqlite-vec, not Postgres.** One file, zero ops, embeddings for "find me the clip where the grey horse was at the gate" in Phase 4. Fits 8 GB.
- **CoreML detector on the Neural Engine, outside Docker.** Frigate's own docs confirm the ANE is unreachable from a container, so the detector is a native process. Candidates: RF-DETR (Apache 2.0, CoreML export, strong on out-of-domain data) or YOLO11 with the COCO `horse` class as a baseline. Benchmark both: that is the Phase 1 post.
- **VLM candidates for 8 GB.** Qwen3-VL-4B-Instruct at 3-bit (~3 GB) or 4-bit, from mlx-community. Gemma 4 E4B (released 2 Apr 2026, image + audio) is the main rival but its Q4 build is ~5.3 GB and will not share the box with anything else. Gemma 4 E2B (~4.4 GB GGUF) is the fallback. Moondream2 (~1.7 GB) as the floor. Measure all four on the golden set: that is the Phase 2 post.
- **Claude as tier 3, labeler and judge.** `claude-opus-5-5` with adaptive thinking for escalations and for first-pass labeling of the golden set (frames + "describe and classify" with structured outputs). `claude-haiku-5-5` as the cheap LLM judge for digest quality. Use the Batch API for the nightly re-label pass at half price. Prompt caching on the fixed instruction + camera-layout prefix.
- **Hosted observability, not self-hosted.** Langfuse self-hosted needs Postgres plus ClickHouse, which will not fit. Emit OTel spans with the GenAI semantic conventions (still marked Development as of mid-2026, so pin the semconv version and note that in the post) and ship them to a free hosted tier.
- **Configuration as code, Mac as cattle.** Everything after Setup Assistant is an Ansible playbook run from the laptop over SSH. A second run must report `changed=0`; `--check --diff` is the drift detector. The erase-and-reprovision test happens once while the box is still empty, because it is cheap now and expensive after Phase 1.
- **No GUI session, no Docker Desktop.** Tailscale runs as the Homebrew `tailscaled` daemon so the mini sits at the login window with nobody logged in, which removes WindowServer, Dock, Siri and the iMessage/iCloud agents from memory. docker-wyze-bridge runs natively under `uv`; if a container is ever needed, OrbStack with a 1 GB VM cap, never Docker Desktop's 2 GB default.
- **Frigate as the benchmark, not the runtime.** Frigate 0.18 now has GenAI review summaries and a chat agent. On 8 GB it cannot run alongside our VLM, but it is the right thing to compare against in the posts ("what Frigate gets you vs. what you learn building it").

### 4.3 Memory budget (resident, steady state)

| Component | Estimate |
|---|---|
| macOS 27 at the login window, no user session | 1.5–2.5 GB |
| VLM sidecar (Qwen3-VL-4B 3-bit) | ~3.0 GB |
| CoreML detector | 0.3–0.5 GB |
| Node services + Mosquitto + wyze-bridge (native) | 0.5–0.8 GB |
| Headroom | 1.0–1.5 GB |

No resident text LLM in Phase 1–4. Text work (digest, Q&A) goes to Claude. Swapping the VLM out for a local text model on demand is a Phase 5 experiment and a post.

### 4.4 Event model

Every event is a row: `id, ts, camera, type, confidence, tier_decided (1|2|3), evidence_frames[], crop_paths[], vlm_text, claude_text, cost_usd, latency_ms, trace_id, verdict (null|true_positive|false_positive)`. The `verdict` column is filled by Vlad from the phone or CLI and feeds the eval set. Every event is also an MQTT message on `ranch/events/<camera>/<type>` so future surfaces subscribe rather than poll.

Event classes for Phase 1–2: `horse_down_prolonged`, `horse_count_mismatch`, `gate_open`, `trough_low`, `animal_unknown_night`, `person_present`, `vehicle_present`. Alert policy: only `horse_down_prolonged` (lying flat > 20 min and not moved) and `person_present` outside hours page the phone. Everything else goes to the digest. Alert fatigue is the enemy and the policy is its own short post.

## 5. Phase 0 — headless, reproducible Mac mini (one weekend)

**Goal.** An identical mini can be rebuilt from an erased disk in under 45 minutes hands-on, and an unattended reboot comes back reachable over Tailscale with all services running and load average under 2.

**State on 13 Oct 2026, late evening.** Bootstrap and playbook built and applied: run 4 reports `changed=0`, `make check` is clean, first snapshot taken (load 3.3 and 74% memory free with the GUI session still up, before reboot). Tailscale daemon running, awaiting one manual `tailscale login`. Reboot and `make verify` pending. macOS has no `timeout`; use a background job plus `sleep` when you need one.

### 5.1 Manual checklist (`infra/MANUAL.md`, ~10 min, one screenshot each)

Setup Assistant cannot be scripted without MDM, so this list stays short and photographed for the post.

1. System Settings → General → Transfer or Reset → Erase All Content and Settings. Install the current macOS release.
2. Language and region. Skip Apple Account. Create admin user `ranch` with a real password (auto-login still works with one; store it in the password manager). Skip Siri, Apple Intelligence, analytics, Screen Time.
3. FileVault off. It conflicts with any unattended boot path and the box holds nothing sensitive.
4. System Settings → General → Sharing → Remote Login on, administrators only. This is the one toggle that has to happen locally; everything else arrives over SSH.
5. System Settings → Apple Intelligence & Siri → both off. No public `defaults` key confirmed for the Apple Intelligence toggle, so it stays manual.
6. No dummy HDMI plug: Apple Silicon minis create a 1920×1080 virtual display with no monitor attached. If a Screen Sharing session looks soft, use High Performance Screen Sharing or the open-source BetterDummy.

### 5.2 Bootstrap (`infra/bootstrap.sh`, run once from the laptop)

```
ssh ranch@ranch-ai.local 'bash -s' < infra/bootstrap.sh
```

Installs Xcode Command Line Tools non-interactively (the `softwareupdate` label trick) and Homebrew with `NONINTERACTIVE=1`. Nothing else. After this python3 is real and Ansible can target the machine.

### 5.3 Ansible playbook (`infra/ansible/`)

Laptop: `uv tool install ansible-core`, then `ansible-galaxy collection install community.general`. Inventory host `ranch-ai.local` now, the Tailscale name later; `ansible_python_interpreter=/usr/bin/python3`. Six roles, each a transcription of something done by hand on 13 Oct:

- **base.** `scutil --set` ComputerName, HostName and LocalHostName to `ranch-ai`; timezone; `pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1 womp 1`; `systemsetup -setremotelogin on`; Screen Sharing via `launchctl enable system/com.apple.screensharing` and `launchctl load -w`; `mdutil -a -i off`; security updates on but `AutomaticallyInstallMacOSUpdates` off so the box never reboots on its own schedule. Time Machine is only verified to have no destination: both `tmutil disable` and writing its preference domain need Full Disk Access, which an SSH session never gets.
- **access.** `authorized_keys` from the laptop's `~/.ssh/id_ed25519.pub`; `/etc/ssh/sshd_config.d/010-keys-only.conf` with PasswordAuthentication and KbdInteractiveAuthentication off; `/etc/sudoers.d/ranch-nopasswd` written with `validate: visudo -cf %s`; handler `launchctl kickstart -k system/com.openssh.sshd`.
- **quiet.** The 21 agent labels from the 13 Oct diagnosis (mediaanalysisd, visualintelligenced, photoanalysisd, photolibraryd, imagent, IMDPersistenceAgent, cloudd, itunescloudd, the three spotlightknowledged variants, corespotlightd, knowledgeconstructiond, the three intelligence*d daemons, siriactionsd, sirittsd, siriknowledged, siriinferenced, suggestd) as a list variable, each `launchctl disable gui/<uid>/<label>`; Siri off via `osx_defaults` on `com.apple.assistant.support` "Assistant Enabled". The role parses `launchctl print-disabled` (format `"label" => disabled`) and is idempotent. Finding from the first reboot: with auto-login on, every one of these agents started anyway despite being marked disabled, so the disable list is defense in depth only. The real fix is no GUI session, which is why the base role turns auto-login off. Strict mode (`make verify`) asserts both: no console user and none of the processes running.
- **packages.** `infra/Brewfile`: git, jq, ffmpeg, mosquitto, tailscale, fnm, uv; OrbStack commented out until needed. Applied with `brew bundle`. Node 24 via fnm.
- **tailscale.** Our own `/Library/LaunchDaemons/com.ranch.tailscaled.plist` runs Homebrew's `tailscaled` as root with nobody logged in (`sudo brew services` fails as root because it cannot reach the user's Homebrew API cache); `tailscale up` with an auth key from Ansible Vault, or once by hand. This is what removes auto-login from the design. Variable `autologin: false`; if ever true, `sysadminctl -autologin set -userName ranch -password {{ vault_ranch_password }}`.
- **services.** launchd plists templated from `infra/launchd/*.plist.j2` into `/Library/LaunchDaemons` and loaded with `launchctl bootstrap system`. Empty in Phase 0 apart from a `caffeinate -dims` daemon as insurance against the display path going dark; Phases 1 to 5 add theirs here.

### 5.4 Snapshot and drift (`infra/snapshot.sh`, `make snapshot`)

Every read-only task carries `check_mode: false` so `--check --diff` still gathers state. Dumps `sw_vers`, `brew bundle dump`, `launchctl print-disabled gui/<uid>`, `pmset -g`, `systemsetup -getremotelogin`, `defaults read` of every domain the playbook touches, listings of `/Library/LaunchDaemons`, `/etc/ssh/sshd_config.d` and `/etc/sudoers.d`, plus `memory_pressure` and `uptime` as a performance baseline, into `infra/snapshots/<date>/` and commits it. `diff` between two snapshots is the human-readable drift report; `ansible-playbook --check --diff` is the machine one.

### 5.5 Dev workflow

VS Code Remote-SSH from the laptop, Claude Code on the mini, the `ranch` repo cloned on the mini, GitHub for the public code. `ssh ranch` alias in the laptop's `~/.ssh/config`.

### 5.6 Acceptance test

1. Playbook run 1 is green against the current mini.
2. Run 2 reports `changed=0`.
3. Reboot. After ten minutes: load average under 2, none of the 21 agents in `ps`, SSH over Tailscale works with nobody logged in, Screen Sharing shows the login window, `memory_pressure` baseline recorded.
4. **Full re-erase → manual checklist → bootstrap → playbook**, timed on video. Target under 45 minutes hands-on. Do it now, while the disk holds nothing.

**Post 0.** "A $600 Mac mini is the best AI edge box nobody talks about" — erase to working in 45 minutes on video, load average before and after the quiet role (11 → under 2), the memory baseline, the FileVault trade-off, why you do not need a dummy plug or auto-login. Platform: Substack long-form, LinkedIn summary, X thread of the playbook.

## 6. Phases 1–5

### Phase 1 — see the horses (2 weekends)

- Inventory cameras: model and firmware. Wyze Cam V4 on firmware ≥ 4.52 blocks TUTK and falls back to WebRTC; Battery Cam Pro and Floodlight Pro are unsupported by the bridge. Decide between mrlt8/docker-wyze-bridge and the IDisposable go2rtc-based fork.
- Run the bridge, confirm one RTSP stream per camera, record 48 hours of 1 fps keyframes to disk as the seed dataset.
- Tier 0 sampler: ffmpeg scene-change gate plus a fixed 1 frame / 10 s floor so nothing is missed at night.
- Tier 1 detector: export RF-DETR and YOLO11 to CoreML, run on ANE, log fps, memory, and `horse` recall on 100 hand-checked frames. Emit `horse_count` per camera to MQTT every minute.
- Deliverable: `ranch-events.sqlite` filling up, a CLI `ranch events --since 24h`.
- **Post 1.** "Liberating Wyze cameras and running a transformer detector on the Neural Engine": the bridge, the ANE-outside-Docker constraint, detector benchmark table.

### Phase 2 — understand what you see (2–3 weekends)

- Python sidecar serving Qwen3-VL-4B over HTTP. Prompt returns strict JSON via structured decoding: `{posture, gate_state, trough_level, animals[], people, vehicles, confidence, needs_escalation}`.
- Tier routing: detector change → crop → VLM. `needs_escalation` or confidence < threshold → Claude with the last 6 frames and the camera's layout note.
- Nightly digest (Claude, one call, prompt-cached prefix) to phone via ntfy. Weekly "most interesting clips".
- Alert policy from 4.4. Phone buttons: "real" / "false alarm" write `verdict`.
- **Post 2.** "Four small vision models on 8 GB: Qwen3-VL vs Gemma 4 vs Moondream, judged on my own horses." Latency, memory, agreement with Claude, cost per event.

### Phase 3 — prove it works (2 weekends)

- Golden set: 300–500 frames stratified by camera, day/night, event class. First-pass labels from Claude (Batch API), every label human-reviewed. Store labels as JSONL in the repo.
- Eval harness in TypeScript: per-class precision/recall for tier 1, JSON-field accuracy for tier 2, LLM-judge score for digests with a 50-item human calibration set. Use promptfoo for VLM prompt regression (it supports image inputs and runs in CI); keep detector metrics in our own script.
- Wire into GitHub Actions on a self-hosted runner on the mini. A model or prompt change that drops recall on `horse_down_prolonged` fails the PR.
- **Post 3.** "I run evals on my barn." The numbers, the night-IR failure modes, how the human calibration set changed the judge. This is the hiring-manager post.

### Phase 4 — talk to it (2 weekends)

- `ranch-tools` MCP server (TypeScript MCP SDK): `cameras.list`, `cameras.snapshot`, `events.query`, `events.explain(trace_id)`, `digest.latest`. Same server will later get `thermostat.*` and `network.*`.
- Agent: Anthropic SDK Tool Runner over those tools, `claude-opus-5-5`, adaptive thinking, structured outputs for anything the UI will render. Hooks for approval gates on any future physical action. CLI chat now; the tablet will reuse the same endpoint.
- Semantic search: embed event crops with a local CLIP-class model into sqlite-vec; `events.search("grey horse at gate")`.
- **Post 4.** "MCP for the physical world: one tool surface for Claude, a CLI and a wall tablet." Also an X thread on tool-description design.

### Phase 5 — trust and resilience (1–2 weekends)

- OTel spans on every stage with GenAI semconv attributes; trace link stored on each event; `events.explain` renders the trace in plain English.
- Degraded mode: watchdog on WAN reachability; when offline, disable tier 3, keep tiers 0–2, queue escalations, replay on reconnect. Test by pulling both WAN cables on the ER605.
- Cost and latency dashboard from the spans: per-event cost, p50/p95 per tier, cloud fraction.
- **Post 5.** "Designing a home AI for the day the cloud goes away." And a short one: "What one night of ranch surveillance costs in tokens."

### Later (out of scope here, but the architecture carries it)

Tablet dashboard (web app on the mini, Fully Kiosk on a $30 Fire HD), voice agent (Gemma 4 E2B's audio input is interesting here), MrCool via Home Assistant, ER605 Omada API, NWS weather and blanket advice.

## 7. Repo layout (public, MIT)

```
ranch/
  apps/
    ingest/        ffmpeg sampler, MQTT publisher (TS)
    detector/      CoreML runner, Swift or Python, native process
    vlm-sidecar/   Python, mlx-vlm server + prompt templates
    brain/         routing, escalation, digest, alert policy (TS)
    ranch-tools/   MCP server (TS)
    cli/           ranch command (TS)
  packages/
    events/        schema, SQLite migrations, sqlite-vec helpers
    otel/          tracing setup shared by all apps
  evals/
    golden/        JSONL labels + frame refs (frames in git-lfs or local)
    promptfoo/     VLM prompt regression
    detector/      precision/recall scripts
  infra/
    MANUAL.md      Setup Assistant checklist with screenshots
    bootstrap.sh   Xcode CLT + Homebrew, run once over SSH
    Brewfile
    ansible/
      inventory.yml
      site.yml
      group_vars/ranch.yml     agent list, pmset values, autologin flag
      roles/{base,access,quiet,packages,tailscale,services}/
    launchd/       *.plist.j2 templates
    snapshot.sh
    snapshots/     dated state dumps, committed
  posts/           drafts, diagrams, benchmark tables
```

Create the `ranch` git repo now at `~/job_hunt_2026/projects/ranch` with `infra/` as its first content. This plan moves to `ranch/docs/PLAN.md` when the repo goes public.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Camera models unsupported by the bridge | No streams | Inventory first; worst case one used Wyze V3 (~$20) which is well supported |
| Night IR frames too poor for the VLM | Misses at the time it matters | Measure night separately in Phase 3; escalate night events to Claude more aggressively; consider an IR floodlight |
| 8 GB thrash when VLM + detector + Docker coexist | Latency spikes, swap | Pin memory with `MLX_MEMORY_LIMIT`-style settings, run VLM 3-bit, OrbStack instead of Docker Desktop, measure in Post 2 |
| Alert fatigue | You turn it off | Two paging classes only, confirm window, `verdict` feedback loop |
| Starlink/Spectrum outage | Escalation stalls | Phase 5 degraded mode; local tiers keep recording |
| Content drift into gadget blog | Wrong audience | Every post leads with a number or an architecture decision, not a feature |
| Time | Job hunt comes first | Phases are weekend-sized; Phase 0–1 alone already yields two posts |
| `launchctl disable` is ignored for Apple GUI agents inside a logged-in session (observed 14 Oct) | Churn returns whenever someone logs in on the console | Auto-login off so there is no session; `make verify` asserts no console user; log out after any Screen Sharing visit |
| Apple Intelligence toggle is manual | One step that can be forgotten on re-provision | Checklist item with screenshot; follow-up to find a defaults key or configuration profile |

## 9. Content calendar (first six posts)

| # | Title (working) | Primary | Secondary | Hook |
|---|---|---|---|---|
| 0 | The $600 AI edge box | Substack | LinkedIn, X playbook thread | Erase-to-working in 45 min on video; load 11 → <2 |
| 1 | Wyze liberation + ANE detector | Substack | X benchmark table | fps/memory table |
| 2 | Four VLMs on 8 GB, judged on my horses | Substack | LinkedIn | Agreement-with-Claude chart |
| 3 | I run evals on my barn | LinkedIn | Substack, HN | Precision/recall by class, day vs night |
| 4 | MCP for the physical world | Substack | X thread on tool design | One tool surface diagram |
| 5 | When the cloud goes away | Substack | LinkedIn | Cable-pull demo, cost per night |

Each post ships with: one architecture diagram, one table of measured numbers, one thing that went wrong, and the repo link.

## 10. Next actions

1. Reboot the mini and verify the 13 Oct agent disables took effect (`ps` shows none of the 21; load under 2 after ten minutes).
2. `uv tool install ansible-core` on the laptop; create the `ranch` repo with `infra/`.
3. Write `bootstrap.sh` and the six roles by transcribing the 13 Oct commands; run against the current mini until `changed=0`.
4. Take the first snapshot.
5. Do the timed erase-and-reprovision while the disk is still empty.
6. Then the Phase 1 prerequisites: Wyze camera models and firmware, Wyze Developer API key, Tailscale account, SSD if the mini is 256 GB.

## Sources checked (13 Oct 2026)

- docker-wyze-bridge: https://github.com/mrlt8/docker-wyze-bridge and the go2rtc fork https://github.com/IDisposable/docker-wyze-bridge
- Headless without a dummy plug: https://astropad.com/blog/dummy-plug-headless-mac-mini/ , https://discussions.apple.com/thread/252079747 , BetterDummy https://github.com/Brezel31/BetterDummy
- Headless Mac on Tahoe: https://hometechops.com/mac/mac-mini-home-server-setup , https://www.jtbullitt.com/tech/mac/mac-standalone.html , Tailscale reboot thread https://forum.tailscale.com/t/mac-mini-server/391
- mlx-vlm and vllm-mlx: https://vllm-mlx.is-a.dev/reference/models/ , https://arxiv.org/html/2601.19139
- Qwen3-VL MLX builds: https://huggingface.co/collections/mlx-community/qwen3-vl , https://huggingface.co/mlx-community/Qwen3-VL-4B-Instruct-4bit
- Gemma 4: https://simonwillison.net/2026/Apr/2/gemma-4/ , https://www.jetson-ai-lab.com/models/gemma4-e4b
- Frigate 0.17/0.18 GenAI and chat: https://newreleases.io/project/github/blakeblackshear/frigate/release/v0.18.0-rc2 , https://docs-dev.frigate.video/configuration/semantic_search , Fregata native port https://community.home-assistant.io/t/fregata-app-native-macos-port-of-frigate-nvr-accelerated-by-apple-silicon/1012474
- RF-DETR and YOLO-World: https://playground.roboflow.com/models/compare/rf-detr-vs-yolo-world , https://blog.roboflow.com/best-ios-object-detection-models/
- Eval tooling: https://dev.to/lamingsrb/llm-evals-in-2026-a-practitioners-field-guide-26if
- OTel GenAI semconv status: https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke , https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions.md
- Apple Foundation Models image input (WWDC26): https://developer.apple.com/videos/play/wwdc2026/237
- Claude Agent SDK custom tools: https://platform.claude.com/docs/en/agent-sdk/custom-tools
