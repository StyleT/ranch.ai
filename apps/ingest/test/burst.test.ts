// Burst extension against synthetic motion: a white square moving right on a grey field. Proves the stop rules
// (still frame ends it, max caps it) without a camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { EventStore } from '@ranch/events';
import { extendBurst } from '../src/main.ts';

const frame = (x: number) => sharp({ create: { width: 640, height: 360, channels: 3, background: '#808080' } })
  .composite([{ input: Buffer.from(`<svg width="640" height="360"><rect x="${x}" y="100" width="120" height="120" fill="white"/></svg>`), top: 0, left: 0 }]).jpeg().toBuffer();
const thumb = (b: Buffer) => sharp(b).resize(64, 36, { fit: 'fill' }).greyscale().raw().toBuffer();
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
