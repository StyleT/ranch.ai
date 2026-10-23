// JPEG delivery without memory-mapping camera-produced files. `sharp(path)` lets libvips mmap its input; when another
// process is still writing that file, touching a page past its current end raises SIGBUS ("FS pagein error") that no
// JavaScript handler can catch. The status daemon died that way 16 times on 22-23 Oct 2026, once per live-view open
// (docs/CAMERA-ARCHITECTURE.md, docs/WEB-DASHBOARD.md). Reading the file into a Buffer first turns a half-written or
// truncated JPEG into an ordinary rejected promise the caller can skip or fall back from.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export const MAX_WIDTH = 4000;

/** The file as a JPEG Buffer, resized to `w` pixels wide when 0 < w < MAX_WIDTH (never enlarged), verbatim otherwise. */
export async function jpegFromFile(path: string, w: number, quality = 82): Promise<Buffer> {
  const buf = await readFile(path);
  if (!(w > 0 && w < MAX_WIDTH)) return buf;
  return sharp(buf).resize({ width: w, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
}

/** First candidate that decodes; `null` when none does (the caller answers 503 `frame_not_ready`). */
export async function firstReadableJpeg(paths: string[], w: number): Promise<{ path: string; buf: Buffer } | null> {
  for (const path of paths) {
    try { return { path, buf: await jpegFromFile(path, w) }; } catch { /* half-written, rotated away, or not a JPEG: try the previous one */ }
  }
  return null;
}
