import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTaxonomy, validateTaxonomy, mapDetection, interestLabels, thresholdFor, scoringLabel, storedLabel, classOf, canonical, horseIsEquine, loadTaxonomyFile, REPO_TAXONOMY_FILE } from '../src/index.ts';

test('repo taxonomy.json is valid and loads', () => {
  const t = loadTaxonomyFile(REPO_TAXONOMY_FILE);
  assert.ok(t.classes.animal.subclasses.includes('horse'));
  assert.equal(canonical(t), canonical(getTaxonomy()));
});

test('validator rejects inconsistent taxonomies with named paths', () => {
  const t = structuredClone(getTaxonomy());
  (t.mappings.coco as Record<string, unknown>)['zebra'] = { class: 'animal', subclass: 'unicorn', threshold: 0.5 };
  t.label_order.push('tractor_beam');
  (t.scoring_map.coco as Record<string, string>)['deer'] = 'bench';
  const r = validateTaxonomy(t);
  assert.ok(!r.ok);
  if (!r.ok) { assert.ok(r.errors.some((e) => e.includes('unicorn'))); assert.ok(r.errors.some((e) => e.includes('tractor_beam'))); assert.ok(r.errors.some((e) => e.includes('bench'))); }
  assert.ok(!validateTaxonomy({ ...getTaxonomy(), mappings: { coco: { horse: { class: 'animal', subclass: 'horse', threshold: 1.5 } } } }).ok);
});

test('mapping, thresholds, stored labels', () => {
  assert.equal(mapDetection('coco', 'cow', 0.7)?.label, 'horse');
  assert.equal(mapDetection('coco', 'cow', 0.3), null);
  assert.equal(mapDetection('coco', 'cow', 0.3, false)?.raw_label, 'cow');
  assert.equal(mapDetection('coco', 'bench', 0.99), null);
  assert.equal(mapDetection('coco', 'person', 0.7)?.label, 'person');
  assert.equal(storedLabel('vehicle', 'tractor'), 'tractor');
  assert.equal(classOf('tractor'), 'vehicle');
  assert.equal(thresholdFor('coco', 'horse'), 0.25);
  assert.equal(thresholdFor('coco', 'person'), 0.6);
  assert.equal(interestLabels('coco')[0], 'horse');
  assert.equal(scoringLabel('coco', 'animal', 'donkey'), 'horse');
  assert.equal(scoringLabel('coco', 'vehicle', 'tractor'), 'truck');
  assert.equal(scoringLabel('coco', 'person', 'mailman'), 'person');
  assert.equal(scoringLabel('coco', 'animal', 'deer'), 'deer');
  assert.ok(horseIsEquine('coco'));
  // a taxonomy passed explicitly is used instead of the active one
  const t = structuredClone(getTaxonomy()); delete (t.mappings.coco as Record<string, unknown>)['cow'];
  assert.equal(mapDetection('coco', 'cow', 0.9, true, t), null);
});
