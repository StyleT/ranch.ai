#!/usr/bin/env node
// A plan is the current state of the work, never a ledger (.claude/skills/plan-maintenance/SKILL.md).
// CLI: `node check-plan.mjs <plan.md>...` prints `file:line: reason` for every hit and exits 1 on any.
// Hook: with no arguments it reads the PostToolUse JSON from stdin, ignores every file but ~/.claude/plans/*.md and
// docs/PLAN.md, and on hits prints them to stderr and exits 2 so the editing session sees them and fixes the plan.
// The pre-commit hook (lint-staged) runs the CLI form on a staged docs/PLAN.md.
import { readFileSync } from 'node:fs';

const LEDGER = [
  { re: /^\s*[-*]\s*\[[xX]\]/, why: 'a ticked item: a finished step is deleted, its result becomes a fact' },
  { re: /✅|✔/, why: 'a check mark: a finished step is deleted, its result becomes a fact' },
  { re: /~~/, why: 'strikethrough: delete superseded text, git keeps it' },
  {
    re: /(^\s*(?:[-*]|\d+[.)])\s*(?:\*\*)?|[(—–]\s*)(?:done|DONE|Done|completed|shipped|landed|skipped)\b/,
    why: 'a status on a step: delete the step, fold its result into Where things stand, one line to the appendix',
  },
  {
    re: /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Update|UPDATE|Correction|Addendum|Note added|Revised|Revision)\b[^\n]{0,40}?:/,
    why: 'an appended note: edit the sentence that is now wrong instead',
  },
  {
    re: /\b(?:no longer|used to|originally|previously|was going to|as of|Decided)\b/,
    why: 'a diff against an earlier version of the plan: state what is true',
  },
];
const DIFF_HEADING =
  /revised|revision|updated|previous plan|old plan|old approach|still relevant|what changed|^#{2,3} +(?:done|completed|finished|history|changelog)\b/i;

export function checkPlan(text, file = 'plan') {
  const hits = [];
  const lines = text.split('\n');
  let inFence = false;
  let titles = 0;
  let remaining = false;
  let appendixAt = -1;
  const h2After = [];
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      return;
    }
    const n = i + 1;
    if (/^# /.test(raw)) {
      titles++;
      if (titles > 1) {
        hits.push(`${file}:${n}: a second title: one plan, one current version; an older plan is appendix bullets, not a section`);
      }
    }
    const h2 = raw.match(/^## +(.*)/);
    if (h2) {
      if (appendixAt >= 0) {
        h2After.push(n);
      } else if (/^appendix\b/i.test(h2[1])) {
        appendixAt = n;
      } else if (/remaining work/i.test(h2[1])) {
        remaining = true;
      }
    }
    if (appendixAt >= 0) {
      return;
    }
    if (/^#{2,3} /.test(raw) && DIFF_HEADING.test(raw)) {
      hits.push(`${file}:${n}: a heading that diffs against the past: rewrite the section it revises ("${raw.trim()}")`);
    }
    const line = raw.replace(/`[^`]*`/g, '');
    for (const { re, why } of LEDGER) {
      const m = line.match(re);
      if (m) {
        hits.push(`${file}:${n}: ${why} ("${m[0].trim()}")`);
      }
    }
  });
  if (!remaining) {
    hits.push(`${file}: no "## Remaining work" section: the plan must say what is left, in order`);
  }
  for (const n of h2After) {
    hits.push(`${file}:${n}: a section after the appendix: the appendix is last and holds only history`);
  }
  return hits;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const files = process.argv.slice(2);
  if (files.length) {
    let hits = [];
    for (const f of files) {
      hits = hits.concat(checkPlan(readFileSync(f, 'utf8'), f));
    }
    hits.forEach((h) => console.log(h));
    process.exit(hits.length ? 1 : 0);
  }
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  let file;
  try {
    file = JSON.parse(input)?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!file || !/\/\.claude\/plans\/[^/]+\.md$|\/docs\/PLAN\.md$/.test(file)) {
    process.exit(0);
  }
  let hits;
  try {
    hits = checkPlan(readFileSync(file, 'utf8'), file);
  } catch {
    process.exit(0);
  }
  if (hits.length) {
    console.error(hits.join('\n'));
    console.error('The plan reads as a ledger. Rewrite it per .claude/skills/plan-maintenance/SKILL.md, then continue.');
    process.exit(2);
  }
}
