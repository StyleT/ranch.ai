// WebRTC signalling proxy (WHEP): the browser POSTs its SDP offer here, the web app forwards it to go2rtc on loopback
// (go2rtc's API is loopback-only), and returns go2rtc's SDP answer. The media itself flows browser <-> go2rtc directly
// on the tailnet (go2rtc advertises the mini's tailnet address as its ICE candidate). A WebRTC consumer shares the
// producer the recorder already holds, so it never re-dials the camera (docs/CAMERA-ARCHITECTURE.md). That holds only while
// the recorder holds it: with no producer, an offer makes go2rtc dial the camera itself. So the offer is refused (409
// camera_offline, go2rtc not contacted) unless the camera's ring got packets within LIVE_ATTACH_MAX_RING_S (NFR-1, NFR-10).
import { env } from './env.ts';
import { UpstreamError } from './daemon.ts';
import { getStatus } from './home.ts';
import { sessionHeld } from '@/lib/live';

export const CAMERA_NAME = /^[a-z0-9_]{1,40}$/;

/** Throws 409 camera_offline unless the recorder holds the camera's session (status is cached 3 s). */
export async function assertSessionHeld(camera: string): Promise<void> {
  const cam = (await getStatus()).cameras.find((c) => c.name === camera);
  const ring = cam?.ring_age_s ?? null;
  if (!sessionHeld(ring)) {
    throw new UpstreamError(
      409,
      'camera_offline',
      `${camera}: no held session (ring ${ring === null ? 'none' : `${ring} s`}), not dialling the camera for a viewer`,
    );
  }
}

export async function proxyWebrtcOffer(camera: string, offerSdp: string, signal: AbortSignal): Promise<Response> {
  if (!CAMERA_NAME.test(camera)) {
    throw new UpstreamError(404, 'not_found', `no camera ${camera}`);
  }
  if (!offerSdp.startsWith('v=')) {
    throw new UpstreamError(400, 'bad_offer', 'expected an SDP offer body');
  }
  await assertSessionHeld(camera);
  let up: Response;
  try {
    up = await fetch(`${env.go2rtcUrl}/api/webrtc?src=${encodeURIComponent(camera)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offerSdp,
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new UpstreamError(503, 'go2rtc_unreachable', e instanceof Error ? e.message : String(e));
  }
  const answer = await up.text();
  if (!up.ok) {
    throw new UpstreamError(502, 'webrtc_failed', `go2rtc webrtc -> ${up.status}: ${answer.slice(0, 120)}`);
  }
  return new Response(answer, {
    status: 200,
    headers: { 'content-type': 'application/sdp', 'cache-control': 'no-store' },
  });
}
