# Draft upstream report: go2rtc 1.9.14 panics in TUTK DTLS keep-alive goroutine (Wyze source)

*Not filed yet. Vlad decides whether and where to post (AlexxIT/go2rtc). Captured on ranch-ai, macOS 27.0.1,
go2rtc 1.9.14 darwin/arm64 (revision b5948cf), seven Wyze cameras (6× Cam v4 4.52.17.26, 1× Cam v3 Pro 4.58.17.21,
1× Cam v3 4.36.17.21) on a lossy 2.4 GHz LAN, driven by IDisposable/docker-wyze-bridge v4.5.0 in external mode.*

## Summary

`go2rtc` crashes with `panic: runtime error: invalid memory address or nil pointer dereference` inside
`pkg/tutk/dtls.(*DTLSConn).AVClientStart.func1` when a Wyze (TUTK/DTLS) connection attempt fails during setup.
Three crashes in 48 h (18 Oct 02:13 and 15:41, 19 Oct 19:18 local), each a few seconds after
`connect failed: dtls: client handshake failed: handshake error: context deadline exceeded`. Identical trace every
time. Before the stderr was captured (16 Oct 17:27) the same exit status 2 took the process down for 3.6 h because
the embedding bridge did not restart it.

## Trace

```
02:13:32.486 ERR github.com/AlexxIT/go2rtc/internal/mjpeg/mjpeg.go:82 > error="streams: wyze: connect failed: dtls: client handshake failed: handshake error: context deadline exceeded"
02:13:35.921 DBG [streams] start producer url=wyze://192.168.1.126?...&model=HL_CAM4&subtype=hd&dtls=true
02:13:35.922 DBG [streams] start producer url=wyze://192.168.1.149?...&model=HL_CAM4&subtype=hd&dtls=true
02:13:36.043 DBG [streams] stop producer url=wyze://192.168.1.149?...&model=HL_CAM4&subtype=hd&dtls=true
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x2 addr=0x328 pc=0x104d65458]

goroutine 46879862 [running]:
github.com/pion/dtls/v3.(*Conn).isConnectionClosed(...)
	github.com/pion/dtls/v3@v3.0.10/conn.go:1273
github.com/pion/dtls/v3.(*Conn).Write(0x0, {0x14002540f18, 0x18, 0x18})
	github.com/pion/dtls/v3@v3.0.10/conn.go:395 +0x28
github.com/AlexxIT/go2rtc/pkg/tutk/dtls.(*DTLSConn).AVClientStart.func1()
	github.com/AlexxIT/go2rtc/pkg/tutk/dtls/conn_dtls.go:215 +0x100
created by github.com/AlexxIT/go2rtc/pkg/tutk/dtls.(*DTLSConn).AVClientStart in goroutine 46874769
	github.com/AlexxIT/go2rtc/pkg/tutk/dtls/conn_dtls.go:203 +0x41c
```

`(*dtls.Conn).Write` is called on a nil `*Conn` from the goroutine started at `conn_dtls.go:203` (the keep-alive /
AVClientStart sender): the connection it writes to is nil, consistent with the DTLS handshake having failed and the
goroutine outliving the setup error.

## Reproduction conditions

High rate of short-lived Wyze sessions: a client requesting `/api/frame.jpeg?src=<cam>` every 5 s per camera with no
other consumer, so each request starts and stops a producer (go2rtc `streams: debug` shows `start producer` /
`stop producer` every few seconds), on cameras with 30–70 % ICMP loss. Roughly 8,000 `discovery timeout` and
1,600 `dtls handshake` failures per day across seven cameras preceded the three panics.

## Workarounds in use

launchd restarts go2rtc within seconds (KeepAlive). Holding one persistent consumer per camera removes most of the
session churn and, so far, the panics.
