// ByteTrack over per-frame detections, as ultralytics implements it (trackers/byte_tracker.py, bytetrack.yaml):
// a constant-velocity Kalman filter in xyah per track, two-stage association (high-confidence boxes first against
// tracked and lost tracks with the score fused into the IoU distance, then the still-unmatched tracked tracks against
// low-confidence boxes by IoU alone), unconfirmed tracks matched once more, lost tracks kept for `trackBuffer` frames.
// Pure: no timers, no I/O. Shared by the eval gate (evals/clips/track.ts) and, if the gate wins, by the detector.
//
// Boxes are the detector's normalized {x, y, w, h} (origin top-left). The tracker works in those units; the Kalman
// noise scales with the box height, so the units cancel.
import type { Pred } from './score.ts';

export interface ByteTrackOpts {
  trackHighThresh: number;
  trackLowThresh: number;
  newTrackThresh: number;
  trackBuffer: number;
  matchThresh: number;
  fuseScore: boolean;
}
/** ultralytics' bytetrack.yaml defaults. */
export const BYTETRACK_DEFAULTS: ByteTrackOpts = {
  trackHighThresh: 0.25,
  trackLowThresh: 0.1,
  newTrackThresh: 0.25,
  trackBuffer: 30,
  matchThresh: 0.8,
  fuseScore: true,
};

export interface TrackedBox extends Pred {
  track_id: number;
}
export interface TrackSummary {
  track_id: number;
  label: string; // the majority label of its boxes
  frames: number; // frames with a matched box
  max_streak: number; // longest run of consecutive matched frames
  first_frame: number;
  last_frame: number;
}

// ---- linear algebra on small dense matrices (row-major number[][]) ----
type Mat = number[][];
const eye = (n: number): Mat =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const mul = (a: Mat, b: Mat): Mat => a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));
const tr = (a: Mat): Mat => a[0]!.map((_, j) => a.map((row) => row[j]!));
const add = (a: Mat, b: Mat): Mat => a.map((row, i) => row.map((v, j) => v + b[i]![j]!));
const sub = (a: Mat, b: Mat): Mat => a.map((row, i) => row.map((v, j) => v - b[i]![j]!));
const diag = (d: number[]): Mat => d.map((v, i) => d.map((_, j) => (i === j ? v : 0)));
/** Gauss-Jordan inverse; the matrices here are 4x4 covariances, always well conditioned. */
function inv(a: Mat): Mat {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...eye(n)[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) {
        p = r;
      }
    }
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]!;
    for (let j = 0; j < 2 * n; j++) {
      m[c]![j]! /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r !== c) {
        const f = m[r]![c]!;
        for (let j = 0; j < 2 * n; j++) {
          m[r]![j]! -= f * m[c]![j]!;
        }
      }
    }
  }
  return m.map((row) => row.slice(n));
}

// ---- Kalman filter in xyah (centre x, centre y, aspect ratio, height) with constant velocity ----
const WP = 1 / 20, // std_weight_position
  WV = 1 / 160; // std_weight_velocity
const F: Mat = eye(8).map((row, i) => row.map((v, j) => (j === i + 4 ? 1 : v))); // dt = 1
const H: Mat = Array.from({ length: 4 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0)));

interface KState {
  mean: number[]; // 8
  cov: Mat; // 8x8
}
function kfInitiate(m: number[]): KState {
  const h = m[3]!;
  const std = [2 * WP * h, 2 * WP * h, 1e-2, 2 * WP * h, 10 * WV * h, 10 * WV * h, 1e-5, 10 * WV * h];
  return { mean: [...m, 0, 0, 0, 0], cov: diag(std.map((s) => s * s)) };
}
function kfPredict(s: KState): KState {
  const h = s.mean[3]!;
  const std = [WP * h, WP * h, 1e-2, WP * h, WV * h, WV * h, 1e-5, WV * h];
  const mean = F.map((row) => row.reduce((acc, v, k) => acc + v * s.mean[k]!, 0));
  const cov = add(mul(mul(F, s.cov), tr(F)), diag(std.map((v) => v * v)));
  return { mean, cov };
}
function kfProject(s: KState): { mean: number[]; cov: Mat } {
  const h = s.mean[3]!;
  const std = [WP * h, WP * h, 1e-1, WP * h];
  return { mean: s.mean.slice(0, 4), cov: add(mul(mul(H, s.cov), tr(H)), diag(std.map((v) => v * v))) };
}
function kfUpdate(s: KState, m: number[]): KState {
  const p = kfProject(s);
  const K = mul(mul(s.cov, tr(H)), inv(p.cov)); // 8x4
  const innov = m.map((v, i) => v - p.mean[i]!);
  const mean = s.mean.map((v, i) => v + K[i]!.reduce((acc, k, j) => acc + k * innov[j]!, 0));
  const cov = sub(s.cov, mul(mul(K, p.cov), tr(K)));
  return { mean, cov };
}

