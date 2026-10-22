// The one place classes and subclasses are defined (docs/TAXONOMY.md, docs/TAXONOMY-UI.md). The values live in
// taxonomy.json (the repo copy is the baseline; the active version on the mini is in SQLite, see store.ts).
// Every consumer imports the helpers here; nothing else may spell a class name.
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const CLASS_NAMES = ['animal', 'person', 'vehicle'] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

const Ident = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase identifier');
const MappingEntrySchema = z.object({ class: z.enum(CLASS_NAMES), subclass: Ident, threshold: z.number().min(0).max(1), note: z.string().optional() });
const ClassDef = z.object({
  subclasses: z.array(Ident).min(1),
  attribute: z.object({ name: Ident, values: z.array(Ident).min(1).nullable() }).nullable(),
});

export const TaxonomySchema = z.object({
  version: z.number().int().min(1),
  classes: z.object({ animal: ClassDef, person: ClassDef, vehicle: ClassDef }),
  scene: z.object({ gate: z.array(Ident).min(1), trough: z.array(Ident).min(1), lighting: z.array(Ident).min(1) }),
  ignored: z.array(Ident),
  label_order: z.array(Ident),
  mappings: z.record(Ident, z.record(z.string().min(1), MappingEntrySchema)),
  scoring_map: z.record(Ident, z.record(Ident, Ident)),
}).superRefine((t, ctx) => {
  // A subclass name may repeat across classes ("other" in animal and vehicle); the stored label is then ambiguous
  // between those classes, which is accepted for catch-alls. Within a class, names are unique.
  const subs = new Map<string, ClassName>();
  for (const c of CLASS_NAMES) {
    for (const s of t.classes[c].subclasses) if (!subs.has(s)) subs.set(s, c);
    if (new Set(t.classes[c].subclasses).size !== t.classes[c].subclasses.length) ctx.addIssue({ code: 'custom', message: `duplicate subclass in ${c}`, path: ['classes', c, 'subclasses'] });
  }
  for (const [fam, map] of Object.entries(t.mappings)) {
    for (const [raw, m] of Object.entries(map)) if (!t.classes[m.class].subclasses.includes(m.subclass)) ctx.addIssue({ code: 'custom', message: `${fam}: "${raw}" maps to unknown ${m.class}/${m.subclass}`, path: ['mappings', fam, raw] });
    const labels = new Set(Object.values(map).map((m) => storedLabel(m.class, m.subclass)));
    for (const [src, dst] of Object.entries(t.scoring_map[fam] ?? {})) {
      if (!subs.has(src)) ctx.addIssue({ code: 'custom', message: `${fam}: scoring source "${src}" is not a subclass`, path: ['scoring_map', fam, src] });
      if (!labels.has(dst)) ctx.addIssue({ code: 'custom', message: `${fam}: scoring target "${dst}" is not a label this family produces`, path: ['scoring_map', fam, src] });
    }
  }
  for (const fam of Object.keys(t.scoring_map)) if (!t.mappings[fam]) ctx.addIssue({ code: 'custom', message: `scoring_map for unknown family "${fam}"`, path: ['scoring_map', fam] });
  for (const l of t.label_order) if (l !== 'person' && !subs.has(l)) ctx.addIssue({ code: 'custom', message: `label_order entry "${l}" is not a subclass`, path: ['label_order'] });
  if (new Set(t.label_order).size !== t.label_order.length) ctx.addIssue({ code: 'custom', message: 'duplicate in label_order', path: ['label_order'] });
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type MappingEntry = z.infer<typeof MappingEntrySchema>;

export function validateTaxonomy(obj: unknown): { ok: true; taxonomy: Taxonomy } | { ok: false; errors: string[] } {
  const r = TaxonomySchema.safeParse(obj);
  if (r.success) return { ok: true, taxonomy: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

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

/** Canonical JSON (sorted keys) for equality and hashing. */
export function canonical(t: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(t));
}

// ---- helpers (all take an optional taxonomy; default = the active one) -------------------------------------------
export function classOf(subclass: string, t: Taxonomy = getTaxonomy()): ClassName | undefined {
  for (const c of CLASS_NAMES) if (t.classes[c].subclasses.includes(subclass)) return c;
  return undefined;
}

/** The label stored for a detection and shown on the dashboard: the subclass, except that a person's subclass is an
 *  identity attribute, so people are stored as `person`. */
export function storedLabel(cls: ClassName, subclass: string): string { return cls === 'person' ? 'person' : subclass; }

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
