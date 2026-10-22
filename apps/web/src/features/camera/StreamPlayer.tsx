'use client';
// Live stream through the BFF proxy, always on while the page is open (user decision 22 Oct): HLS on Safari, fMP4
// elsewhere, MJPEG fallback after an error or 8 s without data; stops on hide, pagehide and unmount so go2rtc drops
// the consumer. Cameras excluded from keep-alive get MJPEG only.
import { useEffect, useRef, useState } from 'react';
import { tid } from '@/lib/testids';

type Mode = 'mp4' | 'm3u8' | 'mjpeg' | 'off';
const isSafari = () => typeof navigator !== 'undefined' && /safari/i.test(navigator.userAgent) && !/chrome|chromium|android/i.test(navigator.userAgent);

export function StreamPlayer({ camera, excluded, poster }: { camera: string; excluded: boolean; poster: string }) {
  const initial: Mode = excluded ? 'mjpeg' : isSafari() ? 'm3u8' : 'mp4';
  const [mode, setMode] = useState<Mode>(initial); const [note, setNote] = useState<string | null>(excluded ? 'MJPEG only: this camera is excluded from continuous HD pulls' : null);
  const [visible, setVisible] = useState(true);
  const video = useRef<HTMLVideoElement>(null); const loaded = useRef(false);
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible'); const onHide = () => setVisible(false);
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  useEffect(() => {
    if (!visible || mode === 'mjpeg' || mode === 'off') return;
    loaded.current = false;
    const t = setTimeout(() => { if (!loaded.current) { setNote('video did not start, showing MJPEG'); setMode('mjpeg'); } }, 8000);
    return () => clearTimeout(t);
  }, [mode, visible]);
  const src = (m: Mode) => `/api/ui/stream/${encodeURIComponent(camera)}?fmt=${m}`;
  return (
    <div data-testid={tid.streamPlayer} data-mode={visible ? mode : 'paused'} className="relative aspect-video overflow-hidden rounded-card bg-black">
      {!visible ? <img src={poster} alt={`${camera} latest frame`} className="h-full w-full object-cover opacity-60" />
        : mode === 'mjpeg' ? <img src={src('mjpeg')} alt={`${camera} live (MJPEG)`} className="h-full w-full object-cover" onError={() => { setNote('stream unavailable'); setMode('off'); }} />
        : mode === 'off' ? <img src={poster} alt={`${camera} latest frame`} className="h-full w-full object-cover" />
        : <video key={mode} ref={video} src={src(mode)} poster={poster} autoPlay muted playsInline controls={false} className="h-full w-full object-cover"
            onLoadedData={() => { loaded.current = true; }} onError={() => { setNote('video failed, showing MJPEG'); setMode('mjpeg'); }} />}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">{!visible ? 'PAUSED' : mode === 'off' ? 'STILL' : `LIVE · ${mode === 'm3u8' ? 'HLS' : mode === 'mp4' ? 'fMP4' : 'MJPEG'}`}</span>
      {note && <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-2 py-0.5 text-[11px] text-white">{note}</span>}
    </div>
  );
}
