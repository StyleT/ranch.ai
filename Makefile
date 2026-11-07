ANSIBLE_PLAYBOOK ?= $(HOME)/.local/bin/ansible-playbook
HOST ?= ranch@ranch-ai.tail6d04cd.ts.net

.PHONY: camera-dials bootstrap provision check verify snapshot logs logs-last dataset-push taxonomy-pull web-dev web-build web-health fixtures-record contract-test e2e e2e-ai

bootstrap:        ## One-time: Xcode CLT + Homebrew on a freshly erased mini
	ssh $(HOST) 'bash -s' < infra/bootstrap.sh

provision:        ## Apply the playbook
	cd infra/ansible && $(ANSIBLE_PLAYBOOK) site.yml

check:            ## Drift report, changes nothing
	cd infra/ansible && $(ANSIBLE_PLAYBOOK) site.yml --check --diff

verify:           ## After a reboot: apply + assert the quiet role took effect
	cd infra/ansible && $(ANSIBLE_PLAYBOOK) site.yml -e strict_quiet=true

snapshot:         ## Dump live state into infra/snapshots/<date>/
	infra/snapshot.sh $(HOST)

# /usr/bin/log, not log: the mini's login shell is zsh, where `log` is a builtin ("zsh:log:1: too many arguments").
logs:             ## Live tail of every ranch daemon (unified log; Ctrl-C to stop)
	ssh $(HOST) '/usr/bin/log stream --predicate '"'"'process == "logger"'"'"' --style compact'

logs-last:        ## Last H hours (default 1) of daemon output, e.g. make logs-last H=3
	ssh $(HOST) '/usr/bin/log show --last $(or $(H),1)h --predicate '"'"'process == "logger"'"'"' --style compact'

# The unified log does not keep logger's -t tag; each daemon's output comes from its own logger process, so the
# logger's pid selects one daemon (its current run only: the pid changes when the daemon restarts).
logs-of:          ## Last H hours (default 1) of ONE daemon's current run, e.g. make logs-of D=camsup H=3
	@ssh $(HOST) 'p=$$(pgrep -f "^/usr/bin/logger -t ranch\.$(D) " | head -1); [ -n "$$p" ] || { echo "no logger for ranch.$(D)"; exit 1; }; /usr/bin/log show --last $(or $(H),1)h --predicate "processID == $$p" --style compact'

HF_REPO ?= vladlenfedosov/ranch-frames

# Runs on the mini: the images and the token (~/.config/ranch/hf.env) live there; the JSONL dir is the deployed copy.
dataset-push:     ## Upload a dataset to the Hub and tag it: make dataset-push ID=frames-ranch-v1 DIR=evals/baseline/2026-10-20 [IMAGES=/usr/local/ranch/media/baseline/2026-10-20]
	@test -n "$(ID)" -a -n "$(DIR)" || (echo "usage: make dataset-push ID=<dataset id> DIR=<repo-relative dir> [IMAGES=<dir on the mini>]"; exit 2)
	ssh $(HOST) 'set -e; set -a; . ~/.config/ranch/hf.env; set +a; export PATH=$$HOME/.local/bin:$$PATH; \
	  hf repo create $(HF_REPO) --repo-type dataset --private 2>/dev/null || true; \
	  hf upload $(HF_REPO) /usr/local/ranch/app/$(DIR) $(ID) --repo-type dataset --commit-message "$(ID): data" --exclude "*.DS_Store" --exclude "frames/*"; \
	  if [ -n "$(IMAGES)" ]; then hf upload $(HF_REPO) $(IMAGES) $(ID)/images --repo-type dataset --commit-message "$(ID): images" --exclude "*.DS_Store"; fi; \
	  hf repo tag create $(HF_REPO) $(ID) --repo-type dataset -m "$(ID)" 2>/dev/null || echo "tag $(ID) exists"'
	@echo "https://huggingface.co/datasets/$(HF_REPO)/tree/$(ID)"

# ---- FiftyOne: review, sharing (Hub) and scoring surface for the eval datasets; laptop only (evals/fiftyone/README.md) ----
FO_DIR = $(CURDIR)/evals/fiftyone
FO_RUN = uv run --directory $(FO_DIR) python
PL_DIR = $(CURDIR)/evals/prelabel
PL_RUN = uv run --directory $(PL_DIR) python
prelabel-install: ## Create evals/prelabel/.venv (Florence-2 through transformers, the OpenAI client for Qwen3-VL via mlx_vlm.server) with uv
	uv sync --directory $(PL_DIR)

