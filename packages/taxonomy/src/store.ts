// Active taxonomy on the mini (docs/TAXONOMY-UI.md §2): versions in SQLite, the active one loaded into this process
// and reloaded on the retained MQTT message. Duck-typed over the store so this package does not depend on events.
import { getTaxonomy, setTaxonomy, validateTaxonomy, canonical, type Taxonomy } from './index.ts';

export interface TaxonomyVersionRow { id: number; created: string; author: string; note: string | null; json: string; parent_id: number | null; score_json: string | null; gate: string | null; active: number }
export interface TaxonomyStore {
  activeTaxonomy(): TaxonomyVersionRow | undefined;
  taxonomyVersion(id: number): TaxonomyVersionRow | undefined;
  insertTaxonomyVersion(v: { author: string; note?: string; json: string; parent_id?: number | null; score_json?: string | null; gate?: string | null }): number;
}
export const TAXONOMY_TOPIC = 'ranch/taxonomy';
export interface TaxonomyMessage { version_id: number; created: string; author: string }

/** Load the active version into the process; when none exists, the repo file becomes version 1. */
export function activateFromStore(store: TaxonomyStore, log: (msg: string, extra?: Record<string, unknown>) => void): TaxonomyVersionRow {
  let row = store.activeTaxonomy();
  if (!row) {
    const id = store.insertTaxonomyVersion({ author: 'repo', note: 'initial version from packages/taxonomy/taxonomy.json', json: canonical(getTaxonomy()) });
    row = store.taxonomyVersion(id)!;
    log('taxonomy version created', { id, author: 'repo' });
  }
  applyRow(row, log);
  return row;
}

export function applyRow(row: TaxonomyVersionRow, log: (msg: string, extra?: Record<string, unknown>) => void): boolean {
  const v = validateTaxonomy(JSON.parse(row.json));
  if (!v.ok) { log('taxonomy version invalid, keeping current', { id: row.id, errors: v.errors.slice(0, 3) }); return false; }
  setTaxonomy(v.taxonomy, row.id);
  log('taxonomy active', { id: row.id, author: row.author, note: row.note ?? '' });
  return true;
}

/** True when the repo file and the active version differ (drift the dashboard shows and `make check` reports). */
export function differsFromRepo(repo: Taxonomy, row: TaxonomyVersionRow | undefined): boolean {
  return !row || canonical(repo) !== canonical(JSON.parse(row.json));
}
