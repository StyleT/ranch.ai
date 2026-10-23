'use client';
// The live view. Primary transport is WebRTC: go2rtc sends the camera's native H.264, the browser decodes it,
// sub-second latency, no transcode (the signalling is proxied by the web app to go2rtc on loopback; the media flows
// browser <-> go2rtc directly on the tailnet). If WebRTC does not connect, it falls back to the recorder's on-demand
// HLS (docs/CAMERA-ARCHITECTURE.md). A WebRTC consumer shares the producer the recorder already holds, so it never
// re-dials the camera. The badge is derived from facts (the picture must advance to read LIVE), never asserted.
import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { tid } from '@/lib/testids';
import { deriveLiveState, parsePlaylist, retryDelayMs, badgeText, type LiveFacts } from './liveState';

const POLL_MS = 2_000;
const WEBRTC_CONNECT_TIMEOUT_MS = 6_000;
const PROGRESS_STALL_MS = 6_000;
const nativeHls = (v: HTMLVideoElement) => v.canPlayType('application/vnd.apple.mpegurl') !== '';

type Transport = 'webrtc' | 'hls';

export function StreamPlayer({ camera, poster, playlist }: { camera: string; poster: string; playlist: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastTime = useRef(0);
  const [visible, setVisible] = useState(true);
  const [muted, setMuted] = useState(true);
  const [transport, setTransport] = useState<Transport>('webrtc');
  const [attach, setAttach] = useState(0);
  const [failures, setFailures] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [lastProgressMs, setLastProgressMs] = useState<number | null>(null);
  const [startedMs, setStartedMs] = useState(() => Date.now());
  const [error, setError] = useState(false);
  // HLS-only facts (playlist age / buffered edge), for the HLS fallback badge
  const [hlsFacts, setHlsFacts] = useState<Pick<LiveFacts, 'playlistAgeS' | 'playlistPolledMs' | 'edgeGapS'>>(() => ({ playlistAgeS: null, playlistPolledMs: null, edgeGapS: null }));

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible'); const onHide = () => setVisible(false);
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // attach the current transport; WebRTC first, HLS on fallback or on re-attach after a webrtc failure
  useEffect(() => {
    const video = videoRef.current; if (!video || !visible) return;
    let cancelled = false; let hls: Hls | null = null; let pc: RTCPeerConnection | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    lastTime.current = 0; setLastProgressMs(null); setStartedMs(Date.now()); setError(false);
    video.muted = true; video.defaultMuted = true;
    const play = () => { if (!cancelled) video.play().catch(() => undefined); };
    const fallbackToHls = () => { if (cancelled) return; setTransport('hls'); };

    if (transport === 'webrtc') {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => { if (!cancelled && e.streams[0]) { video.srcObject = e.streams[0]; play(); } };
      pc.addEventListener('connectionstatechange', () => { if (!pc) return; if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') fallbackToHls(); });
      timer = setTimeout(() => { if (!cancelled && pc && pc.connectionState !== 'connected') fallbackToHls(); }, WEBRTC_CONNECT_TIMEOUT_MS);
      void (async () => {
        try {
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
          await new Promise<void>((r) => { if (pc!.iceGatheringState === 'complete') return r(); const h = () => { if (pc!.iceGatheringState === 'complete') { pc!.removeEventListener('icegatheringstatechange', h); r(); } }; pc!.addEventListener('icegatheringstatechange', h); setTimeout(r, 2500); });
          if (cancelled) return;
          const resp = await fetch(`/api/ui/webrtc/${encodeURIComponent(camera)}`, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
          if (!resp.ok) return fallbackToHls();
          await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
        } catch { fallbackToHls(); }
      })();
    } else {
      video.srcObject = null;
      const fail = () => { if (cancelled) return; setError(true); setFailures((n) => n + 1); };
      if (nativeHls(video)) { video.src = playlist; video.addEventListener('loadedmetadata', play, { once: true }); play(); }
      else {
        void import('hls.js').then(({ default: HlsCtor }) => {
          if (cancelled || !HlsCtor.isSupported()) { if (!cancelled) fail(); return; }
          hls = new HlsCtor({ liveSyncDuration: 1, liveMaxLatencyDuration: 3, maxLiveSyncPlaybackRate: 2, liveDurationInfinity: true, lowLatencyMode: true, enableWorker: true, backBufferLength: 4 });
          hls.on(HlsCtor.Events.ERROR, (_e, d) => { if (d.fatal) fail(); });
          hls.on(HlsCtor.Events.MANIFEST_PARSED, play); hls.on(HlsCtor.Events.FRAG_BUFFERED, () => { if (video.paused) play(); });
          hls.loadSource(playlist); hls.attachMedia(video);
        });
      }
    }
    return () => { cancelled = true; if (timer) clearTimeout(timer); hls?.destroy(); if (pc) { pc.getReceivers().forEach((r) => r.track?.stop()); pc.close(); } video.removeAttribute('src'); video.srcObject = null; video.load(); };
  }, [camera, playlist, visible, attach, transport]);

  // re-attach after a fatal HLS error with backoff
  useEffect(() => { if (!error) return; const t = setTimeout(() => setAttach((n) => n + 1), retryDelayMs(failures)); return () => clearTimeout(t); }, [error, failures]);

  // HLS fallback: poll the playlist for its write age (WebRTC needs no polling)
  useEffect(() => {
    if (!visible || transport !== 'hls') return; let stop = false;
    const poll = async () => {
      try { const r = await fetch(playlist, { cache: 'no-store' }); if (stop) return; const age = Number(r.headers.get('x-live-age-s')); if (r.ok) parsePlaylist(await r.text());
        setHlsFacts((f) => ({ ...f, playlistAgeS: r.ok && Number.isFinite(age) ? age : (r.status === 404 ? 999 : f.playlistAgeS), playlistPolledMs: Date.now() })); } catch { /* next poll */ }
    };
    void poll(); const t = setInterval(() => void poll(), POLL_MS); return () => { stop = true; clearInterval(t); };
  }, [playlist, visible, transport]);

  const onTimeUpdate = () => {
    const v = videoRef.current; if (!v) return;
    if (v.currentTime > lastTime.current + 0.05) {
      lastTime.current = v.currentTime; setLastProgressMs(Date.now()); setError(false);
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null;
      if (end !== null) setHlsFacts((f) => ({ ...f, edgeGapS: Math.max(0, end - v.currentTime) }));
    }
  };
  const onPlaying = () => setFailures(0);

  // badge + mode: WebRTC is sub-second, so LIVE while the picture advances; otherwise reuse the HLS state machine
  let mode: string; let badge: string;
  if (!visible) { mode = 'paused'; badge = 'PAUSED'; }
  else if (transport === 'webrtc') {
    const progressing = lastProgressMs !== null && now - lastProgressMs < PROGRESS_STALL_MS;
    if (progressing) { mode = 'live'; badge = 'LIVE'; }
    else if (lastProgressMs === null && now - startedMs < WEBRTC_CONNECT_TIMEOUT_MS) { mode = 'starting'; badge = 'connecting…'; }
    else { mode = 'stalled'; badge = 'reconnecting…'; }
  } else {
    const s = deriveLiveState({ ...hlsFacts, nowMs: now, visible, startedMs, lastProgressMs, error });
    mode = s.kind; badge = badgeText(s, now);
  }
  const live = mode === 'live' || mode === 'stalled';

  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); if (!v.muted) v.play().catch(() => undefined); };
  return (
    <div data-testid={tid.streamPlayer} data-mode={mode} data-transport={transport} className="relative aspect-video overflow-hidden rounded-card bg-black">
      <video ref={videoRef} muted={muted} playsInline autoPlay preload="none" poster={poster} aria-label={`${camera} live video`} onTimeUpdate={onTimeUpdate} onPlaying={onPlaying} onError={() => transport === 'hls' && setError(true)} className={`h-full w-full object-contain ${!live && mode !== 'starting' ? 'opacity-0' : ''}`} />
      {!live && mode !== 'starting' && <img src={poster} alt={`${camera} latest frame`} className="absolute inset-0 h-full w-full object-cover opacity-70" />}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white" aria-live="polite">{badge}</span>
      <button type="button" data-testid={tid.streamMute} onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute' : 'Mute'} className="absolute right-1.5 bottom-1.5 min-h-touch min-w-touch rounded-full bg-black/70 px-3 text-sm text-white">{muted ? '🔇' : '🔊'}</button>
    </div>
  );
}
