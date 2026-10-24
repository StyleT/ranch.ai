// Live-view probe: the real dashboard, the real network path (the tailnet, like the phone), every camera.
// It measures what a viewer sees, never a proxy (.claude/skills/verify-dashboard/SKILL.md):
//   - the player's own state (data-mode, data-transport, badge text), the <video>'s decoded size and readyState;
//   - progress: currentTime sampled twice SAMPLE_S apart must advance at ~1x (on 23 Oct a frozen picture sat under
//     LIVE badges while every file-freshness check was green);
//   - a PNG of the video frame and the wall clock at capture, for glass-to-glass latency: read the camera's burned-in
//     clock (OSD) in the PNG and subtract it from `wall`. The PNG is the evidence; look at it.
// The daemon's view (connected/state/buffer age from /api/ui/home) is printed next to the player's so a disagreement
// shows. A harness failure (timeout, selector, launch) is reported as UNVERIFIED, never as a product verdict.
// Chrome channel: Playwright's bundled Chromium cannot decode H.264.
//   node apps/web/e2e/live/probe.mjs [cam,cam]     env: RANCH_WEB_URL, SETTLE_S (8), SAMPLE_S (4), OUT_DIR
// Exit 0 only if every camera is either verified live (connected and advancing) or honestly not live (disconnected
// and not claiming LIVE).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.RANCH_WEB_URL ?? 'http://ranch-ai.tail6d04cd.ts.net:5090';
const SETTLE_S = Number(process.env.SETTLE_S ?? 8);
const SAMPLE_S = Number(process.env.SAMPLE_S ?? 4);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = process.env.OUT_DIR ?? fileURLToPath(new URL(`../ai/runs/live-${stamp}/`, import.meta.url));   // git-ignored, not synced
mkdirSync(OUT, { recursive: true });

const home = await (await fetch(`${BASE}/api/ui/home`, { signal: AbortSignal.timeout(10_000) })).json();
const daemon = Object.fromEntries(home.cameras.map((c) => [c.name, { connected: c.connected, state: c.state, buffer_age_s: c.buffer_age_s }]));
const cams = process.argv[2] ? process.argv[2].split(',') : home.cameras.map((c) => c.name);

const sample = (page) => page.evaluate(() => {
  const p = document.querySelector('[data-testid=stream-player]'); const v = p?.querySelector('video');
  return { mode: p?.getAttribute('data-mode') ?? null, transport: p?.getAttribute('data-transport') ?? null, badge: p?.querySelector('span')?.textContent ?? null,
    t: v?.currentTime ?? null, w: v?.videoWidth ?? 0, h: v?.videoHeight ?? 0, readyState: v?.readyState ?? 0 };
});

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const rows = [];
for (const cam of cams) {
  const row = { cam, daemon: daemon[cam] ?? null };
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(`${BASE}/cameras/${cam}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(SETTLE_S * 1000);
    const a = await sample(page); await page.waitForTimeout(SAMPLE_S * 1000); const b = await sample(page);
    const box = await page.locator('[data-testid=stream-player] video').boundingBox();
    // the badge and the mute button sit over the camera's OSD corners (the seconds of the clock): hide them for the shot
    await page.evaluate(() => document.querySelectorAll('[data-testid=stream-player] > :not(video)').forEach((el) => { el.style.visibility = 'hidden'; }));
    const wall = new Date();
    const png = `${OUT}${cam}.png`;
    if (box) await page.screenshot({ path: png, clip: box, timeout: 10_000 });
    const advanced = a.t !== null && b.t !== null ? +(b.t - a.t).toFixed(2) : null;
    Object.assign(row, { mode: b.mode, transport: b.transport, badge: b.badge, size: `${b.w}x${b.h}`, readyState: b.readyState,
      advanced_s: advanced, rate: advanced === null ? null : +(advanced / SAMPLE_S).toFixed(2),
      wall: wall.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' }), png: box ? png : null });
    const progressing = advanced !== null && advanced > 0.5 * SAMPLE_S && b.w > 0;
    const claimsLive = b.mode === 'live' || /^LIVE/.test(b.badge ?? '');
    if (row.daemon?.connected) row.verdict = progressing && b.mode === 'live' ? 'LIVE' : 'FAIL: connected camera not playing';
    else row.verdict = claimsLive && !progressing ? 'FAIL: claims LIVE, picture not advancing' : (progressing ? 'WARN: plays although the daemon says disconnected' : 'not live (honest)');
  } catch (e) {
    row.verdict = `UNVERIFIED: harness error: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
  } finally { await page.close(); }
  rows.push(row); console.log(JSON.stringify(row));
}
await browser.close();
const bad = rows.filter((r) => /^(FAIL|UNVERIFIED)/.test(r.verdict));
console.log(`probe: ${rows.length} camera(s), ${rows.filter((r) => r.verdict === 'LIVE').length} live, ${bad.length} failed/unverified; PNGs in ${OUT} (read each OSD clock against "wall")`);
process.exit(bad.length ? 1 : 0);
