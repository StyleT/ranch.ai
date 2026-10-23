// A truncated JPEG (what a reader sees while ffmpeg is still writing without -atomic_writing) must become a rejected
// promise, never a native crash, and the fallback must pick the previous complete file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { jpegFromFile, firstReadableJpeg } from '../src/jpeg.ts';

const dir = mkdtempSync(join(tmpdir(), 'ranch-jpeg-'));
const full = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 40, g: 120, b: 80 } } }).jpeg().toBuffer();
const good = join(dir, '2026-10-23T13-00-00Z.jpg'); writeFileSync(good, full);
const half = join(dir, '2026-10-23T13-00-02Z.jpg'); writeFileSync(half, full.subarray(0, Math.floor(full.length / 2)));

test('resizes a complete file from a Buffer', async () => {
  const out = await jpegFromFile(good, 160);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 160); assert.equal(meta.format, 'jpeg');
});
test('returns the file verbatim when no width is asked', async () => {
  assert.deepEqual(await jpegFromFile(good, 0), full);
});
test('a truncated file rejects instead of crashing', async () => {
  await assert.rejects(jpegFromFile(half, 160));
});
test('falls back to the previous complete frame', async () => {
  const r = await firstReadableJpeg([half, good], 160);
  assert.equal(r?.path, good);
  assert.equal(await firstReadableJpeg([half, join(dir, 'missing.jpg')], 160), null);
  rmSync(dir, { recursive: true, force: true });
});
