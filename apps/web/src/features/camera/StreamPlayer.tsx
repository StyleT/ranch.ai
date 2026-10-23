'use client';
// The live view: the recorder's HLS output (video copied from the camera, AAC audio) served by the daemon through
// /api/ui/hls (docs/WEB-DASHBOARD.md). Safari and iOS play HLS natively; everything else gets hls.js. Nothing here
// touches go2rtc or a camera: any number of viewers reads the same files. The badge is derived from facts
// (liveState.ts): the playlist's age says whether the recorder is receiving frames, the video element says whether
// they are being played; a frozen picture is never labelled LIVE. Autoplay is muted (browser policy); one tap unmutes.
import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { tid } from '@/lib/testids';
import { deriveLiveState, parsePlaylist, retryDelayMs, badgeText, type LiveFacts } from './liveState';

const POLL_MS = 2_000;   // poll the tiny playlist often so x-live-age-s stays fresh and the latency badge is honest
const nativeHls = (v: HTMLVideoElement) => v.canPlayType('application/vnd.apple.mpegurl') !== '';

export function StreamPlayer({ camera, poster, playlist }: { camera: string; poster: string; playlist: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastTime = useRef(0);   // last currentTime seen advancing (reset on every attach)
  const [visible, setVisible] = useState(true);
  const [muted, setMuted] = useState(true);
  const [attach, setAttach] = useState(0);          // bumps to re-attach after a fatal error
  const [failures, setFailures] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [facts, setFacts] = useState<Omit<LiveFacts, 'nowMs' | 'visible'>>(() => ({ startedMs: Date.now(), playlistAgeS: null, playlistPolledMs: null, edgeGapS: null, lastProgressMs: null, error: false }));

  // page visibility: tear the player down when hidden so nothing is fetched for a page nobody sees
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible'); const onHide = () => setVisible(false);
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // attach the source (native or hls.js); re-run on visibility and on explicit re-attach
  useEffect(() => {
    const video = videoRef.current; if (!video || !visible) return;
    let hls: Hls | null = null; let cancelled = false;
    lastTime.current = 0;
    setFacts((f) => ({ ...f, startedMs: Date.now(), lastProgressMs: null, error: false }));
    const fail = () => { if (cancelled) return; setFacts((f) => ({ ...f, error: true })); setFailures((n) => n + 1); };
    // Muted autoplay must be decided by the browser with the element already muted: React's `muted` prop is a property
    // set after hydration, not a server-rendered attribute, so set it imperatively before any play() (23 Oct: Chrome
    // loaded the stream to readyState 4 and never started it).
    video.muted = true; video.defaultMuted = true;
    const play = () => { if (!cancelled) video.play().catch(() => undefined); };
    if (nativeHls(video)) { video.src = playlist; video.addEventListener('loadedmetadata', play, { once: true }); play(); }
    else {
      void import('hls.js').then(({ default: HlsCtor }) => {
        if (cancelled || !HlsCtor.isSupported()) { if (!cancelled) fail(); return; }
        // 1 s segments, on-demand encoder is real-time at the recorder (0 s), so the latency is all hls.js hold-back.
        // Sit ~1.5 s behind the edge, speed up to 1.5x to catch up, cap at 4 s. lowLatencyMode makes hls.js target the
        // edge aggressively even without LL-HLS parts. Measured glass-to-glass after this: see docs/WEB-DASHBOARD.md.
        hls = new HlsCtor({ liveSyncDuration: 1, liveMaxLatencyDuration: 3, maxLiveSyncPlaybackRate: 2, liveDurationInfinity: true, lowLatencyMode: true, enableWorker: true, backBufferLength: 4 });
        hls.on(HlsCtor.Events.ERROR, (_e, data) => { if (data.fatal) fail(); });
        hls.on(HlsCtor.Events.MANIFEST_PARSED, play);
        hls.on(HlsCtor.Events.FRAG_BUFFERED, () => { if (video.paused) play(); });
        hls.loadSource(playlist); hls.attachMedia(video);
      });
    }
    return () => { cancelled = true; hls?.destroy(); video.removeAttribute('src'); video.load(); };
  }, [playlist, visible, attach]);

  // re-attach after a fatal error with backoff
  useEffect(() => { if (!facts.error) return; const t = setTimeout(() => setAttach((n) => n + 1), retryDelayMs(failures)); return () => clearTimeout(t); }, [facts.error, failures]);

  // the recorder's view: poll the playlist (tiny) for its write age, native and hls.js alike
  useEffect(() => {
    if (!visible) return; let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(playlist, { cache: 'no-store' }); if (stop) return;
        const age = Number(r.headers.get('x-live-age-s')); if (r.ok) parsePlaylist(await r.text());
        setFacts((f) => ({ ...f, playlistAgeS: r.ok && Number.isFinite(age) ? age : (r.status === 404 ? 999 : f.playlistAgeS), playlistPolledMs: Date.now() }));
      } catch { /* next poll */ }
    };
    void poll(); const t = setInterval(() => void poll(), POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [playlist, visible]);

  // the viewer's view: is currentTime advancing, and how far behind the buffered edge is the playhead?
  // progress = currentTime moved forward by more than 50 ms (a first timeupdate at 0 is not progress: 23 Oct a frozen
  // player was reported LIVE for 8 s because the initial sentinel made 0 count as an advance)
  const onTimeUpdate = () => {
    const v = videoRef.current; if (!v) return;
    if (v.currentTime > lastTime.current + 0.05) {
      lastTime.current = v.currentTime;
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null;
      setFacts((f) => ({ ...f, lastProgressMs: Date.now(), error: false, edgeGapS: end === null ? f.edgeGapS : Math.max(0, end - v.currentTime) }));
    }
  };
  const onPlaying = () => setFailures(0);

  const state = deriveLiveState({ ...facts, nowMs: now, visible });
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); if (!v.muted) v.play().catch(() => undefined); };
  const showPoster = state.kind !== 'live' && state.kind !== 'stalled';
  return (
    <div data-testid={tid.streamPlayer} data-mode={state.kind} data-latency-s={state.kind === 'live' && state.latencyS !== null ? state.latencyS : undefined} className="relative aspect-video overflow-hidden rounded-card bg-black">
      <video ref={videoRef} muted={muted} playsInline autoPlay preload="none" poster={poster} aria-label={`${camera} live video`} onTimeUpdate={onTimeUpdate} onPlaying={onPlaying} onError={() => setFacts((f) => ({ ...f, error: true }))} className={`h-full w-full object-contain ${showPoster && state.kind !== 'starting' ? 'opacity-0' : ''}`} />
      {showPoster && state.kind !== 'starting' && <img src={poster} alt={`${camera} latest frame`} className="absolute inset-0 h-full w-full object-cover opacity-70" />}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white" aria-live="polite">{badgeText(state, now)}</span>
      <button type="button" data-testid={tid.streamMute} onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Unmute' : 'Mute'} className="absolute right-1.5 bottom-1.5 min-h-touch min-w-touch rounded-full bg-black/70 px-3 text-sm text-white">{muted ? '🔇' : '🔊'}</button>
    </div>
  );
}
