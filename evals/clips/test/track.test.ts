import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('track.ts writes the gated predictions file and the manifest summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'track-'));
  const box = (x: number, label = 'horse', c = 0.9) => ({ label, confidence: c, x, y: 0.3, w: 0.1, h: 0.1 });
  const rows = [];
  for (let f = 0; f < 15; f++) {
    rows.push({
      clip_id: 1,
      camera: 'cam',
      period: 'day',
      pts_s: f / 15,
      frame_no: f,
      stride: 1,
      model: 'm',
      detections: [box(0.1 + f * 0.004), ...(f < 3 ? [box(0.8, 'person', 0.7)] : [])],
    });
  }
  rows.push({
    clip_id: 2,
    camera: 'cam',
    period: 'night',
    pts_s: 0,
    frame_no: 0,
    stride: 1,
    model: 'm',
    detections: [box(0.5, 'dog')],
  });
  writeFileSync(join(dir, 'predictions.m@s1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(
    join(dir, 'clips.jsonl'),
    [
      { clip_id: 1, fps: 15 },
      { clip_id: 2, fps: 20 },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '../track.ts'),
      '--predictions',
      join(dir, 'predictions.m@s1.jsonl'),
      '--min-streak',
      '10',
      '--clips',
      join(dir, 'clips.jsonl'),
    ],
    { encoding: 'utf8' },
  );
  const summary = JSON.parse(out.trim()) as {
    tracks: number;
    qualified: number;
    boxes_kept: Record<string, number>;
    boxes_dropped: Record<string, number>;
    log_delay_s: { min: number; max: number };
  };
  assert.equal(summary.tracks, 3);
  assert.equal(summary.qualified, 1);
  assert.deepEqual(summary.boxes_kept, { horse: 15 });
  assert.deepEqual(summary.boxes_dropped, { person: 3, dog: 1 });
  assert.deepEqual(summary.log_delay_s, { min: 0.5, max: 0.67, mean: 0.58 });
  const gated = readFileSync(join(dir, 'predictions.m@s1+bt10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(
      (l) =>
        JSON.parse(l) as {
          frame_no: number;
          model: string;
          detections: { label: string; track_id: number; track_len: number }[];
        },
    );
  assert.equal(gated.length, 16); // every input frame is present, gated
  assert.equal(gated[0]!.model, 'm+bt10');
  assert.deepEqual(
    gated[0]!.detections.map((d) => [d.label, d.track_len]),
    [['horse', 15]],
  );
  assert.equal(gated[15]!.detections.length, 0);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    models: Record<string, { min_streak: number }>;
  };
  assert.equal(manifest.models['m@s1+bt10']!.min_streak, 10);
});
