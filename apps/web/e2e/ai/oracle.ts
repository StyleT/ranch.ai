// Oracles compute the expected answer from the daemon API directly (never from the UI) through @ranch/contracts.
import * as C from '@ranch/contracts';

export interface DaemonApi { get<T extends import('zod').ZodType>(schema: T, path: string): Promise<import('zod').infer<T>>; post(path: string, body: unknown): Promise<unknown> }
export const daemonApi = (base: string): DaemonApi => ({
  async get(schema, path) { const r = await fetch(base + path, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${path} -> ${r.status}`); return C.parseContract(schema, await r.json(), path); },
  async post(path, body) { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) }); if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json(); },
});

export type Expected =
  | { kind: 'name'; value: string; alternates?: string[] }
  | { kind: 'number'; value: number; tolerance: number }
  | { kind: 'enum'; value: string }
  | { kind: 'set'; values: string[] }
  | { kind: 'predicate'; describe: string; check: (a: Answer) => boolean };
export interface Answer { answer: string; value?: string }

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '_').replace(/_cam$/, '');
/** Camera-like names mentioned anywhere in the text (`donkey_cam`, `wash_stall`, `front_porch`), normalized. */
const names = (s: string) => new Set((s.toLowerCase().match(/\b[a-z0-9]+(?:_[a-z0-9]+)*\b/g) ?? []).filter((t) => /_cam$|_stall$|_porch$|_yard$|_pasture$|^mops|^tractor|^donkey/.test(t)).map(norm));
export function judge(exp: Expected, a: Answer): { pass: boolean; why: string } {
  const v = a.value ?? a.answer;
  switch (exp.kind) {
    case 'name': { const ok = [exp.value, ...(exp.alternates ?? [])].some((n) => norm(v).includes(norm(n)) || norm(a.answer).includes(norm(n))); return { pass: ok, why: `expected ${exp.value}${exp.alternates?.length ? ` (or ${exp.alternates.join('/')})` : ''}, got "${v}"` }; }
    case 'number': { const n = Number((v.match(/-?\d+(\.\d+)?/) ?? [])[0]); const ok = Number.isFinite(n) && Math.abs(n - exp.value) <= exp.tolerance; return { pass: ok, why: `expected ${exp.value}±${exp.tolerance}, got "${v}"` }; }
    case 'enum': { const ok = norm(v).includes(norm(exp.value)); return { pass: ok, why: `expected ${exp.value}, got "${v}"` }; }
    case 'set': { const got = names(`${v} ${a.answer}`); const want = new Set(exp.values.map(norm)); const ok = [...want].every((w) => got.has(w)) && [...got].every((g) => want.has(g)); return { pass: ok, why: `expected {${exp.values.join(', ')}}, got {${[...got].join(', ')}}` }; }
    case 'predicate': return { pass: exp.check(a), why: exp.describe };
  }
}
