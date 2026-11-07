---
name: plan-maintenance
description: How to write and keep a plan at either level: the master project plan (`docs/PLAN.md`) and the piece-level implementation plans Claude Code keeps while building one piece of it (the plan file plan mode writes to `~/.claude/plans/<slug>.md`, or any plan kept in a scratch file). A plan is the current state of the work: what is known, what is decided, what remains and in which order; it is never a ledger of what happened, and history goes only to its appendix. Mandatory whenever a plan is created or edited: entering or leaving plan mode, after a step lands, after a decision changes, after context compaction, when the user says "update the plan", "clean up the plan", "plan this", "what's left", or redirects the work, when a piece lands and the master plan has to move, and at the end of a session. Carries the checker that runs on every write to a plan file and on `docs/PLAN.md` at commit time.
---

# Plan maintenance: the plan is the present, not the diary

**The rule:** a plan is always the current representation of the work: the knowledge gathered so far, the decisions
in force, and the remaining work in order. It never records what was done. When something changes, the plan is
rewritten so that it is true again; history, if it is worth keeping at all, goes to one appendix at the end and
nowhere else.

## Two levels, one rule

- **The master plan, `docs/PLAN.md`**: the whole project, its phases, the architecture decisions and the posts each
  phase ends in. It is a doc under `docs/`, so the writing-docs skill and its checker also apply (no dates in prose,
  no names, no first person). Its appendix, if any, holds pointers (sources, result directories as code spans), not a
  dated story; the project's history is git and the posts.
- **A piece plan**: the implementation plan for one piece of the master plan, kept by Claude Code in
  `~/.claude/plans/<slug>.md` (plan mode writes it there) or in a scratch file. It is private and never committed, so
  dates and names are allowed in it; the ledger rule is the same.

