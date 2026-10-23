// The status daemon: the JSON + SSE API behind the web dashboard (apps/web, docs/WEB-DASHBOARD.md). One node:http
// server on loopback; the HTML pages it used to serve moved to the Next.js app on 22 Oct.
//   GET /api/status        everything the page shows, JSON (5 s cache)
//   GET /api/frame/<cam>   latest kept frame for that camera; /api/frame/<id>?w=1280 a specific frame, resized on the fly
//   GET /api/frames        the frame browser's rows (docs/FRAMES-AND-BASELINE.md §2)
//   GET /api/baseline, /api/baseline/<date>?model=, /api/baseline-frame/<date>/<camera>/<file>  zero-shot baseline sets (§3)
//   GET /api/events        server-sent events: every MQTT message on ranch/# plus a status document every 15 s
//   GET /api/ping, /api/counts/series, /api/frames/series, /api/tracks, /api/frames/<id>   series and bursts for the web app (docs/WEB-DASHBOARD.md); contract in packages/contracts
//   GET /api/taxonomy[/versions[/<id>]]; POST /api/taxonomy/{validate,score,apply,revert}  the taxonomy editor (docs/TAXONOMY-UI.md)
//   GET /api/buffer/<cam>?w=   newest frame of the recorder's buffer (thumbnails, posters)
//   GET /api/live/<cam>/{index.m3u8,init.mp4,segNNNNNN.m4s}   the recorder's HLS output: the live view (docs/WEB-DASHBOARD.md); files only, no camera is touched
//   GET /api/bridge            the Wyze bridge's own metrics (:5080/api/metrics), proxied because 5080 is loopback-only since 23 Oct
// Every JPEG goes through jpeg.ts (read into memory, then sharp): sharp(path) memory-maps and a file still being written
// killed this process with SIGBUS 16 times on 22-23 Oct.
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, normalize, basename } from 'node:path';
import { config } from '@ranch/config';
import { EventStore, parseSince, type FrameReason } from '@ranch/events';
import type { Ping, CountSeries, FrameSeries, TrackSummary } from '@ranch/contracts';
import { connectBus } from '@ranch/bus';
import { collect, bufferNewestPaths, bufferNameMs, bridgeMetrics, type Status } from './collect.ts';
import { jpegFromFile, firstReadableJpeg } from './jpeg.ts';
import { getTaxonomy, getTaxonomyVersionId, validateTaxonomy, canonical, loadTaxonomyFile, REPO_TAXONOMY_FILE, type Taxonomy } from '@ranch/taxonomy';
import { activateFromStore, applyRow, differsFromRepo, TAXONOMY_TOPIC, type TaxonomyMessage } from '@ranch/taxonomy/store';

const PORT = Number(process.env.RANCH_STATUS_PORT ?? 5091);
const HOST = process.env.RANCH_STATUS_HOST ?? '127.0.0.1';
const BASELINE_DIR = process.env.RANCH_BASELINE_DIR ?? '/usr/local/ranch/app/evals/baseline';
const LABELS_DIR = process.env.RANCH_LABELS_DIR ?? '/usr/local/ranch/app/evals/golden';
const APP_DIR = process.env.RANCH_APP_DIR ?? process.cwd();
const REF_FRAMES = process.env.RANCH_REFERENCE_FRAMES ?? 'evals/baseline/2026-10-20';   // frames dataset dir, relative to APP_DIR
const REF_LABELS = process.env.RANCH_REFERENCE_LABELS ?? 'labels-ranch-claude-revised-vlad-v1';
const STATUS_ENV = process.env.RANCH_STATUS_ENV ?? `${process.env.HOME ?? '/Users/ranch'}/.config/ranch/status.env`;
const exec = promisify(execFile);
/** Write token for the editor (docs/TAXONOMY-UI.md §6): KEY=VALUE file on the mini, never in the repo. */
const writeToken = (() => { try { const m = /^RANCH_STATUS_WRITE_TOKEN=(\S+)/m.exec(readFileSync(STATUS_ENV, 'utf8')); return m?.[1] ?? null; } catch { return null; } })();
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'status', msg, ...extra }) + '\n');
const sendJpeg = (res: ServerResponse, buf: Buffer, headers: Record<string, string>) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(buf.length), ...headers }); res.end(buf); };

