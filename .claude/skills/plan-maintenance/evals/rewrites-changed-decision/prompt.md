---
tags: [plan-maintenance]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Change of direction: no Batch API at all, it stalled twice this week. Haiku 5.5 labels every frame synchronously, and Opus 5.5 only runs on frames where Haiku and the Moondream pre-labels disagree. And drop the fine-tune, it's not happening this quarter. Update the plan in plan.md.

Input files: plan.md
