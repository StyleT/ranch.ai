ANSIBLE_PLAYBOOK ?= $(HOME)/.local/bin/ansible-playbook
HOST ?= ranch@ranch-ai.tail6d04cd.ts.net

.PHONY: bootstrap provision check verify snapshot logs logs-last dataset-push taxonomy-pull web-dev web-build web-health fixtures-record contract-test e2e e2e-ai

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

logs:             ## Live tail of every ranch daemon (unified log; Ctrl-C to stop)
	ssh $(HOST) 'log stream --predicate '"'"'process == "logger"'"'"' --style compact'

logs-last:        ## Last H hours (default 1) of daemon output, e.g. make logs-last H=3
	ssh $(HOST) 'log show --last $(or $(H),1)h --predicate '"'"'process == "logger"'"'"' --style compact'

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
