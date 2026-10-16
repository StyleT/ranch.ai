// What Claude is asked to return per frame. Boxes are normalized to the image (0..1, origin top-left).
import { z } from 'zod';

export const Box = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1),
});
export const FrameLabel = z.object({
  scene: z.string().describe('One sentence: what this camera looks at and the conditions.'),
  lighting: z.enum(['day', 'dusk', 'night_ir']),
  animals: z.array(z.object({
    kind: z.enum(['horse', 'donkey', 'dog', 'cat', 'deer', 'coyote', 'bird', 'other']),
    posture: z.enum(['standing', 'grazing', 'walking', 'lying_sternal', 'lying_flat', 'unknown']),
    box: Box,
    confidence: z.number().min(0).max(1).describe('How sure you are this is an animal of this kind.'),
  })),
  people: z.array(z.object({ box: Box, confidence: z.number().min(0).max(1) })),
  vehicles: z.array(z.object({ kind: z.enum(['car', 'truck', 'tractor', 'atv', 'trailer', 'other']), box: Box, confidence: z.number().min(0).max(1) })),
  gate: z.object({ visible: z.boolean(), state: z.enum(['open', 'closed', 'unknown']) }),
  trough: z.object({ visible: z.boolean(), level: z.enum(['full', 'half', 'low', 'empty', 'unknown']) }),
  notes: z.string().describe('Anything a horse owner would want flagged, or empty.'),
});
export type FrameLabel = z.infer<typeof FrameLabel>;

/** Flatten to the detector benchmark's box list. Donkeys map to horse for the COCO-class comparison. */
export function toBoxes(l: FrameLabel): { label: string; x: number; y: number; w: number; h: number; posture?: string; kind?: string }[] {
  return [
    ...l.animals.map((a) => ({ label: a.kind === 'donkey' ? 'horse' : a.kind, kind: a.kind, posture: a.posture, ...a.box })),
    ...l.people.map((p) => ({ label: 'person', ...p.box })),
    ...l.vehicles.map((v) => ({ label: v.kind === 'tractor' || v.kind === 'atv' || v.kind === 'trailer' ? 'truck' : v.kind, kind: v.kind, ...v.box })),
  ];
}