const toXyah = (b: Pred): number[] => [b.x + b.w / 2, b.y + b.h / 2, b.w / Math.max(b.h, 1e-9), b.h];
const fromXyah = (m: number[]): { x: number; y: number; w: number; h: number } => {
  const h = m[3]!,
    w = m[2]! * h;
  return { x: m[0]! - w / 2, y: m[1]! - h / 2, w, h };
};
const iou = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number => {
  const x1 = Math.max(a.x, b.x),
    y1 = Math.max(a.y, b.y),
    x2 = Math.min(a.x + a.w, b.x + b.w),
    y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
};

/** Minimum-cost assignment (Hungarian, O(n^3)) on a rectangular cost matrix; pairs with cost > thresh are not matches.
 *  Returns matched (row, col) pairs and the unmatched rows and columns. */
export function linearAssignment(
  cost: Mat,
  thresh: number,
  cols = cost[0]?.length ?? 0, // the column count when there are no rows (no tracks yet, every box unmatched)
): { matches: [number, number][]; uRows: number[]; uCols: number[] } {
  const R = cost.length,
    C = R ? cost[0]!.length : cols;
  if (!R || !C) {
    return { matches: [], uRows: [...Array(R).keys()], uCols: [...Array(C).keys()] };
  }
  const n = Math.max(R, C);
  const BIG = 1e6;
  const a: Mat = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i < R && j < C ? (cost[i]![j]! > thresh ? BIG : cost[i]![j]!) : BIG)),
  );
  // Hungarian algorithm (Kuhn-Munkres), potentials formulation
  const u = new Array<number>(n + 1).fill(0),
    v = new Array<number>(n + 1).fill(0),
    p = new Array<number>(n + 1).fill(0),
    way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = a[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const matches: [number, number][] = [];
  const mRows = new Set<number>(),
    mCols = new Set<number>();
  for (let j = 1; j <= n; j++) {
    const i = p[j]! - 1,
      c = j - 1;
    if (i < R && c < C && cost[i]![c]! <= thresh) {
      matches.push([i, c]);
      mRows.add(i);
      mCols.add(c);
    }
  }
  return {
    matches,
    uRows: [...Array(R).keys()].filter((i) => !mRows.has(i)),
    uCols: [...Array(C).keys()].filter((j) => !mCols.has(j)),
  };
}

type State = 'tracked' | 'lost' | 'removed';
interface STrack {
  id: number;
  kf: KState;
  state: State;
  activated: boolean;
  frame: number; // last frame with a matched box
  start: number;
  streak: number;
  maxStreak: number;
  frames: number;
  labels: Map<string, number>;
  score: number;
}

export class ByteTracker {
  private tracked: STrack[] = [];
  private lost: STrack[] = [];
  private removed: STrack[] = [];
  private frameId = 0;
  private nextId = 1;
  readonly opts: ByteTrackOpts;
  constructor(opts: Partial<ByteTrackOpts> = {}) {
    this.opts = { ...BYTETRACK_DEFAULTS, ...opts };
  }

  private predictedBox(t: STrack) {
    return fromXyah(t.kf.mean);
  }
  private dists(tracks: STrack[], dets: Pred[], fuse: boolean): Mat {
    return tracks.map((t) => {
      const pb = this.predictedBox(t);
      return dets.map((d) => {
        const dist = 1 - iou(pb, d);
        return fuse ? 1 - (1 - dist) * d.confidence : dist;
      });
    });
  }
  private matchInto(t: STrack, d: Pred, frame: number, reactivate: boolean) {
    t.kf = kfUpdate(t.kf, toXyah(d));
    t.state = 'tracked';
    t.activated = true;
    t.streak = reactivate || t.frame !== frame - 1 ? 1 : t.streak + 1;
    t.maxStreak = Math.max(t.maxStreak, t.streak);
    t.frame = frame;
    t.frames++;
    t.labels.set(d.label, (t.labels.get(d.label) ?? 0) + 1);
    t.score = d.confidence;
  }

