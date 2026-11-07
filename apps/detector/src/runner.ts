// Wraps the native Core ML runner (apps/detector/swift/main.swift) as a long-lived child process speaking
// JSON lines. One request in flight at a time keeps the ANE latency numbers honest and the memory bounded.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';

export interface RunnerDetection {
  label: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RunnerResult {
  id: string;
  path: string;
  ms: number;
  rss_mb: number;
  detections: RunnerDetection[];
}
export interface RunnerInfo {
  model: string;
  compute: string;
  threshold: number;
  inputs: string[];
  outputs: string[];
  rss_mb: number;
  compiled_ms?: number;
  decoder?: string;
  scale?: string;
  input?: { name: string; w: number; h: number };
}
/** One processed frame of a video run (the runner's --video / {"video"} lines). */
export interface RunnerVideoFrame {
  frame_no: number;
  pts_s: number;
  decode_ms: number;
  ms: number;
  width: number;
  height: number;
  detections: RunnerDetection[];
}
export interface RunnerVideoDone {
  frames: number;
  processed: number;
  stride: number;
  wall_s: number;
  fps_wall: number;
  nominal_fps: number;
  decode_ms: { p50: number; p95: number };
  ms: { p50: number; p95: number };
  rss_mb: number;
  error: string | null;
}

export class Runner {
  private proc: ChildProcessByStdio<Writable, Readable, null>;
  private pending = new Map<
    string,
    {
      resolve: (r: RunnerResult) => void;
      reject: (e: Error) => void;
      /** Video runs collect their frame lines here until the runner's done line. */
      frames?: RunnerVideoFrame[];
      video?: { resolve: (r: { frames: RunnerVideoFrame[]; done: RunnerVideoDone }) => void };
    }
  >();
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  readonly info: Promise<RunnerInfo>;

  constructor(opts: {
    bin?: string;
    model: string;
    compute?: 'all' | 'ane' | 'gpu' | 'cpu';
    threshold?: number;
    labels?: string;
  }) {
    const args = [
      '--model',
      opts.model,
      '--compute',
      opts.compute ?? 'ane',
      '--threshold',
      String(opts.threshold ?? 0.25),
    ];
    // Raw-output models (RF-DETR) ship a class table next to the package: <name>.labels.json
    const labels = opts.labels ?? opts.model.replace(/\.(mlpackage|mlmodelc)$/, '') + '.labels.json';
    if (existsSync(labels)) {
      args.push('--labels', labels);
    }
    this.proc = spawn(opts.bin ?? '/usr/local/ranch/bin/detector', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let compiledMs: number | undefined;
    this.info = new Promise<RunnerInfo>((resolve, reject) => {
      const rl = createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.compiled) {
          compiledMs = Number(msg.ms);
          return;
        }
        if (msg.ready) {
          resolve({
            ...(msg as unknown as RunnerInfo),
            ...(compiledMs !== undefined ? { compiled_ms: compiledMs } : {}),
          });
          return;
        }
        if (msg.error && !msg.id) {
          reject(new Error(String(msg.error)));
          return;
        }
        const p = this.pending.get(String(msg.id));
        if (!p) {
          return;
        }
        if (p.video && p.frames) {
          if (msg.done) {
            this.pending.delete(String(msg.id));
            p.video.resolve({ frames: p.frames, done: msg as unknown as RunnerVideoDone });
          } else if (msg.error && msg.frame_no === undefined) {
            this.pending.delete(String(msg.id));
            p.reject(new Error(String(msg.error)));
          } else if (msg.detections) {
            p.frames.push(msg as unknown as RunnerVideoFrame);
          }
          return;
        }
        this.pending.delete(String(msg.id));
        if (msg.error) {
          p.reject(new Error(String(msg.error)));
        } else {
          p.resolve(msg as unknown as RunnerResult);
        }
      });
      this.proc.on('exit', (code) => {
        const err = new Error(`detector exited with code ${code}`);
        reject(err);
        for (const p of this.pending.values()) {
          p.reject(err);
        }
        this.pending.clear();
      });
    });
  }

  /** Detect on one image path. Calls are serialized. */
  detect(path: string): Promise<RunnerResult> {
    const run = () =>
      new Promise<RunnerResult>((resolve, reject) => {
        const id = String(++this.seq);
        this.pending.set(id, { resolve, reject });
        this.proc.stdin.write(JSON.stringify({ id, path }) + '\n');
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Run a video file through the runner's --video path at a stride: every processed frame's detections and the
   *  summary line. Serialized with detect() calls. */
  video(path: string, stride = 1): Promise<{ frames: RunnerVideoFrame[]; done: RunnerVideoDone }> {
    const run = () =>
      new Promise<{ frames: RunnerVideoFrame[]; done: RunnerVideoDone }>((resolve, reject) => {
        const id = String(++this.seq);
        this.pending.set(id, { resolve: () => undefined, reject, frames: [], video: { resolve } });
        this.proc.stdin.write(JSON.stringify({ id, video: path, stride }) + '\n');
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }
  close(): void {
    this.proc.stdin.end();
    this.proc.kill('SIGTERM');
  }
}
