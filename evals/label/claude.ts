// AI-first labeling (PLAN.md Phase 1, decided 15 Oct): Claude labels the frame set through the Batch API with
// structured outputs; these labels are the Phase 1 ground truth. Phase 1b compares them with human labels.
//   node evals/label/claude.ts submit  --frames evals/baseline/<date>/frames.jsonl --n 100   → batch id (saved under evals/golden/batches/)
//   node evals/label/claude.ts collect --batch <id> --out evals/golden/labels.claude.jsonl
//   node evals/label/claude.ts estimate --frames evals/baseline/<date>/frames.jsonl --n 100  → token count and cost
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import sharp from 'sharp';
import { FrameLabel, toBoxes } from './schema.ts';

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4 / 1e6, output: 20 / 1e6, batchDiscount: 0.5 }; // USD per token, Claude Opus 5.5
const MAX_SIDE = 1568; // Claude's sweet spot for vision; 2560x1440 → 1568x882

const SYSTEM = `You label still frames from fixed security cameras on a small horse ranch (horses, a few donkeys, a barn,
paddocks, a house). Each frame is one camera at one moment; many are night infrared (greyscale, grainy).
Return only what you can actually see. Draw one box per animal, person or vehicle, tight around the visible
extent, in normalized image coordinates (x, y = top-left corner, w, h = size, all 0..1). Do not box reflections,
shadows, or things you are guessing at; use the confidence field for uncertainty instead. Posture: lying_flat means
on its side with legs out; lying_sternal means upright on its chest. Insects and spiders, including ones on the lens,
are not animals: never box them (mention a dirty lens in notes instead). People: kind is "mailman" only with a visible
postal or courier uniform or vehicle, "unknown" otherwise ("friendly" is reserved for the human labeler who knows the
residents); describe clothing and build in "look". Vehicles: "delivery_vehicle" for marked courier or postal vans and
trucks. If no gate or trough is visible, say so.`;

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  frames: { type: 'string', default: 'evals/golden/frames.jsonl' }, batch: { type: 'string' }, out: { type: 'string', default: 'evals/golden/labels.claude.jsonl' },
  limit: { type: 'string' }, n: { type: 'string' },
} });
const cmd = positionals[0];
const client = new Anthropic();
interface FrameRow { path: string; source?: string; camera: string; ts: string; period: string }
const frames = (): FrameRow[] => {
  const all = readFileSync(a.frames!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FrameRow);
  if (a.limit) return all.slice(0, Number(a.limit));
  if (!a.n) return all;
  // --n: take the first N round-robin over camera x period buckets, in file order (the baseline file is already a
  // seeded stratified pick), so the labeled subset stays balanced.
  const buckets = new Map<string, FrameRow[]>();
  for (const f of all) { const k = `${f.camera}|${f.period}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(f); }
  const keys = [...buckets.keys()].sort(); const out: FrameRow[] = []; let i = 0;
  while (out.length < Number(a.n) && i < keys.length * 1000) { const next = buckets.get(keys[i++ % keys.length]!)!.shift(); if (next) out.push(next); if ([...buckets.values()].every((b) => b.length === 0)) break; }
  return out;
};

async function imageBlock(path: string): Promise<Anthropic.ImageBlockParam> {
  const data = await sharp(path).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } };
}

async function params(f: FrameRow): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  return {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { effort: 'high', format: zodOutputFormat(FrameLabel) },
    messages: [{ role: 'user', content: [
      await imageBlock(f.path),
      { type: 'text', text: `Camera "${f.camera}", ${f.ts} UTC (${f.period}). Label this frame.` },
    ] }],
  };
}

if (cmd === 'estimate') {
  const f = frames()[0]!;
  const p = await params(f);
  const c = await client.messages.countTokens({ model: p.model, system: p.system!, messages: p.messages });
  const n = frames().length;
  const est = (c.input_tokens * PRICE.input + 600 * PRICE.output) * PRICE.batchDiscount;
  console.log(JSON.stringify({ frame: f.path, input_tokens: c.input_tokens, est_usd_per_frame: +est.toFixed(4), frames: n, est_usd_total: +(est * n).toFixed(2) }));
} else if (cmd === 'submit') {
  const rows = frames();
  const requests: Anthropic.Messages.BatchCreateParams.Request[] = [];
  for (const [i, f] of rows.entries()) requests.push({ custom_id: `f${i}`, params: await params(f) });
  const batch = await client.messages.batches.create({ requests });
  mkdirSync('evals/golden/batches', { recursive: true });
  writeFileSync(join('evals/golden/batches', `${batch.id}.json`), JSON.stringify({ id: batch.id, created_at: batch.created_at, model: MODEL, frames: rows }, null, 2));
  console.log(JSON.stringify({ batch_id: batch.id, requests: requests.length, status: batch.processing_status }));
} else if (cmd === 'collect') {
  if (!a.batch) { console.error('--batch <id> required'); process.exit(2); }
  const meta = JSON.parse(readFileSync(join('evals/golden/batches', `${a.batch}.json`), 'utf8')) as { frames: FrameRow[] };
  let batch = await client.messages.batches.retrieve(a.batch);
  while (batch.processing_status !== 'ended') {
    console.error(`status ${batch.processing_status}: processing ${batch.request_counts.processing}, succeeded ${batch.request_counts.succeeded}, errored ${batch.request_counts.errored}`);
    await new Promise((r) => setTimeout(r, 30_000));
    batch = await client.messages.batches.retrieve(a.batch);
  }
  const out: string[] = []; let cost = 0; let failed = 0;
  for await (const r of await client.messages.batches.results(a.batch)) {
    const f = meta.frames[Number(r.custom_id.slice(1))]!;
    if (r.result.type !== 'succeeded') { failed++; console.error(`${r.custom_id} ${f.path}: ${r.result.type}`); continue; }
    const msg = r.result.message;
    if (msg.stop_reason === 'refusal') { failed++; console.error(`${r.custom_id} ${f.path}: refusal`); continue; }
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const parsed = FrameLabel.safeParse(JSON.parse(text));
    if (!parsed.success) { failed++; console.error(`${r.custom_id} ${f.path}: schema ${parsed.error.message.slice(0, 200)}`); continue; }
    const usd = (msg.usage.input_tokens * PRICE.input + msg.usage.output_tokens * PRICE.output) * PRICE.batchDiscount;
    cost += usd;
    out.push(JSON.stringify({ path: f.path, source: f.source, camera: f.camera, ts: f.ts, period: f.period, labeler: MODEL, batch_id: a.batch,
      boxes: toBoxes(parsed.data), label: parsed.data, usage: msg.usage, cost_usd: +usd.toFixed(5) }));
  }
  out.sort();
  writeFileSync(a.out!, out.join('\n') + '\n');
  console.log(JSON.stringify({ labeled: out.length, failed, cost_usd: +cost.toFixed(4), out: a.out }));
} else {
  console.error('usage: claude.ts estimate|submit|collect [--frames f.jsonl] [--batch id] [--out labels.jsonl] [--limit n]');
  process.exit(2);
}
