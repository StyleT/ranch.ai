import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, decide, DEFAULTS, type CamState, type CamFacts } from '../src/ladder.ts';

const T0 = Date.parse('2026-10-23T18:00:00Z');
const fresh = (): CamState => ({ downSinceMs: null, lastRebootMs: null, rebootsThisOutage: 0, alertedThisOutage: false });
/** a down camera that already had its bridge stream restart (rung 1b) this outage */
const tried = (): CamState => ({ ...fresh(), downSinceMs: T0, streamRestartTried: true });
const facts = (connected: boolean | null, pingOk: boolean | null, camera = 'tractor_cam'): CamFacts => ({ camera, connected, pingOk });

test('advance: transitions once per edge, unknown facts change nothing, a recovery resets the outage', () => {
  const s = fresh();
  assert.equal(advance(s, facts(null, null), T0), null);
  assert.equal(advance(s, facts(false, true), T0), 'went_down'); assert.equal(s.downSinceMs, T0);
  assert.equal(advance(s, facts(false, true), T0 + 1000), null); assert.equal(s.downSinceMs, T0);
  s.streamRestartTried = true;
  assert.equal(advance(s, facts(true, true), T0 + 5000), 'came_back'); assert.equal(s.downSinceMs, null); assert.equal(s.streamRestartTried, false);
});

test('rung 1b: a reachable camera gets one bridge stream restart after streamRestartAfterS, before any reboot', () => {
  const states = new Map<string, CamState>([['a', { ...fresh(), downSinceMs: T0 }]]);
  const f = [{ ...facts(false, true, 'a'), ip: '192.168.1.105' }];
  assert.deepEqual(decide(T0 + 119e3, f, states, [], null), []);
  const d = decide(T0 + 120e3, f, states, [], null);
  assert.deepEqual(d.map((x) => [x.rung, x.action]), [[1.5, 'stream_restart']]);
  assert.deepEqual(decide(T0 + 121e3, f, states, [], null), []);                       // once per outage
  const later = decide(T0 + 600e3, f, states, [], null);                               // still down: now the reboot
  assert.deepEqual(later.map((x) => [x.rung, x.action]), [[2, 'camera_reboot']]);
  assert.match(later[0]!.reason, /stream restart did not help/);
});

test('rung 2 fires after rebootAfterS when the camera pings, respects cooldown and the fleet budget', () => {
  const states = new Map<string, CamState>([['a', tried()], ['b', tried()], ['c', tried()]]);
  const fs = [facts(false, true, 'a'), facts(false, true, 'b'), facts(false, true, 'c')];
  assert.deepEqual(decide(T0 + 599e3, fs, states, [], null), []);                       // not yet
  const d = decide(T0 + 600e3, fs, states, [], null);
  assert.deepEqual(d.map((x) => [x.rung, x.camera]), [[2, 'a'], [2, 'b']]);            // fleet budget 2/h: c waits
  assert.deepEqual(decide(T0 + 601e3, fs, states, [T0 + 600e3, T0 + 600e3], null), []);  // budget spent, a/b cooling
  const later = decide(T0 + 600e3 + 3600e3 + 1, fs, states, [], null);                  // an hour later: a and b cooled, budget back
  assert.equal(later.filter((x) => x.rung === 2).length, 2);
});

test('rung 2 for a moved address: no ping at the cloud address, MAC seen elsewhere -> reboot with the move in the reason, no stream restart first', () => {
  const states = new Map<string, CamState>([['back_pasture_cam', { ...fresh(), downSinceMs: T0 }]]);
  const moved: CamFacts = { camera: 'back_pasture_cam', connected: false, pingOk: false, ip: '192.168.1.124', macSeenAt: '192.168.1.102', addressMoved: true };
  assert.deepEqual(decide(T0 + 300e3, [moved], states, [], null), []);                 // before rebootAfterS: nothing, no rung 1b, no rung 4
  const d = decide(T0 + 600e3, [moved], states, [], null);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.rung, 2);
  if (d[0]!.rung === 2) { assert.equal(d[0]!.moved, true); assert.equal(d[0]!.blind, false); }
  assert.match(d[0]!.reason, /address moved \(192\.168\.1\.124 -> 192\.168\.1\.102\)/);
  assert.deepEqual(decide(T0 + 601e3, [moved], states, [T0 + 600e3], null), []);       // cooling
});

