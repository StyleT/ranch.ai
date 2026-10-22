// Runtime configuration for every ranch process. Everything comes from the environment (set by the
// LaunchDaemon plist on the mini, or your shell during development) with defaults that match the mini's layout.
const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const config = {
  /** SQLite file holding frames, detections, events. */
  dbPath: env('RANCH_DB', '/usr/local/ranch/var/ranch-events.sqlite'),
  /** Root for frames, crops, snapshots. */
  mediaDir: env('RANCH_MEDIA', '/usr/local/ranch/media'),
  mqttUrl: env('RANCH_MQTT_URL', 'mqtt://127.0.0.1:1883'),
  /** go2rtc API (managed by the Wyze bridge): RTSP at :8554, JPEG frames at /api/frame.jpeg?src=<cam>. */
  go2rtcUrl: env('RANCH_GO2RTC_URL', 'http://127.0.0.1:1984'),
  /** Wyze bridge web API. */
  bridgeUrl: env('RANCH_BRIDGE_URL', 'http://127.0.0.1:5080'),
  /** Space-separated stream names; empty = ask the bridge and take every camera except RANCH_CAMERAS_EXCLUDE. */
  cameras: env('RANCH_CAMERAS', '').split(/\s+/).filter(Boolean),
  camerasExclude: env('RANCH_CAMERAS_EXCLUDE', 'living_room_cam').split(/\s+/).filter(Boolean),
  /** Cameras sampled but NOT held open by a persistent keepalive consumer. Default mops_cam: it is the only
   *  V3 Pro and the weakest-signal camera, and a continuous 2K-HD pull knocks it off its 2.4 GHz Wi-Fi (the same
   *  effect that forced the seed recorder short on 16 Oct). It still gets periodic grabs like the Wyze app does. */
  keepaliveExclude: env('RANCH_KEEPALIVE_EXCLUDE', 'mops_cam').split(/\s+/).filter(Boolean),
  timezone: env('RANCH_TZ', 'America/New_York'),
} as const;

export type Config = typeof config;
