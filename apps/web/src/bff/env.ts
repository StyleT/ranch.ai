// Server-side configuration with defaults (set by the launchd plist on the mini).
export const env = {
  daemonUrl: process.env.RANCH_DAEMON_URL ?? 'http://127.0.0.1:5091',
  go2rtcUrl: process.env.RANCH_GO2RTC_URL ?? 'http://127.0.0.1:1984',
  appDir: process.env.RANCH_APP_DIR ?? process.cwd(),
  maxStreams: Number(process.env.RANCH_WEB_MAX_STREAMS ?? 2),
  keepaliveExclude: (process.env.RANCH_KEEPALIVE_EXCLUDE ?? 'mops_cam').split(/[\s,]+/).filter(Boolean),
  tz: process.env.RANCH_TZ ?? 'America/New_York',
};
