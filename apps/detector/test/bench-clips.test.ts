import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// bench.ts over a clip frames set: video predictions rows (clip_id + pts_s, timings) join the nearest golden frame,
// the golden clip format's per-clip rows feed the motion_source slice, the bootstrap unit is the clip and the
// throughput table comes from the timings.
test('bench.ts scores video predictions against a clip frames set with clip-level blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-clips-'));
  const box = { label: 'horse', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const frames = [
    {
      frame_id: 1000,
      clip_id: 1,
      frame_idx: 0,
      t_s: 0,
      path: 'c1-0.jpg',
      camera: 'cam',
      period: 'day',
      width: 2560,
      height: 1440,
      burst_id: 1,
      seq: 0,
    },
    {
      frame_id: 1001,
      clip_id: 1,
      frame_idx: 1,
      t_s: 1,
      path: 'c1-1.jpg',
      camera: 'cam',
      period: 'day',
      width: 2560,
      height: 1440,
      burst_id: 1,
      seq: 1,
    },
    {
      frame_id: 2000,
      clip_id: 2,
      frame_idx: 0,
      t_s: 0,
      path: 'c2-0.jpg',
      camera: 'cam',
      period: 'night',
      width: 2560,
      height: 1440,
      burst_id: 2,
      seq: 0,
    },
  ];
  const labels = [
    { path: 'c1-0.jpg', boxes: [{ ...box, kind: 'horse', posture: 'standing', id: 'a1' }] },
    { path: 'c1-1.jpg', boxes: [{ ...box, kind: 'horse', posture: 'standing', id: 'a1' }] },
    { path: 'c2-0.jpg', boxes: [] },
    { clip_id: 1, objects: [{ id: 'a1', kind: 'horse', moved: true }], motion_source: 'animal' },
    { clip_id: 2, objects: [], motion_source: 'insect' },
  ];
  // a 2 fps video run: frames at 0, 0.5, 1.0 s on clip 1 (0.5 s lands between two golden frames and is dropped in
  // favour of the nearer ones), one frame on clip 2 firing a horse on an empty clip
  const preds = [
    {
      clip_id: 1,
      pts_s: 0.0,
      frame_no: 0,
      stride: 2,
      decode_ms: 2,
      ms: 20,
      model: 'yolo-e2e',
      detections: [{ ...box, confidence: 0.9 }],
    },
    { clip_id: 1, pts_s: 0.5, frame_no: 10, stride: 2, decode_ms: 2, ms: 20, model: 'yolo-e2e', detections: [] },
    {
      clip_id: 1,
      pts_s: 1.02,
      frame_no: 20,
      stride: 2,
      decode_ms: 2,
      ms: 22,
      model: 'yolo-e2e',
      detections: [{ ...box, confidence: 0.8 }],
    },
    {
      clip_id: 2,
      pts_s: 0.0,
      frame_no: 0,
      stride: 2,
      decode_ms: 2,
      ms: 20,
      model: 'yolo-e2e',
      detections: [{ ...box, confidence: 0.7 }],
    },
  ];
  const w = (n: string, rows: unknown[]) =>
    writeFileSync(join(dir, n), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  w('frames.jsonl', frames);
  w('labels.jsonl', labels);
  w('predictions.yolo-e2e.jsonl', preds);
  const out = join(dir, 'result.json');
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '../src/bench.ts'),
      '--frames',
      join(dir, 'frames.jsonl'),
      '--labels',
      join(dir, 'labels.jsonl'),
      '--predictions',
      join(dir, 'predictions.yolo-e2e.jsonl'),
      '--threshold',
      '0.5',
      '--tag',
      'test',
      '--out',
      out,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const r = JSON.parse(readFileSync(out, 'utf8')) as {
    results: {
      model: string;
      stride: number;
      latency: { frames: number; cameras_at_native: Record<string, number> };
      score: {
        bootstrap_unit: string;
        slices: Record<
          string,
          {
            classes: Record<string, { tp: number; gold: number }>;
            clips: {
              recall: number;
              false_alarms: number;
              by_motion_source: Record<string, { clips: number; fired: number }>;
            };
          }
        >;
      };
    }[];
  };
  const row = r.results[0]!;
  assert.equal(row.model, 'yolo-e2e@s2');
  assert.equal(row.stride, 2);
  assert.equal(row.latency.frames, 4);
  assert.equal(row.score.bootstrap_unit, 'clip');
  const all = row.score.slices.all!;
  assert.equal(all.classes.horse!.gold, 2);
  assert.equal(all.classes.horse!.tp, 2); // both golden frames got the nearest decoded frame's boxes
  assert.equal(all.clips.recall, 1);
  assert.equal(all.clips.false_alarms, 1);
  assert.deepEqual(all.clips.by_motion_source, { insect: { clips: 1, fired: 1 } });
});
