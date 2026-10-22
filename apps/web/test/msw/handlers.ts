// Default MSW handlers: the daemon as recorded in test/fixtures/daemon (docs/WEB-DASHBOARD.md §6).
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FX, 'daemon', `${name}.json`), 'utf8')) as T;
export const DAEMON = 'http://127.0.0.1:5091';
export const GO2RTC = 'http://127.0.0.1:1984';

export const handlers = [
  http.get(`${DAEMON}/api/status`, () => HttpResponse.json(fixture('status'))),
  http.get(`${DAEMON}/api/ping`, () => HttpResponse.json(fixture('ping'))),
  http.get(`${DAEMON}/api/frames`, ({ request }) => { const u = new URL(request.url); return HttpResponse.json(fixture(u.searchParams.get('moving') === '1' ? 'frames-moving' : 'frames')); }),
  http.get(`${DAEMON}/api/frames/:id`, ({ params }) => (params.id === '999999' ? HttpResponse.json({ error: 'no such frame' }, { status: 404 }) : HttpResponse.json(fixture('frame-head')))),
  http.get(`${DAEMON}/api/tracks`, () => HttpResponse.json(fixture('tracks'))),
  http.get(`${DAEMON}/api/counts/series`, () => HttpResponse.json(fixture('counts-series'))),
  http.get(`${DAEMON}/api/frames/series`, () => HttpResponse.json(fixture('frames-series'))),
  http.get(`${DAEMON}/api/taxonomy`, () => HttpResponse.json(fixture('taxonomy'))),
  http.get(`${DAEMON}/api/taxonomy/versions`, () => HttpResponse.json(fixture('taxonomy-versions'))),
  http.get(`${DAEMON}/api/taxonomy/versions/:id`, () => HttpResponse.json(fixture('taxonomy-version'))),
  http.post(`${DAEMON}/api/taxonomy/validate`, () => HttpResponse.json({ ok: true })),
  http.post(`${DAEMON}/api/taxonomy/score`, () => HttpResponse.json(fixture('score-draft'))),
  http.post(`${DAEMON}/api/taxonomy/apply`, ({ request }) => (request.headers.get('x-ranch-token') === 'test-token' ? HttpResponse.json({ ok: true, id: 99 }) : HttpResponse.json({ error: 'bad or missing x-ranch-token' }, { status: 403 }))),
  http.post(`${DAEMON}/api/taxonomy/revert`, ({ request }) => (request.headers.get('x-ranch-token') === 'test-token' ? HttpResponse.json({ ok: true, id: 100 }) : HttpResponse.json({ error: 'bad or missing x-ranch-token' }, { status: 403 }))),
  http.get(`${DAEMON}/api/baseline`, () => HttpResponse.json(fixture('baseline'))),
  http.get(`${DAEMON}/api/baseline/:date`, () => HttpResponse.json(fixture('baseline-set'))),
  http.get(`${DAEMON}/api/frame/:key`, () => new HttpResponse(readFileSync(join(FX, 'images', 'frame-320.jpg')), { headers: { 'content-type': 'image/jpeg', 'x-frame-id': '1', 'x-frame-ts': '2026-10-22T12:00:00.000Z' } })),
  http.get(`${GO2RTC}/api/stream.mjpeg`, () => new HttpResponse('--frame\r\n', { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' } })),
  http.get(`${GO2RTC}/api/stream.mp4`, () => new HttpResponse(new Uint8Array([0, 0, 0, 24]), { headers: { 'content-type': 'video/mp4' } })),
  http.get(`${GO2RTC}/api/frame.jpeg`, () => new HttpResponse(readFileSync(join(FX, 'images', 'frame-320.jpg')), { headers: { 'content-type': 'image/jpeg' } })),
];
