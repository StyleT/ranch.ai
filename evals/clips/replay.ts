// Replay the clip rule over cut clips (docs/CLIPS.md): extracts the mp4's keyframes (the same 2 s GOP keyframes the
// sampler saw), scores consecutive pairs with the production metrics from apps/ingest/src/clips.ts, and runs `step`
// from idle with the thresholds given on the command line. This is how the persistence rule and its constants were
// chosen: from the clips the old rule cut, not from a guess. Laptop only.
//   node --experimental-strip-types evals/clips/replay.ts <mp4...> [--open 0.08] [--continue 0.05] [--confirm-k 3]
//     [--confirm-hot 2] [--lit 0.02] [--global 0.5] [--json]
//   --confirm-hot 0 is the rule before 2 Nov: every clip the mini cut must come back as `cut`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  CLIP,
  step,
  thumbnail,
  blockMaxDiff,
  litFraction,
  idleState,
  type ClipRules,
} from '../../apps/ingest/src/clips.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    open: { type: 'string', default: String(CLIP.openScore) },
    continue: { type: 'string', default: String(CLIP.continueScore) },
    'confirm-k': { type: 'string', default: String(CLIP.confirmK) },
    'confirm-hot': { type: 'string', default: String(CLIP.confirmHot) },
    lit: { type: 'string', default: String(CLIP.litScore) },
    global: { type: 'string', default: String(CLIP.globalFrac) },
    json: { type: 'boolean', default: false },
  },
});
const rules: ClipRules = {
  ...CLIP,
  openScore: Number(a.open),
  continueScore: Number(a.continue),
  confirmK: Number(a['confirm-k']),
  confirmHot: Number(a['confirm-hot']),
  litScore: Number(a.lit),
  globalFrac: Number(a.global),
};

async function keyframeThumbs(mp4: string): Promise<Buffer[]> {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  try {
    execFileSync(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-skip_frame',
        'nokey',
        '-i',
        mp4,
        '-fps_mode',
        'passthrough',
        '-q:v',
        '2',
        '-f',
        'image2',
        join(dir, 'k-%04d.jpg'),
      ],
      { timeout: 60_000 },
    );
    const out: Buffer[] = [];
    for (const f of readdirSync(dir).sort()) {
      out.push(await thumbnail(sharp(readFileSync(join(dir, f)))));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T0 = 100_000; // keyframe i is at T0 + 2 s * i: clear of the cooldown that idleState() measures from 0
let cut = 0;
const rows: Record<string, unknown>[] = [];
for (const mp4 of positionals) {
  const thumbs = await keyframeThumbs(mp4);
  const st = idleState();
  const series: [number, number, number][] = [];
  let verdict = 'no trigger';
  let at = -1;
  for (let i = 1; i < thumbs.length; i++) {
    const key = {
      ts: T0 + i * 2000,
      score: blockMaxDiff(thumbs[i]!, thumbs[i - 1]!),
      lit: litFraction(thumbs[i]!, thumbs[i - 1]!, rules.litScore),
    };
    series.push([i, +key.score.toFixed(3), +key.lit.toFixed(2)]);
    if (verdict !== 'no trigger' && verdict !== 'candidate') {
      continue; // one verdict per clip: the first candidate's fate
    }
    const ev = step(st, key, rules);
    if (ev?.type === 'candidate') {
      verdict = 'candidate';
      at = i;
    } else if (ev?.type === 'open') {
      verdict = 'cut';
      at = at < 0 ? i : at;
      cut++;
    } else if (ev?.type === 'drop') {
      verdict = `dropped:${ev.reason}`;
    } else if (ev?.type === 'global') {
      verdict = 'global';
    }
  }
  if (verdict === 'candidate') {
    verdict = 'candidate (clip ended inside the window)';
  }
  const row = {
    clip: basename(mp4, '.mp4'),
    keyframes: thumbs.length,
    verdict,
    trigger_keyframe: at,
    max_score: Math.max(...series.map((s) => s[1])),
    series,
  };
  rows.push(row);
  if (!a.json) {
    console.log(
      `${row.clip.padStart(4)}  kf=${String(thumbs.length).padStart(2)}  ${verdict.padEnd(16)} trigger@${at}  max=${row.max_score.toFixed(3)}  ${series.map((s) => `${s[1].toFixed(2)}/${s[2].toFixed(2)}`).join(' ')}`,
    );
  }
}
if (a.json) {
  console.log(JSON.stringify({ rules, rows }, null, 1));
}
console.log(
  `cut ${cut} of ${positionals.length}  (open ${rules.openScore}, continue ${rules.continueScore}, confirm ${rules.confirmHot} of ${rules.confirmK}, lit ${rules.litScore}, global ${rules.globalFrac})`,
);
