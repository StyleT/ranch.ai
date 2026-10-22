import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrations } from './migrations.ts';

export type FrameReason = 'floor' | 'change' | 'seed' | 'manual';
export interface Frame {
  id: number; ts: string; camera: string; path: string;
  width: number | null; height: number | null; bytes: number | null; change: number | null; reason: FrameReason;
  kept: number | null; burst_id: number | null; seq: number | null;
}
export interface NewFrame {
  ts: string; camera: string; path: string; reason: FrameReason; burst_id?: number; seq?: number;
  width?: number; height?: number; bytes?: number; change?: number;
}
export interface Detection {
  id: number; frame_id: number; model: string; label: string; confidence: number; track: number | null; seen: number | null; dx: number | null; dy: number | null;
  x: number; y: number; w: number; h: number; latency_ms: number | null; raw_label: string | null;
}
export interface NewDetection {
  model: string; label: string; confidence: number; x: number; y: number; w: number; h: number; latency_ms?: number; raw_label?: string;
}
export type Verdict = 'true_positive' | 'false_positive';
export interface RanchEvent {
  id: string; ts: string; camera: string; type: string; confidence: number; tier_decided: 1 | 2 | 3;
  evidence_frames: string[]; crop_paths: string[]; vlm_text: string | null; claude_text: string | null;
  cost_usd: number; latency_ms: number | null; trace_id: string | null; verdict: Verdict | null;
  verdict_at: string | null; payload: Record<string, unknown>; created_at: string;
}
export interface NewEvent {
  ts: string; camera: string; type: string; confidence: number; tier_decided: 1 | 2 | 3;
  evidence_frames?: string[]; crop_paths?: string[]; vlm_text?: string; claude_text?: string;
  cost_usd?: number; latency_ms?: number; trace_id?: string; payload?: Record<string, unknown>; id?: string;
}
export interface EventQuery { since?: string; until?: string; camera?: string; type?: string; limit?: number; verdict?: Verdict | 'none' }

/** "24h", "90m", "7d", "30s" or an ISO timestamp → UTC ISO string. */
export function parseSince(spec: string, now: Date = new Date()): string {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(spec.trim());
  if (!m) {
    const d = new Date(spec);
    if (Number.isNaN(d.getTime())) throw new Error(`cannot parse time spec "${spec}" (want 24h, 90m, 7d or ISO-8601)`);
    return d.toISOString();
  }
  const n = Number(m[1]);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(now.getTime() - n * unit).toISOString();
}

