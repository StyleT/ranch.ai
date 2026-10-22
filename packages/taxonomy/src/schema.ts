// Pure part of the taxonomy package: the schema, validator and canonical form. No filesystem, safe for browsers.
import { z } from 'zod';

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

/** Canonical JSON (sorted keys) for equality and hashing. */
export function canonical(t: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(t));
}

/** The label stored for a detection and shown on the dashboard: the subclass, except that a person's subclass is an
 *  identity attribute, so people are stored as `person`. */
export function storedLabel(cls: ClassName, subclass: string): string { return cls === 'person' ? 'person' : subclass; }

