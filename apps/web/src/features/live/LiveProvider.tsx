'use client';
// One EventSource for the app; SSE `status` writes into the home query; frame/tracks events bump thumbnails and
// invalidate lists; a watchdog reopens the stream after 45 s of silence and on visibility/online changes.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/query/keys';
import { initialConn, reduceConn, ageSeconds, type Conn } from './connection';
import { activityStore } from './activityStore';

type Live = { conn: Conn; now: number; thumbVersion: Record<string, number> };
const Ctx = createContext<Live>({ conn: initialConn(), now: 0, thumbVersion: {} });
export const useConnection = () => { const l = useContext(Ctx); return { ...l.conn, ageS: ageSeconds(l.conn, l.now) }; };
export const useThumbVersion = (camera: string) => useContext(Ctx).thumbVersion[camera] ?? 0;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [conn, setConn] = useState<Conn>(initialConn);
  const [now, setNow] = useState(() => Date.now());
  const [thumbVersion, setThumb] = useState<Record<string, number>>({});
  const es = useRef<EventSource | null>(null);
  const connRef = useRef<Conn>(initialConn());
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const apply = (e: Parameters<typeof reduceConn>[1]) => {
      const r = reduceConn(connRef.current, e, Date.now()); connRef.current = r.conn; setConn(r.conn);
      if (r.reconnect) open(); if (r.refetch) void qc.invalidateQueries();
    };
    const open = () => {
      es.current?.close();
      const s = new EventSource('/api/ui/live'); es.current = s;
      s.onopen = () => apply({ type: 'open' });
      s.onerror = () => apply({ type: 'error' });
      s.addEventListener('status', () => { apply({ type: 'status' }); void qc.invalidateQueries({ queryKey: keys.home() }); });
      s.addEventListener('frame', (ev) => { const d = JSON.parse((ev as MessageEvent).data) as { camera: string; frame_id: number }; setThumb((t) => ({ ...t, [d.camera]: d.frame_id })); });
      s.addEventListener('tracks', (ev) => { activityStore.push(JSON.parse((ev as MessageEvent).data)); if (!invalidateTimer.current) invalidateTimer.current = setTimeout(() => { invalidateTimer.current = null; void qc.invalidateQueries({ queryKey: ['detections'] }); }, 10_000); });
      s.addEventListener('mqtt', (ev) => activityStore.pushRaw(JSON.parse((ev as MessageEvent).data)));
      s.addEventListener('taxonomy', () => void qc.invalidateQueries({ queryKey: keys.taxonomy() }));
      s.addEventListener('daemon', () => void qc.invalidateQueries({ queryKey: keys.system() }));
    };
    open();
    const tick = setInterval(() => { setNow(Date.now()); apply({ type: 'tick' }); }, 5000);
    const onVis = () => { if (document.visibilityState === 'visible') apply({ type: 'visible' }); };
    const onShow = () => apply({ type: 'visible' });
    const onOffline = () => apply({ type: 'offline' }); const onOnline = () => apply({ type: 'online' });
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pageshow', onShow); window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    return () => { clearInterval(tick); es.current?.close(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pageshow', onShow); window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline); };
  }, [qc]);

  return <Ctx.Provider value={{ conn, now, thumbVersion }}>{children}</Ctx.Provider>;
}
export const useActivity = () => useSyncExternalStore(activityStore.subscribe, activityStore.get, activityStore.get);