test('nothing that reaches a camera fires while the bridge does not list it; the budget is kept for the next tick', () => {
  const states = new Map<string, CamState>([['wash_stall', { ...fresh(), downSinceMs: T0 }], ['a', tried()]]);
  const moved: CamFacts = { camera: 'wash_stall', connected: false, pingOk: false, ip: '192.168.1.149', macSeenAt: '192.168.1.111', addressMoved: true, bridgeKnown: false };
  const reachable: CamFacts = { ...facts(false, true, 'a'), bridgeKnown: false };
  assert.deepEqual(decide(T0 + 600e3, [moved, reachable], states, [], null), []);
  assert.equal(states.get('wash_stall')!.rebootsThisOutage, 0);
  const d = decide(T0 + 615e3, [{ ...moved, bridgeKnown: true }, { ...reachable, bridgeKnown: true }], states, [], null);
  assert.deepEqual(d.map((x) => [x.rung, x.camera]), [[2, 'wash_stall'], [2, 'a']]);
});

test('rung 4 alerts once when the camera is off the LAN; after blindRebootAfterS one blind reboot, then a long cooldown', () => {
  const states = new Map<string, CamState>([['mops_cam', { ...fresh(), downSinceMs: T0 }]]);
  const off = { ...facts(false, false, 'mops_cam'), macSeenAt: null, addressMoved: false };
  const d1 = decide(T0 + 700e3, [off], states, [], null);
  assert.deepEqual(d1.map((x) => x.rung), [4]);
  assert.deepEqual(decide(T0 + 800e3, [off], states, [], null), []);
  const d2 = decide(T0 + 3600e3, [off], states, [], null);
  assert.deepEqual(d2.map((x) => [x.rung, x.action]), [[2, 'camera_reboot']]);
  if (d2[0]!.rung === 2) assert.equal(d2[0]!.blind, true);
  assert.deepEqual(decide(T0 + 3600e3 + 1800e3 + 1, [off], states, [], null), []);     // reboot cooldown passed, blind cooldown (6 h) not
  assert.equal(decide(T0 + 3600e3 + 21600e3 + 1, [off], states, [], null).length, 1);
  assert.deepEqual(decide(T0 + 700e3, [facts(false, null, 'mops_cam')], new Map([['mops_cam', { ...fresh(), downSinceMs: T0 }]]), [], null), []);   // no ping fact: wait
});

test('rung 3 needs three cameras down past go2rtcRestartAfterS with a reboot each, then cools for an hour', () => {
  const cams = ['a', 'b', 'c'];
  const states = new Map<string, CamState>(cams.map((c) => [c, { ...tried(), rebootsThisOutage: 1, lastRebootMs: T0 + 600e3 }]));
  const fs = cams.map((c) => facts(false, true, c));
  const d = decide(T0 + 900e3, fs, states, [T0 + 600e3, T0 + 600e3], null);
  assert.deepEqual(d.map((x) => x.rung), [3]);
  if (d[0]?.rung === 3) assert.deepEqual(d[0].cameras, cams);
  assert.deepEqual(decide(T0 + 901e3, fs, states, [T0 + 600e3, T0 + 600e3], T0 + 900e3), []);
  const two = new Map<string, CamState>(cams.slice(0, 2).map((c) => [c, { ...tried(), rebootsThisOutage: 1, lastRebootMs: T0 + 600e3 }]));
  assert.deepEqual(decide(T0 + 900e3, fs.slice(0, 2), two, [T0 + 600e3, T0 + 600e3], null), []);
});

test('defaults are the documented ladder', () => {
  assert.deepEqual(DEFAULTS, { rebootAfterS: 600, rebootCooldownS: 1800, fleetRebootsPerHour: 2, go2rtcRestartAfterS: 900, go2rtcMinCamerasDown: 3, go2rtcCooldownS: 3600, reattachCooldownS: 120, streamRestartAfterS: 120, blindRebootAfterS: 3600, blindRebootCooldownS: 21600 });
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
