// Score a VLM's answers over an escalation set (plan: the tier-2 table). Reads escalations.jsonl and one or more
// predictions.vlm.<model>@<prompt>.jsonl beside it and writes a result JSON:
//   verification  on `verify` requests: share of golden TPs kept (present=true) and golden FPs rejected (present=false)
//   kind / posture accuracy with confusion matrices on `attributes` requests (gold value -> answered value -> count)
//   scene         gate and trough accuracy on `scene` requests where the gold field is set
//   reliability   JSON-valid rate, latency p50 / p95, RSS max
//   system        with --frames --labels --predictions: tier-1 horse R@FPPF<=0.1 and FPPF(all) after the VLM's rejections
//                 are applied to the tier-1 predictions, beside tier 1 alone (the same scorer as bench.ts)
//   node --experimental-strip-types evals/escalate/score.ts --set evals/baseline/<set>/escalations-<model> \
//     --vlm predictions.vlm.<model>@v1.jsonl [--vlm ...] [--frames f.jsonl --labels l.jsonl --predictions p.jsonl] --out evals/results/<date>-tier2.json
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scoreSet, type Box, type Pred, type Scored } from '../../apps/detector/src/score.ts';
import type { Escalation } from './build.ts';

export interface VlmRow {
  id: string;
  type: string;
  model: string;
  prompt: string;
  prompt_sha: string;
  answer: {
    present: boolean;
    kind: string;
    posture: string | null;
    gate: string | null;
    trough: string | null;
    confidence: number;
  } | null;
  error: string | null;
  ms: number;
  rss_mb: number | null;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((u, v) => u - v);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};
const confusion = (pairs: [string, string][]) => {
  const m: Record<string, Record<string, number>> = {};
  for (const [g, p] of pairs) {
    (m[g] ??= {})[p] = (m[g]![p] ?? 0) + 1;
  }
  return {
    pairs: pairs.length,
    accuracy: pairs.length ? pairs.filter(([g, p]) => g === p).length / pairs.length : 0,
    confusion: m,
  };
};

/** The tier-2 table for one model's answers. Pure; the CLI below reads the files. */
export function scoreVlm(esc: Escalation[], rows: VlmRow[]): Record<string, unknown> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const verify = esc.filter((e) => e.type === 'verify');
  let tpKept = 0,
    tp = 0,
    fpRejected = 0,
    fp = 0;
  for (const e of verify) {
    const r = byId.get(e.id);
    if (e.gold.verdict === 'tp') {
      tp++;
      if (r?.answer?.present) {
        tpKept++;
      }
    } else if (e.gold.verdict === 'fp') {
      fp++;
      if (r?.answer && !r.answer.present) {
        fpRejected++;
      }
    }
  }
  const attrs = esc.filter((e) => e.type === 'attributes');
  const kindPairs: [string, string][] = [],
    posturePairs: [string, string][] = [];
  for (const e of attrs) {
    const r = byId.get(e.id)?.answer;
    if (!r) {
      continue;
    }
    if (e.gold.kind !== undefined) {
      kindPairs.push([e.gold.kind, r.kind]);
    }
    if (e.gold.posture !== undefined) {
      posturePairs.push([e.gold.posture, r.posture ?? 'null']);
    }
  }
  const lying = (v: string) => (v.startsWith('lying') ? 'lying' : 'upright');
  const scene = esc.filter((e) => e.type === 'scene');
  const gatePairs: [string, string][] = [],
    troughPairs: [string, string][] = [];
  for (const e of scene) {
    const r = byId.get(e.id)?.answer;
    if (!r) {
      continue;
    }
    if (e.gold.gate !== undefined) {
      gatePairs.push([e.gold.gate, r.gate ?? 'null']);
    }
    if (e.gold.trough !== undefined) {
      troughPairs.push([e.gold.trough, r.trough ?? 'null']);
    }
  }
  const ms = rows.map((r) => r.ms);
  return {
    requests: esc.length,
    answered: rows.filter((r) => r.answer).length,
    json_valid_rate: rows.length ? rows.filter((r) => r.answer).length / rows.length : 0,
    verification: {
      tp,
      tp_kept: tpKept,
      tp_kept_share: tp ? tpKept / tp : null,
      fp,
      fp_rejected: fpRejected,
      fp_rejected_share: fp ? fpRejected / fp : null,
    },
    kind: confusion(kindPairs),
    posture: confusion(posturePairs),
    posture_lying_vs_upright: confusion(
      posturePairs.map(([g, p]) => [lying(g), p === 'null' ? 'null' : lying(p)] as [string, string]),
    ),
    gate: confusion(gatePairs),
    trough: confusion(troughPairs),
    latency: {
      p50_ms: pct(ms, 0.5),
      p95_ms: pct(ms, 0.95),
      max_rss_mb: Math.max(0, ...rows.map((r) => r.rss_mb ?? 0)) || null,
    },
  };
}

