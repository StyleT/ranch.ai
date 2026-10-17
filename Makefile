ANSIBLE_PLAYBOOK ?= $(HOME)/.local/bin/ansible-playbook
HOST ?= ranch@ranch-ai.tail6d04cd.ts.net

.PHONY: bootstrap provision check verify snapshot logs logs-last

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
