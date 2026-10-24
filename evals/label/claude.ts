// AI-first labeling (PLAN.md Phase 1, decided 15 Oct): Claude labels the frame set through the Batch API with
// structured outputs; these labels are the Phase 1 ground truth. Phase 1b compares them with human labels.
//   node evals/label/claude.ts submit  --frames evals/baseline/<date>/frames.jsonl --n 100   → batch id (saved under evals/golden/batches/)
//   node evals/label/claude.ts submit-bursts --frames evals/baseline/<date>/frames.jsonl     → one request per burst, all members together
//   node evals/label/claude.ts collect --batch <id> --out evals/golden/labels.claude.jsonl   → per-frame rows either way
//   node evals/label/claude.ts estimate [--bursts] --frames ... [--n 100]                     → token count and cost
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import sharp from 'sharp';
import { FrameLabel, BurstLabel, toBoxes } from './schema.ts';

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4 / 1e6, output: 20 / 1e6, batchDiscount: 0.5 }; // USD per token, Claude Opus 5.5
const MAX_SIDE = 1568; // Claude's sweet spot for vision; 2560x1440 → 1568x882

const SYSTEM = `You label still frames from fixed security cameras on a small horse ranch (horses, a few donkeys, a barn,
paddocks, a house). Each frame is one camera at one moment; many are night infrared (greyscale, grainy).
Return only what you can actually see. Draw one box per animal, person or vehicle, tight around the visible
extent, in normalized image coordinates (x, y = top-left corner, w, h = size, all 0..1). Do not box reflections,
shadows, or things you are guessing at; use the confidence field for uncertainty instead. Posture: lying_flat means
on its side with legs out; lying_sternal means upright on its chest; drinking means head down at a trough or water. Insects and spiders, including ones on the lens,
are not animals: never box them (mention a dirty lens in notes instead). People: kind is "mailman" only with a visible
postal or courier uniform or vehicle, "unknown" otherwise ("friendly" is reserved for the human labeler who knows the
residents); describe clothing and build in "look". Vehicles: "delivery_vehicle" for marked courier or postal vans and
trucks. If no gate or trough is visible, say so.`;

// One request per burst (24 Oct): consecutive frames let the labeler tell a living thing from IR noise, a shadow or a
// fixture, which a single night still cannot (20 Oct: a static dark patch was boxed as a "walking cat" in four frames).
// The sequence is evidence for what an object IS; it must not turn a standing animal or a parked vehicle into nothing.
const BURST_ADDENDUM = `
You are given N consecutive frames from the same fixed camera, about one second apart, in order, taken because something
in the scene changed. Label every frame on its own with the rules above, as if it were a single frame; coordinates are
per frame. Use the sequence as evidence of what things are: animals, people and vehicles are solid, consistent objects
that may move between frames; infrared noise, shadows, reflections and lens dirt flicker or stay identical and are not
objects. A faint blob that looks the same in every frame and is not clearly an animal, person or vehicle is not one:
leave it out, or box it with a low confidence. A standing animal or a parked vehicle that is clearly what it is remains
one even though it does not move. Give every distinct object an id (a1, a2, p1, v1 ...) and use the same id for it in
every frame it appears in; then, in "objects", say for each id whether it changed position between the first and the
last frame it appears in.`;

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  frames: { type: 'string', default: 'evals/golden/frames.jsonl' }, batch: { type: 'string' }, out: { type: 'string', default: '' },
  limit: { type: 'string' }, n: { type: 'string' }, dataset: { type: 'string', default: 'frames-ranch-v1' }, labels: { type: 'string', default: 'labels-ranch-claude-v1' },
  bursts: { type: 'boolean', default: false },   // estimate: price the one-request-per-burst form
} });
const cmd = positionals[0];
const client = new Anthropic();
interface FrameRow { path: string; source?: string; camera: string; ts: string; period: string; frame_id?: number; burst_id?: number | null; seq?: number | null }
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
/** Whole bursts, members in seq order, file order otherwise; frames without a burst_id are skipped. */
const bursts = (): FrameRow[][] => {
  const g = new Map<number, FrameRow[]>();
  for (const f of frames()) { if (f.burst_id == null) continue; (g.get(f.burst_id) ?? g.set(f.burst_id, []).get(f.burst_id)!).push(f); }
  return [...g.values()].map((m) => m.sort((u, v) => (u.seq ?? 0) - (v.seq ?? 0)));
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

async function paramsBurst(members: FrameRow[]): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  const t0 = Date.parse(members[0]!.ts);
  const content: Anthropic.ContentBlockParam[] = [];
  for (const [i, f] of members.entries()) {
    content.push({ type: 'text', text: `Frame ${i + 1} of ${members.length} (seq ${f.seq ?? i}, +${((Date.parse(f.ts) - t0) / 1000).toFixed(1)} s):` });
    content.push(await imageBlock(f.path));
  }
  content.push({ type: 'text', text: `Camera "${members[0]!.camera}", burst starting ${members[0]!.ts} UTC (${members[0]!.period}). Label every frame; return one entry per frame, in order, with its seq.` });
  return {
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM + '\n' + BURST_ADDENDUM.replace('N', String(members.length)),
    output_config: { effort: 'high', format: zodOutputFormat(BurstLabel) },
    messages: [{ role: 'user', content }],
  };
}

