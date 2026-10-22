'use client';
// Live view = the recorder's rolling buffer streamed as MJPEG by the status daemon (~1 frame / 2 s), always on while
// the page is visible (user decision 22 Oct). Nothing here touches go2rtc or a camera (docs/CAMERA-ARCHITECTURE.md).
// Stops on hide, pagehide and unmount so the daemon drops the stream.
import { useEffect, useState } from 'react';
import { tid } from '@/lib/testids';

export function StreamPlayer({ camera, poster, fps }: { camera: string; poster: string; fps: number }) {
  const [visible, setVisible] = useState(true); const [failed, setFailed] = useState(false); const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible'); const onHide = () => setVisible(false);
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  useEffect(() => { if (!failed) return; const t = setTimeout(() => { setFailed(false); setNonce((n) => n + 1); }, 10_000); return () => clearTimeout(t); }, [failed]);
  const live = visible && !failed;
  return (
    <div data-testid={tid.streamPlayer} data-mode={live ? 'buffer-mjpeg' : failed ? 'error' : 'paused'} className="relative aspect-video overflow-hidden rounded-card bg-black">
      {live ? <img key={nonce} src={`/api/ui/stream/${encodeURIComponent(camera)}?w=1280&n=${nonce}`} alt={`${camera} live, from the recorder buffer`} className="h-full w-full object-cover" onError={() => setFailed(true)} />
        : <img src={poster} alt={`${camera} latest frame`} className={`h-full w-full object-cover ${failed ? '' : 'opacity-60'}`} />}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">{live ? `LIVE · buffer ${fps} fps` : failed ? 'stream unavailable, retrying…' : 'PAUSED'}</span>
    </div>
  );
}
