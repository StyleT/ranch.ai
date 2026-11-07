import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRejections, scoreVlm, type VlmRow } from '../score.ts';
import type { Escalation } from '../build.ts';

const esc = (
  id: string,
  type: Escalation['type'],
  gold: Escalation['gold'],
  extra: Partial<Escalation> = {},
): Escalation => ({
  id,
  type,
  clip_id: 1,
  frame_id: 1000,
  frame_idx: 0,
  path: 'f0',
  prev_path: null,
  crop: `crops/${id}.jpg`,
  prev_crop: null,
  box: { x: 0, y: 0, w: 0.5, h: 0.5 },
  context: { camera: 'cam', period: 'day', label: 'horse', confidence: 0.4 },
  gold,
  ...extra,
});
const ans = (
  id: string,
  type: string,
  present: boolean,
  kind = 'horse',
  posture: string | null = null,
  gate: string | null = null,
): VlmRow => ({
  id,
  type,
  model: 'm',
  prompt: 'v1',
  prompt_sha: 'abc',
  answer: { present, kind, posture, gate, trough: null, confidence: 0.9 },
  error: null,
  ms: 100,
  rss_mb: 2000,
});

test('scoreVlm: verification shares, attribute confusions, scene accuracy, reliability', () => {
  const E = [
    esc('v1', 'verify', { verdict: 'tp', label: 'horse' }),
    esc('v2', 'verify', { verdict: 'tp', label: 'horse' }),
    esc('v3', 'verify', { verdict: 'fp', label: 'horse' }),
    esc('v4', 'verify', { verdict: 'fp', label: 'horse' }),
    esc('a1', 'attributes', { label: 'horse', kind: 'donkey', posture: 'lying_flat' }),
    esc('a2', 'attributes', { label: 'horse', kind: 'horse', posture: 'standing' }),
    esc('s1', 'scene', { gate: 'open' }),
  ];
  const R = [
    ans('v1', 'verify', true),
    ans('v2', 'verify', false), // a kept TP lost
    ans('v3', 'verify', false),
    ans('v4', 'verify', true), // an FP let through
    ans('a1', 'attributes', true, 'horse', 'lying_sternal'), // kind wrong, lying right as a group
    ans('a2', 'attributes', true, 'horse', 'standing'),
    { ...ans('s1', 'scene', true, 'none', null, 'open'), answer: null, error: 'schema' }, // one invalid answer
  ];
  const s = scoreVlm(E, R) as Record<string, unknown>;
  assert.deepEqual(s.verification, {
    tp: 2,
    tp_kept: 1,
    tp_kept_share: 0.5,
    fp: 2,
    fp_rejected: 1,
    fp_rejected_share: 0.5,
  });
  assert.equal((s.kind as { accuracy: number }).accuracy, 0.5);
  assert.deepEqual((s.kind as { confusion: unknown }).confusion, { donkey: { horse: 1 }, horse: { horse: 1 } });
  assert.equal((s.posture as { accuracy: number }).accuracy, 0.5);
  assert.equal((s.posture_lying_vs_upright as { accuracy: number }).accuracy, 1);
  assert.equal((s.gate as { pairs: number }).pairs, 0); // the scene answer was invalid
  assert.ok(Math.abs((s.json_valid_rate as number) - 6 / 7) < 1e-9);
  assert.equal((s.latency as { max_rss_mb: number }).max_rss_mb, 2000);
});

