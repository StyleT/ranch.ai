// Burst extension against synthetic motion: a white square moving right on a grey field. Proves the stop rules
// (still frame ends it, max caps it) without a camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { EventStore } from '@ranch/events';
import { extendBurst, blockMaxDiff } from '../src/main.ts';

const frame = (x: number) => sharp({ create: { width: 640, height: 360, channels: 3, background: '#808080' } })
  .composite([{ input: Buffer.from(`<svg width="640" height="360"><rect x="${x}" y="100" width="120" height="120" fill="white"/></svg>`), top: 0, left: 0 }]).jpeg().toBuffer();
const thumb = (b: Buffer) => sharp(b).resize(128, 72, { fit: 'fill' }).greyscale().raw().toBuffer();
const bus = { published: [] as { topic: string; payload: unknown }[], publish: async (topic: string, payload: unknown) => { bus.published.push({ topic, payload }); }, subscribe: async () => undefined, close: async () => undefined };

test('burst extends while the square moves and stops at the first still frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'burst-')); const store = new EventStore(':memory:');
  const head = await frame(50); const headId = store.insertFrame({ ts: new Date().toISOString(), camera: 'cam', path: join(dir, 'h.jpg'), reason: 'change' });
  const seq = [await frame(110), await frame(170), await frame(170), await frame(230)]; let i = 0; // moves, moves, still, (never reached)
  const r = await extendBurst({ headId, camera: 'cam', dir, headThumb: await thumb(head), grab: async () => seq[i++]!, store, bus: bus as never, gapMs: 1 });
  assert.equal(r.members, 2); assert.equal(r.stopped, 'still');
  assert.equal(store.burstMembers(headId).length, 3);
  assert.ok(bus.published.some((p) => p.topic === 'ranch/bursts/cam'));
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('burst caps at BURST_MAX frames while motion continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'burst-')); const store = new EventStore(':memory:');
  const headId = store.insertFrame({ ts: new Date().toISOString(), camera: 'cam', path: join(dir, 'h.jpg'), reason: 'change' });
  let x = 50; const r = await extendBurst({ headId, camera: 'cam', dir, headThumb: await thumb(await frame(x)), grab: async () => frame((x += 60)), store, bus: bus as never, gapMs: 1 });
  assert.equal(r.members, 3); assert.equal(r.stopped, 'max');
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('block metric sees a small distant object move while the whole-frame mean does not', async () => {
  // a 100x60 px object (a horse at the far fence on a 2560 px frame) moving 60 px: invisible to a whole-frame mean, seen by the block maximum
  const small = (x: number) => sharp({ create: { width: 2560, height: 1440, channels: 3, background: '#606060' } })
    .composite([{ input: Buffer.from(`<svg width="2560" height="1440"><rect x="${x}" y="700" width="100" height="60" fill="white"/></svg>`), top: 0, left: 0 }]).jpeg().toBuffer();
  const a = await thumb(await small(1200)), b = await thumb(await small(1260));
  let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!); const global = sum / a.length / 255;
  assert.ok(global < 0.01, `global ${global}`);
  assert.ok(blockMaxDiff(a, b) >= 0.05, `block ${blockMaxDiff(a, b)}`);
  assert.equal(blockMaxDiff(a, a), 0);
});
