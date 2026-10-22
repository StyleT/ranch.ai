import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PORT = 5095, WEB_PORT = 5096;
export const BASE = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e/playwright',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: BASE, trace: 'retain-on-failure', reducedMotion: 'reduce' },
  projects: [
    { name: 'iphone-13', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'ipad-mini', use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    { command: `node --experimental-strip-types --no-warnings test/fixture-server.ts ${FIXTURE_PORT}`, url: `http://127.0.0.1:${FIXTURE_PORT}/api/ping`, reuseExistingServer: !process.env.CI, cwd: here },
    { command: `node .next/standalone/apps/web/server.js`, url: `${BASE}/api/ui/health`, reuseExistingServer: !process.env.CI, cwd: here,
      env: { PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1', RANCH_DAEMON_URL: `http://127.0.0.1:${FIXTURE_PORT}`, RANCH_APP_DIR: join(here, '..', '..'), NODE_ENV: 'production' } },
  ],
});