/** Tier-1 predictions after the VLM's rejections: a `verify` request answered present=false removes its box. */
export function applyRejections(esc: Escalation[], rows: VlmRow[], preds: Map<string, Pred[]>): Map<string, Pred[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map(preds);
  for (const e of esc) {
    if (e.type !== 'verify') {
      continue;
    }
    const r = byId.get(e.id);
    if (!r?.answer || r.answer.present) {
      continue;
    }
    const ps = out.get(e.path) ?? [];
    // the escalated box: same label and confidence, its expanded crop contains the box centre
    const cx = (p: Pred) => p.x + p.w / 2,
      cy = (p: Pred) => p.y + p.h / 2;
    const idx = ps.findIndex(
      (p) =>
        p.label === e.context.label &&
        Math.abs(p.confidence - e.context.confidence) < 1e-6 &&
        cx(p) >= e.box.x &&
        cx(p) <= e.box.x + e.box.w &&
        cy(p) >= e.box.y &&
        cy(p) <= e.box.y + e.box.h,
    );
    if (idx >= 0) {
      out.set(
        e.path,
        ps.filter((_, i) => i !== idx),
      );
    }
  }
  return out;
}

if (import.meta.main) {
  const { values: a } = parseArgs({
    options: {
      set: { type: 'string' },
      vlm: { type: 'string', multiple: true },
      frames: { type: 'string' },
      labels: { type: 'string' },
      predictions: { type: 'string' },
      threshold: { type: 'string', default: '0.25' },
      iou: { type: 'string', default: '0.5' },
      out: { type: 'string' },
    },
  });
  if (!a.set || !a.vlm?.length) {
    console.error(
      'usage: score.ts --set <escalations dir> --vlm predictions.vlm.<m>.jsonl [--vlm ...] [--frames --labels --predictions] [--out]',
    );
    process.exit(2);
  }
  const readJsonl = <T>(p: string): T[] =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  const setDir = resolve(a.set);
  const esc = readJsonl<Escalation>(join(setDir, 'escalations.jsonl'));
  const ds = existsSync(join(setDir, 'dataset.json'))
    ? (JSON.parse(readFileSync(join(setDir, 'dataset.json'), 'utf8')) as { id: string })
    : null;
  const system = (() => {
    if (!a.frames || !a.labels || !a.predictions) {
      return null;
    }
    const frames = readJsonl<{ path: string; camera: string; period: string; clip_id?: number }>(a.frames);
    const gold = new Map(
      readJsonl<{ path?: string; boxes?: Box[] }>(a.labels)
        .filter((l) => l.path)
        .map((l) => [l.path!, l.boxes ?? []]),
    );
    const preds = new Map(
      readJsonl<{ path: string; detections: Pred[] }>(a.predictions).map((r) => [r.path, r.detections]),
    );
    const scored = (p: Map<string, Pred[]>): Scored[] =>
      frames
        .filter((f) => gold.has(f.path))
        .map((f) => ({ frame: f, gold: gold.get(f.path)!, pred: p.get(f.path) ?? [] }));
    return { frames, gold, preds, scored };
  })();
  const results = a.vlm.map((v) => {
    const p = existsSync(v) ? v : join(setDir, v);
    const rows = readJsonl<VlmRow>(p);
    const row: Record<string, unknown> = {
      model: rows[0]?.model ?? basename(p),
      prompt: rows[0]?.prompt ?? null,
      prompt_sha: rows[0]?.prompt_sha ?? null,
      file: p,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
      ...scoreVlm(esc, rows),
    };
    if (system) {
      const opts = { threshold: Number(a.threshold), iou: Number(a.iou) };
      const pick = (s: Record<string, unknown>) => {
        const all = (s as { slices: Record<string, { fppf_all: number; classes: Record<string, { recall: number }> }> })
          .slices.all!;
        const op = (s as { operating_points: { r_at_fppf01: { recall: number } } }).operating_points;
        return {
          horse_recall: all.classes.horse?.recall ?? null,
          fppf_all: all.fppf_all,
          r_at_fppf01: op.r_at_fppf01.recall,
        };
      };
      row.system = {
        tier1_alone: pick(scoreSet(system.scored(system.preds), opts)),
        tier1_plus_vlm: pick(scoreSet(system.scored(applyRejections(esc, rows, system.preds)), opts)),
      };
    }
    const v2 = row.verification as { tp_kept_share: number | null; fp_rejected_share: number | null };
    console.log(
      `${String(row.model).padEnd(40)} n ${esc.length}  valid ${(row.json_valid_rate as number).toFixed(2)}  TP kept ${v2.tp_kept_share?.toFixed(2) ?? '-'}  FP rejected ${v2.fp_rejected_share?.toFixed(2) ?? '-'}  kind ${(row.kind as { accuracy: number }).accuracy.toFixed(2)}  posture ${(row.posture as { accuracy: number }).accuracy.toFixed(2)}  p50 ${(row.latency as { p50_ms: number }).p50_ms.toFixed(0)} ms`,
    );
    return row;
  });
  if (a.out) {
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(
      a.out,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          host: hostname(),
          command: process.argv.slice(1).join(' '),
          escalations: ds?.id ?? setDir,
          n: esc.length,
          threshold: Number(a.threshold),
          iou: Number(a.iou),
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('wrote', a.out);
  }
}
