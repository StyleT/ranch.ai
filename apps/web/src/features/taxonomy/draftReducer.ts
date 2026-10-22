// Pure reducer over a taxonomy draft (docs/WEB-DASHBOARD.md §4.3). `dirty` is derived by canonical JSON comparison.
import { canonical, type Taxonomy } from '@ranch/taxonomy/schema';
export type Cls = 'animal' | 'person' | 'vehicle';
export type Action =
  | { type: 'reset'; taxonomy: Taxonomy }
  | { type: 'addSubclass'; cls: Cls; name: string } | { type: 'removeSubclass'; cls: Cls; name: string }
  | { type: 'addAttrValue'; cls: Cls; value: string } | { type: 'removeAttrValue'; cls: Cls; value: string }
  | { type: 'addIgnored'; name: string } | { type: 'removeIgnored'; name: string }
  | { type: 'setMapping'; family: string; raw: string; cls: Cls; subclass: string } | { type: 'setThreshold'; family: string; raw: string; threshold: number }
  | { type: 'setNote'; family: string; raw: string; note: string } | { type: 'removeMapping'; family: string; raw: string } | { type: 'addFamily'; family: string }
  | { type: 'moveOrder'; index: number; delta: -1 | 1 } | { type: 'removeOrder'; index: number } | { type: 'addOrder'; label: string }
  | { type: 'setScoring'; family: string; subclass: string; label: string } | { type: 'removeScoring'; family: string; subclass: string };

const ident = /^[a-z][a-z0-9_]*$/;
export const isIdent = (s: string) => ident.test(s);
export const clamp01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100) / 100));

export function reduce(t: Taxonomy, a: Action): Taxonomy {
  const d = structuredClone(t);
  switch (a.type) {
    case 'reset': return structuredClone(a.taxonomy);
    case 'addSubclass': if (isIdent(a.name) && !d.classes[a.cls].subclasses.includes(a.name)) d.classes[a.cls].subclasses.push(a.name); return d;
    case 'removeSubclass': d.classes[a.cls].subclasses = d.classes[a.cls].subclasses.filter((s) => s !== a.name); return d;
    case 'addAttrValue': { const at = d.classes[a.cls].attribute; if (at?.values && isIdent(a.value) && !at.values.includes(a.value)) at.values.push(a.value); return d; }
    case 'removeAttrValue': { const at = d.classes[a.cls].attribute; if (at?.values) at.values = at.values.filter((v) => v !== a.value); return d; }
    case 'addIgnored': if (isIdent(a.name) && !d.ignored.includes(a.name)) d.ignored.push(a.name); return d;
    case 'removeIgnored': d.ignored = d.ignored.filter((x) => x !== a.name); return d;
    case 'setMapping': { if (!a.raw.trim()) return t; const fam = (d.mappings[a.family] ??= {}); const prev = fam[a.raw]; fam[a.raw] = { class: a.cls, subclass: a.subclass, threshold: prev?.threshold ?? 0.5, ...(prev?.note ? { note: prev.note } : {}) }; return d; }
    case 'setThreshold': { const m = d.mappings[a.family]?.[a.raw]; if (m) m.threshold = clamp01(a.threshold); return d; }
    case 'setNote': { const m = d.mappings[a.family]?.[a.raw]; if (m) { if (a.note.trim()) m.note = a.note; else delete m.note; } return d; }
    case 'removeMapping': { const fam = d.mappings[a.family]; if (fam) delete fam[a.raw]; return d; }
    case 'addFamily': if (isIdent(a.family) && !d.mappings[a.family]) { d.mappings[a.family] = {}; d.scoring_map[a.family] = {}; } return d;
    case 'moveOrder': { const j = a.index + a.delta; if (a.index < 0 || j < 0 || j >= d.label_order.length || a.index >= d.label_order.length) return t; [d.label_order[a.index], d.label_order[j]] = [d.label_order[j]!, d.label_order[a.index]!]; return d; }
    case 'removeOrder': d.label_order.splice(a.index, 1); return d;
    case 'addOrder': if (!d.label_order.includes(a.label)) d.label_order.push(a.label); return d;
    case 'setScoring': (d.scoring_map[a.family] ??= {})[a.subclass] = a.label; return d;
    case 'removeScoring': { const sm = d.scoring_map[a.family]; if (sm) delete sm[a.subclass]; return d; }
  }
}
export const isDirty = (a: Taxonomy, b: Taxonomy) => canonical(a) !== canonical(b);
export const allSubclasses = (t: Taxonomy): { cls: Cls; subclass: string }[] => (['animal', 'person', 'vehicle'] as Cls[]).flatMap((cls) => t.classes[cls].subclasses.map((subclass) => ({ cls, subclass })));
export const storedLabel = (cls: Cls, subclass: string) => (cls === 'person' ? 'person' : subclass);
export const familyLabels = (t: Taxonomy, family: string) => [...new Set(Object.values(t.mappings[family] ?? {}).map((m) => storedLabel(m.class, m.subclass)))];