interface BatchMeta { id: string; created_at: string; model: string; mode?: 'frames' | 'bursts'; frames?: FrameRow[]; bursts?: { burst_id: number; frames: FrameRow[] }[] }
const usd = (u: { input_tokens: number; output_tokens: number }) => (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output) * PRICE.batchDiscount;

if (cmd === 'estimate') {
  if (a.bursts) {
    const bs = bursts(); const first = bs[0]!;
    const p = await paramsBurst(first);
    const c = await client.messages.countTokens({ model: p.model, system: p.system!, messages: p.messages });
    const nFrames = bs.reduce((s, b) => s + b.length, 0);
    const perFrame = ((c.input_tokens / first.length) * PRICE.input + 700 * PRICE.output) * PRICE.batchDiscount;   // ~700 output tokens per frame in the burst form (ids + objects)
    console.log(JSON.stringify({ mode: 'bursts', first_burst: { frames: first.length, input_tokens: c.input_tokens }, bursts: bs.length, frames: nFrames, est_usd_per_frame: +perFrame.toFixed(4), est_usd_total: +(perFrame * nFrames).toFixed(2) }));
  } else {
    const f = frames()[0]!;
    const p = await params(f);
    const c = await client.messages.countTokens({ model: p.model, system: p.system!, messages: p.messages });
    const n = frames().length;
    const est = (c.input_tokens * PRICE.input + 600 * PRICE.output) * PRICE.batchDiscount;
    console.log(JSON.stringify({ frame: f.path, input_tokens: c.input_tokens, est_usd_per_frame: +est.toFixed(4), frames: n, est_usd_total: +(est * n).toFixed(2) }));
  }
} else if (cmd === 'submit') {
  const rows = frames();
  const requests: Anthropic.Messages.BatchCreateParams.Request[] = [];
  for (const [i, f] of rows.entries()) requests.push({ custom_id: `f${i}`, params: await params(f) });
  const batch = await client.messages.batches.create({ requests });
  mkdirSync('evals/golden/batches', { recursive: true });
  const meta: BatchMeta = { id: batch.id, created_at: batch.created_at, model: MODEL, mode: 'frames', frames: rows };
  writeFileSync(join('evals/golden/batches', `${batch.id}.json`), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ batch_id: batch.id, requests: requests.length, status: batch.processing_status }));
} else if (cmd === 'submit-bursts') {
  const bs = bursts();
  if (!bs.length) { console.error('no rows with a burst_id in --frames'); process.exit(2); }
  const requests: Anthropic.Messages.BatchCreateParams.Request[] = [];
  for (const [i, b] of bs.entries()) requests.push({ custom_id: `b${i}`, params: await paramsBurst(b) });
  const batch = await client.messages.batches.create({ requests });
  mkdirSync('evals/golden/batches', { recursive: true });
  const meta: BatchMeta = { id: batch.id, created_at: batch.created_at, model: MODEL, mode: 'bursts', bursts: bs.map((b) => ({ burst_id: b[0]!.burst_id!, frames: b })) };
  writeFileSync(join('evals/golden/batches', `${batch.id}.json`), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ batch_id: batch.id, requests: requests.length, frames: bs.reduce((s, b) => s + b.length, 0), status: batch.processing_status }));
} else if (cmd === 'collect') {
  if (!a.batch) { console.error('--batch <id> required'); process.exit(2); }
  const meta = JSON.parse(readFileSync(join('evals/golden/batches', `${a.batch}.json`), 'utf8')) as BatchMeta;
  let batch = await client.messages.batches.retrieve(a.batch);
  while (batch.processing_status !== 'ended') {
    console.error(`status ${batch.processing_status}: processing ${batch.request_counts.processing}, succeeded ${batch.request_counts.succeeded}, errored ${batch.request_counts.errored}`);
    await new Promise((r) => setTimeout(r, 30_000));
    batch = await client.messages.batches.retrieve(a.batch);
  }
  const out: string[] = []; let cost = 0; let failed = 0; let mismatched = 0;
  const common = { dataset: a.labels, frames_dataset: a.dataset, labeler: MODEL, labeled_at: new Date().toISOString(), batch_id: a.batch };
  for await (const r of await client.messages.batches.results(a.batch)) {
    const idx = Number(r.custom_id.slice(1));
    const where = meta.mode === 'bursts' ? `burst ${meta.bursts![idx]!.burst_id}` : meta.frames![idx]!.path;
    if (r.result.type !== 'succeeded') { failed++; console.error(`${r.custom_id} ${where}: ${r.result.type}`); continue; }
    const msg = r.result.message;
    if (msg.stop_reason === 'refusal') { failed++; console.error(`${r.custom_id} ${where}: refusal`); continue; }
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const c = usd(msg.usage); cost += c;
    if (meta.mode === 'bursts') {
      const b = meta.bursts![idx]!;
      const parsed = BurstLabel.safeParse(JSON.parse(text));
      if (!parsed.success) { failed++; console.error(`${r.custom_id} ${where}: schema ${parsed.error.message.slice(0, 200)}`); continue; }
      if (parsed.data.frames.length !== b.frames.length) { mismatched++; console.error(`${r.custom_id} ${where}: ${parsed.data.frames.length} labeled frames for ${b.frames.length} members`); }
      // One row per member, the same shape as single-frame rows (bench.ts reads path, boxes, label), plus the burst's
      // motion ground truth on every row. Usage and cost are booked on the head row.
      for (const [k, fl] of parsed.data.frames.entries()) {
        const f = b.frames.find((m) => (m.seq ?? 0) === fl.seq) ?? b.frames[k]; if (!f) continue;
        out.push(JSON.stringify({ ...common, frame_id: f.frame_id ?? null, path: f.path, source: f.source, camera: f.camera, ts: f.ts, period: f.period, burst_id: f.burst_id, seq: f.seq,
          boxes: toBoxes(fl), label: fl, objects: parsed.data.objects, ...(k === 0 ? { usage: msg.usage, cost_usd: +c.toFixed(5) } : { cost_usd: 0 }) }));
      }
    } else {
      const f = meta.frames![idx]!;
      const parsed = FrameLabel.safeParse(JSON.parse(text));
      if (!parsed.success) { failed++; console.error(`${r.custom_id} ${where}: schema ${parsed.error.message.slice(0, 200)}`); continue; }
      out.push(JSON.stringify({ ...common, frame_id: f.frame_id ?? null, path: f.path, source: f.source, camera: f.camera, ts: f.ts, period: f.period,
        boxes: toBoxes(parsed.data), label: parsed.data, usage: msg.usage, cost_usd: +c.toFixed(5) }));
    }
  }
  out.sort();
  const outPath = a.out || `evals/golden/${a.labels}.jsonl`;
  writeFileSync(outPath, out.join('\n') + '\n');
  console.log(JSON.stringify({ labeled: out.length, failed, mismatched, cost_usd: +cost.toFixed(4), out: outPath, dataset: a.labels, frames: a.dataset, mode: meta.mode ?? 'frames' }));
} else {
  console.error('usage: claude.ts estimate [--bursts]|submit|submit-bursts|collect [--frames f.jsonl] [--batch id] [--out labels.jsonl] [--limit n]');
  process.exit(2);
}
