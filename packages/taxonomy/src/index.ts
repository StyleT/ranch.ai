// The one place classes and subclasses are defined (docs/TAXONOMY.md). Every consumer (labeling schema, detector
// filter, counting, retention, scoring, dashboard order) imports from here; nothing else may spell a class name.

export const TAXONOMY = {
  animal: {
    subclasses: ['horse', 'donkey', 'dog', 'cat', 'deer', 'coyote', 'bird', 'other'],
    attribute: { name: 'posture', values: ['standing', 'grazing', 'drinking', 'walking', 'lying_sternal', 'lying_flat', 'unknown'] },
  },
  person: {
    // friendly = resident or regular, recognized by face or look (human labeler or a future recognition tier);
    // mailman = postal or courier worker by uniform or vehicle; unknown otherwise.
    subclasses: ['friendly', 'mailman', 'unknown'],
    attribute: { name: 'look', values: null }, // free text
  },
  vehicle: {
    subclasses: ['car', 'truck', 'delivery_vehicle', 'tractor', 'atv', 'trailer', 'other'],
    attribute: null,
  },
} as const;

export const SCENE = {
  gate: ['open', 'closed', 'unknown'],
  trough: ['full', 'half', 'low', 'empty', 'unknown'],
  lighting: ['day', 'dusk', 'night_ir'],
} as const;

/** Named so the rule is explicit: never boxed, never counted. */
export const IGNORED = ['insect', 'spider'] as const;

export type ClassName = keyof typeof TAXONOMY;
export type Subclass<C extends ClassName = ClassName> = (typeof TAXONOMY)[C]['subclasses'][number];
export type AnySubclass = Subclass<'animal'> | Subclass<'person'> | Subclass<'vehicle'>;
export type Posture = (typeof TAXONOMY)['animal']['attribute']['values'][number];

export const CLASSES = Object.keys(TAXONOMY) as ClassName[];
export function classOf(subclass: string): ClassName | undefined {
  for (const c of CLASSES) if ((TAXONOMY[c].subclasses as readonly string[]).includes(subclass)) return c;
  return undefined;
}

/**
 * The label stored for a detection and shown on the dashboard: the subclass, except that a person's subclass is
 * an identity attribute, so people are stored as `person`. Vehicles and animals keep their subclass.
 */
export function storedLabel(cls: ClassName, subclass: string): string {
  return cls === 'person' ? 'person' : subclass;
}

/** Dashboard and report ordering: what a horse owner looks for first. */
export const LABEL_ORDER: readonly string[] = ['horse', 'donkey', 'person', 'dog', 'cat', 'deer', 'coyote', 'bird', 'car', 'truck', 'delivery_vehicle', 'tractor', 'atv', 'trailer', 'other'];
export const orderIndex = (label: string): number => { const i = LABEL_ORDER.indexOf(label); return i < 0 ? 99 : i; };

// ---- model mappings: a detector family's label space -> taxonomy, with per-label thresholds ----------------------
export interface MappingEntry { class: ClassName; subclass: string; threshold: number; note?: string }
export interface ModelMapping { family: string; map: Record<string, MappingEntry> }

const coco = (cls: ClassName, subclass: string, threshold: number, note?: string): MappingEntry => (note ? { class: cls, subclass, threshold, note } : { class: cls, subclass, threshold });

/** COCO-pretrained zero-shot detectors (yolo11*, rf-detr-*). Thresholds from evals/LEADERBOARD.md, 20 Oct 2026. */
export const MODEL_MAPPINGS: Record<string, ModelMapping> = {
  coco: {
    family: 'coco',
    map: {
      horse: coco('animal', 'horse', 0.25, 'precision 1.00 at 0.25; recall is the problem'),
      cow: coco('animal', 'horse', 0.5, 'how COCO models see donkeys and dark horses; +0.20 recall; also fires on blankets'),
      sheep: coco('animal', 'horse', 0.5, 'same as cow'),
      dog: coco('animal', 'dog', 0.4, 'one gold dog; fired on a donkey at 0.74'),
      cat: coco('animal', 'cat', 0.6, 'no verified cat yet'),
      bird: coco('animal', 'bird', 0.5),
      bear: coco('animal', 'other', 0.5, 'large-animal confusion, worth seeing'),
      elephant: coco('animal', 'other', 0.5),
      zebra: coco('animal', 'other', 0.5),
      giraffe: coco('animal', 'other', 0.5),
      person: coco('person', 'unknown', 0.6, 'recall 1.00 at 0.25 with precision 0.42 (night horses as people)'),
      car: coco('vehicle', 'car', 0.25, 'recall 1.00, precision 0.88'),
      truck: coco('vehicle', 'truck', 0.25, 'tractors are never found as trucks (0/14)'),
      bus: coco('vehicle', 'truck', 0.25),
      motorcycle: coco('vehicle', 'atv', 0.4),
    },
  },
};

export interface Mapped { label: string; class: ClassName; subclass: string; raw_label: string; confidence: number; threshold: number }

/** Map one raw detection; null when the label is unmapped or below its threshold (unless applyThreshold is false). */
export function mapDetection(family: string, rawLabel: string, confidence: number, applyThreshold = true): Mapped | null {
  const m = MODEL_MAPPINGS[family]?.map[rawLabel];
  if (!m) return null;
  if (applyThreshold && confidence < m.threshold) return null;
  return { label: storedLabel(m.class, m.subclass), class: m.class, subclass: m.subclass, raw_label: rawLabel, confidence, threshold: m.threshold };
}

/** Stored labels a family can produce (counting, retention "interest", dashboard columns). */
export function interestLabels(family: string): string[] {
  return [...new Set(Object.values(MODEL_MAPPINGS[family]?.map ?? {}).map((m) => storedLabel(m.class, m.subclass)))].sort((a, b) => orderIndex(a) - orderIndex(b));
}

/** Threshold for a stored label in a family: the lowest threshold among raw labels that map to it. */
export function thresholdFor(family: string, label: string): number {
  const ts = Object.values(MODEL_MAPPINGS[family]?.map ?? {}).filter((m) => storedLabel(m.class, m.subclass) === label).map((m) => m.threshold);
  return ts.length ? Math.min(...ts) : 1;
}

/**
 * Scoring direction: taxonomy subclass -> the stored label a family can express, so gold labels and mapped
 * predictions share a label space. Subclasses no COCO model can name collapse onto their nearest expressible one.
 */
export const SCORING_MAP: Record<string, Record<string, string>> = {
  coco: { donkey: 'horse', delivery_vehicle: 'truck', tractor: 'truck', atv: 'truck', trailer: 'truck' },
};
export function scoringLabel(family: string, cls: ClassName, subclass: string): string {
  if (cls === 'person') return 'person';
  return SCORING_MAP[family]?.[subclass] ?? subclass;
}
