// The one place classes and subclasses are defined (docs/TAXONOMY.md, docs/TAXONOMY-UI.md). The values live in
// taxonomy.json (the repo copy is the baseline; the active version on the mini is in SQLite, see store.ts).
// Every consumer imports the helpers here; nothing else may spell a class name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateTaxonomy, storedLabel, CLASS_NAMES, type Taxonomy, type ClassName } from './schema.ts';
export * from './schema.ts';

export const REPO_TAXONOMY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'taxonomy.json');
export function loadTaxonomyFile(path = process.env.RANCH_TAXONOMY_FILE ?? REPO_TAXONOMY_FILE): Taxonomy {
  const v = validateTaxonomy(JSON.parse(readFileSync(/* turbopackIgnore: true */ path, 'utf8')));
  if (!v.ok) throw new Error(`invalid taxonomy ${path}: ${v.errors.join('; ')}`);
  return v.taxonomy;
}

// ---- the active taxonomy in this process ------------------------------------------------------------------------
// Loaded lazily: a bundled consumer (the web app) only needs the validator and never reads the file.
let current: Taxonomy | null = null;
let currentVersionId: number | null = null;
export function getTaxonomy(): Taxonomy { return (current ??= loadTaxonomyFile()); }
export function getTaxonomyVersionId(): number | null { return currentVersionId; }
export function setTaxonomy(t: Taxonomy, versionId: number | null = null): void { current = t; currentVersionId = versionId; }

// ---- helpers (all take an optional taxonomy; default = the active one) -------------------------------------------
export function classOf(subclass: string, t: Taxonomy = getTaxonomy()): ClassName | undefined {
  for (const c of CLASS_NAMES) if (t.classes[c].subclasses.includes(subclass)) return c;
  return undefined;
}

export const orderIndex = (label: string, t: Taxonomy = getTaxonomy()): number => { const i = t.label_order.indexOf(label); return i < 0 ? 99 : i; };

export interface Mapped { label: string; class: ClassName; subclass: string; raw_label: string; confidence: number; threshold: number }

/** Map one raw detection; null when the label is unmapped or below its threshold (unless applyThreshold is false). */
export function mapDetection(family: string, rawLabel: string, confidence: number, applyThreshold = true, t: Taxonomy = getTaxonomy()): Mapped | null {
  const m = t.mappings[family]?.[rawLabel];
  if (!m) return null;
  if (applyThreshold && confidence < m.threshold) return null;
  return { label: storedLabel(m.class, m.subclass), class: m.class, subclass: m.subclass, raw_label: rawLabel, confidence, threshold: m.threshold };
}

/** Stored labels a family can produce (counting, retention "interest", dashboard columns), in label order. */
export function interestLabels(family: string, t: Taxonomy = getTaxonomy()): string[] {
  return [...new Set(Object.values(t.mappings[family] ?? {}).map((m) => storedLabel(m.class, m.subclass)))].sort((a, b) => orderIndex(a, t) - orderIndex(b, t));
}

/** Threshold for a stored label in a family: the lowest threshold among raw labels that map to it. */
export function thresholdFor(family: string, label: string, t: Taxonomy = getTaxonomy()): number {
  const ts = Object.values(t.mappings[family] ?? {}).filter((m) => storedLabel(m.class, m.subclass) === label).map((m) => m.threshold);
  return ts.length ? Math.min(...ts) : 1;
}

/** Scoring direction: taxonomy subclass -> the stored label a family can express. */
export function scoringLabel(family: string, cls: ClassName, subclass: string, t: Taxonomy = getTaxonomy()): string {
  if (cls === 'person') return 'person';
  return t.scoring_map[family]?.[subclass] ?? subclass;
}

/** True when the family's `horse` label also collects other raw classes (then the dashboard says "equine"). */
export function horseIsEquine(family: string, t: Taxonomy = getTaxonomy()): boolean {
  return Object.entries(t.mappings[family] ?? {}).some(([raw, m]) => m.class === 'animal' && m.subclass === 'horse' && raw !== 'horse');
}
