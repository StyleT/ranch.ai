'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useReducer, useRef, useState } from 'react';
import { keys } from '@/lib/query/keys';
import { apiGet, apiPost } from '@/lib/query/fetch';
import type { TaxonomyMeta, TaxonomyVersionFull, ScoreResponse } from '@ranch/contracts';
import type { Taxonomy } from '@ranch/taxonomy/schema';
import { reduce, isDirty, type Action } from './draftReducer';

export const useTaxonomyMeta = () => useQuery({ queryKey: keys.taxonomy(), queryFn: () => apiGet<TaxonomyMeta>('/api/ui/taxonomy'), refetchInterval: 60_000 });

/** The draft lives in sessionStorage keyed by the active version so a tab switch on a phone does not lose edits. */
export function useDraft(active: Taxonomy | undefined, activeId: number | undefined) {
  const key = `ranch.taxonomy.draft.v${activeId ?? '?'}`;
  const [draft, dispatch] = useReducer((t: Taxonomy | null, a: Action | { type: 'load'; taxonomy: Taxonomy }) => (a.type === 'load' ? a.taxonomy : t ? reduce(t, a) : t), null);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; });
  // (Re)load the draft only when the active VERSION changes, never on a mere refetch of the same version: a refetch
  // between an edit and its save must not wipe the edit.
  useEffect(() => { const a = activeRef.current; if (!a || activeId === undefined) return; let stored: Taxonomy | null = null; try { const s = sessionStorage.getItem(key); if (s) stored = JSON.parse(s) as Taxonomy; } catch { /* ignore */ } dispatch({ type: 'load', taxonomy: stored ?? structuredClone(a) }); }, [activeId, key]);
  useEffect(() => { if (!draft || !active) return; try { if (isDirty(active, draft)) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key); } catch { /* ignore */ } }, [draft, active, key]);
  const dirty = !!(draft && active && isDirty(active, draft));
  return { draft, dispatch, dirty, discard: () => { if (active) dispatch({ type: 'reset', taxonomy: active }); } };
}
export function useToken() {
  const [token, setTokenState] = useState(() => { if (typeof window === 'undefined') return ''; try { return sessionStorage.getItem('ranch_token') ?? ''; } catch { return ''; } });
  const setToken = (t: string) => { setTokenState(t); try { sessionStorage.setItem('ranch_token', t); } catch { /* ignore */ } };
  return { token, setToken };
}
export function useTaxonomyActions() {
  const qc = useQueryClient();
  const validate = (taxonomy: Taxonomy) => apiPost<{ ok?: true; errors?: string[] }>('/api/ui/taxonomy/validate', { taxonomy });
  const score = (taxonomy: Taxonomy) => apiPost<ScoreResponse | { errors?: string[]; error?: string }>('/api/ui/taxonomy/score', { taxonomy });
  const apply = async (taxonomy: Taxonomy, note: string, score: ScoreResponse | null, token: string) => { const r = await apiPost<{ ok?: true; id?: number; error?: string; errors?: string[] }>('/api/ui/taxonomy/apply', { taxonomy, note, score }, { 'x-ranch-token': token }); if (r.status === 200) await qc.invalidateQueries({ queryKey: keys.taxonomy() }); return r; };
  const revert = async (id: number, note: string, token: string) => { const r = await apiPost<{ ok?: true; id?: number; error?: string }>('/api/ui/taxonomy/revert', { id, note }, { 'x-ranch-token': token }); if (r.status === 200) await qc.invalidateQueries({ queryKey: keys.taxonomy() }); return r; };
  const loadVersion = (id: number) => apiGet<TaxonomyVersionFull>(`/api/ui/taxonomy/versions/${id}`);
  return { validate, score, apply, revert, loadVersion };
}