prelabel-bench:   ## Pre-label a frames set's labeled frames with a local model, for bench.ts: make prelabel-bench MODEL=florence|qwen3vl SET=evals/baseline/2026-10-20 LABELS=evals/golden/<labels>.jsonl [SERVER_MODEL=<hf id served by make vlm-serve>]
	@test -n "$(MODEL)" -a -n "$(SET)" || (echo "usage: make prelabel-bench MODEL=florence|qwen3vl SET=evals/baseline/<date> [LABELS=<jsonl>] [SERVER_MODEL=<hf id>] [THRESHOLD=t]"; exit 2)
	$(PL_RUN) bench.py --model $(MODEL) --set $(CURDIR)/$(SET) $(if $(LABELS),--only-labeled $(CURDIR)/$(LABELS),) $(if $(SERVER_MODEL),--server-model $(SERVER_MODEL),) $(if $(THRESHOLD),--threshold $(THRESHOLD),)

prelabel-run:     ## Stage 1: pre-label every frame of a clip frames set (resumable): make prelabel-run MODEL=qwen3vl SET=evals/baseline/2026-11-06-1fps [LIMIT_CLIPS=5] [SERVER_MODEL=<hf id>]
	@test -n "$(MODEL)" -a -n "$(SET)" || (echo "usage: make prelabel-run MODEL=florence|qwen3vl SET=evals/baseline/<date>-1fps [LIMIT_CLIPS=n] [SERVER_MODEL=<hf id>]"; exit 2)
	$(PL_RUN) prelabel.py --model $(MODEL) --set $(CURDIR)/$(SET) $(if $(LIMIT_CLIPS),--limit-clips $(LIMIT_CLIPS),) $(if $(SERVER_MODEL),--server-model $(SERVER_MODEL),) $(if $(THRESHOLD),--threshold $(THRESHOLD),)

prelabel-sample:  ## The stratified review sample (7 cameras x day/night x 10 frames) of a clip frames set: make prelabel-sample SET=evals/baseline/2026-11-06-1fps
	$(PL_RUN) prelabel.py --review-sample --set $(CURDIR)/$(SET)

VLM_DIR = $(CURDIR)/evals/vlm
VLM_RUN = uv run --directory $(VLM_DIR) python
vlm-install:      ## Create evals/vlm/.venv (mlx-vlm server + OpenAI client) with uv
	uv sync --directory $(VLM_DIR)

vlm-serve:        ## Serve a tier-2 candidate with mlx-vlm on :8080 (foreground): make vlm-serve MODEL=mlx-community/Qwen3-VL-4B-Instruct-3bit
	@test -n "$(MODEL)" || (echo "usage: make vlm-serve MODEL=<hf id>"; exit 2)
	$(VLM_RUN) -m mlx_vlm.server --model $(MODEL) --port 8080

vlm-run:          ## Send an escalation set through the served model: make vlm-run MODEL=<hf id> ESC=evals/baseline/<set>/escalations-<m>/escalations.jsonl [PROMPT=v1] [LIMIT=n]
	@test -n "$(MODEL)" -a -n "$(ESC)" || (echo "usage: make vlm-run MODEL=<hf id> ESC=<escalations.jsonl> [PROMPT=v1] [LIMIT=n]"; exit 2)
	$(VLM_RUN) run.py --model $(MODEL) --escalations $(CURDIR)/$(ESC) --prompt $(or $(PROMPT),v1) $(if $(LIMIT),--limit $(LIMIT),)

vlm-bench:        ## Tier-2 latency and memory on the mini: serve MODEL there, run the escalation set, pull the answers back: make vlm-bench MODEL=<hf id> ESC=evals/baseline/<set>/escalations-<m> [PROMPT=v1]
	@test -n "$(MODEL)" -a -n "$(ESC)" || (echo "usage: make vlm-bench MODEL=<hf id> ESC=<escalations dir> [PROMPT=v1]"; exit 2)
	rsync -a --delete $(ESC)/ ranch:/usr/local/ranch/var/escalations/$(notdir $(ESC))/
	ssh ranch '/usr/local/ranch/app/infra/bin/vlm-bench.sh $(MODEL) /usr/local/ranch/var/escalations/$(notdir $(ESC))/escalations.jsonl $(or $(PROMPT),v1)'
	rsync -a ranch:/usr/local/ranch/var/escalations/$(notdir $(ESC))/predictions.vlm.*.jsonl $(ESC)/

fiftyone-install: ## Create evals/fiftyone/.venv (FiftyOne, open source) with uv
	uv sync --directory $(FO_DIR)

frames-pull:      ## Copy a baseline set's images from the mini into the git-ignored laptop copy: make frames-pull DATE=2026-10-24
	@test -n "$(DATE)" || (echo "usage: make frames-pull DATE=<evals/baseline date>"; exit 2)
	rsync -a --delete $(HOST):/usr/local/ranch/media/baseline/$(DATE)/ evals/baseline/$(DATE)/frames/

