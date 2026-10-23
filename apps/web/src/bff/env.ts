// Server-side configuration with defaults (set by the launchd plist on the mini).
export const env = {
  daemonUrl: process.env.RANCH_DAEMON_URL ?? 'http://127.0.0.1:5091',
  go2rtcUrl: process.env.RANCH_GO2RTC_URL ?? 'http://127.0.0.1:1984',   // loopback; only the WebRTC signalling is proxied, media is direct over the tailnet
  appDir: process.env.RANCH_APP_DIR ?? process.cwd(),
  tz: process.env.RANCH_TZ ?? 'America/New_York',
};
