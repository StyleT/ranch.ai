import { z } from 'zod';
import { TaxonomyMeta, TaxonomyVersionFull } from '@ranch/contracts';
import { validateTaxonomy } from '@ranch/taxonomy';
import { daemonJson, daemonPost, cached, invalidate, json } from './daemon.ts';

export const getTaxonomy = () => cached('taxonomy', 5000, () => daemonJson(TaxonomyMeta, '/api/taxonomy'));
export const getTaxonomyVersion = (id: number) => cached(`taxonomy:v${id}`, 60_000, () => daemonJson(TaxonomyVersionFull, `/api/taxonomy/versions/${id}`));

const Actions = ['validate', 'score', 'apply', 'revert'] as const;
export type Action = (typeof Actions)[number];
export const isAction = (s: string): s is Action => (Actions as readonly string[]).includes(s);
const Body = z.object({ taxonomy: z.unknown().optional(), note: z.string().max(2000).optional(), score: z.unknown().optional(), id: z.number().int().optional() });

/** Pass a taxonomy action to the daemon. The write token travels only as a header, is never read or logged. */
export async function taxonomyAction(action: Action, rawBody: unknown, token: string | null): Promise<Response> {
  const body = Body.parse(rawBody);
  if (action === 'validate') { const v = validateTaxonomy(body.taxonomy); return json(v.ok ? { ok: true } : { errors: v.errors }, { status: v.ok ? 200 : 400 }); }
  if ((action === 'score' || action === 'apply') && !validateTaxonomy(body.taxonomy).ok) { const v = validateTaxonomy(body.taxonomy); return json(v.ok ? {} : { errors: v.errors }, { status: 400 }); }
  const r = await daemonPost(`/api/taxonomy/${action}`, body, { token, timeoutMs: action === 'score' ? 65_000 : 8000 });
  if (r.status === 200 && (action === 'apply' || action === 'revert')) invalidate('taxonomy'), invalidate('status');
  return json(r.body, { status: r.status });
}
