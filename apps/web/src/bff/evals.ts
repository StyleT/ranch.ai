// Evals read from the repo files (evals/LEADERBOARD.md, evals/DATASETS.md, evals/results/*.json) under RANCH_APP_DIR.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalsData, LeaderboardRow } from '@/lib/types';
import { env } from './env.ts';
import { UpstreamError } from './daemon.ts';

const cells = (line: string) => line.slice(1, -1).split('|').map((c) => c.trim());
/** Parse the markdown leaderboard table: header row defines columns; `**prod**` in the result cell marks production. */
export function parseLeaderboard(md: string): { rows: LeaderboardRow[]; notes: string } {
  const lines = md.split('\n'); const rows: LeaderboardRow[] = []; let header: string[] | null = null; const notes: string[] = [];
  for (const l of lines) {
    if (l.startsWith('|')) { const c = cells(l); if (!header) { header = c; continue; } if (c.every((x) => /^-+$/.test(x))) continue; if (c.length < 10) continue;
      const g = (i: number) => c[i] ?? '';
      rows.push({ date: g(0), tag: g(1), model: g(2), frames: g(3), labels: g(4), r_at_fppf: g(5), horse_recall: g(6), ap: g(7), fppf_all: g(8), count_exact: g(9), p50_ms: g(10), rss_mb: g(11), result: g(12).replace(/\*\*prod\*\*\s*/, '').replace(/`/g, ''), prod: /\*\*prod\*\*/.test(g(12)) });
    } else if (!l.startsWith('#') && l.trim() && header) notes.push(l);
  }
  return { rows, notes: notes.join('\n') };
}
export function parseDatasets(md: string): EvalsData['datasets'] {
  const out: EvalsData['datasets'] = []; let header = false;
  for (const l of md.split('\n')) { if (!l.startsWith('|')) continue; const c = cells(l); if (!header) { header = true; continue; } if (c.every((x) => /^-+$/.test(x)) || c.length < 7) continue; out.push({ id: c[0]!, kind: c[1]!, created: c[2]!, n: c[3]!, parent: c[4]!, location: c[6]! }); }
  return out;
}

let memo: { at: number; key: string; value: EvalsData } | undefined;
export function getEvals(): EvalsData {
  const dir = join(env.appDir, 'evals'); const resultsDir = join(dir, 'results');
  let files: string[] = []; try { files = readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { /* no results dir */ }
  const key = files.map((f) => f + statSync(join(resultsDir, f)).mtimeMs).join(',') + statSafe(join(dir, 'LEADERBOARD.md')) + statSafe(join(dir, 'DATASETS.md'));
  if (memo && memo.key === key && Date.now() - memo.at < 300_000) return memo.value;
  const lb = parseLeaderboard(readSafe(join(dir, 'LEADERBOARD.md')));
  const value: EvalsData = {
    rows: lb.rows, notes: lb.notes, datasets: parseDatasets(readSafe(join(dir, 'DATASETS.md'))),
    files: files.map((file) => { try { const r = JSON.parse(readFileSync(join(resultsDir, file), 'utf8')) as { ts?: string; tag?: string; results?: { model?: string }[] }; return { file, ts: r.ts ?? null, tag: r.tag ?? null, models: (r.results ?? []).map((m) => m.model ?? '?') }; } catch { return { file, ts: null, tag: null, models: [] }; } }),
  };
  memo = { at: Date.now(), key, value }; return value;
}
export function getResultFile(name: string): unknown {
  if (!/^[\w.-]+\.json$/.test(name) || name.includes('..')) throw new UpstreamError(400, 'bad_request', 'bad file name');
  try { return JSON.parse(readFileSync(join(env.appDir, 'evals', 'results', name), 'utf8')); } catch { throw new UpstreamError(404, 'not_found', `no result ${name}`); }
}
const readSafe = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const statSafe = (p: string) => { try { return String(statSync(p).mtimeMs); } catch { return '0'; } };
