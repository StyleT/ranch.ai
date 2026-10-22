import { z } from 'zod';
import { FramesResponse, FrameHead, BaselineSet, BaselineFrame, type FrameHead as FrameHeadT, type FrameWithDetections } from '@ranch/contracts';
import type { DetectionsPage, FrameCard, Box } from '@/lib/types';
import { daemonJson, cached } from './daemon.ts';

export const DetectionsQuery = z.object({
  set: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), model: z.string().max(120).optional(),
  camera: z.string().max(64).optional(), since: z.string().regex(/^(\d+[smhd]|\d{4}-.+)$/).default('1h'), until: z.string().optional(),
  label: z.string().max(64).optional(), min_conf: z.coerce.number().min(0).max(1).optional(), reason: z.enum(['floor', 'change', 'seed', 'manual']).optional(),
  with_detections: z.enum(['0', '1']).optional(), moving: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(200).default(60), before: z.coerce.number().int().optional(),
});
export type DetectionsQuery = z.infer<typeof DetectionsQuery>;

const box = (d: FrameWithDetections['detections'][number]): Box => ({ label: d.label, raw_label: d.raw_label, confidence: d.confidence, x: d.x, y: d.y, w: d.w, h: d.h, seen: d.seen, dx: d.dx, dy: d.dy, gold: false });
const cardOf = (f: FrameWithDetections): FrameCard => ({ id: f.id, camera: f.camera, ts: f.ts, reason: f.reason, change: f.change, img: `/api/ui/frame/${f.id}`, width: f.width, height: f.height, detections: f.detections.map(box), burst: [] });
export const frameCardFromHead = (f: FrameHeadT): FrameCard => ({ ...cardOf(f), burst: f.burst.map(cardOf) });

export async function getDetections(q: DetectionsQuery): Promise<DetectionsPage> {
  if (q.set) {
    const p = new URLSearchParams({ model: q.model ?? '', min_conf: String(q.min_conf ?? 0.25) }); if (q.camera) p.set('camera', q.camera);
    const rows = await cached(`baseline:${q.set}:${p}`, 60_000, () => daemonJson(BaselineFrame.array(), `/api/baseline/${q.set}?${p}`, { timeoutMs: 10_000 }));
    let items: FrameCard[] = rows.map((r) => ({
      id: r.id, camera: r.camera, ts: r.ts, reason: r.reason, change: null, period: r.period, img: `/api/ui/baseline-frame/${r.img.replace('/api/baseline-frame/', '')}`, width: null, height: null,
      detections: r.detections.map((d) => ({ label: d.label, raw_label: null, confidence: d.confidence, x: d.x, y: d.y, w: d.w, h: d.h, seen: null, dx: null, dy: null, gold: d.model.startsWith('labels:') })), burst: [],
    }));
    if (q.label) items = items.filter((f) => f.detections.some((d) => d.label.split('/')[0] === q.label || d.label === q.label));
    if (q.with_detections === '1') items = items.filter((f) => f.detections.length > 0);
    return { source: 'baseline', items, next_before: null, total: items.length };
  }
  const p = new URLSearchParams({ since: q.since, limit: String(q.limit) });
  for (const k of ['camera', 'until', 'label', 'reason'] as const) if (q[k]) p.set(k, q[k]!);
  if (q.min_conf !== undefined) p.set('min_conf', String(q.min_conf));
  if (q.with_detections === '1') p.set('with_detections', '1'); if (q.moving === '1') p.set('moving', '1'); if (q.before) p.set('before', String(q.before));
  const rows = await daemonJson(FramesResponse, `/api/frames?${p}`, { timeoutMs: 10_000 });
  const items = rows.map(frameCardFromHead);
  return { source: 'live', items, next_before: rows.length >= q.limit ? (rows[rows.length - 1]?.id ?? null) : null, total: null };
}
export const getDetection = async (id: number): Promise<FrameCard> => frameCardFromHead(await daemonJson(FrameHead, `/api/frames/${id}`));
export const getBaselineSets = () => cached('baseline-sets', 60_000, () => daemonJson(BaselineSet.array(), '/api/baseline'));
