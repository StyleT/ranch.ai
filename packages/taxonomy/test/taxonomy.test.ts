import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAXONOMY, CLASSES, classOf, storedLabel, mapDetection, interestLabels, thresholdFor, scoringLabel, MODEL_MAPPINGS, LABEL_ORDER, SCORING_MAP } from '../src/index.ts';

test('taxonomy is internally consistent', () => {
  for (const c of CLASSES) { const subs = TAXONOMY[c].subclasses as readonly string[]; assert.equal(new Set(subs).size, subs.length, `${c} has duplicate subclasses`); for (const s of subs) assert.equal(classOf(s), classOf(s)); }
  for (const [fam, mm] of Object.entries(MODEL_MAPPINGS)) for (const [raw, m] of Object.entries(mm.map)) {
    assert.ok((TAXONOMY[m.class].subclasses as readonly string[]).includes(m.subclass), `${fam}:${raw} maps to unknown subclass ${m.class}/${m.subclass}`);
    assert.ok(m.threshold > 0 && m.threshold <= 1, `${fam}:${raw} threshold out of range`);
  }
  for (const [fam, sm] of Object.entries(SCORING_MAP)) for (const [sub, target] of Object.entries(sm)) {
    assert.ok(classOf(sub), `${fam}: scoring map source ${sub} is not a subclass`);
    assert.ok(interestLabels(fam).includes(target), `${fam}: scoring target ${target} is not a label the family produces`);
  }
  for (const l of LABEL_ORDER) assert.ok(l === 'person' || classOf(l), `order entry ${l} is not a subclass`);
});

test('mapping, thresholds, stored labels', () => {
  assert.deepEqual(mapDetection('coco', 'cow', 0.7)?.label, 'horse');
  assert.equal(mapDetection('coco', 'cow', 0.3), null);                 // below cow's 0.5
  assert.equal(mapDetection('coco', 'cow', 0.3, false)?.raw_label, 'cow');
  assert.equal(mapDetection('coco', 'bench', 0.99), null);              // unmapped noise
  assert.equal(mapDetection('coco', 'person', 0.7)?.label, 'person');   // person subclass is not the label
  assert.equal(storedLabel('vehicle', 'tractor'), 'tractor');
  assert.equal(thresholdFor('coco', 'horse'), 0.25);                     // min over horse/cow/sheep
  assert.equal(thresholdFor('coco', 'person'), 0.6);
  assert.ok(interestLabels('coco')[0] === 'horse');
  assert.equal(scoringLabel('coco', 'animal', 'donkey'), 'horse');
  assert.equal(scoringLabel('coco', 'vehicle', 'tractor'), 'truck');
  assert.equal(scoringLabel('coco', 'person', 'mailman'), 'person');
  assert.equal(scoringLabel('coco', 'animal', 'deer'), 'deer');
});
