---
name: writing-docs
description: How to write and edit this repository's documentation (anything under docs/, a README, a handoff, an architecture or design note, a plan kept as a doc, "write it up", "explain this in the docs", "document the change"). A doc states the system as it is, with its reasons and evidence; it never reads as a dated log and never names a person. Use it whenever you create, change, summarise into or review a Markdown doc, even when the user does not say "doc"; it carries the checker the pre-commit hook runs on staged docs/*.md, so a doc written without it is refused at commit time.
---

# Writing docs: the present, the reasons, no diary, no names

**The rule:** a doc describes the system as it stands, for a reader who joined today and has no memory of how it
got there. History lives in git. The story lives in the posts. The doc holds the present and why it is that way.

## Who reads these

The repo is public and written for Staff/Principal AI-platform readers. They open a doc to learn what a component
does, what rule it enforces, what evidence backs the rule, and how to operate it. They do not want to replay the
project to work out which paragraph is still true, and they cannot ask anyone.

## Rule 1: a doc is not a ledger

Why: each dated entry ("23 Oct, night: the long outages are hung dials") describes a state that was true once.
Append three of them and the reader has to diff the entries to reconstruct the present. The author stops being
able to delete anything, because every entry looks like evidence. The doc grows, the signal falls, and on the day
it matters nobody can tell what holds.

What this means:

- Headings name topics, not days. "## 23 Oct, late: the live view froze; root cause and the on-demand rewrite"
  becomes "## Why the live view is on demand".
- Facts carry no timestamps. "(16 Oct)", "since 23 Oct", "Decided 1 Nov", "As built, 22 Oct" all go. State the fact.
- No "now", "today", "currently", "no longer", "used to". They are dates in disguise and rot the same way. "The
  detector is yolo26s" ages better than "yolo26s is now the production detector".
- Superseded text is deleted, never struck through or kept "for context". The context is `git log -- docs/<file>`.
- A date is allowed as data when it identifies evidence: a dataset id (`frames-ranch-v1`), a date-named results
  directory (`evals/baseline/2026-10-20`), a run id in a table. It identifies; it does not narrate. Write it in a
  code span, which is also how the checker tells the two apart.
- A lesson worth keeping is a standing reason with its evidence, not an event. "A 24/7 HD pull knocks the weaker
  cameras off Wi-Fi: with the keep-alive on, mops_cam answered 5% of pings; without it, 98%." Not "on 19 Oct we
  found that".

## Rule 2: no people

Why: a name is attribution, not information. The reader cannot act on it, and in a public repo it is a liability.
"Vlad decided X" says nothing about why X; "ask Vlad" rots the moment that person is unavailable. A model is not
a character either: "Claude's boxes" lends intent to a tool.

What this means:

- The decision and its reason replace the decider. "Chosen by Vlad on 13 Oct" becomes the reason the option won.
- A role replaces a person who is part of the process: the human reviewer, the labeler, the operator. "Vlad labels
  the same 100 frames blind" becomes "a human labels the same 100 frames without seeing the model's boxes".
- A requirement replaces a blocker on a person. "Blocked on Vlad: relocate mops_cam" becomes "Needs physical
  access: mops_cam or its access point has to move."
- The component replaces "I", "we", "our". "We keep a frame every 10 s" becomes "the sampler keeps a frame every 10 s".
- Tools and models appear as technology. "claude-opus-5-5 labels each burst in one request" is fine. "Claude's five
  cat boxes" becomes "the model's five cat boxes".
- Identifiers stay as they are even when they contain a name: `labels-ranch-claude-revised-vlad-v1`,
  `vladlenfedosov/ranch-frames`, the `ranch` user. They are addresses, and they live in code spans.

## Shape of a doc

1. **Title**: what the thing is. "Camera architecture: one producer, consumers read disk".
2. **First paragraph**: the thing and its rule, two or three sentences, no preamble.
3. **How it works**: components, data flow, the invariants that must hold.
4. **Why**: the evidence. A measurement with its method and units: "go2rtc dialled mops_cam 2,912 times in a day
   without the keep-alive and about 10 with it". A number appears when it changes what the reader does, not to
   show that work happened.
5. **Operating it**: commands, ports, what to look at when it misbehaves.
6. **Limits and open questions**.

One topic per doc. Link to the other doc instead of restating it; two copies of a fact disagree within a week.

## When something changes

Edit the doc so it describes the new state and delete what stopped being true. The commit message carries the
when and the before/after; that is what `git log` is for. If the old design is instructive, it earns one sentence
under Why as a rejected alternative with its reason, undated.

## Before you finish

1. Run the checker on the file. It is the same one the pre-commit hook runs on staged `docs/*.md`, and a hit
   refuses the commit:
   ```
   node .claude/skills/writing-docs/scripts/check-doc.mjs docs/<file>.md
   ```
   It flags day-month and ISO dates in prose, the ledger words (As built, later:, Decided, no longer, used to,
   currently), strikethrough, the names, first person, and "Blocked on". Dates and names inside code spans pass.
2. Read the doc once as someone who joined today. Can they tell what is true without knowing what happened?

## Examples, taken from the docs as they were

Before: `## 23 Oct, night: availability is measured, the bridge's blind fallback is off, go2rtc preload on trial`
After: `## Availability is measured, not assumed`, with the body stating the measurement and the setting.

Before: "Reference labels: `labels-ranch-claude-revised-vlad-v1` (Vlad removed Claude's five cat boxes, rest accepted)."
After: "Reference labels: `labels-ranch-claude-revised-vlad-v1`, the model's labels after human review, which
dropped five cat boxes placed on reflections and accepted the rest."

Before: "**1 Nov, camera outage and the fix:** a DHCP re-lease at 21:34 UTC moved four cameras to new addresses; the
Wyze cloud kept reporting the boot-time addresses, the bridge and go2rtc dialed them for 3.5 h..."
After: "## Cameras move; the cloud does not notice. A DHCP re-lease gives a camera a new address while the Wyze cloud
keeps reporting the one from boot, so the bridge dials a dead address until the camera reboots. netprobe reports
where each camera's MAC really is, and the ladder reboots a moved camera through the cloud."
