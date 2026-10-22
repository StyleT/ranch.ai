// After `next build` with output: 'standalone': copy static assets and public/ next to the standalone server, and
// write BUILD_INFO.json for /api/ui/health (docs/WEB-DASHBOARD.md).
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = join(app, '.next', 'standalone', 'apps', 'web');
if (!existsSync(standalone)) { console.error('no standalone output at', standalone); process.exit(1); }
mkdirSync(join(standalone, '.next'), { recursive: true });
cpSync(join(app, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
if (existsSync(join(app, 'public'))) cpSync(join(app, 'public'), join(standalone, 'public'), { recursive: true });
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: app, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();
writeFileSync(join(standalone, 'BUILD_INFO.json'), JSON.stringify({ commit, built_at: new Date().toISOString(), node: process.version }, null, 2) + '\n');
console.log('postbuild: static + public copied, BUILD_INFO written', { commit });
