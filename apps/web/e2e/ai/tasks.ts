// The agentic e2e tasks (docs/WEB-DASHBOARD.md): a natural-language goal for the browsing agent and an oracle that
// derives the expected answer from the daemon API. Live data moves while the agent works, so the runner evaluates
// each oracle before and after the run and accepts either.
import * as C from '@ranch/contracts';
import type { DaemonApi, Expected } from './oracle.ts';

export interface Task { name: string; goal: string; model?: 'haiku' | 'sonnet' | 'opus'; maxTurns?: number; oracle: (api: DaemonApi) => Promise<Expected> }

export const tasks: Task[] = [
  {
    name: 'most-equines-1h',
    goal: 'Open the home page. In the "Detections · last hour" table, which camera has the most horse detections? Answer with the camera name exactly as shown in the column header (it may be abbreviated).',
    oracle: async (api) => { const s = await api.get(C.Status, '/api/status'); const rows = s.labels_by_camera_1h.filter((r) => r.label === 'horse').sort((a, b) => b.n - a.n); if (!rows[0]) return { kind: 'predicate', describe: 'no horse detections in the last hour: any answer saying so passes', check: (a) => /no|none|0/.test(a.answer.toLowerCase()) }; const top = rows[0].n; return { kind: 'name', value: rows[0].camera, alternates: rows.filter((r) => r.n === top).map((r) => r.camera) }; },
  },
  {
    name: 'donkey-cam-count',
    goal: 'Open the camera page for donkey_cam and report its current equine (horse) count as shown next to "now" under the live view. If it shows a dash, answer 0.',
    oracle: async (api) => { const s = await api.get(C.Status, '/api/status'); const c = s.cameras.find((x) => x.name === 'donkey_cam'); return { kind: 'number', value: c?.horse_last_min ?? 0, tolerance: 0 }; },
  },
  {
    name: 'offline-cameras',
    goal: 'Open the home page and list the cameras that are offline (their badge says "off"). Answer with the camera names, comma-separated, or "none".',
    oracle: async (api) => { const s = await api.get(C.Status, '/api/status'); const off = s.cameras.filter((c) => !c.online).map((c) => c.name); return off.length ? { kind: 'set', values: off } : { kind: 'predicate', describe: 'all cameras online: the answer must say none', check: (a) => /none|no /.test((a.value ?? a.answer).toLowerCase()) }; },
  },
  {
    name: 'daemon-most-memory',
    goal: 'Open the System page. Which daemon uses the most memory (the "rss" figure on each daemon card)? Answer with the daemon name.',
    oracle: async (api) => { const s = await api.get(C.Status, '/api/status'); const rows = s.daemons.filter((d) => d.rss_mb !== null && d.rss_mb !== undefined).sort((a, b) => (b.rss_mb ?? 0) - (a.rss_mb ?? 0)); return { kind: 'name', value: rows[0]!.label.replace('com.ranch.', ''), alternates: rows.slice(0, 2).map((r) => r.label.replace('com.ranch.', '')) }; },
  },
  {
    name: 'latest-moving-person',
    goal: 'Open the Detections page, set the window to 24 h, tick "moving only" and pick the label "person". Report the camera and the time (HH:MM) of the newest frame shown, as "camera HH:MM". If there is none, say "none".',
    // the same query the page runs (label filters the head frame, moving looks across the burst), so the oracle mirrors the UI
    oracle: async (api) => { const rows = await api.get(C.FramesResponse, '/api/frames?since=24h&moving=1&label=person&limit=1'); const top = rows[0]; if (!top) return { kind: 'predicate', describe: 'no moving person: the answer must say none', check: (a) => /none/.test((a.value ?? a.answer).toLowerCase()) }; return { kind: 'predicate', describe: `camera ${top.camera} at ${top.ts}`, check: (a) => (a.value ?? a.answer).toLowerCase().includes(top.camera.replace('_cam', '').toLowerCase()) }; },
  },
  {
    name: 'live-video',
    goal: 'Open the camera page for back_yard_cam. Look at the live video area at the top: a badge in its corner says either "LIVE · N s" (with a latency), "connecting…", "buffering · N s" or "camera reconnecting · N". Wait up to 20 seconds for it to settle, then report the badge text you see, as shown.',
    // the oracle reads the recorder's facts: frames flowing within 10 s => the player must say LIVE (or still be connecting); otherwise it must not say LIVE
    oracle: async (api) => { const s = await api.get(C.Status, '/api/status'); const c = s.cameras.find((x) => x.name === 'back_yard_cam'); const flowing = c?.connected === true && (c.live_age_s ?? 999) < 10; return { kind: 'predicate', describe: flowing ? 'frames are flowing: the badge must say LIVE (connecting… is acceptable only if the page was just opened)' : `frames are not flowing (connected=${c?.connected}, live_age=${c?.live_age_s}): the badge must not say LIVE`, check: (a) => { const t = (a.value ?? a.answer).toLowerCase(); return flowing ? /live|connecting/.test(t) : !/^live|live ·/.test(t); } }; },
  },
  {
    name: 'remediation-24h',
    goal: 'Open the System page and find the "Camera supervisor · ledger · 24 h" table. Which cameras have an "outage" row in it? Answer with the camera names as shown (comma-separated), or "none" if the table says there were no outages.',
    oracle: async (api) => { const rows = await api.get(C.RemediationResponse, '/api/remediation?since=24h&limit=200'); const cams = [...new Set(rows.filter((r) => r.action === 'down').map((r) => r.camera))]; return cams.length ? { kind: 'set', values: cams } : { kind: 'predicate', describe: 'no outages: the answer must say none', check: (a) => /none/.test((a.value ?? a.answer).toLowerCase()) }; },
  },
  {
    name: 'taxonomy-score-gate',
    model: 'sonnet', maxTurns: 30,
    goal: 'Open the Taxonomy page. In the coco mappings table, change the threshold of the "person" raw label to 0.7 (type into its threshold input). Then click "Score draft" and wait for the gate table. Report whether the gate passed: answer "pass" or "fail". Do NOT click Apply.',
    oracle: async (api) => { const m = await api.get(C.TaxonomyMeta, '/api/taxonomy'); const draft = structuredClone(m.taxonomy) as { mappings: Record<string, Record<string, { threshold: number }>> }; draft.mappings.coco!.person!.threshold = 0.7; const r = C.parseContract(C.ScoreResponse, await api.post('/api/taxonomy/score', { taxonomy: draft }), 'score'); return { kind: 'enum', value: r.gate.pass ? 'pass' : 'fail' }; },
  },
];
