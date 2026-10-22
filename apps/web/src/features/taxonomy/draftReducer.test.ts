import { describe, it, expect } from 'vitest';
import { loadTaxonomyFile, REPO_TAXONOMY_FILE } from '@ranch/taxonomy';
import { reduce, isDirty, familyLabels } from './draftReducer';

const base = loadTaxonomyFile(REPO_TAXONOMY_FILE);
describe('draftReducer', () => {
  it('is pure and tracks dirtiness by canonical json', () => {
    const d = reduce(base, { type: 'setThreshold', family: 'coco', raw: 'person', threshold: 0.9 });
    expect(base.mappings.coco!.person!.threshold).toBe(0.6); expect(d.mappings.coco!.person!.threshold).toBe(0.9);
    expect(isDirty(base, d)).toBe(true); expect(isDirty(base, reduce(d, { type: 'reset', taxonomy: base }))).toBe(false);
  });
  it('clamps thresholds, rejects bad identifiers and duplicates', () => {
    expect(reduce(base, { type: 'setThreshold', family: 'coco', raw: 'cow', threshold: 7 }).mappings.coco!.cow!.threshold).toBe(1);
    expect(reduce(base, { type: 'addSubclass', cls: 'animal', name: 'Bad Name' }).classes.animal.subclasses).toEqual(base.classes.animal.subclasses);
    expect(reduce(base, { type: 'addSubclass', cls: 'animal', name: 'horse' }).classes.animal.subclasses.filter((s) => s === 'horse').length).toBe(1);
    expect(reduce(base, { type: 'addSubclass', cls: 'animal', name: 'goat' }).classes.animal.subclasses).toContain('goat');
  });
  it('edits mappings, families, order and scoring', () => {
    let d = reduce(base, { type: 'addFamily', family: 'ranch_v1' });
    d = reduce(d, { type: 'setMapping', family: 'ranch_v1', raw: 'donkey', cls: 'animal', subclass: 'donkey' });
    expect(d.mappings.ranch_v1!.donkey).toEqual({ class: 'animal', subclass: 'donkey', threshold: 0.5 });
    d = reduce(d, { type: 'setNote', family: 'ranch_v1', raw: 'donkey', note: 'native class' }); expect(d.mappings.ranch_v1!.donkey!.note).toBe('native class');
    d = reduce(d, { type: 'setNote', family: 'ranch_v1', raw: 'donkey', note: ' ' }); expect(d.mappings.ranch_v1!.donkey!.note).toBeUndefined();
    expect(familyLabels(d, 'ranch_v1')).toEqual(['donkey']);
    d = reduce(d, { type: 'removeMapping', family: 'ranch_v1', raw: 'donkey' }); expect(d.mappings.ranch_v1).toEqual({});
    const first = base.label_order[0]!, second = base.label_order[1]!;
    const o = reduce(base, { type: 'moveOrder', index: 0, delta: 1 }); expect(o.label_order.slice(0, 2)).toEqual([second, first]);
    expect(reduce(base, { type: 'moveOrder', index: 0, delta: -1 })).toBe(base);
    const s = reduce(base, { type: 'setScoring', family: 'coco', subclass: 'deer', label: 'horse' }); expect(s.scoring_map.coco!.deer).toBe('horse');
  });
});
