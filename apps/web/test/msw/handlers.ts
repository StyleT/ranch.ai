// Default MSW handlers: the daemon as recorded in test/fixtures/daemon (docs/WEB-DASHBOARD.md §6).
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAvailability } from '../fixtures/availability.ts';
import { makeRemediation } from '../fixtures/remediation.ts';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FX, 'daemon', `${name}.json`), 'utf8')) as T;
export const DAEMON = 'http://127.0.0.1:5091';
export const GO2RTC = 'http://127.0.0.1:1984';

export const handlers = [
  http.post(`${GO2RTC}/api/webrtc`, async ({ request }) => { const body = await request.text(); return body.startsWith('v=') ? new HttpResponse('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n', { headers: { 'content-type': 'application/sdp' } }) : HttpResponse.text('bad', { status: 400 }); }),
  http.get(`${DAEMON}/api/status`, () => HttpResponse.json(fixture('status'))),
  http.get(`${DAEMON}/api/ping`, () => HttpResponse.json(fixture('ping'))),
  http.get(`${DAEMON}/api/bridge`, () => HttpResponse.json(fixture('bridge'))),
  http.get(`${DAEMON}/api/remediation`, ({ request }) => HttpResponse.json(makeRemediation(Date.now(), new URL(request.url).searchParams.get('camera')))),
  http.get(`${DAEMON}/api/availability`, ({ request }) => { const u = new URL(request.url); return HttpResponse.json(makeAvailability(fixture<{ cameras: { name: string }[] }>('status').cameras.map((c) => c.name), Date.now(), u.searchParams.get('bucket') === '1h' ? 3600 : 900, u.searchParams.get('camera'))); }),
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
  http.get(`${DAEMON}/api/live/:cam/:file`, ({ params }) => {
    if (params.cam === 'mops_cam') return HttpResponse.text('no live file', { status: 404 });
    if (params.file === 'index.m3u8') return new HttpResponse('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-10-23T12:00:00.000Z\nseg000007.m4s\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'x-live-age-s': '1' } });
    if (params.file === 'init.mp4' || params.file === 'seg000007.m4s') return new HttpResponse(readFileSync(join(FX, 'hls', params.file === 'init.mp4' ? 'init.mp4' : 'seg000000.m4s')), { headers: { 'content-type': 'video/mp4', 'cache-control': params.file === 'init.mp4' ? 'no-store' : 'max-age=60' } });
    return HttpResponse.text('no live file', { status: 404 });
  }),
  http.get(`${DAEMON}/api/buffer/:cam`, ({ params }) => (params.cam === 'mops_cam' ? HttpResponse.text('no buffered frame', { status: 404 }) : new HttpResponse(readFileSync(join(FX, 'images', 'frame-320.jpg')), { headers: { 'content-type': 'image/jpeg', 'x-frame-ts': '2026-10-22T12:00:00.000Z' } }))),
  http.get(`${DAEMON}/api/frame/:key`, () => new HttpResponse(readFileSync(join(FX, 'images', 'frame-320.jpg')), { headers: { 'content-type': 'image/jpeg', 'x-frame-id': '1', 'x-frame-ts': '2026-10-22T12:00:00.000Z' } })),
];
