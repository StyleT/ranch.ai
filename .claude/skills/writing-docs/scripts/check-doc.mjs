#!/usr/bin/env node
// Docs describe the present and name no one (.claude/skills/writing-docs/SKILL.md). Prints `file:line: reason`
// for every hit outside code spans and fenced blocks; exits 1 on any. The pre-commit hook runs it on staged docs/*.md.
import { readFileSync } from 'node:fs';

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DAY_MONTH = `\\b\\d{1,2}(?:[–-]\\d{1,2})? ${MONTH}\\b|\\b${MONTH} \\d{1,2}\\b`;
const RULES = [
  { re: new RegExp(DAY_MONTH), why: 'a date on a fact: state what is true, git keeps when it became true' },
  { re: /\b20\d\d-\d\d-\d\d\b/, why: 'ISO date in prose: a date that identifies evidence goes in a code span' },
  { re: /\b(?:As built|Regroup|Decided)\b|\blater:/, why: 'ledger phrase: describe the state, delete the history' },
  { re: /\b(?:no longer|used to|nowadays|currently)\b/i, why: 'a date in disguise: say what is true' },
  { re: /~~/, why: 'strikethrough: delete superseded text, git keeps it' },
  { re: /\bVlad\b|\bClaude's\b/, why: 'a person or a model as an actor: use the role, the reason or the identifier' },
  { re: /\bI\b(?!\/)|\b(?:we|our|us)\b/i, why: 'first person: name the component that does it' },
  { re: /\bBlocked on\b/, why: 'blocked on a person: state the requirement instead' },
];

let hits = 0;
for (const file of process.argv.slice(2)) {
  let inFence = false;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) {
        inFence = !inFence;
        return;
      }
      if (inFence) {
        return;
      }
      const line = raw.replace(/`[^`]*`/g, '');
      for (const { re, why } of RULES) {
        const m = line.match(re);
        if (m) {
          hits++;
          console.log(`${file}:${i + 1}: ${why} ("${m[0]}")`);
        }
      }
    });
}
process.exit(hits ? 1 : 0);
