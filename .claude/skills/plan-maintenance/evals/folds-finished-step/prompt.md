---
tags: [plan-maintenance]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Step 2 of the plan landed in commit 9a1f3c2. Results: Moondream 3.1 passed the gate (horse recall 0.86 day / 0.71 night, person 0.91 / 0.68, precision 0.78, 3.1 s per frame, 6.2 GB RSS); Florence-2 failed on night recall (0.41) and is out. The rows are in evals/DATASETS.md. Update the plan in plan.md.

Input files: plan.md
