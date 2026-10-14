ANSIBLE_PLAYBOOK ?= $(HOME)/.local/bin/ansible-playbook
HOST ?= ranch@ranch-ai.tail6d04cd.ts.net

.PHONY: bootstrap provision check verify snapshot

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