test('applyRejections removes exactly the escalated box the VLM called absent', () => {
  const preds = new Map([
    [
      'f0',
      [
        { label: 'horse', confidence: 0.4, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { label: 'horse', confidence: 0.9, x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
      ],
    ],
  ]);
  const E = [esc('v1', 'verify', { verdict: 'fp', label: 'horse' }, { box: { x: 0.05, y: 0.05, w: 0.3, h: 0.3 } })];
  const after = applyRejections(E, [ans('v1', 'verify', false)], preds);
  assert.equal(after.get('f0')!.length, 1);
  assert.equal(after.get('f0')![0]!.confidence, 0.9);
  assert.equal(applyRejections(E, [ans('v1', 'verify', true)], preds).get('f0')!.length, 2); // present: nothing removed
});

test('build.ts turns golden labels and tier-1 predictions into verify, attributes and scene requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esc-'));
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
    },
  ];
  const labels = [
    {
      path: 'c1-0.jpg',
      boxes: [{ label: 'horse', kind: 'donkey', posture: 'standing', id: 'a1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      gate: { visible: true, state: 'open' },
      trough: { visible: false, level: 'unknown' },
    },
    {
      path: 'c1-1.jpg',
      boxes: [{ label: 'horse', kind: 'donkey', posture: 'walking', id: 'a1', x: 0.12, y: 0.1, w: 0.2, h: 0.2 }],
      gate: { visible: false, state: 'unknown' },
      trough: { visible: false, level: 'unknown' },
    },
    { clip_id: 1, objects: [{ id: 'a1', kind: 'donkey', moved: true }], motion_source: 'animal' },
  ];
  const preds = [
    {
      path: 'c1-0.jpg',
      model: 'yolo',
      detections: [
        { label: 'horse', confidence: 0.4, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { label: 'horse', confidence: 0.3, x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
      ],
    },
    {
      path: 'c1-1.jpg',
      model: 'yolo',
      detections: [{ label: 'horse', confidence: 0.9, x: 0.12, y: 0.1, w: 0.2, h: 0.2 }],
    },
  ];
  const w = (n: string, rows: unknown[]) =>
    writeFileSync(join(dir, n), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  w('frames.jsonl', frames);
  w('labels.jsonl', labels);
  w('predictions.yolo.jsonl', preds);
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '../build.ts'),
      '--frames',
      join(dir, 'frames.jsonl'),
      '--labels',
      join(dir, 'labels.jsonl'),
      '--predictions',
      join(dir, 'predictions.yolo.jsonl'),
      '--out',
      join(dir, 'esc'),
      '--no-crops',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const full = JSON.parse(out.trim().split('\n').pop()!) as {
    out: string;
    n: number;
    verify: number;
    attributes: number;
    scene: number;
  };
  const summary = { n: full.n, verify: full.verify, attributes: full.attributes, scene: full.scene };
  const rows = readFileSync(join(dir, 'esc', 'escalations.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Escalation);
  // frame 0: two in-band horses (0.4 tp, 0.3 fp) -> 2 verify; the matched gold donkey -> 1 attributes; gate visible -> 1 scene.
  // frame 1: the 0.9 box is above the band -> no verify; its matched gold -> 1 attributes with the previous frame's crop.
  assert.deepEqual(summary, { n: 5, verify: 2, attributes: 2, scene: 1 });
  const verdicts = rows.filter((r) => r.type === 'verify').map((r) => [r.context.confidence, r.gold.verdict]);
  assert.deepEqual(verdicts.sort(), [
    [0.3, 'fp'],
    [0.4, 'tp'],
  ]);
  const attr1 = rows.find((r) => r.type === 'attributes' && r.frame_idx === 1)!;
  assert.equal(attr1.gold.kind, 'donkey');
  assert.equal(attr1.gold.posture, 'walking');
  assert.equal(attr1.prev_path, 'c1-0.jpg');
  assert.ok(attr1.prev_crop);
  const scene = rows.find((r) => r.type === 'scene')!;
  assert.deepEqual(scene.gold, { gate: 'open' });
  const ds = JSON.parse(readFileSync(join(dir, 'esc', 'dataset.json'), 'utf8')) as {
    id: string;
    kind: string;
    n: number;
  };
  assert.equal(ds.kind, 'escalations');
  assert.equal(ds.n, 5);
  assert.ok(ds.id.startsWith('escalations-'));
});
