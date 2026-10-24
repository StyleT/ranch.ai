// What Claude is asked to return per frame. Boxes are normalized to the image (0..1, origin top-left).
import { z } from 'zod';
import { getTaxonomy, scoringLabel } from '@ranch/taxonomy';
const T = getTaxonomy();
const en = (xs: readonly string[]) => z.enum(xs as [string, ...string[]]);

export const Box = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1),
});
// Insects and spiders (including on the lens) are deliberately not animals: never boxed, never counted.
const AnimalEntry = z.object({
  kind: en(T.classes.animal.subclasses),
  posture: en(T.classes.animal.attribute?.values ?? ['unknown']),
  box: Box,
  confidence: z.number().min(0).max(1).describe('How sure you are this is an animal of this kind.'),
});
const PersonEntry = z.object({
  // friendly = a resident or regular, recognized by face or look (set by the human labeler, or by a future
  // recognition tier); mailman = postal or courier worker, by uniform or vehicle; unknown otherwise.
  kind: en(T.classes.person.subclasses),
  look: z.string().describe('Short description of clothing and build, for later recognition. Empty if unclear.'),
  box: Box,
  confidence: z.number().min(0).max(1),
});
const VehicleEntry = z.object({
  kind: en(T.classes.vehicle.subclasses),
  box: Box,
  confidence: z.number().min(0).max(1),
});
const SceneFields = {
  scene: z.string().describe('One sentence: what this camera looks at and the conditions.'),
  lighting: en(T.scene.lighting),
  gate: z.object({ visible: z.boolean(), state: en(T.scene.gate) }),
  trough: z.object({ visible: z.boolean(), level: en(T.scene.trough) }),
  notes: z.string().describe('Anything a horse owner would want flagged, or empty.'),
};

export const FrameLabel = z.object({
  scene: SceneFields.scene, lighting: SceneFields.lighting,
  animals: z.array(AnimalEntry), people: z.array(PersonEntry), vehicles: z.array(VehicleEntry),
  gate: SceneFields.gate, trough: SceneFields.trough, notes: SceneFields.notes,
});
export type FrameLabel = z.infer<typeof FrameLabel>;

// One request per burst (24 Oct, Vlad): the labeler sees the members together, so a living thing that moves or holds its
// shape can be told from IR noise, a shadow or a fixture, which a single night still cannot. Each object carries an
// id that is the same in every frame it appears in; `objects` says per id whether it moved: a motion ground truth.
const Id = z.string().describe('Short id for this object, the same in every frame of the burst where it appears (a1, a2, p1, v1 ...).');
export const BurstFrameLabel = z.object({
  seq: z.number().int().min(0).describe('The frame index in the burst, as given.'),
  scene: SceneFields.scene, lighting: SceneFields.lighting,
  animals: z.array(AnimalEntry.extend({ id: Id })), people: z.array(PersonEntry.extend({ id: Id })), vehicles: z.array(VehicleEntry.extend({ id: Id })),
  gate: SceneFields.gate, trough: SceneFields.trough, notes: SceneFields.notes,
});
export const BurstLabel = z.object({
  frames: z.array(BurstFrameLabel).describe('One entry per frame, in the order given.'),
  objects: z.array(z.object({
    id: Id, kind: z.string().describe('The kind you gave it.'),
    moved: z.boolean().describe('Did it change position between the first and the last frame it appears in?'),
  })).describe('Every id used above, once.'),
});
export type BurstLabel = z.infer<typeof BurstLabel>;

/** Flatten to the benchmark's box list in a model family's label space (docs/TAXONOMY.md, SCORING_MAP): for COCO,
 *  donkey → horse; delivery_vehicle, tractor, atv, trailer → truck; every person kind → person. The kind is kept. */
export function toBoxes(l: FrameLabel, family = 'coco'): { label: string; x: number; y: number; w: number; h: number; posture?: string; kind?: string; look?: string; id?: string }[] {
  const id = (o: object) => ('id' in o ? { id: (o as { id: string }).id } : {});
  return [
    ...l.animals.map((a) => ({ label: scoringLabel(family, 'animal', a.kind), kind: a.kind, posture: a.posture, ...a.box, ...id(a) })),
    ...l.people.map((p) => ({ label: scoringLabel(family, 'person', p.kind), kind: p.kind, look: p.look, ...p.box, ...id(p) })),
    ...l.vehicles.map((v) => ({ label: scoringLabel(family, 'vehicle', v.kind), kind: v.kind, ...v.box, ...id(v) })),
  ];
}