clips-frames:     ## Decode a frozen clip set to a frames set at a fixed rate (laptop; ffmpeg): make clips-frames SET=evals/baseline/2026-11-06 ID=frames-ranch-clips-v1 [FPS=1]
	@test -n "$(SET)" -a -n "$(ID)" || (echo "usage: make clips-frames SET=evals/baseline/<date> ID=frames-<name>-vN [FPS=1]"; exit 2)
	node --experimental-strip-types evals/clips/frames.ts --set $(SET) --id $(ID) --fps $(or $(FPS),1)

clips-predict:    ## Tier-1 predictions on the clip videos, on the mini: make clips-predict MODELS=yolo26s,yolo26s-e2e-384x640 [STRIDE=1,2,4,8] [SET=evals/baseline/2026-11-06] [OUT=evals/baseline/2026-11-06-1fps]
	@test -n "$(MODELS)" || (echo "usage: make clips-predict MODELS=a,b [STRIDE=1,2,4,8] [SET=...] [OUT=...]"; exit 2)
	ssh ranch 'cd /usr/local/ranch/app && /usr/local/ranch/bin/node --experimental-strip-types evals/clips/predict.ts --set $(or $(SET),evals/baseline/2026-11-06) --out /usr/local/ranch/var/predict/$(notdir $(or $(OUT),evals/baseline/2026-11-06-1fps)) --models $(MODELS) --stride $(or $(STRIDE),1) --bin /usr/local/ranch/var/build/detector'
	rsync -a ranch:/usr/local/ranch/var/predict/$(notdir $(or $(OUT),evals/baseline/2026-11-06-1fps))/ $(or $(OUT),evals/baseline/2026-11-06-1fps)/

fiftyone-import:  ## Import a set (+labels, +predictions) into FiftyOne: make fiftyone-import SET=evals/baseline/2026-10-24 LABELS=evals/golden/x.jsonl:gt_claude MODELS=yolo26s,yolo11n
	@test -n "$(SET)" || (echo "usage: make fiftyone-import SET=evals/baseline/<date> [LABELS=<jsonl>:<field>] [MODELS=a,b]"; exit 2)
	$(FO_RUN) import_jsonl.py --set $(CURDIR)/$(SET) $(if $(LABELS),--labels $(CURDIR)/$(LABELS),) $(if $(MODELS),--predictions $(MODELS),) --overwrite

fiftyone-import-clips: ## Import a clip set into a FiftyOne video dataset for review: make fiftyone-import-clips SET=evals/baseline/2026-11-06
	@test -n "$(SET)" || (echo "usage: make fiftyone-import-clips SET=evals/baseline/<date>"; exit 2)
	$(FO_RUN) import_clips.py --set $(CURDIR)/$(SET) --overwrite

fiftyone-review:  ## Write the review tags of a clip dataset back into its set directory: make fiftyone-review NAME=clips-ranch-pool-v1 SET=evals/baseline/2026-11-06
	@test -n "$(NAME)" -a -n "$(SET)" || (echo "usage: make fiftyone-review NAME=<dataset> SET=evals/baseline/<date>"; exit 2)
	$(FO_RUN) review_tags.py --name $(NAME) --set $(CURDIR)/$(SET)

fiftyone-push:    ## Push a FiftyOne dataset to the Hub (private, native format) and tag the revision: make fiftyone-push NAME=frames-ranch-bursts-v1 REPO=ranch-frames-bursts-v1 TAG=claude-v1
	$(FO_RUN) hub.py push --name $(NAME) --repo $(REPO) $(if $(TAG),--tag $(TAG),)

fiftyone-load:    ## Load a revision from the Hub into a local dataset: make fiftyone-load REPO=ranch-frames-bursts-v1 [REV=claude-v1] [NAME=<local name>]
	$(FO_RUN) hub.py load --repo $(REPO) $(if $(REV),--revision $(REV),) $(if $(NAME),--name $(NAME),) --overwrite

fiftyone:         ## Open the FiftyOne App: make fiftyone NAME=frames-ranch-bursts-v1 [MODE=browse|annotate|flat] | make fiftyone REPO=ranch-frames-bursts-v1 [REV=claude-v1]
	$(FO_RUN) app.py $(if $(NAME),--name $(NAME),) $(if $(REPO),--repo $(REPO),) $(if $(REV),--revision $(REV),) --mode $(or $(MODE),browse)

taxonomy-pull:    ## Bring the mini's active taxonomy version into the repo (packages/taxonomy/taxonomy.json + its score) for commit
	@ssh $(HOST) 'cd /usr/local/ranch/app && /usr/local/ranch/bin/node --no-warnings=ExperimentalWarning packages/taxonomy/src/cli.ts export' > .scratch/taxonomy-export.json
	@node -e 'const fs=require("fs");const e=JSON.parse(fs.readFileSync(".scratch/taxonomy-export.json","utf8"));fs.writeFileSync("packages/taxonomy/taxonomy.json",JSON.stringify(e.taxonomy,null,2)+"\n");if(e.version.score){const f="evals/results/taxonomy-v"+e.version.id+".json";fs.writeFileSync(f,JSON.stringify({version:e.version,taxonomy:e.taxonomy},null,2)+"\n");console.log("wrote",f)}console.log("packages/taxonomy/taxonomy.json <- v"+e.version.id+" ("+e.version.author+(e.version.note?": "+e.version.note:"")+")")'
	@git status --short packages/taxonomy/taxonomy.json evals/results/

