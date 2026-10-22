// What Claude is asked to return per frame. Boxes are normalized to the image (0..1, origin top-left).
import { z } from 'zod';
import { getTaxonomy, scoringLabel } from '@ranch/taxonomy';
const T = getTaxonomy();
const en = (xs: readonly string[]) => z.enum(xs as [string, ...string[]]);

export const Box = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1),
});
export const FrameLabel = z.object({
  scene: z.string().describe('One sentence: what this camera looks at and the conditions.'),
  lighting: en(T.scene.lighting),
  // Insects and spiders (including on the lens) are deliberately not animals: never boxed, never counted.
  animals: z.array(z.object({
    kind: en(T.classes.animal.subclasses),
    posture: en(T.classes.animal.attribute?.values ?? ['unknown']),
    box: Box,
    confidence: z.number().min(0).max(1).describe('How sure you are this is an animal of this kind.'),
  })),
  people: z.array(z.object({
    // friendly = a resident or regular, recognized by face or look (set by the human labeler, or by a future
    // recognition tier); mailman = postal or courier worker, by uniform or vehicle; unknown otherwise.
    kind: en(T.classes.person.subclasses),
    look: z.string().describe('Short description of clothing and build, for later recognition. Empty if unclear.'),
    box: Box,
    confidence: z.number().min(0).max(1),
  })),
  vehicles: z.array(z.object({
    kind: en(T.classes.vehicle.subclasses),
    box: Box,
    confidence: z.number().min(0).max(1),
  })),
  gate: z.object({ visible: z.boolean(), state: en(T.scene.gate) }),
  trough: z.object({ visible: z.boolean(), level: en(T.scene.trough) }),
  notes: z.string().describe('Anything a horse owner would want flagged, or empty.'),
});
export type FrameLabel = z.infer<typeof FrameLabel>;

/** Flatten to the benchmark's box list in a model family's label space (docs/TAXONOMY.md, SCORING_MAP): for COCO,
 *  donkey → horse; delivery_vehicle, tractor, atv, trailer → truck; every person kind → person. The kind is kept. */
export function toBoxes(l: FrameLabel, family = 'coco'): { label: string; x: number; y: number; w: number; h: number; posture?: string; kind?: string; look?: string }[] {
  return [
    ...l.animals.map((a) => ({ label: scoringLabel(family, 'animal', a.kind), kind: a.kind, posture: a.posture, ...a.box })),
    ...l.people.map((p) => ({ label: scoringLabel(family, 'person', p.kind), kind: p.kind, look: p.look, ...p.box })),
    ...l.vehicles.map((v) => ({ label: scoringLabel(family, 'vehicle', v.kind), kind: v.kind, ...v.box })),
  ];
}
