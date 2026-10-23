// Agentic e2e: Claude Code (the user's subscription, `claude -p`) drives the dashboard through the Playwright MCP
// server and answers each task; a code oracle checks the answer against the daemon API (docs/WEB-DASHBOARD.md).
//   make e2e-ai [MODEL=haiku|sonnet|opus] [TASK=name] [TARGET=live|tunnel|fixtures]
//   live     browser -> http://ranch-ai.tail6d04cd.ts.net:5090 (tailnet; 5090 is tailnet-only since 23 Oct), oracle -> ssh tunnel 127.0.0.1:5091
//   tunnel   browser -> http://127.0.0.1:5097 (ssh tunnel to the mini's 5090), oracle -> 127.0.0.1:5091
//   fixtures browser -> local standalone build on 5096 over the fixture daemon on 5095 (no ranch needed)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './tasks.ts';
import { daemonApi, judge, type Answer, type Expected } from './oracle.ts';

const here = dirname(fileURLToPath(import.meta.url)); const app = join(here, '..', '..'); const repo = join(app, '..', '..');
const MODEL = process.env.RANCH_E2E_MODEL || 'haiku'; const TARGET = process.env.RANCH_E2E_TARGET || 'fixtures'; const ONLY = process.env.RANCH_E2E_TASK || '';
const MCP_VERSION = '0.0.83';
const targets = { live: { base: 'http://ranch-ai.tail6d04cd.ts.net:5090', daemon: 'http://127.0.0.1:5091' }, tunnel: { base: 'http://127.0.0.1:5097', daemon: 'http://127.0.0.1:5091' }, fixtures: { base: 'http://127.0.0.1:5096', daemon: 'http://127.0.0.1:5095' } } as const;
if (!(TARGET in targets)) { console.error(`unknown target ${TARGET}`); process.exit(2); }
const { base, daemon } = targets[TARGET as keyof typeof targets];

const waitFor = async (url: string, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`not up: ${url}`); };
const children: ChildProcess[] = [];
if (TARGET === 'fixtures') {
  if (!existsSync(join(app, '.next', 'standalone', 'apps', 'web', 'server.js'))) { console.error('no standalone build: run `npm -w apps/web run build` first'); process.exit(2); }
  children.push(spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(app, 'test', 'fixture-server.ts'), '5095'], { stdio: 'ignore' }));
  children.push(spawn(process.execPath, [join(app, '.next', 'standalone', 'apps', 'web', 'server.js')], { stdio: 'ignore', env: { ...process.env, PORT: '5096', HOSTNAME: '127.0.0.1', RANCH_DAEMON_URL: daemon, RANCH_APP_DIR: repo, NODE_ENV: 'production' } }));
  await waitFor(`${daemon}/api/ping`); await waitFor(`${base}/api/ui/health`);
}
process.on('exit', () => { for (const c of children) c.kill(); });

const work = mkdtempSync(join(tmpdir(), 'ranch-e2e-ai-')); // neutral cwd: no project hooks, .mcp.json or CLAUDE.md
const mcpConfig = join(work, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: [`@playwright/mcp@${MCP_VERSION}`, '--headless', '--isolated', '--viewport-size', '1280x900', '--allowed-origins', base] } } }, null, 2));
const schema = JSON.stringify({ type: 'object', properties: { answer: { type: 'string' }, value: { type: 'string' } }, required: ['answer'] });
const allowed = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_wait_for', 'browser_take_screenshot', 'browser_navigate_back'].map((t) => `mcp__playwright__${t}`).join(',');
const api = daemonApi(daemon);
const runsDir = join(here, 'runs'); mkdirSync(runsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const report: Record<string, unknown>[] = []; let failures = 0;

for (const task of tasks) {
  if (ONLY && task.name !== ONLY) continue;
  const model = process.env.RANCH_E2E_MODEL ? MODEL : (task.model ?? MODEL);
  const before = await task.oracle(api).catch((e: Error) => ({ kind: 'predicate', describe: `oracle failed: ${e.message}`, check: () => false }) as Expected);
  const prompt = `${task.goal}\n\nThe dashboard is at ${base} (start by navigating there).`;
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--max-turns', String(task.maxTurns ?? 20), '--max-budget-usd', '0.50',
    '--strict-mcp-config', '--mcp-config', mcpConfig, '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence',
    '--append-system-prompt-file', join(here, 'rubric.md'), '--json-schema', schema, '--allowedTools', allowed];
  const t0 = Date.now();
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.CLAUDECODE; // subscription auth, never the API key; not nested in a Claude session
  const r = spawnSync('claude', args, { cwd: work, env, encoding: 'utf8', maxBuffer: 64e6, timeout: 15 * 60_000 });
  let out: { result?: string; structured_output?: Answer; session_id?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean; subtype?: string } = {};
  try { out = JSON.parse(r.stdout) as typeof out; } catch { out = { result: r.stdout.slice(0, 2000) }; }
  const answer: Answer = out.structured_output ?? { answer: out.result ?? '' };
  const after = await task.oracle(api).catch(() => before);
  const j1 = judge(before, answer), j2 = judge(after, answer); const pass = j1.pass || j2.pass;
  if (!pass) failures++;
  const row = { task: task.name, model, pass, answer, why: pass ? (j1.pass ? j1.why : j2.why) : j1.why, seconds: +((Date.now() - t0) / 1000).toFixed(1), turns: out.num_turns ?? null, cost_estimate_usd: out.total_cost_usd ?? null, session_id: out.session_id ?? null, exit: r.status, subtype: out.subtype ?? null, stderr: r.stderr.slice(-600) };
  report.push(row);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${task.name.padEnd(22)} ${model.padEnd(7)} ${row.seconds}s  turns ${row.turns ?? '?'}  ~$${row.cost_estimate_usd?.toFixed(3) ?? '?'}  answer: ${(answer.value ?? answer.answer).slice(0, 80)}  (${row.why})`);
}
writeFileSync(join(runsDir, `${stamp}.json`), JSON.stringify({ stamp, target: TARGET, base, model: MODEL, report }, null, 2) + '\n');
console.log(`\n${report.length - failures}/${report.length} passed · report e2e/ai/runs/${stamp}.json`);
rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
