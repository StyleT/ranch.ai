// MQTT topic contract for the ranch. Every surface subscribes here rather than polling SQLite.
//   ranch/frames/<camera>            one message per kept frame            {ts, camera, path, reason, change}
//   ranch/detections/<camera>        tier-1 output per frame              {ts, camera, frame_id, model, detections[]}
//   ranch/counts/<camera>            per-minute label counts              {ts, camera, model, counts: {horse: 2}}
//   ranch/events/<camera>/<type>     PLAN.md 4.4 event rows               RanchEvent
//   ranch/status/<service>           retained liveness                    {ts, pid, ...}
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '@ranch/config';

export const topics = {
  frames: (camera: string) => `ranch/frames/${camera}`,
  detections: (camera: string) => `ranch/detections/${camera}`,
  counts: (camera: string) => `ranch/counts/${camera}`,
  events: (camera: string, type: string) => `ranch/events/${camera}/${type}`,
  status: (service: string) => `ranch/status/${service}`,
  taxonomy: 'ranch/taxonomy',
  bursts: (camera: string) => `ranch/bursts/${camera}`,   // sampler: a burst closed {burst_id, frame_ids}
  tracks: (camera: string) => `ranch/tracks/${camera}`,   // detector: tracks across a burst
} as const;

export interface Bus {
  publish(topic: string, payload: unknown, opts?: { retain?: boolean }): Promise<void>;
  subscribe(topic: string, handler: (topic: string, payload: unknown) => void): Promise<void>;
  close(): Promise<void>;
  readonly client: MqttClient;
}

export function connectBus(clientId: string, url: string = config.mqttUrl): Promise<Bus> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { clientId: `${clientId}-${process.pid}`, reconnectPeriod: 2000, connectTimeout: 10_000 });
    const handlers = new Map<string, (topic: string, payload: unknown) => void>();
    client.on('message', (topic, buf) => {
      let payload: unknown = buf.toString('utf8');
      try { payload = JSON.parse(payload as string); } catch { /* raw string */ }
      for (const [pattern, h] of handlers) if (topicMatches(pattern, topic)) h(topic, payload);
    });
    client.once('error', reject);
    client.once('connect', () => {
      client.off('error', reject);
      resolve({
        client,
        publish: (topic, payload, opts = {}) => new Promise((res, rej) =>
          client.publish(topic, JSON.stringify(payload), { qos: 0, retain: opts.retain ?? false }, (err) => (err ? rej(err) : res()))),
        subscribe: (topic, handler) => new Promise((res, rej) => {
          handlers.set(topic, handler);
          client.subscribe(topic, { qos: 0 }, (err) => (err ? rej(err) : res()));
        }),
        close: () => new Promise((res) => client.end(false, {}, () => res())),
      });
    });
  });
}

/** MQTT wildcard match: + for one level, # for the rest. */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split('/'); const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