  /** One frame of detections (every box the runner emitted at its floor); returns the boxes the tracker assigned to a
   *  track this frame, each with its track id. Frames must arrive in order. */
  update(dets: Pred[]): TrackedBox[] {
    this.frameId++;
    const o = this.opts;
    const valid = dets.filter((d) => d.w > 0 && d.h > 0);
    const high = valid.filter((d) => d.confidence >= o.trackHighThresh);
    const low = valid.filter((d) => d.confidence > o.trackLowThresh && d.confidence < o.trackHighThresh);
    const out: TrackedBox[] = [];
    const assign = (t: STrack, d: Pred, reactivate: boolean) => {
      this.matchInto(t, d, this.frameId, reactivate);
      out.push({ ...d, track_id: t.id });
    };

    const unconfirmed = this.tracked.filter((t) => !t.activated);
    const confirmed = this.tracked.filter((t) => t.activated);
    const pool = [...confirmed, ...this.lost];
    for (const t of pool) {
      if (t.state !== 'tracked') {
        t.kf.mean[7] = 0; // ultralytics: a lost track predicts with its height velocity zeroed
      }
      t.kf = kfPredict(t.kf);
    }
    // stage 1: high-confidence boxes against tracked + lost
    const d1 = this.dists(pool, high, o.fuseScore);
    const m1 = linearAssignment(d1, o.matchThresh, high.length);
    const activated: STrack[] = [],
      refind: STrack[] = [],
      lostNow: STrack[] = [];
    for (const [ti, di] of m1.matches) {
      const t = pool[ti]!;
      const wasLost = t.state === 'lost';
      assign(t, high[di]!, wasLost);
      (wasLost ? refind : activated).push(t);
    }
    // stage 2: the still-tracked unmatched tracks against low-confidence boxes, IoU only, 0.5
    const rTracked = m1.uRows.map((i) => pool[i]!).filter((t) => t.state === 'tracked');
    const m2 = linearAssignment(this.dists(rTracked, low, false), 0.5, low.length);
    for (const [ti, di] of m2.matches) {
      assign(rTracked[ti]!, low[di]!, false);
      activated.push(rTracked[ti]!);
    }
    for (const i of m2.uRows) {
      const t = rTracked[i]!;
      t.state = 'lost';
      lostNow.push(t);
    }
    // unconfirmed tracks (seen once, not yet activated) against the remaining high boxes, 0.7
    const remainingHigh = m1.uCols.map((j) => high[j]!);
    for (const t of unconfirmed) {
      t.kf = kfPredict(t.kf);
    }
    const m3 = linearAssignment(this.dists(unconfirmed, remainingHigh, o.fuseScore), 0.7, remainingHigh.length);
    for (const [ti, di] of m3.matches) {
      assign(unconfirmed[ti]!, remainingHigh[di]!, false);
      activated.push(unconfirmed[ti]!);
    }
    for (const i of m3.uRows) {
      unconfirmed[i]!.state = 'removed';
      this.removed.push(unconfirmed[i]!);
    }
    // new tracks from the high boxes nobody took
    for (const j of m3.uCols) {
      const d = remainingHigh[j]!;
      if (d.confidence < o.newTrackThresh) {
        continue;
      }
      const t: STrack = {
        id: this.nextId++,
        kf: kfInitiate(toXyah(d)),
        state: 'tracked',
        activated: this.frameId === 1, // ultralytics: a first-frame track is activated at once
        frame: this.frameId,
        start: this.frameId,
        streak: 1,
        maxStreak: 1,
        frames: 1,
        labels: new Map([[d.label, 1]]),
        score: d.confidence,
      };
      activated.push(t);
      out.push({ ...d, track_id: t.id });
    }
    // lost for too long -> removed
    for (const t of this.lost) {
      if (this.frameId - t.frame > o.trackBuffer) {
        t.state = 'removed';
        this.removed.push(t);
      }
    }
    this.tracked = [...activated, ...refind].filter((t, i, arr) => t.state === 'tracked' && arr.indexOf(t) === i);
    this.lost = [...this.lost.filter((t) => t.state === 'lost' && !refind.includes(t)), ...lostNow].filter(
      (t, i, arr) => arr.indexOf(t) === i,
    );
    return out;
  }

  /** Every track ever started, with its length and longest consecutive run. */
  summary(): TrackSummary[] {
    const all = [...this.tracked, ...this.lost, ...this.removed];
    return all
      .sort((u, v) => u.id - v.id)
      .map((t) => ({
        track_id: t.id,
        label: [...t.labels.entries()].sort((u, v) => v[1] - u[1])[0]![0],
        frames: t.frames,
        max_streak: t.maxStreak,
        first_frame: t.start,
        last_frame: t.frame,
      }));
  }
}

/** The persistence gate over one clip: run ByteTrack over its frames in order and keep only the boxes of tracks whose
 *  longest consecutive run reached `minStreak`, on every frame they were observed. Returns the gated frames (same
 *  order, boxes with track_id and track_len) and the tracks' summaries. */
export function gateClip<T extends { detections: Pred[] }>(
  frames: T[],
  minStreak: number,
  opts: Partial<ByteTrackOpts> = {},
): {
  frames: (T & { detections: (TrackedBox & { track_len: number })[] })[];
  tracks: TrackSummary[];
  qualified: Set<number>;
} {
  const tracker = new ByteTracker(opts);
  const perFrame = frames.map((f) => tracker.update(f.detections));
  const tracks = tracker.summary();
  const byId = new Map(tracks.map((t) => [t.track_id, t]));
  const qualified = new Set(tracks.filter((t) => t.max_streak >= minStreak).map((t) => t.track_id));
  return {
    frames: frames.map((f, i) => ({
      ...f,
      detections: perFrame[i]!.filter((b) => qualified.has(b.track_id)).map((b) => ({
        ...b,
        track_len: byId.get(b.track_id)!.frames,
      })),
    })),
    tracks,
    qualified,
  };
}
