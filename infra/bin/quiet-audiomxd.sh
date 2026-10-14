#!/bin/bash
# Headless workaround for macOS 27.0.1: with no console user, audiomxd spins (~75% CPU) retrying a
# Bluetooth audio-routing XPC to audioaccessoryd, and drags configd (~40%) with it. launchctl disable is
# ignored for this SIP-protected daemon, so: pause it (SIGSTOP) while nobody is logged in, resume it
# (SIGCONT) when someone is. Runs as a LaunchDaemon (com.ranch.quiet-audiomxd). Reversible: unload it.
INTERVAL="${INTERVAL:-30}"
while true; do
  pid=$(pgrep -x audiomxd | head -1)
  if [ -n "$pid" ]; then
    state=$(ps -o stat= -p "$pid" | tr -d ' ')
    console=$(who | awk '$2=="console"{print $1}' | head -1)
    if [ -z "$console" ] && [[ "$state" != T* ]]; then
      kill -STOP "$pid" && echo "$(date '+%F %T') paused audiomxd[$pid] (no console user)"
    elif [ -n "$console" ] && [[ "$state" == T* ]]; then
      kill -CONT "$pid" && echo "$(date '+%F %T') resumed audiomxd[$pid] (console user: $console)"
    fi
  fi
  sleep "$INTERVAL"
done
