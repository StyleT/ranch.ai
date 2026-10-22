// Runtime configuration for every ranch process. Everything comes from the environment (set by the
// LaunchDaemon plist on the mini, or your shell during development) with defaults that match the mini's layout.
const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export const config = {
  /** SQLite file holding frames, detections, events. */
  dbPath: env('RANCH_DB', '/usr/local/ranch/var/ranch-events.sqlite'),
  /** Root for frames, crops, snapshots. */
  mediaDir: env('RANCH_MEDIA', '/usr/local/ranch/media'),
  mqttUrl: env('RANCH_MQTT_URL', 'mqtt://127.0.0.1:1883'),
  /** go2rtc API (managed by the Wyze bridge): RTSP at :8554. Only the recorder consumes a live camera stream;
   *  every other process reads the recorder's on-disk buffer (docs/CAMERA-ARCHITECTURE.md). */
  go2rtcUrl: env('RANCH_GO2RTC_URL', 'http://127.0.0.1:1984'),
  /** Wyze bridge web API (metadata only; never a camera stream). */
  bridgeUrl: env('RANCH_BRIDGE_URL', 'http://127.0.0.1:5080'),
  /** The recorder's rolling per-camera JPEG buffer (<bufferDir>/<camera>/<UTC ts>.jpg). The single source of
   *  frames for the sampler and everything downstream. Nothing reads a camera directly. */
  bufferDir: env('RANCH_BUFFER', '/usr/local/ranch/media/buffer'),
  /** Space-separated stream names; empty = discover from the buffer directory's per-camera subdirs. */
  cameras: env('RANCH_CAMERAS', '').split(/\s+/).filter(Boolean),
  camerasExclude: env('RANCH_CAMERAS_EXCLUDE', 'living_room_cam').split(/\s+/).filter(Boolean),
  timezone: env('RANCH_TZ', 'America/New_York'),
} as const;

export type Config = typeof config;
