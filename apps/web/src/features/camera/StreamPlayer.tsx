'use client';
// Live view = the recorder's rolling buffer streamed as MJPEG by the status daemon (~1 frame / 2 s), always on while
// the page is visible (user decision 22 Oct). Nothing here touches go2rtc or a camera (docs/CAMERA-ARCHITECTURE.md).
// Stops on hide, pagehide and unmount so the daemon drops the stream. After an error the retry waits 10, 20, 40, then
// 60 s between attempts (reset by a successful load): on 23 Oct a fixed 10 s retry re-crashed a broken daemon every
// 10 s for as long as the page stayed open.
import { useEffect, useState } from 'react';
import { tid } from '@/lib/testids';

export const retryDelayMs = (failures: number): number => Math.min(60_000, 10_000 * 2 ** Math.max(0, failures - 1));

export function StreamPlayer({ camera, poster, fps }: { camera: string; poster: string; fps: number }) {
  const [visible, setVisible] = useState(true); const [failed, setFailed] = useState(false); const [failures, setFailures] = useState(0); const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible'); const onHide = () => setVisible(false);
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, []);
  useEffect(() => { if (!failed) return; const t = setTimeout(() => { setFailed(false); setNonce((n) => n + 1); }, retryDelayMs(failures)); return () => clearTimeout(t); }, [failed, failures]);
  const live = visible && !failed; const waitS = Math.round(retryDelayMs(failures) / 1000);
  return (
    <div data-testid={tid.streamPlayer} data-mode={live ? 'buffer-mjpeg' : failed ? 'error' : 'paused'} data-retry-s={failed ? waitS : undefined} className="relative aspect-video overflow-hidden rounded-card bg-black">
      {live ? <img key={nonce} src={`/api/ui/stream/${encodeURIComponent(camera)}?w=1280&n=${nonce}`} alt={`${camera} live, from the recorder buffer`} className="h-full w-full object-cover" onLoad={() => setFailures(0)} onError={() => { setFailures((f) => f + 1); setFailed(true); }} />
        : <img src={poster} alt={`${camera} latest frame`} className={`h-full w-full object-cover ${failed ? '' : 'opacity-60'}`} />}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">{live ? `LIVE · buffer ${fps} fps` : failed ? `stream unavailable, retry in ${waitS} s` : 'PAUSED'}</span>
    </div>
  );
}
