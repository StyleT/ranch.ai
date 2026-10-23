# Draft upstream report: docker-wyze-bridge (Go rewrite) health check counts a dead go2rtc producer as alive

*Not filed yet. Vlad decides whether and where to post (IDisposable/docker-wyze-bridge). Observed on ranch-ai, macOS
27.0.1, wyze-bridge v4.5.0 (commit da56b95) in external-go2rtc mode with go2rtc 1.9.14, seven Wyze cameras (6× V4,
1× V3 Pro; plus a V3), native `wyze://` TUTK sources.*

## Summary

`Manager.HealthCheck` decides a stream is healthy with `len(info.Producers) > 0`
(`internal/go2rtcmgr/apiclient.go:184`). go2rtc's `/api/streams` lists a configured source as a producer entry even
when it has no connection (no `remote_addr`, no `recv`), so a camera whose TUTK session has died, or whose dial hangs,
is never seen as lost: no `stream lost, will retry`, no reconnect, no `recordTUTKFailure`, no TUTK→WebRTC promotion.
The UI and `/api/metrics` keep reporting `state: streaming`.

## Evidence (23 Oct 2026)

- 24 h of our own probe (every 15 s per camera, "connected" = a producer with a `remote_addr`): availability 10–92 %
  per camera, ~200 drops, go2rtc logged `wyze: connect failed: discovery timeout` 1,202 times. The bridge logged
  **zero** `stream lost` / `connecting camera` / `promoting` events in the same 24 h.
- `GET /api/cameras` for `tractor_cam` after a 21-hour outage: `state: streaming`, `connected_at: 2026-10-20T08:21`,
  `last_seen: 2026-10-20T08:21`. go2rtc for the same stream: `producers: [{url: wyze://…}]` with no `remote_addr`,
  `consumers: []`.
- A dead-but-configured producer is also what the recorder's hung dial looks like: ffmpeg attached, RTSP socket
  established, go2rtc producer without `remote_addr` for 11+ minutes, no error.

## Suggested fix

Treat a producer as alive only when it carries a live connection: `remote_addr != ""` (and/or `recv > 0` growing
between two checks). A configured-but-disconnected entry should count as a loss for the health check and the TUTK
failure streak. Separately, the DELETE + PUT re-registration on every bridge start leaves consumers attached to an
orphaned stream object (frames keep flowing to them while the new object shows no producer and no consumers); a PATCH
of the source, or keeping the stream object when the source URL is unchanged, would avoid the duplicate camera
session that the next consumer attach creates.

## Workaround in use

Health is judged by frames on disk (our recorder's HLS playlist age) and by a probe of go2rtc's `remote_addr`, not by
the bridge; `TUTK_FALLBACK_THRESHOLD=0` because Wyze's cloud answers "camera does not use WebRTC streaming" for this
fleet, so a promotion would swap TUTK for a 404.