export class EventStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    // Several daemons open the database at the same moment after a provision. BEGIN IMMEDIATE takes the write lock
    // before the version check, so only one of them applies a migration and the others see it as applied.
    for (const m of migrations) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const done = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.version);
        if (done) { this.db.exec('COMMIT'); continue; }
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations').get() as { v: number }).v;
  }

  close(): void { this.db.close(); }

  // ---- frames
  insertFrame(f: NewFrame): number {
    const r = this.db.prepare(
      'INSERT INTO frames (ts, camera, path, width, height, bytes, change, reason, burst_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(f.ts, f.camera, f.path, f.width ?? null, f.height ?? null, f.bytes ?? null, f.change ?? null, f.reason, f.burst_id ?? null, f.seq ?? null);
    return Number(r.lastInsertRowid);
  }
  /** Turn a kept frame into a burst head (burst_id = its own id, seq 0). */
  markBurstHead(id: number): void { this.db.prepare('UPDATE frames SET burst_id = ?, seq = 0 WHERE id = ?').run(id, id); }
  burstMembers(burstId: number): Frame[] {
    return this.db.prepare('SELECT * FROM frames WHERE burst_id = ? ORDER BY seq').all(burstId) as unknown as Frame[];
  }
  updateTrack(detectionId: number, t: { track: number; seen: number; dx: number; dy: number }): void {
    this.db.prepare('UPDATE detections SET track = ?, seen = ?, dx = ?, dy = ? WHERE id = ?').run(t.track, t.seen, t.dx, t.dy, detectionId);
  }

  frames(q: { since?: string; until?: string; camera?: string; limit?: number } = {}): Frame[] {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (q.since) { where.push('ts >= ?'); args.push(q.since); }
    if (q.until) { where.push('ts < ?'); args.push(q.until); }
    if (q.camera) { where.push('camera = ?'); args.push(q.camera); }
    const sql = `SELECT * FROM frames ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(q.limit ?? 100);
    return this.db.prepare(sql).all(...args) as unknown as Frame[];
  }

  /**
   * Retention policy (docs/FRAMES-AND-BASELINE.md §1). Evaluates frames older than `olderThanMs` that have not
   * been evaluated yet (kept IS NULL), per camera in time order. A frame is kept when its reason is not `floor`
   * (the scene changed), or its detections differ from the previous kept frame's (a new label, or a same-label
   * box with IoU below `iou`). A floor frame whose picture and detections match the previous kept frame is
   * deleted: nothing is kept only because time passed. The file paths are returned for the caller to unlink.
   */
  applyRetention(opts: { olderThanMs: number; iou?: number; now?: Date } = { olderThanMs: 3600e3 }): { kept: number; deleted: number; paths: string[] } {
    const iouMin = opts.iou ?? 0.8;
    const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.olderThanMs).toISOString();
    const cams = (this.db.prepare('SELECT DISTINCT camera FROM frames WHERE kept IS NULL AND ts < ?').all(cutoff) as { camera: string }[]).map((r) => r.camera);
    const detsOf = this.db.prepare('SELECT label, x, y, w, h FROM detections WHERE frame_id = ?');
    const markKept = this.db.prepare('UPDATE frames SET kept = 1 WHERE id = ?');
    const del = this.db.prepare('DELETE FROM frames WHERE id = ?');
    let kept = 0; const paths: string[] = [];
    for (const camera of cams) {
      const prevKept = this.db.prepare('SELECT id FROM frames WHERE camera = ? AND kept = 1 AND ts < ? ORDER BY ts DESC LIMIT 1').get(camera, cutoff) as { id: number } | undefined;
      let prevDets = prevKept ? (detsOf.all(prevKept.id) as unknown as Box[]) : [];
      const rows = this.db.prepare('SELECT id, ts, path, reason, burst_id FROM frames WHERE camera = ? AND kept IS NULL AND ts < ? AND (seq IS NULL OR seq = 0) ORDER BY ts').all(camera, cutoff) as { id: number; ts: string; path: string; reason: string; burst_id: number | null }[];
      const memberPaths = this.db.prepare('SELECT path FROM frames WHERE burst_id = ? AND seq > 0');
      const keepMembers = this.db.prepare('UPDATE frames SET kept = 1 WHERE burst_id = ? AND seq > 0');
      const delMembers = this.db.prepare('DELETE FROM frames WHERE burst_id = ? AND seq > 0');
      this.db.exec('BEGIN');
      try {
        for (const f of rows) {
          const dets = detsOf.all(f.id) as unknown as Box[];
          const keep = f.reason !== 'floor' || detectionsDiffer(prevDets, dets, iouMin);
          if (keep) { markKept.run(f.id); kept++; prevDets = dets; if (f.burst_id) keepMembers.run(f.burst_id); }
          else { if (f.burst_id) { for (const m of memberPaths.all(f.burst_id) as { path: string }[]) paths.push(m.path); delMembers.run(f.burst_id); } del.run(f.id); paths.push(f.path); }
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return { kept, deleted: paths.length, paths };
  }

  /** Delete frames (and their detections) older than `before`; returns the file paths for the caller to unlink. */
  pruneFrames(before: string): string[] {
    const rows = this.db.prepare('SELECT path FROM frames WHERE ts < ?').all(before) as { path: string }[];
    this.db.prepare('DELETE FROM frames WHERE ts < ?').run(before);
    return rows.map((r) => r.path);
  }

  frameById(id: number): Frame | undefined {
    return this.db.prepare('SELECT * FROM frames WHERE id = ?').get(id) as unknown as Frame | undefined;
  }

  /** Frames with their detections for the browser (docs/FRAMES-AND-BASELINE.md §2). Newest first. */
  framesWithDetections(q: { camera?: string; since?: string; until?: string; label?: string; minConf?: number; reason?: FrameReason; withDetections?: boolean; moving?: boolean; limit?: number; before?: number } = {}): (Frame & { detections: Detection[]; burst: (Frame & { detections: Detection[] })[] })[] {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (q.camera) { where.push('f.camera = ?'); args.push(q.camera); }
    if (q.since) { where.push('f.ts >= ?'); args.push(q.since); }
    if (q.until) { where.push('f.ts < ?'); args.push(q.until); }
    if (q.reason) { where.push('f.reason = ?'); args.push(q.reason); }
    if (q.before) { where.push('f.id < ?'); args.push(q.before); }
    where.push('(f.seq IS NULL OR f.seq = 0)'); // burst members ride with their head
    if (q.moving) where.push('EXISTS (SELECT 1 FROM detections d JOIN frames m ON m.id = d.frame_id WHERE (m.id = f.id OR m.burst_id = f.id) AND d.dx IS NOT NULL AND (d.dx*d.dx + d.dy*d.dy) >= 0.0004)'); // anywhere in the burst
    const detCond: string[] = []; const detArgs: SQLInputValue[] = [];
    if (q.label) { detCond.push('d.label = ?'); detArgs.push(q.label); }
    if (q.minConf !== undefined) { detCond.push('d.confidence >= ?'); detArgs.push(q.minConf); }
    if (q.withDetections || detCond.length) {
      where.push(`EXISTS (SELECT 1 FROM detections d WHERE d.frame_id = f.id${detCond.length ? ' AND ' + detCond.join(' AND ') : ''})`);
      args.push(...detArgs);
    }
    const sql = `SELECT f.* FROM frames f ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.id DESC LIMIT ?`;
    args.push(Math.min(q.limit ?? 60, 500));
    const frames = this.db.prepare(sql).all(...args) as unknown as Frame[];
    const dets = this.db.prepare('SELECT * FROM detections WHERE frame_id = ? ORDER BY confidence DESC');
    const members = this.db.prepare('SELECT * FROM frames WHERE burst_id = ? AND seq > 0 ORDER BY seq');
    return frames.map((f) => ({ ...f, detections: dets.all(f.id) as unknown as Detection[], burst: f.burst_id ? (members.all(f.burst_id) as unknown as Frame[]).map((m) => ({ ...m, detections: dets.all(m.id) as unknown as Detection[] })) : [] }));
  }

  /** camera x label counts in a window, for the dashboard. */
  detectionsByCamera(since: string): { camera: string; label: string; n: number; conf: number; raw: Record<string, number> }[] {
    const rows = this.db.prepare(`SELECT f.camera, d.label, COALESCE(d.raw_label, d.label) raw_label, COUNT(*) n, ROUND(AVG(d.confidence), 2) conf FROM detections d JOIN frames f ON f.id = d.frame_id
      WHERE f.ts >= ? GROUP BY f.camera, d.label, raw_label ORDER BY f.camera, n DESC`).all(since) as unknown as { camera: string; label: string; raw_label: string; n: number; conf: number }[];
    const out = new Map<string, { camera: string; label: string; n: number; conf: number; raw: Record<string, number> }>();
    for (const r of rows) {
      const k = `${r.camera}|${r.label}`; const o = out.get(k) ?? { camera: r.camera, label: r.label, n: 0, conf: 0, raw: {} };
      o.conf = +((o.conf * o.n + r.conf * r.n) / (o.n + r.n)).toFixed(2); o.n += r.n; o.raw[r.raw_label] = (o.raw[r.raw_label] ?? 0) + r.n; out.set(k, o);
    }
    return [...out.values()].sort((a, b) => a.camera.localeCompare(b.camera) || b.n - a.n);
  }

  // ---- taxonomy versions (docs/TAXONOMY-UI.md §2) ----
  activeTaxonomy(): TaxonomyVersionRow | undefined {
    return this.db.prepare('SELECT * FROM taxonomy_versions WHERE active = 1 ORDER BY id DESC LIMIT 1').get() as unknown as TaxonomyVersionRow | undefined;
  }
  taxonomyVersion(id: number): TaxonomyVersionRow | undefined {
    return this.db.prepare('SELECT * FROM taxonomy_versions WHERE id = ?').get(id) as unknown as TaxonomyVersionRow | undefined;
  }
  taxonomyVersions(limit = 50): Omit<TaxonomyVersionRow, 'json'>[] {
    return this.db.prepare('SELECT id, created, author, note, parent_id, score_json, gate, active FROM taxonomy_versions ORDER BY id DESC LIMIT ?').all(limit) as unknown as Omit<TaxonomyVersionRow, 'json'>[];
  }
  insertTaxonomyVersion(v: { author: string; note?: string; json: string; parent_id?: number | null; score_json?: string | null; gate?: string | null }): number {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE taxonomy_versions SET active = 0 WHERE active = 1').run();
      const r = this.db.prepare('INSERT INTO taxonomy_versions (created, author, note, json, parent_id, score_json, gate, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(new Date().toISOString(), v.author, v.note ?? null, v.json, v.parent_id ?? null, v.score_json ?? null, v.gate ?? null);
      this.db.exec('COMMIT');
      return Number(r.lastInsertRowid);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /** Labels the taxonomy has stored (raw_label set, i.e. since the filter), to refuse removing a subclass in use.
   *  Pre-taxonomy rows (raw_label NULL) carried raw COCO classes and do not count. */
  labelsInUse(): { label: string; n: number }[] {
    return this.db.prepare('SELECT label, COUNT(*) n FROM detections WHERE raw_label IS NOT NULL GROUP BY label').all() as unknown as { label: string; n: number }[];
  }

  lastFrame(camera: string): Frame | undefined {
    return this.db.prepare('SELECT * FROM frames WHERE camera = ? ORDER BY ts DESC LIMIT 1').get(camera) as unknown as Frame | undefined;
  }

  // ---- detections
  insertDetections(frameId: number, ds: NewDetection[]): number[] {
    const stmt = this.db.prepare(
      'INSERT INTO detections (frame_id, model, label, confidence, x, y, w, h, latency_ms, raw_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const ids: number[] = [];
    this.db.exec('BEGIN');
    try {
      for (const d of ds) ids.push(Number(stmt.run(frameId, d.model, d.label, d.confidence, d.x, d.y, d.w, d.h, d.latency_ms ?? null, d.raw_label ?? null).lastInsertRowid));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return ids;
  }

  detectionsForFrame(frameId: number, model?: string): Detection[] {
    return (model
      ? this.db.prepare('SELECT * FROM detections WHERE frame_id = ? AND model = ? ORDER BY confidence DESC').all(frameId, model)
      : this.db.prepare('SELECT * FROM detections WHERE frame_id = ? ORDER BY confidence DESC').all(frameId)) as unknown as Detection[];
  }

  // ---- events
  insertEvent(e: NewEvent): string {
    const id = e.id ?? randomUUID();
    this.db.prepare(`INSERT INTO events (id, ts, camera, type, confidence, tier_decided, evidence_frames, crop_paths,
        vlm_text, claude_text, cost_usd, latency_ms, trace_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, e.ts, e.camera, e.type, e.confidence, e.tier_decided,
      JSON.stringify(e.evidence_frames ?? []), JSON.stringify(e.crop_paths ?? []),
      e.vlm_text ?? null, e.claude_text ?? null, e.cost_usd ?? 0, e.latency_ms ?? null, e.trace_id ?? null,
      JSON.stringify(e.payload ?? {}),
    );
    return id;
  }

  events(q: EventQuery = {}): RanchEvent[] {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (q.since) { where.push('ts >= ?'); args.push(q.since); }
    if (q.until) { where.push('ts < ?'); args.push(q.until); }
    if (q.camera) { where.push('camera = ?'); args.push(q.camera); }
    if (q.type) { where.push('type = ?'); args.push(q.type); }
    if (q.verdict === 'none') where.push('verdict IS NULL');
    else if (q.verdict) { where.push('verdict = ?'); args.push(q.verdict); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
    args.push(q.limit ?? 200);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToEvent);
  }

  event(id: string): RanchEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as Record<string, unknown> | undefined;
    return r ? rowToEvent(r) : undefined;
  }

  setVerdict(id: string, verdict: Verdict): boolean {
    const r = this.db.prepare('UPDATE events SET verdict = ?, verdict_at = ? WHERE id = ?').run(verdict, new Date().toISOString(), id);
    return r.changes > 0;
  }

  // ---- counts
  upsertCameraCount(c: { ts: string; camera: string; label: string; count: number; model: string }): void {
    this.db.prepare(`INSERT INTO camera_counts (ts, camera, label, count, model) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (ts, camera, label) DO UPDATE SET count = excluded.count, model = excluded.model`).run(c.ts, c.camera, c.label, c.count, c.model);
  }

  cameraCounts(q: { since?: string; camera?: string; label?: string; limit?: number } = {}): { ts: string; camera: string; label: string; count: number; model: string }[] {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (q.since) { where.push('ts >= ?'); args.push(q.since); }
    if (q.camera) { where.push('camera = ?'); args.push(q.camera); }
    if (q.label) { where.push('label = ?'); args.push(q.label); }
    args.push(q.limit ?? 1000);
    return this.db.prepare(`SELECT * FROM camera_counts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`).all(...args) as never;
  }
}

export interface TaxonomyVersionRow { id: number; created: string; author: string; note: string | null; json: string; parent_id: number | null; score_json: string | null; gate: string | null; active: number }

interface Box { label: string; x: number; y: number; w: number; h: number }
function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
/** True when the two detection sets are not the same picture: different labels, or a box that moved. */
export function detectionsDiffer(prev: Box[], cur: Box[], iouMin = 0.8): boolean {
  if (prev.length !== cur.length) return true;
  const used = new Set<number>();
  for (const c of cur) {
    let found = -1;
    for (let i = 0; i < prev.length; i++) { const p = prev[i]!; if (!used.has(i) && p.label === c.label && iou(p, c) >= iouMin) { found = i; break; } }
    if (found < 0) return true;
    used.add(found);
  }
  return false;
}

function rowToEvent(r: Record<string, unknown>): RanchEvent {
  return {
    ...(r as unknown as RanchEvent),
    evidence_frames: JSON.parse(String(r.evidence_frames)),
    crop_paths: JSON.parse(String(r.crop_paths)),
    payload: JSON.parse(String(r.payload)),
  };
}
