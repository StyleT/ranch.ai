import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, decide, DEFAULTS, type CamState, type CamFacts } from '../src/ladder.ts';

const T0 = Date.parse('2026-10-23T18:00:00Z');
const fresh = (): CamState => ({ downSinceMs: null, lastRebootMs: null, rebootsThisOutage: 0, alertedThisOutage: false });
const facts = (connected: boolean | null, pingOk: boolean | null, camera = 'tractor_cam'): CamFacts => ({ camera, connected, pingOk });

test('advance: transitions once per edge, unknown facts change nothing', () => {
  const s = fresh();
  assert.equal(advance(s, facts(null, null), T0), null);
  assert.equal(advance(s, facts(false, true), T0), 'went_down'); assert.equal(s.downSinceMs, T0);
  assert.equal(advance(s, facts(false, true), T0 + 1000), null); assert.equal(s.downSinceMs, T0);
  assert.equal(advance(s, facts(true, true), T0 + 5000), 'came_back'); assert.equal(s.downSinceMs, null);
});

test('rung 2 fires after rebootAfterS when the camera pings, respects cooldown and the fleet budget', () => {
  const states = new Map<string, CamState>([['a', { ...fresh(), downSinceMs: T0 }], ['b', { ...fresh(), downSinceMs: T0 }], ['c', { ...fresh(), downSinceMs: T0 }]]);
  const fs = [facts(false, true, 'a'), facts(false, true, 'b'), facts(false, true, 'c')];
  assert.deepEqual(decide(T0 + 599e3, fs, states, [], null), []);                       // not yet
  const d = decide(T0 + 600e3, fs, states, [], null);
  assert.deepEqual(d.map((x) => [x.rung, x.camera]), [[2, 'a'], [2, 'b']]);            // fleet budget 2/h: c waits
  assert.deepEqual(decide(T0 + 601e3, fs, states, [T0 + 600e3, T0 + 600e3], null), []);  // budget spent, a/b cooling
  const later = decide(T0 + 600e3 + 3600e3 + 1, fs, states, [], null);                  // an hour later: a and b cooled, budget back
  assert.equal(later.filter((x) => x.rung === 2).length, 2);
});

test('rung 4 alerts once when the camera does not answer ping; a pinging camera is never alerted', () => {
  const states = new Map<string, CamState>([['mops_cam', { ...fresh(), downSinceMs: T0 }]]);
  const d1 = decide(T0 + 700e3, [facts(false, false, 'mops_cam')], states, [], null);
  assert.deepEqual(d1.map((x) => x.rung), [4]);
  assert.deepEqual(decide(T0 + 800e3, [facts(false, false, 'mops_cam')], states, [], null), []);
  assert.deepEqual(decide(T0 + 700e3, [facts(false, null, 'mops_cam')], new Map([['mops_cam', { ...fresh(), downSinceMs: T0 }]]), [], null), []);   // no ping fact: wait
});

test('rung 3 needs three cameras down past go2rtcRestartAfterS with a reboot each, then cools for an hour', () => {
  const cams = ['a', 'b', 'c'];
  const states = new Map<string, CamState>(cams.map((c) => [c, { ...fresh(), downSinceMs: T0, rebootsThisOutage: 1, lastRebootMs: T0 + 600e3 }]));
  const fs = cams.map((c) => facts(false, true, c));
  const d = decide(T0 + 900e3, fs, states, [T0 + 600e3, T0 + 600e3], null);
  assert.deepEqual(d.map((x) => x.rung), [3]);
  if (d[0]?.rung === 3) assert.deepEqual(d[0].cameras, cams);
  assert.deepEqual(decide(T0 + 901e3, fs, states, [T0 + 600e3, T0 + 600e3], T0 + 900e3), []);
  const two = new Map<string, CamState>(cams.slice(0, 2).map((c) => [c, { ...fresh(), downSinceMs: T0, rebootsThisOutage: 1, lastRebootMs: T0 + 600e3 }]));
  assert.deepEqual(decide(T0 + 900e3, fs.slice(0, 2), two, [T0 + 600e3, T0 + 600e3], null), []);
});

test('defaults are the documented ladder', () => {
  assert.deepEqual(DEFAULTS, { rebootAfterS: 600, rebootCooldownS: 1800, fleetRebootsPerHour: 2, go2rtcRestartAfterS: 900, go2rtcMinCamerasDown: 3, go2rtcCooldownS: 3600, reattachCooldownS: 120 });
});

test('rung 1 re-attaches an orphaned consumer after two ticks and cools for two minutes', () => {
  const states = new Map<string, CamState>([['back_yard_cam', fresh()]]);
  const orphan: CamFacts = { camera: 'back_yard_cam', connected: true, pingOk: true, framesFresh: true, consumers: 0 };
  assert.deepEqual(decide(T0, [orphan], states, [], null), []);                      // first tick: wait
  const d = decide(T0 + 15e3, [orphan], states, [], null);
  assert.deepEqual(d.map((x) => [x.rung, x.action]), [[1, 'reattach']]);
  assert.deepEqual(decide(T0 + 30e3, [orphan], states, [], null), []);               // one tick after: counting again
  assert.deepEqual(decide(T0 + 45e3, [orphan], states, [], null), []);               // two ticks but cooling
  assert.equal(decide(T0 + 15e3 + 120e3 + 15e3 * 2, [orphan], states, [], null).length, 1);
  const healthy: CamFacts = { camera: 'back_yard_cam', connected: true, pingOk: true, framesFresh: true, consumers: 1 };
  assert.deepEqual(decide(T0 + 600e3, [healthy], new Map([['back_yard_cam', fresh()]]), [], null), []);
});
