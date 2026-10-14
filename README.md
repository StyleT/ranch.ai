# ranch

Home AI for a horse ranch on an 8 GB Mac mini. Phase 0 (this directory's `infra/`) makes the mini reproducible:
manual checklist in `infra/MANUAL.md`, one-time `infra/bootstrap.sh`, then Ansible in `infra/ansible/`.
Plan: `docs/PLAN.md`.

```
make bootstrap | provision | check | verify | snapshot
```
