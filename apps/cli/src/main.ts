#!/usr/bin/env node
// `ranch` command. Reads the SQLite store directly; talks to the bridge only for `cameras`.
import { parseArgs } from 'node:util';
import { config } from '@ranch/config';
import { EventStore, parseSince, type RanchEvent } from '@ranch/events';

const USAGE = `usage: ranch <command> [options]

  events   [--since 24h] [--camera NAME] [--type TYPE] [--verdict none|true_positive|false_positive] [--limit N] [--json]
  frames   [--since 1h]  [--camera NAME] [--limit N] [--json]
  counts   [--since 24h] [--camera NAME] [--label horse] [--json]
  verdict  <event-id|prefix> true|false
  cameras  [--json]                      cameras known to the Wyze bridge
  status                                 db path, schema version, row counts
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: 'string' }, camera: { type: 'string' }, type: { type: 'string' }, label: { type: 'string' },
    verdict: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, ...rest] = positionals;
if (opts.help || !cmd) { process.stdout.write(USAGE); process.exit(cmd ? 0 : 1); }

const limit = opts.limit ? Number(opts.limit) : undefined;
const fmtTs = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: config.timezone }).replace(' ', 'T');
const table = (input: object[]) => {
  const rows = input as Record<string, unknown>[];
  if (rows.length === 0) return '(none)\n';
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals: unknown[]) => vals.map((v, i) => String(v ?? '').padEnd(w[i]!)).join('  ').trimEnd() + '\n';
  return line(cols) + line(w.map((n) => '-'.repeat(n))) + rows.map((r) => line(cols.map((c) => r[c]))).join('');
};
const out = (rows: object[]) => process.stdout.write(opts.json ? JSON.stringify(rows, null, 2) + '\n' : table(rows));

switch (cmd) {
  case 'events': {
    const store = new EventStore(config.dbPath);
    const since = parseSince(opts.since ?? '24h');
    const q = { since, limit: limit ?? 200, ...(opts.camera ? { camera: opts.camera } : {}), ...(opts.type ? { type: opts.type } : {}) };
    const events = store.events(opts.verdict ? { ...q, verdict: opts.verdict as never } : q);
    out(opts.json ? events : events.map((e: RanchEvent) => ({
      id: e.id.slice(0, 8), ts: fmtTs(e.ts), camera: e.camera, type: e.type, conf: e.confidence.toFixed(2),
      tier: e.tier_decided, verdict: e.verdict ?? '', cost: e.cost_usd ? `$${e.cost_usd.toFixed(4)}` : '',
    })));
    break;
  }
  case 'frames': {
    const store = new EventStore(config.dbPath);
    const frames = store.frames({ since: parseSince(opts.since ?? '1h'), limit: limit ?? 100, ...(opts.camera ? { camera: opts.camera } : {}) });
    out(opts.json ? frames : frames.map((f) => ({ id: f.id, ts: fmtTs(f.ts), camera: f.camera, reason: f.reason, change: f.change?.toFixed(3) ?? '', size: `${f.width ?? '?'}x${f.height ?? '?'}`, path: f.path })));
    break;
  }
  case 'counts': {
    const store = new EventStore(config.dbPath);
    const rows = store.cameraCounts({ since: parseSince(opts.since ?? '24h'), limit: limit ?? 500, ...(opts.camera ? { camera: opts.camera } : {}), ...(opts.label ? { label: opts.label } : {}) });
    out(opts.json ? rows : rows.map((r) => ({ ts: fmtTs(r.ts), camera: r.camera, label: r.label, count: r.count, model: r.model })));
    break;
  }
  case 'verdict': {
    const [id, v] = rest;
    if (!id || !v || !['true', 'false'].includes(v)) { process.stderr.write('usage: ranch verdict <id> true|false\n'); process.exit(2); }
    const store = new EventStore(config.dbPath);
    const e = store.event(id);
    if (!e) { process.stderr.write(`no event matching ${id}\n`); process.exit(1); }
    store.setVerdict(e.id, v === 'true' ? 'true_positive' : 'false_positive');
    process.stdout.write(`${e.id} ${e.type}@${e.camera} → ${v === 'true' ? 'true_positive' : 'false_positive'}\n`);
    break;
  }
  case 'cameras': {
    const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { process.stderr.write(`bridge ${res.status}\n`); process.exit(1); }
    const cams = (await res.json()) as Record<string, unknown>[];
    out(opts.json ? cams : cams.map((c) => ({ name: c.name, model: c.model_name, fw: c.fw_version, ip: c.ip, state: c.state, last_seen: c.last_seen ? fmtTs(String(c.last_seen)) : '' })));
    break;
  }
  case 'status': {
    const store = new EventStore(config.dbPath);
    const n = (t: string) => (store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    process.stdout.write(`db       ${config.dbPath}\nschema   v${store.schemaVersion}\nframes   ${n('frames')}\ndetections ${n('detections')}\nevents   ${n('events')}\ncounts   ${n('camera_counts')}\n`);
    break;
  }
  default:
    process.stderr.write(`unknown command "${cmd}"\n${USAGE}`); process.exit(2);
}
