---
name: version-management
description: How a change travels from an edit to the ranch mini without losing work or rolling the mini back. Covers worktrees vs the main checkout, commit/push/fast-forward, which checkout to provision from, proving what the mini runs, rollback, and safe worktree cleanup. Use before any commit, push, merge, `make provision` or `make check`, before leaving or deleting a worktree, at the end of every session, and whenever the repo, origin/main and the mini might disagree.
---

# Version management: from edit to the mini

**The model:** origin/main is the record. **The mini runs whatever checkout `make provision` was run from.** The app
role rsyncs that working tree over `/usr/local/ranch/app` with `--delete`, so choosing a checkout is a deploy
decision. A checkout that lacks published commits rolls the mini back, silently.

## Why these rules (incidents)

- **22 Oct:** a worktree branched before `apps/web` landed and provisioned the mini; the dashboard was nearly deleted.
  The same session warned that provisioning from main before merging would revert the cameras.
- **22 Oct:** a worktree had no `node_modules`, so tsc resolved `@ranch/config` from the main checkout's older copy.
  Green typecheck, wrong code.
- **22 Oct:** "verify if changes are on disk and committed" found the work only on a branch, not on main.
- **23 Oct:** pushes went `HEAD:main` from a worktree, but nobody fast-forwarded the main checkout, so it fell 4–7
  commits behind. `make provision` from it reverted the live view to the old player and undid the pf/go2rtc WebRTC
  config. Only a browser probe showed it (`data-mode=buffer-mjpeg`).
- **23 Oct:** provisioning from a fresh worktree synced its empty model directory with `--delete`. The model packages
  vanished from the mini; the detector survived only on its cached `.mlmodelc`.
- **23 Oct:** the main checkout contains `.claude/worktrees/*`, so a sync from it would have shipped a whole nested
  checkout. Timestamp-only differences between two checkouts of the same commit triggered `npm ci`, a detector
  rebuild and app-daemon restarts.
- **23 Oct:** WebRTC config was hand-applied on the mini "for testing" and left there. `make check` reported
  `changed=8`, which was read as noise.

The playbook now enforces the deploy side (commit `3c57f93`): a pre-task refuses any checkout where origin/main is not
an ancestor of HEAD and lists uncommitted files; the sync excludes `.claude`, compares by checksum and ignores
attribute-only changes; the model sync is skipped when the checkout has no exported models. The guard only exists in
checkouts at or after that commit.

## The flow for one change

1. **Isolate.** Background sessions must work in a worktree (EnterWorktree). Run `npm install` there first.
2. **Commit** each logical change on its own: code, infra role, doc, snapshot. The message says why and ends with the
   trailer lines the session specifies. Never leave finished work uncommitted.
3. **Test the tip you will push:** `npm run typecheck && npm test`, plus `make web-build && make e2e` when apps/web
   changed. Run the whole suite, not a subset.
4. **Publish, fast-forward only:** `git push origin HEAD:main`. If it's rejected because origin/main moved:
   `git fetch origin && git rebase origin/main` (your own unpushed commits only), re-test, push. Never force-push,
   never create merge commits on main.
5. **Bring the main checkout level.** From a worktree session the harness blocks git on the shared checkout (`cd`
   into it and `git -C` both refuse). So: `ExitWorktree` with `keep` →
   `git fetch origin && git merge --ff-only origin/main` in the main checkout → `EnterWorktree path=<worktree>` to
   continue.
6. **Deploy from the main checkout**, which holds the git-ignored models: `make provision`, then a second
   `make provision` must report `changed=0`, then `make check` must report `changed=0`. A `REFUSED:` line means the
   checkout is behind. Update it; don't override.
7. **Prove what runs.** Diff the served web build against HEAD (commands below), then follow the `verify-dashboard`
   skill for behaviour.
8. **End state, every session:** `git status -sb` clean and `main...origin/main` level in both checkouts; every
   worktree branch an ancestor of origin/main; the mini at `changed=0` from main.

## Rules

- Never provision from a checkout that is behind origin/main. `RANCH_ALLOW_ROLLBACK=1` is only for a deliberate
  rollback (below).
- Provisioning uncommitted work is fine while iterating, but it is drift until it's committed and pushed. Never end a
  session with the mini running something that isn't on origin/main.
- Never hand-edit the mini and leave it. A temporary experiment ends reverted, or made into Ansible and committed.
  `make check` must be `changed=0`; investigate every change it lists, don't explain it away.
- Models (`*.mlpackage`, `*.pt`, `*.labels.json` under `apps/detector/export`) are git-ignored and live only in the
  main checkout. Worktrees skip the model sync; update models only by provisioning from main.
- In a worktree session, git targets only that worktree. Keep commands simple (one git verb per call, no `cd` to the
  shared checkout, no heredoc chains), or the guard refuses them.
- The stash stack is shared with other sessions. Never use a bare `git stash`/`pop`; use a WIP commit.
- Merging means the branch is an ancestor of origin/main: `git merge-base --is-ancestor <branch> origin/main`.
  Equal commits count as merged.

## Rollback

- **Preferred:** `git revert <sha>` → push → the normal flow. History stays linear and the guard stays satisfied.
- **Emergency** (put an older commit on the mini now): create a detached worktree at that commit and run
  `RANCH_ALLOW_ROLLBACK=1 make provision` from it (it skips the models). Then fix forward on main straight away: the
  next normal provision re-applies main.

## Worktree cleanup (only when all are true)

1. The branch is merged: `git merge-base --is-ancestor <branch> main`.
2. `git -C <wt> status --short` is empty.
3. `git -C <wt> status --ignored --short` shows only build output (node_modules, .next, test-results, tsbuildinfo).
4. The lock owner is gone: `cat .git/worktrees/<name>/locked` → `ps -p <pid>` → not running.

Then: `git worktree unlock <wt>` (if locked) → `git worktree remove <wt>` → `git branch -d <branch>`. If `-d` refuses
only because the *remote* tracking branch is behind, and step 1 holds, `-D` loses nothing. Leave remote branches
alone unless the user asks. Never remove the worktree the session is in, or one another live session holds.

## State check (copy-paste)

```
git fetch -q origin && git status -sb                   # want: ## main...origin/main, nothing listed
git worktree list && git branch -vv
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do git merge-base --is-ancestor $b origin/main && echo "merged   $b" || echo "UNMERGED $b"; done
served=$(curl -s http://ranch-ai.tail6d04cd.ts.net:5090/api/ui/system | python3 -c 'import json,sys;print(json.load(sys.stdin)["web"]["build"]["commit"])')
git diff --stat $served HEAD -- apps/web packages package-lock.json ':!apps/web/test' ':!apps/web/e2e'   # empty = web build current
make check                                              # changed=0
```
The web build stamps its commit only when `apps/web`/`packages` change. So compare *sources* between the stamped
commit and HEAD; don't expect the commit to equal HEAD.