# ---- web app (apps/web, docs/WEB-DASHBOARD.md) ---------------------------------------------------------------------
STATUS_PORT ?= 5091
BRIDGE_PORT ?= 5080
tunnel:           ## ssh -L to the mini's loopback-only ports: status API 5091, Wyze bridge UI 5080 (the UI starts camera consumers, so it is never on the LAN)
	@ssh -f -N -o ExitOnForwardFailure=yes -L $(STATUS_PORT):127.0.0.1:$(STATUS_PORT) -L $(BRIDGE_PORT):127.0.0.1:$(BRIDGE_PORT) $(HOST) 2>/dev/null || true

camera-owners:    ## Who consumes camera streams right now (go2rtc consumers, :8554 sockets, buffer writers); the single-consumer rule, measured
	@ssh $(HOST) /usr/local/ranch/bin/camera-owners.sh

camera-dials:     ## Who dialled the cameras and how often, per 10 min (H hours, CAM one camera); ASSERT=1 fails on any dial not caused by the recorder's jpeg role
	@ssh $(HOST) /usr/local/ranch/bin/camera-dials.sh --hours $(or $(H),1) $(if $(CAM),--cam $(CAM)) $(if $(ASSERT),--assert)

verify-live:      ## Live-view soak on the mini: every connected camera's ring (packets) stays fresh for MINUTES (default 30); crash reports, web errors, CPU, owners asserted at the end
	@ssh $(HOST) /usr/local/ranch/bin/verify-live.sh $(or $(MINUTES),30)

live-probe:       ## The real dashboard over the tailnet in Chrome, per camera: player state, picture advancing, PNG for OSD glass-to-glass. make live-probe [CAMS=a,b]
	node apps/web/e2e/live/probe.mjs $(CAMS)

e2e-chaos:        ## Fault injection on the mini (software only): stop one camera's feed, assert detection, watchdog re-attach, supervisor row, recovery. make e2e-chaos [CAM=back_yard_cam] [DURATION=90] [MODE=stop|udp]
	@ssh $(HOST) /usr/local/ranch/bin/e2e-chaos.sh $(or $(CAM),back_yard_cam) $(or $(DURATION),90) $(or $(MODE),stop)

web-dev: tunnel        ## Next dev on the laptop against the mini's status daemon over an ssh tunnel
	RANCH_DAEMON_URL=http://127.0.0.1:$(STATUS_PORT) RANCH_APP_DIR=$(CURDIR) npm -w apps/web run dev

web-build:        ## Build apps/web locally (the same command Ansible runs on the mini)
	npm -w apps/web run build

web-health:       ## RSS and daemon reachability of com.ranch.web on the mini
	ssh $(HOST) 'curl -s 127.0.0.1:5090/api/ui/health' | python3 -m json.tool

fixtures-record: tunnel  ## Re-record daemon fixtures into apps/web/test/fixtures (review the diff, commit)
	node --experimental-strip-types --no-warnings apps/web/scripts/record-fixtures.ts --daemon http://127.0.0.1:$(STATUS_PORT)

contract-test: tunnel    ## Validate the live daemon against packages/contracts
	RANCH_DAEMON_URL=http://127.0.0.1:$(STATUS_PORT) node --experimental-strip-types --no-warnings apps/web/test/contract/daemon.contract.ts

e2e:              ## Deterministic Playwright against a local build + the fixture daemon
	npm -w apps/web run e2e

e2e-ai:           ## Agentic e2e: Claude Code (your subscription) drives the browser. make e2e-ai [TARGET=tunnel|live|fixtures] [MODEL=haiku|sonnet|opus] [TASK=name]
	@case "$(or $(TARGET),tunnel)" in tunnel) ssh -f -N -o ExitOnForwardFailure=yes -L 5097:127.0.0.1:5090 -L 5091:127.0.0.1:5091 $(HOST) 2>/dev/null || true;; live) ssh -f -N -o ExitOnForwardFailure=yes -L 5091:127.0.0.1:5091 $(HOST) 2>/dev/null || true;; esac
	RANCH_E2E_TARGET=$(or $(TARGET),tunnel) $(if $(MODEL),RANCH_E2E_MODEL=$(MODEL),) RANCH_E2E_TASK=$(TASK) node --experimental-strip-types --no-warnings apps/web/e2e/ai/run.ts
