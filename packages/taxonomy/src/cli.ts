// Taxonomy versions from the command line (docs/TAXONOMY-UI.md §2). Runs on the mini from /usr/local/ranch/app.
//   node packages/taxonomy/src/cli.ts sync [--check]   repo file -> new active version when it differs; publishes the reload
//   node packages/taxonomy/src/cli.ts export            prints {taxonomy, version} of the active version (make taxonomy-pull)
//   node packages/taxonomy/src/cli.ts status            one line: active version and whether it matches the repo file
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus } from '@ranch/bus';
import { loadTaxonomyFile, canonical, REPO_TAXONOMY_FILE } from './index.ts';
import { differsFromRepo, TAXONOMY_TOPIC, type TaxonomyMessage } from './store.ts';

const [cmd, ...rest] = process.argv.slice(2);
const store = new EventStore(config.dbPath);
const repo = loadTaxonomyFile(REPO_TAXONOMY_FILE);
const active = store.activeTaxonomy();
const differs = differsFromRepo(repo, active);

if (cmd === 'status') {
  console.log(JSON.stringify({ active_id: active?.id ?? null, author: active?.author ?? null, created: active?.created ?? null, matches_repo: !differs }));
} else if (cmd === 'export') {
  if (!active) { console.error('no active taxonomy'); process.exit(1); }
  console.log(JSON.stringify({ taxonomy: JSON.parse(active.json), version: { id: active.id, created: active.created, author: active.author, note: active.note, gate: active.gate, score: active.score_json ? JSON.parse(active.score_json) : null } }, null, 2));
} else if (cmd === 'sync') {
  if (!differs) { console.log(JSON.stringify({ result: 'unchanged', active_id: active!.id })); }
  else if (rest.includes('--check')) { console.log(JSON.stringify({ result: 'would insert', active_id: active?.id ?? null })); }
  else {
    const id = store.insertTaxonomyVersion({ author: 'ansible', note: 'provision: repo file differs from the active version', json: canonical(repo), parent_id: active?.id ?? null });
    const bus = await connectBus('taxonomy-cli');
    await bus.publish(TAXONOMY_TOPIC, { version_id: id, created: new Date().toISOString(), author: 'ansible' } satisfies TaxonomyMessage, { retain: true });
    await bus.close();
    console.log(JSON.stringify({ result: 'inserted', active_id: id, previous: active?.id ?? null }));
  }
} else { console.error('usage: cli.ts sync [--check] | export | status'); process.exit(2); }
store.close();