const store = new EventStore(config.dbPath);
activateFromStore(store, log);
const repoTaxonomy = loadTaxonomyFile(REPO_TAXONOMY_FILE);
const bus = await connectBus('status');
const mqttStatus = new Map<string, Record<string, unknown>>();
const sse = new Set<ServerResponse>();
const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

await bus.subscribe('ranch/#', (topic, payload) => {
  if (topic.startsWith('ranch/status/') && payload && typeof payload === 'object') mqttStatus.set(topic.slice('ranch/status/'.length), payload as Record<string, unknown>);
  if (topic === TAXONOMY_TOPIC) { const m = payload as TaxonomyMessage; if (m && typeof m.version_id === 'number' && m.version_id !== getTaxonomyVersionId()) { const row = store.taxonomyVersion(m.version_id); if (row) { applyRow(row, log); cache = undefined; } } }
  for (const res of sse) send(res, 'mqtt', { topic, payload });
});

let cache: { at: number; value: Promise<Status> } | undefined;
const status = (): Promise<Status> => {
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), value: collect(store, mqttStatus) };
  return cache.value;
};

setInterval(async () => {
  if (sse.size === 0) return;
  try { const s = await status(); for (const res of sse) send(res, 'status', s); } catch (e) { log('status failed', { error: String(e) }); }
}, 15_000);
setInterval(() => { for (const res of sse) res.write(': keep-alive\n\n'); }, 20_000);

// ---- taxonomy editor support ------------------------------------------------------------------------------------
const readBody = (req: import('node:http').IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 2e6) reject(new Error('body too large')); }); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
/** Bucket spec for the series endpoints: 1m, 5m, 15m, 1h (seconds, min 60). */
const parseBucket = (spec: string): number => { const m = /^(\d+)(m|h)$/.exec(spec); if (!m) throw new Error(`bad bucket ${spec}`); const s = Number(m[1]) * (m[2] === 'h' ? 3600 : 60); if (s < 60 || s > 86400) throw new Error(`bad bucket ${spec}`); return s; };
/** Series never reach back more than 7 days (bounded row counts). */
const clampSince = (iso: string): string => { const min = Date.now() - 7 * 86400e3; return Date.parse(iso) < min ? new Date(min).toISOString() : iso; };
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const authorized = (req: import('node:http').IncomingMessage): string | null => !writeToken ? 'no write token configured on the mini (~/.config/ranch/status.env)' : req.headers['x-ranch-token'] !== writeToken ? 'bad or missing x-ranch-token' : null;

