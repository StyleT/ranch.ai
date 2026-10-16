import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrations } from './migrations.ts';

export type FrameReason = 'floor' | 'change' | 'seed' | 'manual';
export interface Frame {
  id: number; ts: string; camera: string; path: string;
  width: number | null; height: number | null; bytes: number | null; change: number | null; reason: FrameReason;
}
export interface NewFrame {
  ts: string; camera: string; path: string; reason: FrameReason;
  width?: number; height?: number; bytes?: number; change?: number;
}
export interface Detection {
  id: number; frame_id: number; model: string; label: string; confidence: number;
  x: number; y: number; w: number; h: number; latency_ms: number | null;
}
export interface NewDetection {
  model: string; label: string; confidence: number; x: number; y: number; w: number; h: number; latency_ms?: number;
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
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.db.exec('BEGIN');
      try {
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
      'INSERT INTO frames (ts, camera, path, width, height, bytes, change, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(f.ts, f.camera, f.path, f.width ?? null, f.height ?? null, f.bytes ?? null, f.change ?? null, f.reason);
    return Number(r.lastInsertRowid);
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

  /** Delete frames (and their detections) older than `before`; returns the file paths for the caller to unlink. */
  pruneFrames(before: string): string[] {
    const rows = this.db.prepare('SELECT path FROM frames WHERE ts < ?').all(before) as { path: string }[];
    this.db.prepare('DELETE FROM frames WHERE ts < ?').run(before);
    return rows.map((r) => r.path);
  }

  lastFrame(camera: string): Frame | undefined {
    return this.db.prepare('SELECT * FROM frames WHERE camera = ? ORDER BY ts DESC LIMIT 1').get(camera) as unknown as Frame | undefined;
  }

  // ---- detections
  insertDetections(frameId: number, ds: NewDetection[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO detections (frame_id, model, label, confidence, x, y, w, h, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const d of ds) stmt.run(frameId, d.model, d.label, d.confidence, d.x, d.y, d.w, d.h, d.latency_ms ?? null);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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

function rowToEvent(r: Record<string, unknown>): RanchEvent {
  return {
    ...(r as unknown as RanchEvent),
    evidence_frames: JSON.parse(String(r.evidence_frames)),
    crop_paths: JSON.parse(String(r.crop_paths)),
    payload: JSON.parse(String(r.payload)),
  };
}