A piece plan names the master-plan item it implements in its first lines ("Implements `docs/PLAN.md` §6, Phase 3:
the golden set and the eval harness"), so that a reader can place it, and so that the right master-plan lines are
known when the piece lands. When a piece lands, the master plan moves in the same session: its Remaining work loses
the item, Where things stand (or the phase's text) gains the result as a fact, and a decision the piece settled is
written into the master plan's decisions. A master plan that still lists a finished piece is the same ledger failure
as a piece plan that still lists a finished step, one level up.

## In plan mode, only the plan file changes

Plan mode forbids changes to the codebase: the one file it writes is the piece plan in `~/.claude/plans/`. This skill
never overrides that. While planning, the master plan is read, not edited; the piece plan's last step says what the
master plan will gain when the piece lands ("`docs/PLAN.md` §6 Phase 3: the golden-set item leaves Remaining work,
the label counts become facts"), and that edit happens during implementation, after plan mode has been exited, as
part of landing the piece. Nothing in this skill is a reason to edit, commit or run anything against the repository
from plan mode; running the checker on the plan file is read-only and allowed.

## Who reads a plan, and why a ledger fails them

The plan is read by a context window that was not there when it was written: the same session after compaction, a
subagent, the next session, and the user skimming to see what is left. Each of them needs to answer three questions
without reconstruction: what is true, what is decided, what is next. A ledger answers none of them directly. Every
"done 24 Oct", "revised", "Update:", "no longer" is a diff against a state the reader never saw; three of them in a
row and the reader has to replay the project to find the present. Plans in this repository that were maintained by
appending reached 35 to 45 KB, held a full previous plan under "Appendix", a "Steps, revised" beside "Steps", and a
section titled "what's still relevant", which is the author admitting that the rest no longer was.

A plan that is rewritten stays short, because finished work leaves it and only its results stay. That is what makes it
safe to re-read after compaction and cheap to hand to a subagent.

## Shape of a plan

1. **Title**: what the work is, as a noun phrase.
2. **One sentence** saying that the file is the current state of the work and that history is in the appendix and in
   git. It tells a fresh reader how to read the file.
3. **Why**: the goal, who it is for, the rules in force that constrain it (the CLAUDE.md rules that bite here, the
   numbers that have to move). Two or three paragraphs.
4. **Where things stand**: what exists and is measured, grouped by component, in the present tense. Results of
   finished steps live here as facts, not as "step 3 done". A date or a commit hash appears when it identifies
   evidence (`evals/baseline/2026-11-06/`, the mini on HEAD `fc101ae`, "rates since the fix, 23 h"), never to narrate.
5. **Decisions in force**: each standing decision with its reason. A superseded decision is deleted; if the rejected
   alternative is instructive it earns one sentence with the reason it lost, undated.
6. **Remaining work, in order**: the steps still to do, each with what it changes and how it is verified, with the
   dependencies between them. A finished step is deleted from here (see below). A step that was dropped is deleted,
   with its reason moved to Decisions if the reason matters.
7. **Verification** (end to end) and **Open questions**: what has to hold before the work is called done, and what is
   undecided, each question with what would decide it.
8. **Appendix: how it got here**: the only place for history. Dated one- or two-line bullets with commit hashes and
   doc pointers. No steps, no decisions, nothing the reader must act on; if an appendix item is still needed to act,
   it belongs above, rewritten as a fact or a step.

Sections 3 to 7 are the plan. The appendix is optional and last; nothing follows it.

## The maintenance loop

Each of these is a rewrite of the section concerned, never an append.

- **A step lands.** Delete it from Remaining work. Fold what it produced into Where things stand as a fact (the file,
  the number, the daemon). Add one line to the appendix with the commit. Re-check the dependency sentence and the
  numbering of the steps that remain.
- **A decision changes.** Rewrite the bullet in Decisions in force so that it states the new decision and its reason.
  Adjust every step that assumed the old one. The old decision does not stay as strikethrough, "previously", or
  "revised"; at most it is the one-sentence rejected alternative.
- **Something is learned** (a measurement, a constraint, a finding from reading code). Put it where it belongs: a
  fact into Where things stand, a constraint into Why or Decisions, a consequence into the steps. "Update:",
  "Correction:", "Note added:" are the appending reflex; resist it and edit the sentence that is now wrong.
- **The user redirects.** Rewrite the plan to the new direction. Do not add "Steps, revised" next to the old steps,
  and do not paste the previous plan under an appendix heading; if the previous direction is worth a trace, it is one
  appendix bullet saying what it was and why it changed.
- **A step is skipped or deferred.** Delete it, or move it to a "Deferred" step with the condition that would bring it
  back. "Skipped (14 Oct)" is a ledger entry.
- **Context was compacted, or a session starts on an existing plan.** Read the plan first and reconcile it with
  reality before doing anything else: `git log` and the working tree say which steps already landed. Fix the plan,
  then continue from it.
- **Session ends.** The plan has to read correctly to the next session: no step listed that is already done, no fact
  stated that the day's work changed. This is the last edit of the session, before the last commit.

## What never appears above the appendix

- Ticked items (`[x]`, "✅"), "done", "shipped", "completed", "skipped" as the status of a step, and a "Done",
  "Completed" or "History" section above the appendix. A finished step is deleted and its result becomes a fact; a
  Done section is the ledger with a heading.
- Strikethrough. Git keeps the old text.
- "Update", "Correction", "Addendum", "revised", "previously", "originally", "no longer", "used to", "as of", "Decided
  <date>". Each is a diff against an earlier version of the plan; state what is true instead.
- A second title. One plan, one current version. An embedded older plan is a ledger in disguise.
- Headings that diff against the past: "Steps, revised", "What's still relevant", "Previous plan", "Old approach".
- Findings sections that only exist because an investigation happened ("Findings, 3 Nov, read-only"). Findings are
  facts and live in Where things stand or in the step they changed.

Dates and names are allowed in a plan: it is a private working file, not a public doc. The test is whether the date
identifies evidence (a results directory, a measurement window) or narrates an event (when something was decided or
done). The first stays, the second goes to the appendix or goes away.

## Before you finish an edit

Run the checker. The PostToolUse hook in `.claude/settings.json` runs it on every `Write` or `Edit` to a file under
`~/.claude/plans/` or to `docs/PLAN.md` and refuses the edit with the hits when they exist; the pre-commit hook runs
it on a staged `docs/PLAN.md` (beside the writing-docs checker). Run it by hand on any other plan file:

```
node .claude/skills/plan-maintenance/scripts/check-plan.mjs ~/.claude/plans/<slug>.md
```

It checks the structure (one title, a Remaining work section, the appendix last and alone) and the ledger phrases
above the appendix. It cannot tell whether a finished step is still listed or a changed decision still reads the old
way, so after the checker read the plan once as the next session: can it start from Remaining work without asking
what happened? For a piece plan that just landed, ask the same of the master plan.

## Examples, from plans in this repository

Before: `## Steps, revised` under `## Steps — phase 1`, both kept.
After: one `## Remaining work, in order` holding the current steps; one appendix bullet: "the first version imported
through the JSONL exporter; replaced by the FiftyOne-native round trip because the exporter dropped the group field".

Before: `# Appendix — previous plan (Part A done 24 Oct; Part B, the article structure, is still the deliverable)`
followed by the whole earlier plan.
After: Part B's structure moved into Remaining work as the step it still is; Part A's results folded into Where things
stand ("four-frame bursts did not beat single frames: 21 of 25 boxes at IoU 0.5, median IoU 0.97"); one appendix
bullet for Part A with its commits.

Before: "4. ~~Full re-erase → manual checklist → bootstrap → playbook, timed.~~ Skipped (14 Oct). Revisit only if a
future macOS update breaks the box."
After: the step deleted; in Decisions: "The timed erase-and-reprovision is not run: three convergent provisions and a
green verify across reboots stand in for it; it comes back only if a macOS update breaks the box."

Before: "**Regroup, 19 Oct. Next, in order:** 1. Watch delivery for a day ... 2. ~~Phase 1 steps 6–7~~ done 20 Oct:
`labels-ranch-claude-v1` (100 frames, $1.44) ..."
After: step 1 stays as a step with its target; step 2's results become facts in Where things stand (the label set, its
size and cost, the recall numbers); the dates and the strikethrough go to the appendix as one line each.

## Relation to the other docs

`docs/HANDOFF.md` is the master plan's operating companion (the machine, the commands, where things stand); it is a
doc under writing-docs and is read with the same question as a plan: does it state the present? Posts are where the
story is told; a plan that wants to tell it is a draft post in the wrong file.