interface ScoreSummary { horse_recall: number; horse_ci: { lo: number; hi: number } | null; horse_ap: number; horse_precision: number; fppf_all: number; count_exact: number; day_recall: number | null; night_recall: number | null; classes: Record<string, { gold: number; precision: number; recall: number }> }
const detectorModel = () => String(mqttStatus.get('detector')?.model ?? 'yolo11n');
const detectorFamily = () => String(mqttStatus.get('detector')?.family ?? 'coco');
/** Score a taxonomy against the reference datasets with the stored prediction files (no model runs). */
async function scoreTaxonomy(t: Taxonomy): Promise<{ model: string; frames_dataset: string; labels_dataset: string; summary: ScoreSummary; ms: number; raw: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'ranch-tax-'));
  try {
    const taxFile = join(dir, 'taxonomy.json'); writeFileSync(taxFile, JSON.stringify(t));
    const framesDir = join(APP_DIR, REF_FRAMES); const model = detectorModel();
    const preds = join(framesDir, `predictions.${model}.jsonl`);
    if (!existsSync(preds)) throw new Error(`no predictions for ${model} in ${REF_FRAMES}`);
    const out = join(dir, 'result.json'); const t0 = Date.now();
    await exec(process.execPath, ['--no-warnings=ExperimentalWarning', join(APP_DIR, 'apps/detector/src/bench.ts'), '--frames', join(framesDir, 'frames.jsonl'), '--labels', join(LABELS_DIR, `${REF_LABELS}.jsonl`), '--predictions', preds, '--taxonomy', detectorFamily(), '--threshold', '0.05', '--min-label-conf', '0.5', '--tag', 'taxonomy-ui', '--out', out],
      { cwd: APP_DIR, env: { ...process.env, RANCH_TAXONOMY_FILE: taxFile }, timeout: 60_000, maxBuffer: 16e6 });
    const r = JSON.parse(readFileSync(out, 'utf8')) as { frames: { dataset: string | null }; results: { score: { slices: Record<string, { classes: Record<string, { gold: number; precision: number; recall: number; ap: number }>; fppf_all: number; horse_count: { exact: number }; horse_recall_ci: { lo: number; hi: number } | null }> } }[] };
    const sl = r.results[0]!.score.slices; const all = sl.all!; const h = all.classes.horse;
    const summary: ScoreSummary = { horse_recall: h?.recall ?? 0, horse_ci: all.horse_recall_ci, horse_ap: h?.ap ?? 0, horse_precision: h?.precision ?? 0, fppf_all: all.fppf_all, count_exact: all.horse_count.exact,
      day_recall: sl['period:day']?.classes.horse?.recall ?? null, night_recall: sl['period:night']?.classes.horse?.recall ?? null,
      classes: Object.fromEntries(Object.entries(all.classes).map(([k, v]) => [k, { gold: v.gold, precision: v.precision, recall: v.recall }])) };
    return { model, frames_dataset: r.frames.dataset ?? REF_FRAMES, labels_dataset: REF_LABELS, summary, ms: Date.now() - t0, raw: r };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** EVALUATION.md §6 relative gate: no class loses recall or precision, FPPF(all) does not rise. */
function gate(active: ScoreSummary, draft: ScoreSummary): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []; const eps = 1e-9;
  for (const [c, a] of Object.entries(active.classes)) { if (a.gold === 0) continue; const d = draft.classes[c]; if (!d) { reasons.push(`${c}: no longer scored`); continue; } if (d.recall < a.recall - eps) reasons.push(`${c} recall ${a.recall.toFixed(2)}→${d.recall.toFixed(2)}`); if (d.precision < a.precision - eps) reasons.push(`${c} precision ${a.precision.toFixed(2)}→${d.precision.toFixed(2)}`); }
  if (draft.fppf_all > active.fppf_all + eps) reasons.push(`FPPF(all) ${active.fppf_all.toFixed(2)}→${draft.fppf_all.toFixed(2)}`);
  return { pass: reasons.length === 0, reasons };
}
let activeScore: { version: number; value: Promise<Awaited<ReturnType<typeof scoreTaxonomy>>> } | undefined;
const scoreActive = () => { const v = getTaxonomyVersionId() ?? 0; if (!activeScore || activeScore.version !== v) activeScore = { version: v, value: scoreTaxonomy(getTaxonomy()) }; return activeScore.value; };
const scoreSummaryOf = (row: { score_json: string | null }): ScoreSummary | null => { try { return row.score_json ? (JSON.parse(row.score_json) as { draft: ScoreSummary }).draft : null; } catch { return null; } };
function taxonomyMeta() {
  const row = store.activeTaxonomy()!;
  return { active: { id: row.id, created: row.created, author: row.author, note: row.note, gate: row.gate, parent_id: row.parent_id }, matches_repo: !differsFromRepo(repoTaxonomy, row), detector_model: detectorModel(), detector_family: detectorFamily(),
    reference: { frames: REF_FRAMES, labels: REF_LABELS }, write_enabled: !!writeToken, versions: store.taxonomyVersions().map((v) => ({ ...v, score_json: undefined, score_summary: scoreSummaryOf(v) })), taxonomy: getTaxonomy() };
}
async function applyTaxonomy(t: Taxonomy, author: string, note: string, score: unknown | null, parent: number | null): Promise<{ id: number }> {
  const inUse = store.labelsInUse().map((l) => l.label); const expressible = new Set<string>();
  for (const map of Object.values(t.mappings)) for (const m of Object.values(map)) expressible.add(m.class === 'person' ? 'person' : m.subclass);
  const orphans = inUse.filter((l) => !expressible.has(l));
  if (orphans.length) throw new Error(`stored detections use labels no mapping produces any more: ${orphans.join(', ')} (add a mapping or keep the subclass)`);
  const g = score && typeof score === 'object' && 'gate' in score ? (score as { gate: { pass: boolean } }).gate.pass ? 'pass' : 'fail' : null;
  const id = store.insertTaxonomyVersion({ author, note, json: canonical(t), parent_id: parent, score_json: score ? JSON.stringify(score) : null, gate: g });
  applyRow(store.taxonomyVersion(id)!, log);
  await bus.publish(TAXONOMY_TOPIC, { version_id: id, created: new Date().toISOString(), author } satisfies TaxonomyMessage, { retain: true });
  cache = undefined;
  return { id };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/api/taxonomy' && req.method === 'GET') {
      json(res, 200, taxonomyMeta()); return;
    } else if (url.pathname === '/api/taxonomy/versions') {
      json(res, 200, store.taxonomyVersions(200).map((v) => ({ ...v, score_json: undefined, score_summary: scoreSummaryOf(v) }))); return;
    } else if (/^\/api\/taxonomy\/versions\/\d+$/.test(url.pathname)) {
      const row = store.taxonomyVersion(Number(url.pathname.split('/').pop())); if (!row) { json(res, 404, { error: 'no such version' }); return; }
      json(res, 200, { ...row, json: undefined, taxonomy: JSON.parse(row.json), score: row.score_json ? JSON.parse(row.score_json) : null }); return;
    } else if (url.pathname.startsWith('/api/taxonomy/') && req.method === 'POST') {
      const body = await readBody(req) as { taxonomy?: unknown; note?: string; score?: unknown; id?: number };
      const action = url.pathname.slice('/api/taxonomy/'.length);
      if (action === 'validate') { const v = validateTaxonomy(body.taxonomy); json(res, v.ok ? 200 : 400, v.ok ? { ok: true } : { errors: v.errors }); return; }
      if (action === 'score') {
        const v = validateTaxonomy(body.taxonomy); if (!v.ok) { json(res, 400, { errors: v.errors }); return; }
        const [a, d] = await Promise.all([scoreActive(), scoreTaxonomy(v.taxonomy)]);
        json(res, 200, { model: d.model, frames_dataset: d.frames_dataset, labels_dataset: d.labels_dataset, active_version: getTaxonomyVersionId(), active: a.summary, draft: d.summary, gate: gate(a.summary, d.summary), ms: d.ms, draft_taxonomy: v.taxonomy }); return;
      }
      const denied = authorized(req); if (denied) { json(res, writeToken ? 403 : 503, { error: denied }); return; }
      const author = `ui:${req.socket.remoteAddress ?? '?'}`;
      if (action === 'apply') {
        const v = validateTaxonomy(body.taxonomy); if (!v.ok) { json(res, 400, { errors: v.errors }); return; }
        const r = await applyTaxonomy(v.taxonomy, author, String(body.note ?? ''), body.score ?? null, getTaxonomyVersionId());
        log('taxonomy applied from ui', { id: r.id, author, note: body.note ?? '' }); json(res, 200, { ok: true, ...r }); return;
      }
      if (action === 'revert') {
        const row = store.taxonomyVersion(Number(body.id)); if (!row) { json(res, 404, { error: 'no such version' }); return; }
        const r = await applyTaxonomy(JSON.parse(row.json) as Taxonomy, author, `revert to v${row.id}: ${body.note ?? ''}`, row.score_json ? JSON.parse(row.score_json) : null, getTaxonomyVersionId());
        json(res, 200, { ok: true, ...r }); return;
      }
      json(res, 404, { error: 'unknown action' }); return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(await status()));
    } else if (url.pathname === '/api/ping') {
      json(res, 200, { ok: true, ts: new Date().toISOString(), pid: process.pid, rss_mb: Math.round(process.memoryUsage().rss / 1048576), taxonomy_version: getTaxonomyVersionId(), api: 1 } satisfies Ping); return;
    } else if (url.pathname === '/api/bridge') {
      try { json(res, 200, await bridgeMetrics()); } catch (e) { json(res, 503, { error: 'bridge_unreachable', detail: String(e) }); } return;
    } else if (url.pathname === '/api/counts/series' || url.pathname === '/api/frames/series') {
      const p = url.searchParams; const bucketS = parseBucket(p.get('bucket') ?? '5m');
      const since = clampSince(parseSince(p.get('since') ?? '1h'));
      const base = { since, bucketS, ...(p.get('until') ? { until: p.get('until')! } : {}), ...(p.get('camera') ? { camera: p.get('camera')! } : {}) };
      const out = url.pathname === '/api/counts/series'
        ? store.cameraCountSeries({ ...base, ...(p.get('label') ? { label: p.get('label')! } : {}) }) satisfies CountSeries
        : store.frameSeries(base) satisfies FrameSeries;
      json(res, 200, out); return;
    } else if (url.pathname === '/api/tracks') {
      const p = url.searchParams;
      const rows = store.trackSummaries({ since: clampSince(parseSince(p.get('since') ?? '1h')), ...(p.get('camera') ? { camera: p.get('camera')! } : {}), ...(p.get('label') ? { label: p.get('label')! } : {}), moving: p.get('moving') === '1', ...(p.get('limit') ? { limit: Number(p.get('limit')) } : {}) })
        .map((r) => ({ ...r, img: `/api/frame/${r.frame_id}` })) satisfies TrackSummary[];
      json(res, 200, rows); return;
    } else if (/^\/api\/frames\/\d+$/.test(url.pathname)) {
      const f = store.frameWithBurst(Number(url.pathname.split('/').pop()));
      if (!f) { json(res, 404, { error: 'no such frame' }); return; }
      json(res, 200, f); return;
    } else if (url.pathname === '/api/frames') {
      const p = url.searchParams;
      const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
      const since = p.get('since') ? parseSince(p.get('since')!) : undefined;
      const rows = store.framesWithDetections({
        ...(p.get('camera') ? { camera: p.get('camera')! } : {}), ...(since ? { since } : {}), ...(p.get('until') ? { until: p.get('until')! } : {}),
        ...(p.get('label') ? { label: p.get('label')! } : {}), ...(num('min_conf') !== undefined ? { minConf: num('min_conf')! } : {}),
        ...(p.get('reason') ? { reason: p.get('reason') as FrameReason } : {}), withDetections: p.get('with_detections') === '1', moving: p.get('moving') === '1',
        ...(num('limit') !== undefined ? { limit: num('limit')! } : {}), ...(num('before') !== undefined ? { before: num('before')! } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rows));
    } else if (url.pathname === '/api/baseline') {
      const sets = existsSync(BASELINE_DIR) ? readdirSync(BASELINE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(BASELINE_DIR, d, 'manifest.json'))).sort().reverse() : [];
      const labelSets = existsSync(LABELS_DIR) ? readdirSync(LABELS_DIR).filter((f) => /^labels-.*\.jsonl$/.test(f)).map((f) => 'labels:' + f.replace(/\.jsonl$/, '')) : [];
      const out = sets.map((d) => { const m = JSON.parse(readFileSync(join(BASELINE_DIR, d, 'manifest.json'), 'utf8')) as { n: number; models: Record<string, unknown> }; return { date: d, n: m.n, models: [...labelSets, ...Object.keys(m.models)] }; });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(out));
    } else if (/^\/api\/baseline\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
      const date = url.pathname.split('/').pop()!; const model = url.searchParams.get('model') ?? ''; const minConf = Number(url.searchParams.get('min_conf') ?? 0.25);
      const dir = join(BASELINE_DIR, date);
      const framesFile = join(dir, 'frames.jsonl'); const predFile = join(dir, `predictions.${model}.jsonl`);
      if (!existsSync(framesFile)) { res.writeHead(404); res.end('no such set'); return; }
      const frames = readFileSync(framesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { frame_id: number; path: string; camera: string; ts: string; period: string; reason: string });
      const preds = new Map<string, { label: string; confidence: number; x: number; y: number; w: number; h: number }[]>();
      if (model.startsWith('labels:')) {
        // a labels dataset (evals/golden/<id>.jsonl): boxes carry kind/posture; shown with the label text
        const lf = join(LABELS_DIR, `${model.slice('labels:'.length)}.jsonl`);
        if (existsSync(lf)) for (const l of readFileSync(lf, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { path: string; boxes: { label: string; kind?: string; posture?: string; x: number; y: number; w: number; h: number }[] }; preds.set(r.path, r.boxes.map((b) => ({ label: `${b.label === 'person' || (b.kind && b.kind !== b.label && !b.posture) ? b.label + '/' : ''}${b.kind ?? b.label}${b.posture ? '/' + b.posture : ''}`.replace(/^(\w+)\/\1$/, '$1'), confidence: 1, x: b.x, y: b.y, w: b.w, h: b.h }))); }
      } else if (model && existsSync(predFile)) for (const l of readFileSync(predFile, 'utf8').split('\n').filter(Boolean)) { const p = JSON.parse(l) as { path: string; detections: { label: string; confidence: number; x: number; y: number; w: number; h: number }[] }; preds.set(p.path, p.detections.filter((d) => d.confidence >= minConf)); }
      const camera = url.searchParams.get('camera');
      const rows = frames.filter((f) => !camera || f.camera === camera).map((f) => ({ id: f.frame_id, camera: f.camera, ts: f.ts, reason: f.reason, period: f.period, change: null, baseline: { date, file: f.path.slice(dir.length + 1) }, img: `/api/baseline-frame/${date}/${f.path.split('/').slice(-2).join('/')}`, detections: (preds.get(f.path) ?? []).map((d) => ({ ...d, model })) }));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rows));
    } else if (url.pathname.startsWith('/api/baseline-frame/')) {
      const rel = normalize(decodeURIComponent(url.pathname.slice('/api/baseline-frame/'.length)));
      const path = join('/usr/local/ranch/media/baseline', rel);
      if (rel.includes('..') || !existsSync(path)) { res.writeHead(404); res.end('no frame'); return; }
      const w = Number(url.searchParams.get('w') ?? 0);
      sendJpeg(res, await jpegFromFile(path, w), { 'cache-control': 'max-age=3600' });
    } else if (/^\/api\/buffer\/[a-z0-9_]+$/.test(url.pathname)) {
      const cam = url.pathname.split('/')[3]!; const paths = bufferNewestPaths(cam, 2);
      if (!paths.length) { res.writeHead(404); res.end('no buffered frame'); return; }
      const r = await firstReadableJpeg(paths, Number(url.searchParams.get('w') ?? 0));
      if (!r) { json(res, 503, { error: 'frame_not_ready' }); return; }
      sendJpeg(res, r.buf, { 'cache-control': 'no-store', 'x-frame-ts': new Date(bufferNameMs(basename(r.path))).toISOString() });
    } else if (/^\/api\/live\/[a-z0-9_]+\/(index\.m3u8|init(-\d+)?\.mp4|seg(\d+-)?\d{6}\.m4s)$/.test(url.pathname)) {
      // The recorder's HLS files (docs/WEB-DASHBOARD.md): plain file reads, complete files only (ffmpeg writes them to a
      // temp name and renames). The playlist carries x-live-age-s so the player and tests can read staleness.
      const [, , , cam, file] = url.pathname.split('/');
      const path = join(config.liveDir, cam!, file!);
      let st; try { st = statSync(path); } catch { res.writeHead(404); res.end('no live file'); return; }
      const headers: Record<string, string> = { 'content-length': String(st.size) };
      if (file === 'index.m3u8') { headers['content-type'] = 'application/vnd.apple.mpegurl'; headers['cache-control'] = 'no-store'; headers['x-live-age-s'] = String(Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000))); }
      else { headers['content-type'] = 'video/mp4'; headers['cache-control'] = file!.startsWith('init') ? 'no-store' : 'max-age=60'; }
      res.writeHead(200, headers);
      createReadStream(path).on('error', () => res.destroy()).pipe(res);
    } else if (url.pathname.startsWith('/api/frame/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/frame/'.length));
      const f = /^\d+$/.test(key) ? store.frameById(Number(key)) : store.lastFrame(key);
      if (!f || !existsSync(f.path)) { res.writeHead(404); res.end('no frame'); return; }
      sendJpeg(res, await jpegFromFile(f.path, Number(url.searchParams.get('w') ?? 0)), { 'cache-control': 'no-store', 'x-frame-ts': f.ts, 'x-frame-id': String(f.id) });
    } else if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      try { send(res, 'status', await status()); } catch { /* next tick */ }
    } else { res.writeHead(404); res.end('not found'); }
  } catch (e) {
    log('request failed', { path: url.pathname, error: String(e) });
    if (!res.headersSent) json(res, url.pathname.startsWith('/api/taxonomy/') || /^\/api\/(counts|frames|tracks)/.test(url.pathname) ? 400 : 500, { error: e instanceof Error ? e.message : String(e) }); else res.end();
  }
});
server.listen(PORT, HOST, () => log('listening', { host: HOST, port: PORT, db: config.dbPath }));

const shutdown = async () => { server.close(); for (const r of sse) r.end(); await bus.close(); store.close(); process.exit(0); };
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
